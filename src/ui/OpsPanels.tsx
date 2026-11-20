import { useState } from 'react';
import { compareIds } from '../core/model/ids';
import { departureCutoffIssue } from '../core/economy/city';
import { PLAN_TURN_BUFFER_SEC } from '../core/economy/planning';
import { AIRCRAFT_TYPES, AIRCRAFT_TYPE_IDS, resolveType, type AircraftTypeId } from '../core/sim/aircraftTypes';
import { SPEED_LEVELS } from '../core/sim/clock';
import { flightDelayMin, operableTypes } from '../core/sim/simulation';
import { edgeIndexAt, routeLength } from '../core/sim/routes';
import { tasksOf } from '../core/sim/ground';
import { SIM_START_SEC } from '../core/sim/rules';
import type { Simulation } from '../core/sim/simulation';
import { areaOccupancy, facilityLoad, serversOf } from '../core/sim/passengers';
import { peekMissBreakdown } from '../core/sim/missBreakdown';
import { summarizeMissedBreakdown } from '../core/analytics/review';
import type { BagState, BlockReason, DisruptionKind, Flight, RunwayMode, SimState, WeatherKind } from '../core/sim/types';
import { designatorsOf } from '../core/layout/designators';
import type { AirportLayout, Runway } from '../core/model/types';
import { editorStore, useEditor, type OpsState } from '../editor/store';
import { disruptionActions, ops } from '../editor/simRunner';
import { compatibleStands, standOptionLabel } from './operate/flightActions';
import { REPAIR_COST } from '../core/sim/disruptions';
import { focusEntity } from '../editor/input';
import { actions } from '../editor/store';
import {
  AIRCRAFT_STATE_LABEL,
  DELAY_CAUSE_LABEL,
  FLIGHT_STATUS_LABEL,
  HOLD_REASON_LABEL,
  HOLD_REASON_EXPLANATION,
  RUNWAY_MODE_LABEL,
  BOARDING_LABEL,
  BAG_STATE_LABEL,
  BLOCK_REASON_LABEL,
  TASK_LABEL,
  TASK_STATE_LABEL,
  UNIT_KIND_LABEL,
  UNIT_STATUS_LABEL,
  ZONE_LABEL,
  DISRUPTION_KIND_LABEL,
  DISRUPTION_STATUS_LABEL,
  WEATHER_LABEL,
  MISS_BOTTLENECK_LABEL,
  displayName,
  eventText,
  formatClock,
  formatSimTime,
  BUS_PHASE_LABEL,
} from '../i18n/ja';

/** 運航状態（約10Hzで更新）。sim は可変オブジェクトなので uiVersion の変化で再描画する */
export function useOps(): OpsState | null {
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
  // 手動の到着便の折り返し出発が最終出発時刻（city.nightOps）を過ぎる見込みなら警告だけ出す（禁止しない。R7）
  const cutoffWarning = departureCutoffIssue(o.sim.company?.city, state.now + resolveType(ctx.types, type).turnaroundSec + PLAN_TURN_BUFFER_SEC);

  return (
    <div className="toolbox ops" data-testid="ops-controls">
      <div className="sim-clock" data-testid="sim-clock">{formatSimTime(state.now + (state.economy?.dayOffset ?? 0) * 86400, true)}</div>
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
        <button className={!interior ? 'tool active' : 'tool'} disabled={!interior} title={!interior ? '現在は外観表示です（階ボタンを押すとターミナル内部を表示します）' : '外観表示に戻します'} onClick={() => interior && actions.toggleOverlay('interior')}>
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

      <div className="tool-group-title">便の追加</div>
      <div className="tool-options">
        <label>
          機種
          <select value={type} onChange={(e) => setType(e.target.value as AircraftTypeId)}>
            {AIRCRAFT_TYPE_IDS.map((id) => (
              <option key={id} value={id} disabled={!types.includes(id)}>
                {resolveType(AIRCRAFT_TYPES, id).label}（{resolveType(AIRCRAFT_TYPES, id).size}）
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => ops.addArrival(type)} disabled={!types.includes(type)} data-testid="add-arrival">
          到着便を追加（すぐ空域に進入）
        </button>
        {cutoffWarning && <div className="warning-text small" role="status" data-testid="manual-cutoff-warning">{cutoffWarning}</div>}
        {o.sim.company ? (
          <div className="muted small">定期便は契約から作られます（下の「運航計画」タブ）。手動で追加した便も料金・費用の対象です。</div>
        ) : (
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
        )}
      </div>
    </div>
  );
}

/** 保存可能なスポッティング・実運航記録。統計値は記録済み FlightRecord だけから更新する。 */
export function JournalPanel() {
  const journal = useEditor((s) => s.journal);
  const entries = Object.values(journal.spotted).sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name, 'ja'));
  const typeTotals = Object.entries(journal.typeMovements).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const records = journal.records;
  return (
    <div className="prop-panel" data-testid="journal-panel">
      <div className="prop-section">
        <div className="prop-section-title">累計記録</div>
        <Row label="最多運航日">{records.busiestDay ? `${records.busiestDay.day + 1}日目 · ${records.busiestDay.movements}動作` : '記録なし'}</Row>
        <Row label="最多の1時間">{records.busiestHour ? `${records.busiestHour.day + 1}日目 ${String(records.busiestHour.hour).padStart(2, '0')}:00 · ${records.busiestHour.movements}動作` : '記録なし'}</Row>
        <Row label="カタログ最大翼幅">{records.largestAircraft ? `${records.largestAircraft.name} · ${records.largestAircraft.wingspanM.toFixed(1)} m` : '寸法データの記録なし'}</Row>
        <Row label="最長の実遅延">{records.longestDelay ? `${records.longestDelay.flight} · ${(records.longestDelay.delaySec / 60).toFixed(1)}分` : '記録なし'}</Row>
        <Row label="連続定時日数">{records.onTimeStreak.days}日（15分以内）</Row>
      </div>
      <div className="prop-section">
        <div className="prop-section-title">スポッティング記録</div>
        {entries.length === 0 ? <div className="muted">日次締め後に実運航ログから記録します。</div> : entries.map((entry) => (
          <Row key={`${entry.kind}:${entry.id}`} label={entry.kind === 'aircraft' ? '機種' : '航空会社'}>
            <span>{entry.name}{entry.rare ? ' · 珍しい運航' : ''}</span>
            <small>{entry.visits}便 · 初回 {entry.firstDay + 1}日目</small>
          </Row>
        ))}
      </div>
      <div className="prop-section">
        <div className="prop-section-title">機種別の累計発着回数</div>
        {typeTotals.length === 0 ? <div className="muted">記録なし</div> : typeTotals.map(([id, count]) => <Row key={id} label={id}>{count}回</Row>)}
      </div>
      <p className="muted small">記録は実際に完了した便のログから集計します。珍しい運航は契約外の便または翼幅65 m以上を示すゲーム内分類です。</p>
    </div>
  );
}

export function RunwayRow({ state, rid, layoutRunway, layout }: { state: SimState; rid: string; layoutRunway: Runway; layout: AirportLayout }) {
  const rs = state.runways[rid]!;
  const cfg = state.runwayConfig[rid]!;
  const [d0, d1] = designatorsOf(layoutRunway, layout).text;
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

/** 障害への対応: 代替スポット・遅延・作業の優先（sim/disruptions.ts） */
function ResponseSection({ acId }: { acId: string }) {
  const o = useOps();
  const [stand, setStand] = useState('');
  if (!o) return null;
  const { state } = o.sim;
  const ac = state.aircraft[acId]!;
  const dep = state.flights[ac.departureFlightId]!;
  const arr = state.flights[ac.arrivalFlightId]!;
  const beforeLanding = ac.state === 'scheduled' || ac.state === 'inbound' || ac.state === 'holding';
  const stands = compatibleStands(o.sim, acId);
  return (
    <div className="prop-section" data-testid="aircraft-response">
      <div className="prop-section-title">対応</div>
      {beforeLanding && (
        <Row label="代替スポット">
          <select value={stand} onChange={(e) => setStand(e.target.value)} data-testid="reassign-stand">
            <option value="">選択…</option>
            {stands.map((s) => (
              <option key={s.id} value={s.id} disabled={standOptionLabel(o.sim, s.id).closed}>
                {standOptionLabel(o.sim, s.id).text}
              </option>
            ))}
          </select>
          <button disabled={!stand} onClick={() => disruptionActions.reassignStand(acId, stand)}>
            変更
          </button>
        </Row>
      )}
      <Row label="遅延">
        {beforeLanding && <button onClick={() => disruptionActions.delay(arr.id, 15)}>到着 +15分</button>}
        {dep.block === null && <button onClick={() => disruptionActions.delay(dep.id, 15)}>出発 +15分</button>}
      </Row>
      <Row label="地上作業">
        <label>
          <input type="checkbox" checked={!!dep.priority} onChange={(e) => disruptionActions.prioritize(acId, e.target.checked)} data-testid="prioritize" />
          優先する（便の順序変更）
        </label>
      </Row>
    </div>
  );
}

/** 天候・障害の一覧と設定（運航中） */
export function DisruptionBoard() {
  const o = useOps();
  const [kind, setKind] = useState<DisruptionKind>('weather');
  const [target, setTarget] = useState('');
  const [weather, setWeather] = useState<WeatherKind>('rain');
  const [minutes, setMinutes] = useState(60);
  const [amount, setAmount] = useState(2);
  if (!o) return null;
  const { state, ctx } = o.sim;
  const l = ctx.layout;
  const targets: Partial<Record<DisruptionKind, [string, string][]>> = {
    runwayClosed: Object.keys(l.runways).map((id) => [id, displayName(l, id)]),
    taxiwayClosed: Object.keys(l.taxiways).map((id) => [id, displayName(l, id)]),
    standClosed: Object.keys(l.stands).map((id) => [id, displayName(l, id)]),
    gateFailure: Object.values(l.facilities)
      .filter((f) => f.kind === 'gate')
      .map((f) => [f.id, displayName(l, f.id)]),
    baggageFailure: [
      ...ctx.sorters.map((x): [string, string] => [x.id, displayName(l, x.id)]),
      ...Object.values(ctx.terminal.areas)
        .filter((a) => a.kind === 'baggageClaim')
        .map((a): [string, string] => [`belt:${a.id}`, `${displayName(l, a.id)} のベルト`]),
    ],
    vehicleFailure: Object.values(state.units)
      .filter((u) => u.kind !== 'staff' && u.kind !== 'engineer')
      .map((u) => [u.id, `${UNIT_KIND_LABEL[u.kind]} ${u.id}`]),
    maintenance: [...Object.keys(l.runways), ...Object.keys(l.stands), ...Object.keys(l.taxiways)].map((id) => [id, displayName(l, id)]),
  };
  const opts = targets[kind];
  const add = () =>
    disruptionActions.add({
      kind,
      targetId: opts ? target || opts[0]?.[0] || null : null,
      ...(kind === 'weather' ? { weather } : {}),
      ...(kind === 'staffAbsence' || kind === 'demandSurge' || kind === 'inboundDelay' ? { amount } : {}),
      end: minutes > 0 ? state.now + minutes * 60 : null,
    });
  const list = [...state.disruptions].reverse();
  return (
    <div className="issues" data-testid="disruption-board">
      <div className="issues-header">
        <strong>天候・障害</strong>
        <span data-testid="weather-now">天候: {WEATHER_LABEL[state.weather.kind]}</span>
        <span>
          閉鎖中: 誘導路 {state.closures.taxiways.length} · スポット {state.closures.stands.length} · ゲート {state.closures.gates.length}
        </span>
        <label className="sev-toggle">
          <input type="checkbox" checked={!!state.settings.randomDisruptions} onChange={(e) => disruptionActions.setRandom(e.target.checked)} />
          ランダムに発生させる
        </label>
        <span className="muted">影響はゲーム用の簡略化モデル</span>
      </div>
      <div className="issues-list">
        <div className="fee-grid">
          <select value={kind} onChange={(e) => (setKind(e.target.value as DisruptionKind), setTarget(''))} data-testid="disruption-kind">
            {(Object.keys(DISRUPTION_KIND_LABEL) as DisruptionKind[]).map((k) => (
              <option key={k} value={k}>
                {DISRUPTION_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {opts && (
            <select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="disruption-target">
              {opts.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {kind === 'weather' && (
            <select value={weather} onChange={(e) => setWeather(e.target.value as WeatherKind)}>
              {(['rain', 'snow', 'fog'] as const).map((w) => (
                <option key={w} value={w}>
                  {WEATHER_LABEL[w]}
                </option>
              ))}
            </select>
          )}
          {(kind === 'staffAbsence' || kind === 'demandSurge' || kind === 'inboundDelay') && (
            <label>
              {kind === 'staffAbsence' ? '人数' : kind === 'demandSurge' ? '倍率' : '遅延（分）'}
              <input type="number" step={kind === 'demandSurge' ? 0.1 : 1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} style={{ width: 60 }} />
            </label>
          )}
          <label>
            継続（分、0 = 修理まで）
            <input type="number" min={0} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={{ width: 60 }} />
          </label>
          <button onClick={add} data-testid="disruption-add">
            発生させる
          </button>
        </div>
        <table className="board">
          <thead>
            <tr>
              <th>種類</th>
              <th>対象</th>
              <th>状態</th>
              <th>開始</th>
              <th>復旧予定</th>
              <th>影響</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.id} data-testid={`disruption-${d.id}`}>
                <td>
                  {DISRUPTION_KIND_LABEL[d.kind]}
                  {d.weather ? `（${WEATHER_LABEL[d.weather]}）` : ''}
                  {d.amount !== undefined ? ` ×${d.amount}` : ''}
                </td>
                <td>{d.targetId ? displayName(l, d.targetId) : '全体'}</td>
                <td className={d.status === 'active' ? 'ng-text' : ''}>{DISRUPTION_STATUS_LABEL[d.status]}</td>
                <td>{formatClock(d.start)}</td>
                <td>{d.status === 'resolved' ? `${formatClock(d.resolvedAt!)}（${d.resolvedBy === 'player' ? '修理' : '時間'}）` : d.end !== null ? formatClock(d.end) : '修理まで'}</td>
                <td className="muted">
                  便 {d.affected.flights.length} · 作業 {d.affected.tasks.length} · ユニット {d.affected.units.length}
                </td>
                <td>
                  {d.status !== 'resolved' && !['weather', 'demandSurge', 'inboundDelay'].includes(d.kind) && (
                    <button onClick={() => disruptionActions.resolve(d.id)} title={`費用 ${REPAIR_COST[d.kind].toLocaleString('ja-JP')} cr`} data-testid={`resolve-${d.id}`}>
                      修理
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty">障害はありません</div>}
      </div>
    </div>
  );
}

/** バス扱いの便の搭乗方式・バスゲート・運行の状況 */
function BusRows({ state, dep, arr, layout }: { state: SimState; dep: Flight; arr: Flight; layout: AirportLayout }) {
  const gate = (dep.pax.bus?.gateId ?? arr.pax.bus?.gateId) ?? null;
  const trips = Object.values(state.bus!.trips).filter((t) => (t.flightId === dep.id || t.flightId === arr.id) && t.phase !== 'done' && t.phase !== 'cancelled');
  const waiting = [...(state.flightPax[dep.id] ?? []), ...(state.flightPax[arr.id] ?? [])].map((id) => state.paxGroups[id]!).filter((g) => g.state === 'waitingBus').reduce((n, g) => n + g.count, 0);
  const carried = (dep.pax.bus?.paxCarried ?? 0) + (arr.pax.bus?.paxCarried ?? 0);
  return (
    <div data-testid="aircraft-bus">
      <Row label="搭乗方式">{`バス（${gate ? displayName(layout, gate) : 'バスゲート未定'}）`}</Row>
      <Row label="ランプバス">{`バス待ち ${waiting}人 · 運んだ旅客 ${carried}人${trips.length > 0 ? ` · 運行中 ${trips.map((t) => `${t.id}（${BUS_PHASE_LABEL[t.phase]} ${t.pax}人）`).join('、')}` : ''}`}</Row>
    </div>
  );
}

export function AircraftPanel() {
  const o = useOps();
  const id = o?.selectedAircraft;
  const ac = id ? o.sim.state.aircraft[id] : undefined;
  if (!o || !ac) return null;
  const { state, ctx } = o.sim;
  const type = resolveType(o.sim.ctx.types, ac.typeId);
  const arr = state.flights[ac.arrivalFlightId]!;
  const dep = state.flights[ac.departureFlightId]!;
  const remaining = ac.route ? Math.max(0, Math.round(routeLength(ac.route) - ac.dist)) : null;
  const layout = ctx.layout;
  const routeNames = ac.route ? [...new Set(ac.route.edges.slice(edgeIndexAt(ac.route, ac.dist)).flatMap((edgeId) => {
    const edge = ctx.network.edges[edgeId];
    const name = edge?.kind === 'taxiway' ? layout.taxiways[edge.sourceId]?.name : '';
    return name ? [name] : [];
  }))] : [];

  return (
    <div className="properties" data-testid="aircraft-panel">
      <div className="prop-header">
        <div className="prop-title">{ac.callsign}</div>
        <div className="prop-sub">
          {type.label} · {type.size}級{type.codeF ? '（コード F）' : ''} · <code>{ac.id}</code>
        </div>
      </div>
      {type.unresolved && <div className="operability ng">機種ID {ac.typeId} がカタログにありません（代替の値で運航中）</div>}
      <div className="prop-section" data-testid="aircraft-model">
        <div className="prop-section-title">機種</div>
        <Row label="機種ID">{ac.typeId}</Row>
        <Row label="寸法">{`全長 ${type.lengthM} m · 翼幅 ${type.wingspanM} m${type.heightM !== null ? ` · 全高 ${type.heightM} m` : ''}`}</Row>
        <Row label="座席">{`${dep.seats ?? type.seats}席${type.maxPax !== null ? `（最大旅客定員 ${type.maxPax}）` : ''}`}</Row>
        <Row label="貨物室">{`手荷物 ${type.holdBags}個まで（ゲーム値）`}</Row>
      </div>
      <ResponseSection acId={ac.id} />
      <div className={ac.holdReason || ac.state === 'diverted' || ac.state === 'cannotOperate' ? 'operability ng' : 'operability ok'} data-testid="aircraft-state">
        {AIRCRAFT_STATE_LABEL[ac.state]}
        {ac.holdReason && <div className="reason">待機理由: {HOLD_REASON_LABEL[ac.holdReason]}（{ac.waitSince !== null ? Math.round((state.now - ac.waitSince) / 60) : 0}分）<div className="muted small">{HOLD_REASON_EXPLANATION[ac.holdReason]}</div></div>}
      </div>
      <div className="prop-section">
        <div className="prop-section-title">位置・速度</div>
        <Row label="速度">{`${ac.speed.toFixed(1)} m/s（${Math.round(ac.speed * 3.6)} km/h）`}</Row>
        <Row label="位置">{`(${ac.x.toFixed(1)}, ${ac.y.toFixed(1)}) 機首 ${Math.round(ac.heading)}°`}</Row>
        <Row label="滑走路">{ac.runwayId ? <Link layoutName={displayName(layout, ac.runwayId)} id={ac.runwayId} /> : '—'}</Row>
        <Row label="スポット">{ac.standId ? <Link layoutName={displayName(layout, ac.standId)} id={ac.standId} /> : arr.standId ? `${displayName(layout, arr.standId)}（離脱済み）` : '未割り当て'}</Row>
        <Row label="経路">{remaining !== null ? `残り ${remaining.toLocaleString()} m（${ac.route!.nodes.length} ノード）` : '—'}</Row>
        {routeNames.length > 0 && <Row label="走行指示">誘導路 {routeNames.join(' → ')}{ac.holdReason === 'crossing' ? ' · 滑走路横断許可待ち' : ''}</Row>}
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
        {(dep.pax.busFailure || arr.pax.busFailure) && (
          <div className="operability ng" data-testid="aircraft-bus-failure">
            バスゲート設定エラー: {[...new Set([dep.pax.busFailure, arr.pax.busFailure].filter(Boolean))].map((failure) => failure === 'disabled' ? 'このスポットではバスを使用しない設定です' : failure === 'invalidGate' ? '指定ゲートが無効、閉鎖中、またはターミナル・搭乗口・降機口に接続されていません' : 'バスゲートが未設定または利用できません').join(' / ')}
          </div>
        )}
        {(dep.pax.bus || arr.pax.bus) && state.bus && <BusRows state={state} dep={dep} arr={arr} layout={layout} />}
      </div>
      <TurnaroundSection sim={o.sim} acId={ac.id} />
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

// ---------------------------------------------------------------- 下: ターミナル・イベント

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
  // 当日ここまでの乗り遅れ内訳（締めで日報へ移る前の集計を読む）
  const missSummary = summarizeMissedBreakdown(peekMissBreakdown(state));
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
      {missSummary.length > 0 && (
        <div className="issues-header" data-testid="pax-missed-breakdown">
          <span>乗り遅れの内訳（本日ここまで）</span>
          {missSummary.slice(0, 4).map((s) => (
            <span key={s.category} className={s === missSummary[0] ? 'warn-text' : ''}>
              {MISS_BOTTLENECK_LABEL[s.category]} {s.count}人{s.topSpotId ? `（${displayName(ctx.layout, s.topSpotId)}）` : ''}
            </span>
          ))}
          {missSummary.length > 4 && <span>ほか {missSummary.length - 4} 件</span>}
        </div>
      )}
      <div className="issues-list">
        <table className="board clickable-rows">
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

// ---------------------------------------------------------------- 地上支援・手荷物

function bagCounts(state: SimState, flightId: string): Partial<Record<BagState, number>> {
  const m: Partial<Record<BagState, number>> = {};
  for (const id of state.flightBags[flightId] ?? []) {
    const b = state.bags[id]!;
    m[b.state] = (m[b.state] ?? 0) + 1;
  }
  return m;
}

const fmtCounts = (m: Partial<Record<BagState, number>>) =>
  (Object.entries(m) as [BagState, number][]).map(([k, v]) => `${BAG_STATE_LABEL[k]} ${v}`).join(' · ') || 'なし';

/** 機体の折り返し作業の進捗 */
function TurnaroundSection({ sim, acId }: { sim: Simulation; acId: string }) {
  const { state } = sim;
  const tasks = tasksOf(state, acId);
  const ac = state.aircraft[acId]!;
  const dep = state.flights[ac.departureFlightId]!;
  const arr = state.flights[ac.arrivalFlightId]!;
  if (tasks.length === 0) return null;
  return (
    <div className="prop-section" data-testid="turnaround">
      <div className="prop-section-title">折り返し作業</div>
      <table className="board tasks">
        <tbody>
          {tasks.map((t) => {
            const pct =
              t.state === 'done' ? 100 : t.workSec > 0 ? Math.min(99, Math.round((t.doneSec / t.workSec) * 100)) : t.state === 'inProgress' ? null : 0;
            return (
              <tr key={t.id} className={t.blockedReason && t.blockedReason !== 'dependency' && t.blockedReason !== 'waitingTime' ? 'blocked' : ''} data-testid={`task-${t.kind}`}>
                <td>{TASK_LABEL[t.kind]}</td>
                <td>{TASK_STATE_LABEL[t.state]}</td>
                <td>
                  <span className="bar">
                    <span style={{ width: `${pct ?? 50}%` }} className={pct === null ? 'indeterminate' : ''} />
                  </span>
                </td>
                <td className="muted">
                  {t.blockedReason ? BLOCK_REASON_LABEL[t.blockedReason] : t.units.map((u) => UNIT_KIND_LABEL[state.units[u]!.kind]).join('・')}
                  {t.note ? ` ${t.note}` : ''}
                </td>
                <td className="time">{t.doneAt !== null ? formatClock(t.doneAt) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {dep.readyAt !== null && (
        <Row label="準備完了">
          {formatClock(dep.readyAt)}（最後: {dep.criticalTask ? TASK_LABEL[dep.criticalTask] : '—'}）
        </Row>
      )}
      <Row label="出発手荷物">{fmtCounts(bagCounts(state, dep.id))}</Row>
      <Row label="到着手荷物">{fmtCounts(bagCounts(state, arr.id))}</Row>
    </div>
  );
}

/** 地上支援: 作業員・車両の配置と稼働、設備の状態、止まっている作業 */
export function GroundBoard() {
  const o = useOps();
  if (!o) return null;
  const { state, ctx } = o.sim;
  const units = Object.values(state.units);
  const kinds = [...new Set(units.map((u) => u.kind))];
  const elapsed = Math.max(1, state.now - SIM_START_SEC);
  const blocked = state.activeTasks
    .map((id) => state.tasks[id]!)
    .filter((t) => t.blockedReason && t.blockedReason !== 'dependency' && t.blockedReason !== 'waitingTime');
  const claims = Object.values(ctx.terminal.areas).filter((a) => a.kind === 'baggageClaim');
  const gs = state.groundStats;
  return (
    <div className="issues" data-testid="ground-board">
      <div className="issues-header">
        <strong>地上支援</strong>
        <span>完了作業 {gs.tasksDone}</span>
        <span className={gs.lateReadyFlights ? 'warn-text' : ''}>準備遅れ {gs.lateReadyFlights}便（計 {Math.round(gs.lateReadySec / 60)}分）</span>
        <span>
          停止時間 {(Object.entries(gs.blockedSec) as [BlockReason, number][])
            .filter(([k]) => k !== 'dependency' && k !== 'waitingTime')
            .map(([k, v]) => `${BLOCK_REASON_LABEL[k]} ${Math.round(v / 60)}分`)
            .join(' / ') || 'なし'}
        </span>
        <label className="sev-toggle">
          <input type="checkbox" checked={state.settings.randomFailures} onChange={(e) => ops.setRandomFailures(e.target.checked)} data-testid="random-failures" />
          ランダム故障
        </label>
      </div>
      <div className="issues-list ground-grid">
        <table className="board">
          <thead>
            <tr>
              <th>種類</th>
              <th>台数</th>
              <th>待機</th>
              <th>移動</th>
              <th>作業中</th>
              <th>故障</th>
              <th>稼働率</th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((k) => {
              const list = units.filter((u) => u.kind === k);
              const c = (st: string[]) => list.filter((u) => st.includes(u.status)).length;
              const util = Math.round((list.reduce((s, u) => s + u.busySec, 0) / (list.length * elapsed)) * 100);
              return (
                <tr key={k} data-testid={`units-${k}`}>
                  <td>{UNIT_KIND_LABEL[k]}</td>
                  <td>{list.length}</td>
                  <td>{c(['idle'])}</td>
                  <td>{c(['enroute', 'returning'])}</td>
                  <td>{c(['working'])}</td>
                  <td className={c(['broken']) ? 'ng-text' : ''}>{c(['broken']) || ''}</td>
                  <td>{util}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <table className="board">
          <thead>
            <tr>
              <th>車両・作業員</th>
              <th>状態</th>
              <th>作業</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {units
              .filter((u) => u.kind !== 'staff')
              .map((u) => {
                const t = u.taskId ? state.tasks[u.taskId] : undefined;
                return (
                  <tr key={u.id}>
                    <td>
                      {UNIT_KIND_LABEL[u.kind]} <span className="muted">{u.id}</span>
                    </td>
                    <td className={u.status === 'broken' ? 'ng-text' : ''}>{UNIT_STATUS_LABEL[u.status]}</td>
                    <td>{t ? `${state.aircraft[t.aircraftId]!.callsign} ${TASK_LABEL[t.kind]}` : ''}</td>
                    <td>
                      <button className="small" onClick={() => ops.setUnitBroken(u.id, u.status !== 'broken')} data-testid={`break-${u.id}`}>
                        {u.status === 'broken' ? '修理' : '故障'}
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        <table className="board">
          <thead>
            <tr>
              <th>設備</th>
              <th>状態</th>
              <th>停止時間</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...ctx.sorters.map((x) => ({ key: x.id, name: displayName(ctx.layout, x.id), detail: `${x.capacityPerMin}個/分` })), ...claims.map((a) => ({ key: `belt:${a.id}`, name: `${displayName(ctx.layout, a.id)} ベルト`, detail: `${Number(ctx.layout.terminalAreas[a.id]!.props.belts ?? 0)}本` }))].map((e) => {
              const eq = state.equipment[e.key];
              return (
                <tr key={e.key} data-testid={`equipment-${e.key}`}>
                  <td>
                    {e.name} <span className="muted">{e.detail}</span>
                  </td>
                  <td className={eq?.broken ? 'ng-text' : ''}>{eq?.broken ? '停止中' : '稼働'}</td>
                  <td>{eq ? `${Math.round(eq.downSec / 60)}分` : ''}</td>
                  <td>
                    <button className="small" onClick={() => ops.setEquipmentBroken(e.key, !eq?.broken)}>
                      {eq?.broken ? '復旧' : '停止'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <table className="board clickable-rows">
          <thead>
            <tr>
              <th>止まっている作業</th>
              <th>理由</th>
              <th>停止</th>
            </tr>
          </thead>
          <tbody>
            {blocked.map((t) => (
              <tr key={t.id} onClick={() => ops.selectAircraft(t.aircraftId)}>
                <td>
                  {state.aircraft[t.aircraftId]!.callsign} {TASK_LABEL[t.kind]}
                </td>
                <td className="warn-text">{BLOCK_REASON_LABEL[t.blockedReason!]}</td>
                <td>{t.blockedSince !== null ? `${Math.round((state.now - t.blockedSince) / 60)}分` : ''}</td>
              </tr>
            ))}
            {blocked.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  なし
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 手荷物: 便ごとの処理状況と、手荷物の所在・履歴の検索 */
export function BaggageBoard() {
  const o = useOps();
  const [query, setQuery] = useState('');
  if (!o) return null;
  const { state } = o.sim;
  const gs = state.groundStats;
  const flights = Object.values(state.flights)
    .filter((f) => (state.flightBags[f.id] ?? []).length > 0)
    .filter((f) => f.status !== 'completed' || state.now - (f.actual ?? f.block ?? 0) < 30 * 60 || (f.direction === 'arrival' && bagCounts(state, f.id).collected !== (state.flightBags[f.id] ?? []).length))
    .slice(-40);
  const found = query ? state.bags[query.trim()] : undefined;
  return (
    <div className="issues" data-testid="baggage-board">
      <div className="issues-header">
        <strong>手荷物</strong>
        <span>処理中 {state.activeBags.length}個</span>
        <span>積載 {gs.bagsLoaded}</span>
        <span>受け取り {gs.bagsCollected}</span>
        <span className={gs.bagsLeftBehind ? 'ng-text' : ''}>積み残し {gs.bagsLeftBehind}</span>
        <span>取り下ろし {gs.bagsOffloaded}</span>
        <label className="sev-toggle">
          手荷物ID
          <input type="text" value={query} placeholder="bg_123" onChange={(e) => setQuery(e.target.value)} data-testid="bag-search" />
        </label>
      </div>
      <div className="issues-list">
        {found && (
          <div className="bag-history" data-testid="bag-history">
            <b>{found.id}</b>（{state.flights[found.flightId]!.number}・{found.direction === 'departure' ? '出発' : '到着'}）現在: {BAG_STATE_LABEL[found.state]} @ {found.location}
            {found.history.map((h, i) => (
              <div key={i}>
                <span className="time">{formatClock(h.t)}</span>
                {BAG_STATE_LABEL[h.state]} <span className="muted">{h.location}</span>
              </div>
            ))}
          </div>
        )}
        <table className="board clickable-rows">
          <thead>
            <tr>
              <th>便名</th>
              <th>区分</th>
              <th>個数</th>
              <th>状況</th>
            </tr>
          </thead>
          <tbody>
            {flights.map((f) => (
              <tr key={f.id} onClick={() => ops.selectAircraft(f.aircraftId)}>
                <td>{f.number}</td>
                <td>{f.direction === 'arrival' ? '到着' : '出発'}</td>
                <td>{(state.flightBags[f.id] ?? []).length}</td>
                <td>{fmtCounts(bagCounts(state, f.id))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
