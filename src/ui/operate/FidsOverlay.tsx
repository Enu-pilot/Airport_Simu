import { useState } from 'react';
import { compareIds } from '../../core/model/ids';
import { designatorsOf } from '../../core/layout/designators';
import { destinationDef } from '../../core/economy/registry';
import { resolveType } from '../../core/sim/aircraftTypes';
import { flightDelayMin } from '../../core/sim/simulation';
import type { Aircraft, Flight } from '../../core/sim/types';
import { disruptionActions } from '../../editor/simRunner';
import {
  AIRCRAFT_STATE_LABEL,
  BOARDING_LABEL,
  DELAY_CAUSE_LABEL,
  FLIGHT_STATUS_LABEL,
  HOLD_REASON_LABEL,
  OPS_UI,
  displayName,
  formatClock,
} from '../../i18n/ja';
import { useOps } from '../OpsPanels';
import { canReassignStand, compatibleStands, standOptionLabel } from './flightActions';
import { selectAircraftAndFocus } from './focus';
import { opsUi, useOpsUi } from './opsUi';

const STANDARD_ROWS = 40;
const FULL_ROWS = 150;

/** 運航表の旅客欄（全列表示）: 出発便 = 搭乗/予約（乗り遅れ）、到着便 = 退出/降機 */
function paxCell(f: Flight): string {
  const p = f.pax;
  if (!p.generated) return '';
  if (f.direction === 'departure') return `${BOARDING_LABEL[p.boarding]} ${p.boarded}/${p.booked}${p.missed ? `（乗遅${p.missed}）` : ''}`;
  return `退出 ${p.exited}/${p.deplaned + p.deplaneRemaining}`;
}

/** 状態の色（表示のみの演出）: 定刻 = 白、遅延 = 琥珀、搭乗中 = 緑、欠航・ダイバート = 赤 */
function tone(f: Flight, ac: Aircraft, delay: number | null): 'ok' | 'delay' | 'boarding' | 'bad' {
  if (ac.state === 'diverted' || ac.state === 'cannotOperate' || f.status === 'cancelled' || f.status === 'diverted') return 'bad';
  if (f.direction === 'departure' && f.pax.generated && f.pax.boarding === 'open') return 'boarding';
  if (delay !== null && delay >= 15) return 'delay';
  return 'ok';
}

/**
 * マップ右上の運航表（空港の案内板風の演出。実在の案内板の再現ではない）。
 * 出発 / 到着 / すべて、完了を隠す、折りたたみ、全列表示（上部の「運航表（全列）」）。行クリックで機体を選択し、
 * 行の ⋯ から直接操作（遅延・スポット変更・優先・移動）。操作は既存の disruptionActions（sim/disruptions.ts）を呼ぶ。
 */
export function FidsOverlay() {
  const o = useOps();
  const filter = useOpsUi((s) => s.fidsFilter);
  const hideDone = useOpsUi((s) => s.fidsHideDone);
  const collapsed = useOpsUi((s) => s.fidsCollapsed);
  const full = useOpsUi((s) => s.fidsFull);
  const menu = useOpsUi((s) => s.fidsMenu);
  if (!o) return null;
  const { state, ctx } = o.sim;
  const flights = Object.values(state.flights)
    .filter((f) => filter === 'all' || f.direction === filter)
    .filter((f) => !hideDone || f.status === 'scheduled' || f.status === 'active' || state.now - (f.actual ?? f.block ?? f.estimated) < 15 * 60)
    .sort((a, b) => a.scheduled - b.scheduled || compareIds(a.id, b.id))
    .slice(0, full ? FULL_ROWS : STANDARD_ROWS);
  const menuFlight = menu ? state.flights[menu] : undefined;

  return (
    <div className={`fids ${full ? 'full' : ''} ${collapsed ? 'collapsed' : ''}`} data-testid="flight-board">
      <div className="fids-head">
        <span className="fids-title">{OPS_UI.fidsTitle}</span>
        <span className="fids-clock" data-testid="fids-clock">
          {formatClock(state.now)}
        </span>
        {!collapsed && (
          <>
            <span className="fids-seg" role="group">
              {(['all', 'departure', 'arrival'] as const).map((k) => (
                <button key={k} className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => opsUi.patch({ fidsFilter: k })} data-testid={`fids-filter-${k}`}>
                  {OPS_UI.fidsFilter[k]}
                </button>
              ))}
            </span>
            <label className="fids-check">
              <input type="checkbox" checked={hideDone} onChange={(e) => opsUi.patch({ fidsHideDone: e.target.checked })} />
              {OPS_UI.fidsHideDone}
            </label>
          </>
        )}
        <button className="fids-fold" onClick={() => opsUi.patch({ fidsCollapsed: !collapsed })} title={collapsed ? OPS_UI.fidsOpen : OPS_UI.fidsFold} data-testid="fids-fold">
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="fids-scroll">
            <table className="board fids-table">
              <thead>
                <tr>
                  {(full ? OPS_UI.fidsColsFull : OPS_UI.fidsCols).map((c, i) => (
                    <th key={c} className={full ? '' : i === 3 ? 'col-type' : i === 6 ? 'col-delay' : ''}>
                      {c}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {flights.map((f) => {
                  const ac = state.aircraft[f.aircraftId]!;
                  const delay = flightDelayMin(f, state.now);
                  const type = resolveType(ctx.types, ac.typeId);
                  const place = f.destinationId ? destinationDef(f.destinationId).name : '—';
                  const stand = f.standId ? displayName(ctx.layout, f.standId).replace('スポット ', '') : '';
                  const stateText = `${AIRCRAFT_STATE_LABEL[ac.state]}${ac.holdReason ? `（${HOLD_REASON_LABEL[ac.holdReason]}）` : ''}`;
                  const rw = f.runwayId ? ctx.layout.runways[f.runwayId] : undefined;
                  return (
                    <tr
                      key={f.id}
                      onClick={() => selectAircraftAndFocus(ac.id)}
                      className={`tone-${tone(f, ac, delay)} ${ac.id === o.selectedAircraft ? 'selected' : ''}`}
                      data-testid={`flight-${f.number}`}
                    >
                      {full ? (
                        <>
                          <td className="fids-num">{f.number}</td>
                          <td>{f.direction === 'arrival' ? '到着' : '出発'}</td>
                          <td>{type.shortLabel}</td>
                          <td>{formatClock(f.scheduled)}</td>
                          <td>{f.actual !== null ? formatClock(f.actual) : f.status === 'scheduled' || f.status === 'active' ? formatClock(f.estimated) : '—'}</td>
                          <td className={delay && delay >= 15 ? 'fids-late' : ''}>{delay ? `${delay}分` : ''}</td>
                          <td>{rw ? designatorsOf(rw, ctx.layout).text.join('/') : ''}</td>
                          <td>{stand}</td>
                          <td data-testid={`pax-${f.number}`}>{paxCell(f)}</td>
                          <td>{FLIGHT_STATUS_LABEL[f.status]}</td>
                          <td className="fids-state">{stateText}</td>
                          <td className="muted">{f.delayCauses.map((c) => DELAY_CAUSE_LABEL[c]).join('、')}</td>
                        </>
                      ) : (
                        <>
                          <td>{formatClock(f.scheduled)}</td>
                          <td className="fids-num">{f.number}</td>
                          <td className="fids-place">
                            <span className="fids-dir">{f.direction === 'arrival' ? OPS_UI.fidsFrom : OPS_UI.fidsTo}</span>
                            {place}
                          </td>
                          <td className="col-type">{type.shortLabel}</td>
                          <td>{stand}</td>
                          <td className="fids-state">{stateText}</td>
                          <td className={`col-delay ${delay && delay >= 15 ? 'fids-late' : ''}`}>{delay ? `+${delay}分` : ''}</td>
                        </>
                      )}
                      <td className="fids-act">
                        <button
                          className="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            opsUi.patch({ fidsMenu: menu === f.id ? null : f.id });
                          }}
                          title={OPS_UI.fidsActions}
                          aria-label={OPS_UI.fidsActions}
                          data-testid={`fids-menu-${f.number}`}
                        >
                          ⋯
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {flights.length === 0 && <div className="fids-empty">{OPS_UI.fidsEmpty}</div>}
          </div>
          {menuFlight && <FlightMenu flight={menuFlight} />}
        </>
      )}
    </div>
  );
}

/** 選んだ便への直接操作（行の ⋯ から開く）。遅延・スポット変更・優先・移動 */
function FlightMenu({ flight }: { flight: Flight }) {
  const o = useOps();
  const [stand, setStand] = useState('');
  if (!o) return null;
  const sim = o.sim;
  const ac = sim.state.aircraft[flight.aircraftId]!;
  const dep = sim.state.flights[ac.departureFlightId]!;
  const n = flight.number;
  const canStand = canReassignStand(sim, ac.id);
  const canDelay = flight.status !== 'completed' && flight.status !== 'cancelled' && flight.status !== 'diverted' && flight.block === null;
  return (
    <div className="fids-menu" data-testid={`fids-menu-panel-${n}`}>
      <b>{n}</b>
      <button onClick={() => disruptionActions.delay(flight.id, 15)} disabled={!canDelay} data-testid={`fids-delay15-${n}`}>
        {OPS_UI.delay15}
      </button>
      <button onClick={() => disruptionActions.delay(flight.id, 30)} disabled={!canDelay} data-testid={`fids-delay30-${n}`}>
        {OPS_UI.delay30}
      </button>
      <span className="fids-stand" data-testid={`fids-stand-${n}`}>
        <select value={stand} onChange={(e) => setStand(e.target.value)} disabled={!canStand} aria-label={OPS_UI.reassign}>
          <option value="">{OPS_UI.reassign}…</option>
          {compatibleStands(sim, ac.id).map((s) => (
            <option key={s.id} value={s.id} disabled={standOptionLabel(sim, s.id).closed}>
              {standOptionLabel(sim, s.id).text}
            </option>
          ))}
        </select>
        <button disabled={!canStand || !stand} onClick={() => disruptionActions.reassignStand(ac.id, stand)} data-testid={`fids-stand-apply-${n}`}>
          {OPS_UI.apply}
        </button>
      </span>
      <button className={dep.priority ? 'on' : ''} onClick={() => disruptionActions.prioritize(ac.id, !dep.priority)} data-testid={`fids-prio-${n}`}>
        {dep.priority ? OPS_UI.prioOff : OPS_UI.prio}
      </button>
      <button onClick={() => selectAircraftAndFocus(ac.id)} data-testid={`fids-goto-${n}`}>
        {OPS_UI.goto}
      </button>
      <button className="small" onClick={() => opsUi.patch({ fidsMenu: null })} aria-label={OPS_UI.close}>
        ×
      </button>
    </div>
  );
}
