import { useState } from 'react';
import { compareIds } from '../core/model/ids';
import { AIRCRAFT_TYPES, AIRCRAFT_TYPE_IDS, type AircraftTypeId } from '../core/sim/aircraftTypes';
import { SPEED_LEVELS } from '../core/sim/clock';
import { flightDelayMin, operableTypes } from '../core/sim/simulation';
import { routeLength } from '../core/sim/routes';
import { areaOccupancy, facilityLoad, serversOf } from '../core/sim/passengers';
import type { Flight, RunwayMode, SimState } from '../core/sim/types';
import { runwayDesignators } from '../core/layout/runway';
import { editorStore, useEditor, type OpsState } from '../editor/store';
import { ops } from '../editor/simRunner';
import { focusEntity } from '../editor/input';
import { actions } from '../editor/store';
import {
  AIRCRAFT_STATE_LABEL,
  DELAY_CAUSE_LABEL,
  FLIGHT_STATUS_LABEL,
  HOLD_REASON_LABEL,
  RUNWAY_MODE_LABEL,
  BOARDING_LABEL,
  ZONE_LABEL,
  displayName,
  eventText,
  formatClock,
  formatSimTime,
} from '../i18n/ja';

/** 運航状態（約10Hzで更新）。sim は可変オブジェクトなので uiVersion の変化で再描画する */
function useOps(): OpsState | null {
  useEditor((s) => s.ops?.uiVersion ?? -1);
  return editorStore.getState().ops;
}

// ---------------------------------------------------------------- 左: 運航コントロール

export function OpsControls() {
  const o = useOps();
  const [type, setType] = useState<AircraftTypeId>('narrow180');
  const level = useEditor((s) => s.interiorLevel);
  const interior = useEditor((s) => s.overlays.interior);
  if (!o) return null;
  const { state, ctx } = o.sim;
  const st = state.stats;
  const active = Object.values(state.aircraft).filter((a) => !['scheduled', 'departed', 'diverted', 'cannotOperate'].includes(a.state));
  const airborne = active.filter((a) => ['inbound', 'holding', 'approach'].includes(a.state)).length;
  const types = operableTypes(ctx);

  return (
    <div className="toolbox ops" data-testid="ops-controls">
      <div className="sim-clock" data-testid="sim-clock">{formatSimTime(state.now, true)}</div>
      <div className="speed-buttons">
        {SPEED_LEVELS.map((l, i) => (
          <button
            key={l.speed}
            className={o.clock.speed === l.speed ? 'tool active' : 'tool'}
            onClick={() => ops.setSpeed(l.speed)}
            title={i === 0 ? 'Space' : `${i} キー（1実秒 = ${l.speed}ゲーム秒）`}
            data-testid={`speed-${l.speed}`}
          >
            {l.label}
          </button>
        ))}
      </div>
      {o.dropped && <div className="warn-text">処理が追いつかないため、ゲーム内時間を遅らせています</div>}

      <div className="tool-group-title">ターミナル内部の表示</div>
      <div className="speed-buttons">
        {[0, 1, 2].map((l) => (
          <button key={l} className={interior && level === l ? 'tool active' : 'tool'} onClick={() => actions.setInteriorLevel(l)}>
            {l + 1}F
          </button>
        ))}
        <button className={!interior ? 'tool active' : 'tool'} onClick={() => interior && actions.toggleOverlay('interior')}>
          外観
        </button>
      </div>

      <div className="tool-group-title">運航状況</div>
      <div className="stat-grid">
        <span>空域</span>
        <b>{airborne}</b>
        <span>地上</span>
        <b>{active.length - airborne}</b>
        <span>着陸</span>
        <b data-testid="stat-arrivals">{st.arrivals}</b>
        <span>離陸</span>
        <b data-testid="stat-departures">{st.departures}</b>
        <span>ダイバート</span>
        <b>{st.diverted}</b>
        <span>欠航</span>
        <b>{st.cancelled}</b>
        <span>着陸復行</span>
        <b>{st.goArounds}</b>
        <span>競合検知</span>
        <b className={st.conflicts > 0 ? 'ng-text' : ''} data-testid="stat-conflicts">{st.conflicts}</b>
        <span>平均到着走行</span>
        <b>{st.arrivals ? `${Math.round(st.taxiInSecTotal / st.arrivals / 6) / 10}分` : '—'}</b>
        <span>平均出発走行</span>
        <b>{st.departures ? `${Math.round(st.taxiOutSecTotal / st.departures / 6) / 10}分` : '—'}</b>
      </div>

      <div className="tool-group-title">滑走路</div>
      {Object.keys(state.runways)
        .sort(compareIds)
        .map((rid) => (
          <RunwayRow key={rid} state={state} rid={rid} layoutRunway={ctx.layout.runways[rid]!} />
        ))}

      <div className="tool-group-title">便の追加</div>
      <div className="tool-options">
        <label>
          機種
          <select value={type} onChange={(e) => setType(e.target.value as AircraftTypeId)}>
            {AIRCRAFT_TYPE_IDS.map((id) => (
              <option key={id} value={id} disabled={!types.includes(id)}>
                {AIRCRAFT_TYPES[id].label}（{AIRCRAFT_TYPES[id].size}）
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => ops.addArrival(type)} disabled={!types.includes(type)} data-testid="add-arrival">
          到着便を追加（すぐ空域に進入）
        </button>
        <label>
          1日の往復便数（翌日以降）
          <input
            type="number"
            min={0}
            max={200}
            value={state.settings.flightsPerDay}
            onChange={(e) => ops.setFlightsPerDay(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
          />
        </label>
      </div>
    </div>
  );
}

function RunwayRow({ state, rid, layoutRunway }: { state: SimState; rid: string; layoutRunway: { heading: 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315; name: string } }) {
  const rs = state.runways[rid]!;
  const cfg = state.runwayConfig[rid]!;
  const [d0, d1] = runwayDesignators(layoutRunway.heading);
  const occ = rs.occupant ? state.aircraft[rs.occupant.aircraftId] : null;
  const booking = rs.booking ? state.aircraft[rs.booking.aircraftId] : null;
  const arrQ = Object.values(state.aircraft).filter((a) => a.runwayId === rid && (a.state === 'holding' || a.state === 'inbound')).length;
  const depQ = Object.values(state.aircraft).filter((a) => a.runwayId === rid && a.state === 'holdShort').length;
  const purpose = { landing: '着陸', takeoff: '離陸', crossing: '横断' } as const;
  return (
    <div className="runway-row" data-testid={`runway-${rid}`}>
      <div className="runway-name">
        {layoutRunway.name || `${d0}/${d1}`}
        <span className={occ ? 'pill busy' : booking ? 'pill booked' : 'pill free'}>
          {occ ? `${purpose[rs.occupant!.purpose]}: ${occ.callsign}` : booking ? `進入: ${booking.callsign}` : '空き'}
        </span>
      </div>
      <div className="runway-ctl">
        <select value={cfg.direction} onChange={(e) => ops.setRunway(rid, { direction: e.target.value as 'forward' | 'reverse' })} title="運用方向">
          <option value="forward">{d0} 方向</option>
          <option value="reverse">{d1} 方向</option>
        </select>
        <select value={cfg.mode} onChange={(e) => ops.setRunway(rid, { mode: e.target.value as RunwayMode })} data-testid={`runway-mode-${rid}`}>
          {(Object.keys(RUNWAY_MODE_LABEL) as RunwayMode[]).map((m) => (
            <option key={m} value={m}>
              {RUNWAY_MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      <div className="runway-q">
        到着待ち {arrQ} / 離陸待ち {depQ}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 右: 機体の詳細

export function AircraftPanel() {
  const o = useOps();
  const id = o?.selectedAircraft;
  const ac = id ? o.sim.state.aircraft[id] : undefined;
  if (!o || !ac) return null;
  const { state, ctx } = o.sim;
  const type = AIRCRAFT_TYPES[ac.typeId];
  const arr = state.flights[ac.arrivalFlightId]!;
  const dep = state.flights[ac.departureFlightId]!;
  const remaining = ac.route ? Math.max(0, Math.round(routeLength(ac.route) - ac.dist)) : null;
  const layout = ctx.layout;

  return (
    <div className="properties" data-testid="aircraft-panel">
      <div className="prop-header">
        <div className="prop-title">{ac.callsign}</div>
        <div className="prop-sub">
          {type.label} · {type.size}級 · <code>{ac.id}</code>
        </div>
      </div>
      <div className={ac.holdReason || ac.state === 'diverted' || ac.state === 'cannotOperate' ? 'operability ng' : 'operability ok'} data-testid="aircraft-state">
        {AIRCRAFT_STATE_LABEL[ac.state]}
        {ac.holdReason && <div className="reason">待機理由: {HOLD_REASON_LABEL[ac.holdReason]}（{ac.waitSince !== null ? Math.round((state.now - ac.waitSince) / 60) : 0}分）</div>}
      </div>
      <div className="prop-section">
        <div className="prop-section-title">位置・速度</div>
        <Row label="速度">{`${ac.speed.toFixed(1)} m/s（${Math.round(ac.speed * 3.6)} km/h）`}</Row>
        <Row label="位置">{`(${ac.x.toFixed(1)}, ${ac.y.toFixed(1)}) 機首 ${Math.round(ac.heading)}°`}</Row>
        <Row label="滑走路">{ac.runwayId ? <Link layoutName={displayName(layout, ac.runwayId)} id={ac.runwayId} /> : '—'}</Row>
        <Row label="スポット">{ac.standId ? <Link layoutName={displayName(layout, ac.standId)} id={ac.standId} /> : arr.standId ? `${displayName(layout, arr.standId)}（離脱済み）` : '未割り当て'}</Row>
        <Row label="経路">{remaining !== null ? `残り ${remaining.toLocaleString()} m（${ac.route!.nodes.length} ノード）` : '—'}</Row>
      </div>
      <div className="prop-section">
        <div className="prop-section-title">便</div>
        <FlightRows f={arr} now={state.now} label="到着" />
        <FlightRows f={dep} now={state.now} label="出発" />
        {dep.pax.generated && (
          <Row label="搭乗">
            {BOARDING_LABEL[dep.pax.boarding]} {dep.pax.boarded}/{dep.pax.booked}
            {dep.pax.deadline !== null ? ` · 締切 ${formatClock(dep.pax.deadline)}` : ''}
            {dep.pax.missed ? ` · 乗り遅れ ${dep.pax.missed}` : ''}
          </Row>
        )}
        {arr.pax.generated && <Row label="到着旅客">{`降機 ${arr.pax.deplaned}/${arr.pax.booked} · 退出 ${arr.pax.exited}`}</Row>}
      </div>
      <div className="prop-section">
        <div className="prop-section-title">運航履歴</div>
        <div className="history" data-testid="aircraft-history">
          {ac.history.map((h, i) => (
            <div key={i} className="history-row">
              <span className="time">{formatClock(h.t)}</span>
              <span>{AIRCRAFT_STATE_LABEL[h.state]}</span>
              {h.note && <span className="muted">（{HOLD_REASON_LABEL[h.note as keyof typeof HOLD_REASON_LABEL] ?? h.note}）</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FlightRows({ f, now, label }: { f: Flight; now: number; label: string }) {
  const delay = flightDelayMin(f, now);
  return (
    <>
      <Row label={`${label} ${f.number}`}>
        {FLIGHT_STATUS_LABEL[f.status]} · 予定 {formatClock(f.scheduled)}
        {f.actual !== null ? ` / 実績 ${formatClock(f.actual)}` : f.status !== 'completed' ? ` / 予想 ${formatClock(f.estimated)}` : ''}
      </Row>
      {delay !== null && delay > 0 && (
        <Row label="遅延">
          <span className="warn-text">
            {delay}分 {f.delayCauses.map((c) => DELAY_CAUSE_LABEL[c]).join('、')}
          </span>
        </Row>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop-field">
      <span className="prop-label">{label}</span>
      <span className="prop-value info">{children}</span>
    </div>
  );
}

function Link({ layoutName, id }: { layoutName: string; id: string }) {
  return (
    <button className="link" onClick={() => focusEntity(id)}>
      {layoutName}
    </button>
  );
}

// ---------------------------------------------------------------- 下: 運航表・イベント

export function FlightBoard() {
  const o = useOps();
  const [filter, setFilter] = useState<'all' | 'arrival' | 'departure'>('all');
  const [hideDone, setHideDone] = useState(true);
  if (!o) return null;
  const { state } = o.sim;
  const flights = Object.values(state.flights)
    .filter((f) => filter === 'all' || f.direction === filter)
    .filter((f) => !hideDone || f.status === 'scheduled' || f.status === 'active' || state.now - (f.actual ?? f.block ?? f.estimated) < 15 * 60)
    .sort((a, b) => a.scheduled - b.scheduled || compareIds(a.id, b.id))
    .slice(0, 150);
  const select = (acId: string) => {
    ops.selectAircraft(acId);
    const ac = state.aircraft[acId];
    if (ac && ac.state !== 'scheduled') actions.focus({ x: ac.x + 0.5, y: ac.y + 0.5 });
  };

  return (
    <div className="issues" data-testid="flight-board">
      <div className="issues-header">
        <strong>運航表</strong>
        {(['all', 'arrival', 'departure'] as const).map((k) => (
          <label key={k} className="sev-toggle">
            <input type="radio" checked={filter === k} onChange={() => setFilter(k)} />
            {{ all: 'すべて', arrival: '到着', departure: '出発' }[k]}
          </label>
        ))}
        <label className="sev-toggle">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
          完了した便を隠す
        </label>
      </div>
      <div className="issues-list">
        <table className="board">
          <thead>
            <tr>
              <th>便名</th>
              <th>区分</th>
              <th>機種</th>
              <th>予定</th>
              <th>予想/実績</th>
              <th>遅延</th>
              <th>滑走路</th>
              <th>スポット</th>
              <th>旅客</th>
              <th>便の状態</th>
              <th>機体の状態</th>
              <th>遅延理由</th>
            </tr>
          </thead>
          <tbody>
            {flights.map((f) => {
              const ac = state.aircraft[f.aircraftId]!;
              const delay = flightDelayMin(f, state.now);
              const rw = f.runwayId ? o.sim.ctx.layout.runways[f.runwayId] : undefined;
              return (
                <tr key={f.id} onClick={() => select(ac.id)} className={ac.id === o.selectedAircraft ? 'selected' : ''} data-testid={`flight-${f.number}`}>
                  <td>{f.number}</td>
                  <td>{f.direction === 'arrival' ? '到着' : '出発'}</td>
                  <td>{AIRCRAFT_TYPES[ac.typeId].size}</td>
                  <td>{formatClock(f.scheduled)}</td>
                  <td>{f.actual !== null ? formatClock(f.actual) : f.status === 'scheduled' || f.status === 'active' ? formatClock(f.estimated) : '—'}</td>
                  <td className={delay && delay >= 15 ? 'ng-text' : ''}>{delay ? `${delay}分` : ''}</td>
                  <td>{rw ? runwayDesignators(rw.heading).join('/') : ''}</td>
                  <td>{f.standId ? displayName(o.sim.ctx.layout, f.standId).replace('スポット ', '') : ''}</td>
                  <td data-testid={`pax-${f.number}`}>{paxCell(f)}</td>
                  <td>{FLIGHT_STATUS_LABEL[f.status]}</td>
                  <td>
                    {AIRCRAFT_STATE_LABEL[ac.state]}
                    {ac.holdReason ? `（${HOLD_REASON_LABEL[ac.holdReason]}）` : ''}
                  </td>
                  <td className="muted">{f.delayCauses.map((c) => DELAY_CAUSE_LABEL[c]).join('、')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {flights.length === 0 && <div className="empty">表示する便はありません</div>}
      </div>
    </div>
  );
}

/** 運航表の旅客欄: 出発便 = 搭乗/予約（乗り遅れ）、到着便 = 退出/降機 */
function paxCell(f: Flight): string {
  const p = f.pax;
  if (!p.generated) return '';
  if (f.direction === 'departure') return `${BOARDING_LABEL[p.boarding]} ${p.boarded}/${p.booked}${p.missed ? `（乗遅${p.missed}）` : ''}`;
  return `退出 ${p.exited}/${p.deplaned + p.deplaneRemaining}`;
}

/** ターミナル: 施設ごとの処理状況と旅客の集計 */
export function TerminalBoard() {
  const o = useOps();
  if (!o) return null;
  const { state, ctx } = o.sim;
  const model = ctx.terminal;
  const occ = areaOccupancy(state);
  const inTerminal = state.activePax.reduce((s, id) => {
    const g = state.paxGroups[id]!;
    return s + (g.area ? g.count : 0);
  }, 0);
  const ps = state.paxStats;
  const stranded = state.activePax.reduce((s, id) => s + (['stranded', 'waitingFacility'].includes(state.paxGroups[id]!.state) ? state.paxGroups[id]!.count : 0), 0);
  const rows = Object.values(model.areas).sort((a, b) => a.level - b.level || compareIds(a.id, b.id));
  return (
    <div className="issues" data-testid="terminal-board">
      <div className="issues-header">
        <strong>ターミナル</strong>
        <span>館内 {inTerminal}人</span>
        <span>搭乗 {ps.boarded}</span>
        <span className={ps.missed ? 'ng-text' : ''} data-testid="pax-missed">乗り遅れ {ps.missed}</span>
        <span>到着退出 {ps.exited}</span>
        <span className={stranded ? 'warn-text' : ''}>待機・到達不能 {stranded}</span>
        <span>平均待ち {ps.finished ? Math.round(ps.waitTotal / ps.finished / 6) / 10 : 0}分</span>
        <span>平均歩行 {ps.finished ? Math.round(ps.walkTotal / ps.finished / 6) / 10 : 0}分</span>
      </div>
      <div className="issues-list">
        <table className="board">
          <thead>
            <tr>
              <th>階</th>
              <th>施設</th>
              <th>区域</th>
              <th>窓口</th>
              <th>滞在</th>
              <th>待ち</th>
              <th>手続き中</th>
              <th>処理済み</th>
              <th>平均待ち</th>
              <th>最大待ち</th>
              <th>混雑</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const fac = state.facilities[a.id];
              const load = facilityLoad(state, a.id);
              const here = occ.get(a.id) ?? 0;
              const closed = state.closedAreas.includes(a.id);
              const servers = serversOf(o.sim, a.id);
              const crowd = Math.round((here / a.capacity) * 100);
              return (
                <tr key={a.id} onClick={() => focusEntity(a.id)} className={closed ? 'closed' : ''}>
                  <td>{a.level + 1}F</td>
                  <td>{displayName(ctx.layout, a.id).replace(/^\dF /, '')}</td>
                  <td className="muted">{ZONE_LABEL[a.zone].replace(/（.*）/, '')}</td>
                  <td>{['checkIn', 'security', 'restroom'].includes(a.kind) ? servers : ''}</td>
                  <td>{here || ''}</td>
                  <td className={load.queued > 50 ? 'ng-text' : ''}>{load.queued || ''}</td>
                  <td>{load.inService || ''}</td>
                  <td>{fac?.served || ''}</td>
                  <td>{fac?.served ? `${Math.round(fac.waitTotal / fac.served / 6) / 10}分` : ''}</td>
                  <td>{fac?.maxQueue || ''}</td>
                  <td className={crowd > 100 ? 'ng-text' : crowd > 50 ? 'warn-text' : ''}>{crowd ? `${crowd}%` : ''}</td>
                  <td>
                    <button
                      className="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        ops.setAreaClosed(a.id, !closed);
                      }}
                      data-testid={`close-${a.id}`}
                    >
                      {closed ? '再開' : '閉鎖'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">ターミナル内部のエリアがありません（建設モードの「ターミナル内部」で配置）</div>}
      </div>
    </div>
  );
}

export function EventLog() {
  const o = useOps();
  if (!o) return null;
  const { state } = o.sim;
  const cs = (id: string) => state.aircraft[id]?.callsign ?? id;
  const events = state.events.filter((e) => e.kind !== 'spawn').slice(-200).reverse();
  return (
    <div className="issues" data-testid="event-log">
      <div className="issues-list">
        {events.map((e, i) => (
          <div key={`${e.t}-${i}`} className={`issue ${e.kind === 'conflict' || e.kind === 'diverted' || e.kind === 'cannotOperate' ? 'error' : e.kind === 'hold' || e.kind === 'goAround' ? 'warning' : 'info'}`} onClick={() => e.aircraftId && ops.selectAircraft(e.aircraftId)}>
            <span className="time">{formatClock(e.t)}</span>
            <span>{eventText(e, cs)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
