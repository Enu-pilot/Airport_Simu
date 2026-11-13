import { Rng } from '../rng';
import { compareIds, sortedValues } from '../model/ids';
import { checkStand } from '../aircraft/compat';
import { noteDisruption } from '../analytics/records';
import { post } from '../economy/company';
import { resolveType } from './aircraftTypes';
import { setEquipmentBroken } from './baggage';
import { setUnitBroken } from './ground';
import { setAreaClosed } from './passengers';
import type { Simulation } from './simulation';
import { EVENT_LOG_LIMIT, type Disruption, type DisruptionKind, type SimState, type WeatherKind } from './types';

/**
 * 天候・障害・運航トラブル（docs/19_disruptions.md）。
 * ゲーム内の簡略化モデルであり、実際の航空管制・安全基準への適合を保証しない。
 *
 * - 障害は「予定 → 発生中 → 復旧」の状態を持ち、開始・終了時刻、対象、量、影響を受けた便・作業・ユニットを記録する。
 * - 閉鎖中の施設には、新しい機体・旅客・作業を割り当てない（スポット・滑走路・誘導路・ゲート・設備・ユニット）。
 *   閉鎖の時点で割り当てられていた到着機（まだ着陸していない）はスポット・滑走路の割り当てを解除し、別の施設に割り当て直す。
 * - 停止した地上作業は停止理由を記録し、ユニットが戻れば自動で再割り当てされる（ground.ts）。
 * - プレイヤーの対応: 修理（早期復旧、費用あり）、代替スポットへの変更、便の遅延・欠航、作業の優先、作業員の配置換え。
 */

/** 天候の影響（ゲーム値）: 離着陸間隔の倍率・地上走行速度の倍率 */
export const WEATHER_EFFECTS: Record<WeatherKind, { separation: number; taxi: number }> = {
  clear: { separation: 1, taxi: 1 },
  rain: { separation: 1.2, taxi: 0.9 },
  snow: { separation: 1.5, taxi: 0.7 },
  fog: { separation: 1.8, taxi: 0.8 },
};

/** プレイヤーが早期に復旧させる費用（cr、ゲーム値） */
export const REPAIR_COST: Record<DisruptionKind, number> = {
  weather: 0,
  runwayClosed: 400_000,
  taxiwayClosed: 80_000,
  standClosed: 50_000,
  gateFailure: 60_000,
  baggageFailure: 120_000,
  vehicleFailure: 40_000,
  staffAbsence: 90_000,
  demandSurge: 0,
  inboundDelay: 0,
  maintenance: 100_000,
};

/** 時間指定のない障害の既定の長さ（秒） */
export const DEFAULT_DURATION_SEC = 2 * 3600;

function log(state: SimState, note: string): void {
  state.events.push({ t: state.now, kind: 'disruption', note });
  if (state.events.length > EVENT_LOG_LIMIT) state.events.splice(0, state.events.length - EVENT_LOG_LIMIT);
}

function nextId(state: SimState): string {
  const n = (state.counters.dr ?? 0) + 1;
  state.counters.dr = n;
  return `dr_${n}`;
}

const addSorted = (list: string[], id: string) => (list.includes(id) ? list : [...list, id].sort(compareIds));
const remove = (list: string[], id: string) => list.filter((x) => x !== id);

export function weatherEffects(state: SimState): { separation: number; taxi: number } {
  return WEATHER_EFFECTS[state.weather.kind];
}

export type DisruptionInput = Pick<Disruption, 'kind' | 'targetId'> &
  Partial<Pick<Disruption, 'weather' | 'amount' | 'start' | 'end' | 'origin'>>;

/** 障害を登録する（開始時刻が今以前ならすぐ発生する） */
export function addDisruption(sim: Simulation, input: DisruptionInput): Disruption {
  const { state } = sim;
  const start = input.start ?? state.now;
  const d: Disruption = {
    id: nextId(state),
    kind: input.kind,
    targetId: input.targetId,
    ...(input.weather ? { weather: input.weather } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    start,
    end: input.end === undefined ? start + DEFAULT_DURATION_SEC : input.end,
    status: 'scheduled',
    resolvedAt: null,
    resolvedBy: null,
    affected: { tasks: [], flights: [], units: [] },
    origin: input.origin ?? 'manual',
  };
  state.disruptions.push(d);
  if (state.now >= start) activate(sim, d);
  return d;
}

/** 毎ティック: 予定の障害の発生・期限の来た障害の復旧・ランダムな発生 */
export function stepDisruptions(sim: Simulation): void {
  const { state } = sim;
  for (const d of state.disruptions) {
    if (d.status === 'scheduled' && state.now >= d.start) activate(sim, d);
    else if (d.status === 'active' && d.end !== null && state.now >= d.end) deactivate(sim, d, 'time');
  }
  if (state.settings.randomDisruptions && state.now % 3600 === 0) randomDisruptions(sim);
}

/** プレイヤーが修理・解除する（費用を会社に計上）。天候・需要・遅延は解除できない */
export function resolveDisruption(sim: Simulation, id: string): boolean {
  const d = sim.state.disruptions.find((x) => x.id === id);
  if (!d || d.status === 'resolved') return false;
  if (d.kind === 'weather' || d.kind === 'demandSurge' || d.kind === 'inboundDelay') return false;
  if (d.status === 'active') {
    if (sim.company) post(sim.company, 'disruption', -REPAIR_COST[d.kind]);
    deactivate(sim, d, 'player');
  } else {
    d.status = 'resolved';
    d.resolvedAt = sim.state.now;
    d.resolvedBy = 'player';
  }
  return true;
}

/** 発生中の障害で、対象の施設が閉鎖・停止しているもの */
export const activeDisruptions = (state: SimState): Disruption[] => state.disruptions.filter((d) => d.status === 'active');

/** 旅客需要の倍率（発生中の需要急増の積） */
export function demandFactorAt(state: SimState): number {
  return activeDisruptions(state)
    .filter((d) => d.kind === 'demandSurge')
    .reduce((f, d) => f * (d.amount ?? 1.3), 1);
}

// ---------------------------------------------------------------- 発生と復旧

type Target = 'runway' | 'taxiway' | 'stand' | 'gate' | 'area' | 'equipment' | 'unit' | null;

function targetKind(sim: Simulation, id: string | null): Target {
  if (!id) return null;
  const l = sim.ctx.layout;
  if (l.runways[id]) return 'runway';
  if (l.taxiways[id]) return 'taxiway';
  if (l.stands[id]) return 'stand';
  if (l.facilities[id]?.kind === 'gate') return 'gate';
  if (l.terminalAreas[id]) return 'area';
  if (sim.state.units[id]) return 'unit';
  if (sim.ctx.sorters.some((s) => s.id === id) || id.startsWith('belt:')) return 'equipment';
  return null;
}

function activate(sim: Simulation, d: Disruption): void {
  const { state } = sim;
  d.status = 'active';
  const t = targetKind(sim, d.targetId);
  const id = d.targetId!;
  const kind = d.kind === 'maintenance' ? t : null;
  switch (d.kind) {
    case 'weather':
      state.weather = { kind: d.weather ?? 'rain', since: state.now };
      break;
    case 'runwayClosed':
      closeRunway(sim, d, id);
      break;
    case 'taxiwayClosed':
      state.closures.taxiways = addSorted(state.closures.taxiways, id);
      break;
    case 'standClosed':
      closeStand(sim, d, id);
      break;
    case 'gateFailure':
      state.closures.gates = addSorted(state.closures.gates, id);
      break;
    case 'baggageFailure':
      setEquipmentBroken(sim, id, true, d.end !== null ? d.end - state.now : 10 * 86400);
      break;
    case 'vehicleFailure': {
      const u = state.units[id];
      if (u?.taskId) d.affected.tasks.push(u.taskId);
      setUnitBroken(sim, id, true, d.end !== null ? d.end - state.now : 10 * 86400);
      d.affected.units.push(id);
      break;
    }
    case 'staffAbsence': {
      // 欠勤: 作業員を n 人使えなくする（作業していない人から、ID 順）
      const staff = sortedValues(state.units).filter((u) => u.kind === 'staff' && u.status !== 'broken');
      staff.sort((a, b) => Number(!!a.taskId) - Number(!!b.taskId) || compareIds(a.id, b.id));
      for (const u of staff.slice(0, Math.max(0, Math.round(d.amount ?? 2)))) {
        if (u.taskId) d.affected.tasks.push(u.taskId);
        setUnitBroken(sim, u.id, true, d.end !== null ? d.end - state.now : 10 * 86400);
        d.affected.units.push(u.id);
      }
      break;
    }
    case 'demandSurge':
      break;
    case 'inboundDelay': {
      const until = d.end ?? d.start + 3 * 3600;
      for (const f of sortedValues(state.flights)) {
        if (f.direction !== 'arrival' || f.status !== 'scheduled' || f.scheduled < d.start || f.scheduled > until) continue;
        f.estimated += Math.round((d.amount ?? 30) * 60);
        if (!f.delayCauses.includes('inboundLate')) f.delayCauses.push('inboundLate');
        d.affected.flights.push(f.id);
        noteDisruption(sim, f.aircraftId, d.id);
      }
      break;
    }
    case 'maintenance':
      if (kind === 'runway') closeRunway(sim, d, id);
      else if (kind === 'taxiway') state.closures.taxiways = addSorted(state.closures.taxiways, id);
      else if (kind === 'stand') closeStand(sim, d, id);
      else if (kind === 'gate') state.closures.gates = addSorted(state.closures.gates, id);
      else if (kind === 'area') setAreaClosed(sim, id, true);
      break;
  }
  log(state, `障害の発生: ${d.kind}${d.targetId ? ` ${d.targetId}` : ''}${d.weather ? ` ${d.weather}` : ''}`);
}

function deactivate(sim: Simulation, d: Disruption, by: 'time' | 'player'): void {
  const { state } = sim;
  d.status = 'resolved';
  d.resolvedAt = state.now;
  d.resolvedBy = by;
  const id = d.targetId!;
  const t = d.kind === 'maintenance' ? targetKind(sim, id) : null;
  switch (d.kind) {
    case 'weather': {
      // 他に発生中の天候があればそれ、なければ晴れ
      const other = activeDisruptions(state).filter((x) => x.kind === 'weather');
      state.weather = { kind: other.length ? (other[other.length - 1]!.weather ?? 'rain') : 'clear', since: state.now };
      break;
    }
    case 'runwayClosed':
      reopenRunway(sim, d, id);
      break;
    case 'taxiwayClosed':
      state.closures.taxiways = remove(state.closures.taxiways, id);
      break;
    case 'standClosed':
      state.closures.stands = remove(state.closures.stands, id);
      break;
    case 'gateFailure':
      state.closures.gates = remove(state.closures.gates, id);
      break;
    case 'baggageFailure':
      setEquipmentBroken(sim, id, false);
      break;
    case 'vehicleFailure':
    case 'staffAbsence':
      for (const u of d.affected.units) if (state.units[u]?.status === 'broken') setUnitBroken(sim, u, false);
      break;
    case 'maintenance':
      if (t === 'runway') reopenRunway(sim, d, id);
      else if (t === 'taxiway') state.closures.taxiways = remove(state.closures.taxiways, id);
      else if (t === 'stand') state.closures.stands = remove(state.closures.stands, id);
      else if (t === 'gate') state.closures.gates = remove(state.closures.gates, id);
      else if (t === 'area') setAreaClosed(sim, id, false);
      break;
    default:
      break;
  }
  log(state, `障害の復旧（${by === 'player' ? '修理' : '時間経過'}）: ${d.kind}${d.targetId ? ` ${d.targetId}` : ''}`);
}

/** 着陸前の到着機のスポット・滑走路の割り当てを外す（再割り当てさせる） */
function releaseInbound(sim: Simulation, d: Disruption, pred: (acId: string, standId: string | null, runwayId: string | null) => boolean): void {
  const { state } = sim;
  for (const ac of sortedValues(state.aircraft)) {
    if (ac.state !== 'inbound' && ac.state !== 'holding') continue;
    if (!pred(ac.id, ac.standId, ac.runwayId)) continue;
    if (ac.standId && state.standAssignments[ac.standId] === ac.id) delete state.standAssignments[ac.standId];
    ac.standId = null;
    ac.runwayId = null;
    ac.retryAt = state.now;
    for (const f of [state.flights[ac.arrivalFlightId]!, state.flights[ac.departureFlightId]!]) {
      f.standId = null;
      f.runwayId = null;
    }
    d.affected.flights.push(ac.arrivalFlightId);
    noteDisruption(sim, ac.id, d.id);
  }
}

function closeRunway(sim: Simulation, d: Disruption, runwayId: string): void {
  const cfg = sim.state.runwayConfig[runwayId];
  if (!cfg) return;
  d.prev = cfg.mode;
  cfg.mode = 'closed';
  releaseInbound(sim, d, (_a, _s, r) => r === runwayId);
}

function reopenRunway(sim: Simulation, d: Disruption, runwayId: string): void {
  const cfg = sim.state.runwayConfig[runwayId];
  // 同じ滑走路に発生中の閉鎖が他にあれば閉鎖のまま
  const still = activeDisruptions(sim.state).some((x) => x.id !== d.id && x.targetId === runwayId && (x.kind === 'runwayClosed' || x.kind === 'maintenance'));
  if (cfg && !still) cfg.mode = (d.prev as typeof cfg.mode | undefined) ?? 'mixed';
}

function closeStand(sim: Simulation, d: Disruption, standId: string): void {
  sim.state.closures.stands = addSorted(sim.state.closures.stands, standId);
  releaseInbound(sim, d, (_a, s) => s === standId);
}

// ---------------------------------------------------------------- プレイヤーの対応

export type ResponseResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'TOO_LATE' | 'INCOMPATIBLE' | 'OCCUPIED' | 'CLOSED' };

/** 代替スポットへの変更（着陸前の到着機のみ）。適合しない・使用中・閉鎖中のスポットには変えない */
export function reassignStand(sim: Simulation, acId: string, standId: string): ResponseResult {
  const { state, ctx } = sim;
  const ac = state.aircraft[acId];
  const stand = ctx.layout.stands[standId];
  if (!ac || !stand) return { ok: false, reason: 'NOT_FOUND' };
  if (ac.state !== 'scheduled' && ac.state !== 'inbound' && ac.state !== 'holding') return { ok: false, reason: 'TOO_LATE' };
  if (checkStand(resolveType(ctx.types, ac.typeId), stand, ctx.network).status !== 'ok') return { ok: false, reason: 'INCOMPATIBLE' };
  if (state.closures.stands.includes(standId)) return { ok: false, reason: 'CLOSED' };
  const holder = state.standAssignments[standId];
  if (holder && holder !== acId) return { ok: false, reason: 'OCCUPIED' };
  if (ac.standId && state.standAssignments[ac.standId] === acId) delete state.standAssignments[ac.standId];
  // 計画スポットを変更して、次の割り当てで使わせる（経路・滑走路は割り当て時に決める）
  ac.standId = null;
  ac.runwayId = null;
  ac.retryAt = state.now;
  for (const f of [state.flights[ac.arrivalFlightId]!, state.flights[ac.departureFlightId]!]) {
    f.plannedStandId = standId;
    f.standId = null;
  }
  log(state, `代替スポットに変更: ${ac.callsign} → ${standId}`);
  return { ok: true };
}

/** 便の遅延（予定を後ろへずらす）。出発便は準備完了の判定にも使う予定時刻を変える */
export function delayFlight(sim: Simulation, flightId: string, minutes: number): ResponseResult {
  const f = sim.state.flights[flightId];
  if (!f) return { ok: false, reason: 'NOT_FOUND' };
  if (f.status === 'completed' || f.status === 'cancelled' || f.status === 'diverted' || f.block !== null) return { ok: false, reason: 'TOO_LATE' };
  f.estimated += Math.round(minutes * 60);
  log(sim.state, `便を遅らせる: ${f.number} +${minutes}分`);
  return { ok: true };
}

/** 地上作業の優先（便の順序変更）: この機体の作業を先に割り当てる */
export function prioritize(sim: Simulation, acId: string, on: boolean): ResponseResult {
  const ac = sim.state.aircraft[acId];
  if (!ac) return { ok: false, reason: 'NOT_FOUND' };
  sim.state.flights[ac.departureFlightId]!.priority = on;
  return { ok: true };
}

/** 作業員・車両の配置換え（待機中のユニットを別の基地に所属させる） */
export function moveUnitToBase(sim: Simulation, unitId: string, baseId: string): ResponseResult {
  const u = sim.state.units[unitId];
  const base = sim.ctx.bases.find((b) => b.id === baseId);
  if (!u || !base) return { ok: false, reason: 'NOT_FOUND' };
  if (u.taskId || u.trip || u.status === 'broken') return { ok: false, reason: 'OCCUPIED' };
  u.baseId = baseId;
  u.fromX = u.x;
  u.fromY = u.y;
  u.toX = base.x;
  u.toY = base.y;
  u.moveStart = sim.state.now;
  u.moveEnd = sim.state.now + 300;
  u.status = 'returning';
  return { ok: true };
}

// ---------------------------------------------------------------- ランダムな発生

/** 1時間ごとの発生確率（ゲーム値） */
export const RANDOM_PROB_PER_HOUR: Partial<Record<DisruptionKind, number>> = {
  weather: 0.04,
  runwayClosed: 0.005,
  taxiwayClosed: 0.01,
  standClosed: 0.01,
  gateFailure: 0.01,
  staffAbsence: 0.01,
  demandSurge: 0.01,
  inboundDelay: 0.02,
};

function randomDisruptions(sim: Simulation): void {
  const { state, ctx } = sim;
  const picks: DisruptionInput[] = [];
  const rng = new Rng(state.rng);
  const pick = <T>(list: T[]): T | undefined => (list.length ? list[rng.int(0, list.length - 1)] : undefined);
  for (const [kind, p] of Object.entries(RANDOM_PROB_PER_HOUR) as [DisruptionKind, number][]) {
    if (rng.next() >= p) continue;
    const dur = rng.int(30, 120) * 60;
    const end = state.now + dur;
    if (kind === 'weather') picks.push({ kind, targetId: null, weather: pick<WeatherKind>(['rain', 'snow', 'fog'])!, end });
    else if (kind === 'runwayClosed') {
      const r = pick(Object.keys(ctx.runways).sort(compareIds));
      if (r) picks.push({ kind, targetId: r, end });
    } else if (kind === 'taxiwayClosed') {
      const t = pick(Object.keys(ctx.layout.taxiways).sort(compareIds));
      if (t) picks.push({ kind, targetId: t, end });
    } else if (kind === 'standClosed') {
      const s = pick(Object.keys(ctx.layout.stands).sort(compareIds));
      if (s) picks.push({ kind, targetId: s, end });
    } else if (kind === 'gateFailure') {
      const g = pick(Object.values(ctx.standGate).sort(compareIds));
      if (g) picks.push({ kind, targetId: g, end });
    } else if (kind === 'staffAbsence') picks.push({ kind, targetId: null, amount: rng.int(1, 4), end: state.now + 4 * 3600 });
    else if (kind === 'demandSurge') picks.push({ kind, targetId: null, amount: 1.2 + rng.next() * 0.3, end: state.now + 3 * 3600 });
    else if (kind === 'inboundDelay') picks.push({ kind, targetId: null, amount: rng.int(15, 60), end: state.now + 2 * 3600 });
  }
  state.rng = rng.state();
  for (const p of picks) addDisruption(sim, { ...p, origin: 'random' });
}

