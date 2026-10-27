import { useState } from 'react';
import { compareIds } from '../core/model/ids';
import { AIRCRAFT_TYPES, AIRCRAFT_TYPE_IDS, type AircraftTypeId } from '../core/sim/aircraftTypes';
import { SPEED_LEVELS } from '../core/sim/clock';
import { flightDelayMin, operableTypes } from '../core/sim/simulation';
import { routeLength } from '../core/sim/routes';
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
