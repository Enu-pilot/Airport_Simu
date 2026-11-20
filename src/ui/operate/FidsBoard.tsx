import { compareIds } from '../../core/model/ids';
import { designatorsOf } from '../../core/layout/designators';
import { resolveType } from '../../core/sim/aircraftTypes';
import { flightDelayMin } from '../../core/sim/simulation';
import {
  AIRCRAFT_STATE_LABEL,
  DELAY_CAUSE_LABEL,
  FLIGHT_STATUS_LABEL,
  HOLD_REASON_LABEL,
  OPS_UI,
  displayName,
  formatClock,
} from '../../i18n/ja';
import { useOps } from '../OpsPanels';
import { FlightMenu, paxCell, tone } from './FidsOverlay';
import { selectAircraftAndFocus } from './focus';
import { opsUi, useOpsUi } from './opsUi';

/** 全列表示で出す最大行数（従来の浮動パネルの全列表示と同じ） */
const FULL_ROWS = 150;

/**
 * 運航ボードの運航表（全列表示。ユーザ決定C の FIDS 併用）。
 * 浮動パネル（FidsOverlay）は要約表示だけにし、全列（滑走路・旅客・便の状態・遅延理由まで）は
 * ここに置く。絞り込み（出発/到着・完了を隠す）は浮動側と opsUi の同じ状態を共有する。
 * 行クリックで機体を選択し、行の ⋯ から直接操作できる（浮動側と同じ FlightMenu）。
 */
export function FidsBoard() {
  const o = useOps();
  const filter = useOpsUi((s) => s.fidsFilter);
  const hideDone = useOpsUi((s) => s.fidsHideDone);
  const menu = useOpsUi((s) => s.fidsMenu);
  if (!o) return null;
  const { state, ctx } = o.sim;
  const flights = Object.values(state.flights)
    .filter((f) => filter === 'all' || f.direction === filter)
    .filter((f) => !hideDone || f.status === 'scheduled' || f.status === 'active' || state.now - (f.actual ?? f.block ?? f.estimated) < 15 * 60)
    .sort((a, b) => a.scheduled - b.scheduled || compareIds(a.id, b.id))
    .slice(0, FULL_ROWS);
  const menuFlight = menu ? state.flights[menu] : undefined;
  return (
    <div className="fids-board" data-testid="fids-board">
      <div className="fids-board-head">
        <span className="fids-seg" role="group">
          {(['all', 'departure', 'arrival'] as const).map((k) => (
            <button key={k} className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => opsUi.patch({ fidsFilter: k })} data-testid={`fids-board-filter-${k}`}>
              {OPS_UI.fidsFilter[k]}
            </button>
          ))}
        </span>
        <label className="fids-check">
          <input type="checkbox" checked={hideDone} onChange={(e) => opsUi.patch({ fidsHideDone: e.target.checked })} data-testid="fids-board-hide-done" />
          {OPS_UI.fidsHideDone}
        </label>
        <span className="muted small">{OPS_UI.fidsBoardNote}</span>
      </div>
      <div className="fids-scroll">
        <table className="board fids-table">
          <thead>
            <tr>
              {OPS_UI.fidsColsFull.map((c) => (
                <th key={c}>{c}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {flights.map((f) => {
              const ac = state.aircraft[f.aircraftId]!;
              const delay = flightDelayMin(f, state.now);
              const type = resolveType(ctx.types, ac.typeId);
              const stand = f.standId ? displayName(ctx.layout, f.standId).replace('スポット ', '') : '';
              const busGate = f.pax.bus?.gateId ?? null;
              const busTag = f.pax.bus ? (
                <span className="fids-bus" title={busGate ? OPS_UI.fidsBusTitle(displayName(ctx.layout, busGate)) : undefined} data-testid={`fids-bus-${f.number}`}>
                  {' '}
                  {OPS_UI.fidsBus}
                </span>
              ) : null;
              const stateText = `${AIRCRAFT_STATE_LABEL[ac.state]}${ac.holdReason ? `（${HOLD_REASON_LABEL[ac.holdReason]}）` : ''}`;
              const rw = f.runwayId ? ctx.layout.runways[f.runwayId] : undefined;
              return (
                <tr
                  key={f.id}
                  onClick={() => selectAircraftAndFocus(ac.id)}
                  className={`tone-${tone(f, ac, delay)} ${ac.id === o.selectedAircraft ? 'selected' : ''}`}
                  data-testid={`flight-full-${f.number}`}
                >
                  <td className="fids-num">{f.number}</td>
                  <td>{f.direction === 'arrival' ? '到着' : '出発'}</td>
                  <td>{type.shortLabel}</td>
                  <td>{formatClock(f.scheduled)}</td>
                  <td>{f.actual !== null ? formatClock(f.actual) : f.status === 'scheduled' || f.status === 'active' ? formatClock(f.estimated) : '—'}</td>
                  <td className={delay && delay >= 15 ? 'fids-late' : ''}>{delay ? `${delay}分` : ''}</td>
                  <td>{rw ? designatorsOf(rw, ctx.layout).text.join('/') : ''}</td>
                  <td>
                    {stand}
                    {busTag}
                  </td>
                  <td data-testid={`pax-${f.number}`}>{paxCell(f)}</td>
                  <td>{FLIGHT_STATUS_LABEL[f.status]}</td>
                  <td className="fids-state">{stateText}</td>
                  <td className="muted">{f.delayCauses.map((c) => DELAY_CAUSE_LABEL[c]).join('、')}</td>
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
    </div>
  );
}
