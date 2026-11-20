import { useEffect, useRef, useState } from 'react';
import { compareIds } from '../../core/model/ids';
import { destinationDef } from '../../core/economy/registry';
import { resolveType } from '../../core/sim/aircraftTypes';
import { flightDelayMin } from '../../core/sim/simulation';
import type { Aircraft, Flight } from '../../core/sim/types';
import { disruptionActions } from '../../editor/simRunner';
import {
  AIRCRAFT_STATE_LABEL,
  BOARDING_LABEL,
  HOLD_REASON_LABEL,
  OPS_UI,
  displayName,
  formatClock,
} from '../../i18n/ja';
import { useOps } from '../OpsPanels';
import { canReassignStand, compatibleStands, standOptionLabel } from './flightActions';
import { selectAircraftAndFocus } from './focus';
import { opsUi, saveFidsPrefs, useOpsUi } from './opsUi';

const STANDARD_ROWS = 40;
/** コンパクト表示で出す便数（直近の N 便） */
const COMPACT_ROWS = 8;

/** 運航表の旅客欄（全列表示）: 出発便 = 搭乗/予約（乗り遅れ）、到着便 = 退出/降機 */
export function paxCell(f: Flight): string {
  const p = f.pax;
  if (!p.generated) return '';
  if (f.direction === 'departure') return `${BOARDING_LABEL[p.boarding]} ${p.boarded}/${p.booked}${p.missed ? `（乗遅${p.missed}）` : ''}`;
  return `退出 ${p.exited}/${p.deplaned + p.deplaneRemaining}`;
}

/** 状態の色（表示のみの演出）: 定刻 = 白、遅延 = 琥珀、搭乗中 = 緑、欠航・ダイバート = 赤 */
export function tone(f: Flight, ac: Aircraft, delay: number | null): 'ok' | 'delay' | 'boarding' | 'bad' {
  if (ac.state === 'diverted' || ac.state === 'cannotOperate' || f.status === 'cancelled' || f.status === 'diverted') return 'bad';
  if (f.direction === 'departure' && f.pax.generated && f.pax.boarding === 'open') return 'boarding';
  if (delay !== null && delay >= 15) return 'delay';
  return 'ok';
}

/**
 * マップ右上の運航表（空港の案内板風の演出。実在の案内板の再現ではない）。
 * 出し分け（ユーザ決定C）: 浮動パネルは要約表示（時刻・便名・行先・機種・スポット・状態・遅延）だけにし、
 * 全列表示は運航ボード（FidsBoard）に置く。浮動側の見出しボタンからボードへ辿れる。
 * 出発 / 到着 / すべて、完了を隠す、折りたたみは従来どおり。行クリックで機体を選択し、
 * 行の ⋯ から直接操作（遅延・スポット変更・優先・移動）。操作は既存の disruptionActions（sim/disruptions.ts）を呼ぶ。
 */
export function FidsOverlay() {
  const o = useOps();
  const filter = useOpsUi((s) => s.fidsFilter);
  const hideDone = useOpsUi((s) => s.fidsHideDone);
  const collapsed = useOpsUi((s) => s.fidsCollapsed);
  const menu = useOpsUi((s) => s.fidsMenu);
  const compact = useOpsUi((s) => s.fidsCompact);
  const pos = useOpsUi((s) => s.fidsPos);
  const boardRef = useRef<HTMLDivElement>(null);
  if (!o) return null;
  const { state, ctx } = o.sim;
  const flights = Object.values(state.flights)
    .filter((f) => filter === 'all' || f.direction === filter)
    .filter((f) => !hideDone || f.status === 'scheduled' || f.status === 'active' || state.now - (f.actual ?? f.block ?? f.estimated) < 15 * 60)
    .sort((a, b) => a.scheduled - b.scheduled || compareIds(a.id, b.id))
    .slice(0, compact ? COMPACT_ROWS : STANDARD_ROWS);
  const menuFlight = menu ? state.flights[menu] : undefined;

  /** 見出しのドラッグで移動する（ボタン・入力の上では動かさない）。位置は親（マップ）の内側に収める */
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, label, select')) return;
    const el = boardRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const pr = parent.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(0, ev.clientX - pr.left - dx), Math.max(0, pr.width - 80));
      const y = Math.min(Math.max(0, ev.clientY - pr.top - dy), Math.max(0, pr.height - 30));
      opsUi.patch({ fidsPos: { x: Math.round(x), y: Math.round(y) } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveFidsPrefs();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };

  return (
    <div
      ref={boardRef}
      className={`fids ${collapsed ? 'collapsed' : ''} ${pos ? 'moved' : ''}`}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
      data-testid="flight-board"
    >
      <div className="fids-head" onPointerDown={startDrag} title={OPS_UI.fidsDrag} data-testid="fids-head">
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
            <button
              className={`small fids-compact ${compact ? 'on' : ''}`}
              aria-pressed={compact}
              onClick={() => {
                opsUi.patch({ fidsCompact: !compact });
                saveFidsPrefs();
              }}
              title={compact ? OPS_UI.fidsCompactOff : OPS_UI.fidsCompactOn(COMPACT_ROWS)}
              data-testid="fids-compact"
            >
              {compact ? OPS_UI.fidsCompactLabel(COMPACT_ROWS) : OPS_UI.fidsAllLabel}
            </button>
            <label className="fids-check">
              <input type="checkbox" checked={hideDone} onChange={(e) => opsUi.patch({ fidsHideDone: e.target.checked })} />
              {OPS_UI.fidsHideDone}
            </label>
            <button className="small" onClick={() => opsUi.openOverlay('flights')} data-testid="fids-open-board">
              {OPS_UI.fidsOpenBoard}
            </button>
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
                  {OPS_UI.fidsCols.map((c, i) => (
                    <th key={c} className={i === 3 ? 'col-type' : i === 6 ? 'col-delay' : ''}>
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
                  const busGate = f.pax.bus?.gateId ?? null;
                  const busTag = f.pax.bus ? (
                    <span className="fids-bus" title={busGate ? OPS_UI.fidsBusTitle(displayName(ctx.layout, busGate)) : undefined} data-testid={`fids-bus-${f.number}`}>
                      {' '}
                      {OPS_UI.fidsBus}
                    </span>
                  ) : null;
                  const stateText = `${AIRCRAFT_STATE_LABEL[ac.state]}${ac.holdReason ? `（${HOLD_REASON_LABEL[ac.holdReason]}）` : ''}`;
                  return (
                    <tr
                      key={f.id}
                      onClick={() => selectAircraftAndFocus(ac.id)}
                      className={`tone-${tone(f, ac, delay)} ${ac.id === o.selectedAircraft ? 'selected' : ''}`}
                      data-testid={`flight-${f.number}`}
                    >
                      <td>{formatClock(f.scheduled)}</td>
                      <td className="fids-num">{f.number}</td>
                      <td className="fids-place">
                        <span className="fids-dir">{f.direction === 'arrival' ? OPS_UI.fidsFrom : OPS_UI.fidsTo}</span>
                        {place}
                      </td>
                      <td className="col-type">{type.shortLabel}</td>
                      <td>
                        {stand}
                        {busTag}
                      </td>
                      <td className="fids-state">{stateText}</td>
                      <td className={`col-delay ${delay && delay >= 15 ? 'fids-late' : ''}`}>{delay ? `+${delay}分` : ''}</td>
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

/** 選んだ便への直接操作（行の ⋯ から開く）。遅延・スポット変更・優先・移動。運航ボードの全列表（FidsBoard）からも使う */
export function FlightMenu({ flight }: { flight: Flight }) {
  const o = useOps();
  const [stand, setStand] = useState('');
  const close = () => opsUi.patch({ fidsMenu: null });
  // 外側のクリック・Esc で閉じる（遅延・優先は続けて押せるよう開いたまま。スポット変更・移動は操作後に閉じる）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-testid^="fids-menu"], [data-testid="flight-board"] table')) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  });
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
        <button disabled={!canStand || !stand} onClick={() => {
            disruptionActions.reassignStand(ac.id, stand);
            close();
          }} data-testid={`fids-stand-apply-${n}`}>
          {OPS_UI.apply}
        </button>
      </span>
      {sim.company?.game && (
        <button
          disabled={ac.state !== 'scheduled'}
          title={OPS_UI.cancelEarlyTitle}
          onClick={() => {
            if (window.confirm(OPS_UI.cancelEarlyConfirm(n))) {
              disruptionActions.cancelEarly(ac.id);
              close();
            }
          }}
          data-testid={`fids-cancel-${n}`}
        >
          {OPS_UI.cancelEarly}
        </button>
      )}
      <button className={dep.priority ? 'on' : ''} onClick={() => disruptionActions.prioritize(ac.id, !dep.priority)} data-testid={`fids-prio-${n}`}>
        {dep.priority ? OPS_UI.prioOff : OPS_UI.prio}
      </button>
      <button onClick={() => {
          selectAircraftAndFocus(ac.id);
          close();
        }}
        data-testid={`fids-goto-${n}`}>
        {OPS_UI.goto}
      </button>
      <button className="small" onClick={() => opsUi.patch({ fidsMenu: null })} aria-label={OPS_UI.close}>
        ×
      </button>
    </div>
  );
}
