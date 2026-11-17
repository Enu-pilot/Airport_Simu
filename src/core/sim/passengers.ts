import { Rng, seedFromString } from '../rng';
import { compareIds } from '../model/ids';
import { terminalLinkCapacityPerHour, WALK_SPEED_MPS, type AreaNode } from '../terminal/model';
import { findPaxRoute, linkBetween } from '../terminal/route';
import { serviceSecPerPax } from '../terminal/capacity';
import { resolveType } from './aircraftTypes';
import { demandFactorAt } from './disruptions';
import { arrivalBags, checkInBags, collectBags, groupBagsOnBelt, reconcileDepartureBags, transferArrivalBags } from './baggage';
import { boardingAllowed } from './ground';
import { applyBusArrival, applyBusDeparture, pickBusGate, stepBusBoarding } from './apronBus';
import { BUS_EXTRA_LEAD_MIN, BUS_GATE_SEC_PER_PAX, BUS_MIN_WINDOW_SEC } from './busRules';
import { gateMode } from '../model/gates';
import { BALANCE } from '../economy/balance';
import { onPaxDeplaned, onPaxMissed, onShopDone, onTransferMissed } from '../economy/ops';
import { accessArrival, accessDeparture } from '../access/runtime';
import type { Simulation } from './simulation';
import {
  EVENT_LOG_LIMIT,
  PAX_FINAL_STATES,
  type FacilityRuntime,
  type Flight,
  type FlightPax,
  type MissReason,
  type PaxGroup,
  type PaxStep,
  type SimState,
} from './types';

/**
 * ターミナル内の旅客流動（docs/12_passenger_rules.md）。
 *
 * 旅客は 1〜5 人のグループ単位で計算する（業務計算）。描画はグループを代表点として表示するだけで、
 * 状態には影響しない。施設は窓口数（サーバー数）と1人あたりの処理時間を持つ待ち行列で、
 * 同時に処理できるのは窓口数のグループまで。
 */

// ---------------------------------------------------------------- 定数（ゲーム用の仮の値）

/** 出発便の旅客を生成する時刻（出発予定の何秒前か） */
export const PAX_GENERATE_LEAD_SEC = 3 * 3600;
/** 空港到着時刻の分布（出発予定の何分前か）: 三角分布 [最早, 最頻, 最遅] */
export const PAX_ARRIVAL_MIN = { earliest: 150, mode: 90, latest: 45 };
/** フェーズ 4 §4.4: 国際の出発旅客は早く来て長く滞在する */
export const PAX_ARRIVAL_MIN_INTL = { earliest: 240, mode: 150, latest: 75 };
export const LOAD_FACTOR = { min: 0.65, max: 0.9 };
export const MAX_GROUP_SIZE = 5;
const STEP_FREE_GROUP_RATE = 0.05;
/** 1人あたり手荷物を預ける確率 */
export const BAG_PROB = 0.5;
/** 手荷物のない旅客がチェックインカウンターに寄る確率（残りはオンラインチェックイン） */
export const COUNTER_WITHOUT_BAGS_PROB = 0.3;
export const RESTROOM_PROB = 0.3;
export const RESTROOM_SEC = 180;
/** 搭乗開始（出発予定の何分前か）と搭乗締切 */
export const BOARDING_LEAD_MIN = { S: 20, M: 30, L: 40 } as const;
export const DEADLINE_BEFORE_SEC = 10 * 60;
/** 搭乗開始から締切までの最低時間（機体の到着が遅れた場合に締切を後ろへずらす） */
export const MIN_BOARDING_WINDOW_SEC = 15 * 60;
/** 1人あたりの搭乗時間（ボーディングブリッジあり / なし） */
export const BOARD_SEC_PER_PAX = { bridge: 3, stairs: 5 };
/** 降機速度（人/分） */
export const DEPLANE_PAX_PER_MIN = { bridge: 20, stairs: 12 };
/** 手荷物の受け取り時間 */
export const PICKUP_SEC = 90;
export const PAX_RETRY_SEC = 30;

export function emptyFlightPax(): FlightPax {
  return {
    booked: 0,
    generated: false,
    boarded: 0,
    missed: 0,
    boarding: 'notStarted',
    boardingOpenedAt: null,
    deadline: null,
    gateId: null,
    deplaned: 0,
    exited: 0,
    deplaneRemaining: 0,
    deplaneAcc: 0,
    claimAreaId: null,
    bagsReadyAt: null,
  };
}

// ---------------------------------------------------------------- 補助

function withRng<T>(state: SimState, fn: (rng: Rng) => T): T {
  const rng = new Rng(state.rng);
  const v = fn(rng);
  state.rng = rng.state();
  return v;
}

function nextId(state: SimState, prefix: string): string {
  const n = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = n;
  return `${prefix}_${n}`;
}

function needsStepFreeRoute(seed: string, groupId: string): boolean {
  // Use a separate per-group stream so this feature does not shift operational RNG results.
  return new Rng(`${seed}:step-free:${groupId}`).next() < STEP_FREE_GROUP_RATE;
}

function log(state: SimState, e: SimState['events'][number]): void {
  state.events.push(e);
  if (state.events.length > EVENT_LOG_LIMIT) state.events.splice(0, state.events.length - EVENT_LOG_LIMIT);
}

function facility(state: SimState, key: string): FacilityRuntime {
  return (state.facilities[key] ??= { queue: [], inService: [], served: 0, waitTotal: 0, maxQueue: 0 });
}

const isClosed = (state: SimState, areaId: string) => state.closedAreas.includes(areaId);

/** 施設の窓口数（閉鎖中は 0） */
export function serversOf(sim: Simulation, key: string): number {
  // 故障・閉鎖中のゲートでは搭乗の処理をしない（sim/disruptions.ts）
  if (key.startsWith('gate:')) return sim.state.closures.gates.includes(key.slice('gate:'.length)) ? 0 : 1;
  const a = sim.ctx.layout.terminalAreas[key];
  if (!a || isClosed(sim.state, key)) return 0;
  return Math.max(0, Number(a.props.counters ?? a.props.booths ?? a.props.lanes ?? a.props.fixtures ?? a.props.capacity ?? 0));
}

function perPaxSec(sim: Simulation, key: string): number {
  const a = sim.ctx.layout.terminalAreas[key];
  if (!a) return 0;
  if (a.kind === 'restroom') return RESTROOM_SEC / 2;
  if (a.kind === 'shop') return BALANCE.retail.shopSec / 3;
  if (a.kind === 'restaurant') return BALANCE.retail.restaurantSec / 3;
  return serviceSecPerPax(a.kind, a.props);
}

/** 待ち行列の見込み待ち時間（秒） */
function expectedWait(sim: Simulation, key: string): number {
  const servers = serversOf(sim, key);
  if (servers <= 0) return Infinity;
  const f = sim.state.facilities[key];
  const queued = (f?.queue ?? []).reduce((s, id) => s + (sim.state.paxGroups[id]?.count ?? 0), 0);
  return (queued * perPaxSec(sim, key)) / servers;
}

const STEP_KIND: Partial<Record<PaxStep, AreaNode['kind']>> = {
  checkIn: 'checkIn',
  security: 'security',
  restroom: 'restroom',
  claim: 'baggageClaim',
  exit: 'exit',
  emigration: 'emigration',
  immigration: 'immigration',
  customs: 'customs',
  transferSecurity: 'transferSecurity',
};

function boardingLeadSec(sim: Simulation, f: Flight): number {
  const ac = sim.state.aircraft[f.aircraftId]!;
  // バス扱いの便は、バスの移動・乗降の分だけ早く搭乗を始める。国際は搭乗開始が 15 分早い（フェーズ 4 §4.4）
  return BOARDING_LEAD_MIN[resolveType(sim.ctx.types, ac.typeId).size] * 60 + (f.pax.bus ? BUS_EXTRA_LEAD_MIN * 60 : 0) + (f.routeType === 'international' ? 15 * 60 : 0);
}

function hasBridge(sim: Simulation, gateId: string | null): boolean {
  const g = gateId ? sim.ctx.layout.facilities[gateId] : undefined;
  // バスゲートはボーディングブリッジを使わない（jetBridge は無視）
  return !!g && !!g.props.jetBridge && gateMode(g) !== 'bus';
}

// ---------------------------------------------------------------- 1ティック

export function stepPassengers(sim: Simulation): void {
  const { state } = sim;
  // 便・グループは ID の発行順に挿入されるため、Object の列挙順がそのまま決定的な処理順になる
  for (const f of Object.values(state.flights)) {
    if (f.pax.boarding === 'closed' && f.direction === 'departure') continue;
    if (f.direction === 'arrival' && f.pax.generated && f.pax.deplaneRemaining <= 0) continue;
    if (f.direction === 'departure') stepDepartureFlight(sim, f);
    else stepArrivalFlight(sim, f);
  }
  const occupancy = areaOccupancy(state);
  for (const id of state.activePax) stepGroup(sim, state.paxGroups[id]!, occupancy);
  // 終了したグループを処理対象から外す
  state.activePax = state.activePax.filter((id) => !PAX_FINAL_STATES.includes(state.paxGroups[id]!.state));
  for (const key of Object.keys(state.facilities).sort()) stepFacility(sim, key);
}

/** エリアごとの滞在人数（歩行中は出発側のエリアに数える） */
export function areaOccupancy(state: SimState): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of state.activePax) {
    const g = state.paxGroups[id]!;
    if (g.area && !PAX_FINAL_STATES.includes(g.state)) m.set(g.area, (m.get(g.area) ?? 0) + g.count);
  }
  return m;
}

// ---------------------------------------------------------------- 出発便

function stepDepartureFlight(sim: Simulation, f: Flight): void {
  const { state, ctx } = sim;
  const p = f.pax;
  const ac = state.aircraft[f.aircraftId]!;

  if (f.status === 'cancelled') {
    if (p.boarding !== 'closed') closeBoarding(sim, f, 'cancelled');
    return;
  }
  const prospectiveStandId = ac.standId ?? f.plannedStandId;
  const prospectiveStandInfo = prospectiveStandId ? ctx.stands[prospectiveStandId] : undefined;
  const explicitRemoteConfiguration = !!prospectiveStandInfo && !prospectiveStandInfo.contact && ctx.layout.stands[prospectiveStandId!]?.remoteBoarding !== undefined;
  const configuredRemoteStandExists = Object.values(ctx.layout.stands).some((stand) => stand.remoteBoarding !== undefined);
  const requiresTerminalAssignment = Object.keys(ctx.terminal.byTerminal).length > 1 || explicitRemoteConfiguration || (!ac.standId && configuredRemoteStandExists);
  // A planned stand gives us a stable terminal/gate early enough to start passenger
  // processing on time. Invalid explicit remote mappings deliberately remain unset.
  if (!ac.standId && prospectiveStandInfo && requiresTerminalAssignment && !p.gateId) {
    const layoutStand = ctx.layout.stands[prospectiveStandInfo.id];
    const plannedGateId = prospectiveStandInfo.contact
      ? ctx.standGate[prospectiveStandInfo.id] ?? null
      : pickBusGate(sim, f, 'boarding', prospectiveStandInfo.id);
    const gate = plannedGateId ? ctx.terminal.gates[plannedGateId] : undefined;
    const validPlannedGate = !!gate?.terminalId && !!gate.boarding && !state.closures.gates.includes(plannedGateId!);
    const explicitBusGateValid = layoutStand?.remoteBoarding !== 'bus' || (validPlannedGate && ctx.busGates.includes(plannedGateId!));
    if (validPlannedGate && explicitBusGateValid) p.gateId = plannedGateId;
  }
  const hasStableTerminal = !!p.gateId && !!ctx.terminal.gates[p.gateId]?.terminalId;
  // Keep the legacy single-terminal order when no planned gate is available.
  if ((!requiresTerminalAssignment || hasStableTerminal) && !p.generated && state.now >= f.scheduled - PAX_GENERATE_LEAD_SEC) generateDeparturePax(sim, f);
  // 搭乗ゲートは機体のスポットで決まる
  if (ac.standId && p.boarding !== 'closed') {
    const previousGateId = p.gateId;
    p.gateId = ctx.standGate[ac.standId] ?? null;
    // バスゲートがある運航: ゲートのないスポットの便はバスゲートで搭乗し、ランプバスで運ぶ（sim/apronBus.ts）
    if (state.bus || explicitRemoteConfiguration) applyBusDeparture(sim, f, ac);
    // 付け直すのは「別のゲートへ変わった」ときだけ。最初の割当（null → ゲート）では付け直さない: 通常の運航の旅客の動きを
    // 従来と同じに保つため。バスゲートの一時閉鎖は、生成後のゲート固定（apronBus）と stranded の復帰で扱う（1-07 / P-1）
    if (p.generated && previousGateId && p.gateId && previousGateId !== p.gateId) reconcileDepartureGate(sim, f, p.gateId);
  }
  // 複数ターミナルでは、ゲート所属先が確定してから旅客を作る。
  // 単一ターミナル空港では従来どおり、便の生成時刻に旅客を作る。
  if (requiresTerminalAssignment && !p.generated && ac.standId && state.now >= f.scheduled - PAX_GENERATE_LEAD_SEC) {
    generateDeparturePax(sim, f);
  }

  if (p.boarding === 'notStarted') {
    const atStand = ac.state === 'turnaround' || ac.state === 'readyForPushback';
    // 降機・清掃・ケータリング・給油・点検が終わるまで搭乗を始めない
    if (atStand && boardingAllowed(state, ac.id) && state.now >= f.estimated - boardingLeadSec(sim, f)) {
      p.boarding = 'open';
      p.boardingOpenedAt = state.now;
      log(state, { t: state.now, kind: 'boardingOpen', aircraftId: ac.id, note: f.number });
    }
  }
  if (p.boarding === 'open') {
    p.deadline = Math.max(f.estimated - DEADLINE_BEFORE_SEC, p.boardingOpenedAt! + (p.bus ? BUS_MIN_WINDOW_SEC : MIN_BOARDING_WINDOW_SEC));
    if (p.bus) {
      stepBusBoarding(sim, f, closeBoarding);
      return;
    }
    const groups = groupsOf(state, f.id);
    // 搭乗処理中は締め切らない（ただし故障中のゲートは処理が進まないので締め切る）
    const gateClosed = !!p.gateId && state.closures.gates.includes(p.gateId);
    const gateBusy =
      p.gateId && !gateClosed ? (state.facilities[`gate:${p.gateId}`]?.queue.length ?? 0) + (state.facilities[`gate:${p.gateId}`]?.inService.length ?? 0) > 0 : false;
    const allResolved = p.generated && groups.every((g) => PAX_FINAL_STATES.includes(g.state));
    if ((state.now >= p.deadline && !gateBusy) || allResolved) closeBoarding(sim, f, null);
  }
}

function registerGroup(state: SimState, g: PaxGroup): void {
  state.paxGroups[g.id] = g;
  state.activePax.push(g.id);
  (state.flightPax[g.flightId] ??= []).push(g.id);
}

function groupsOf(state: SimState, flightId: string): PaxGroup[] {
  return (state.flightPax[flightId] ?? []).map((id) => state.paxGroups[id]!);
}

export { groupsOf as groupsOfFlight };

/**
 * 条件に合う未完了のグループを乗り遅れ（または欠航）にして、乗り遅れ人数を返す。補償は onPaxMissed。
 * forced が null のときの理由は従来どおり（ゲートなし・到達不能・施設閉鎖・間に合わず）
 */
/** ハブの集計（フェーズ 4 §5.4）。記録があるときだけ作る */
export function hubStatsOf(state: SimState): NonNullable<SimState['hubStats']> {
  return (state.hubStats ??= { spawned: 0, connected: 0, missed: 0, noShow: 0, byLink: {} });
}

export function missGroups(sim: Simulation, f: Flight, forced: MissReason | null, pred: (g: PaxGroup) => boolean = () => true): number {
  const { state } = sim;
  const p = f.pax;
  let missed = 0;
  let transferMissed = 0;
  for (const g of groupsOf(state, f.id)) {
    if (PAX_FINAL_STATES.includes(g.state) || !pred(g)) continue;
    const reason: MissReason =
      forced ?? (!p.gateId ? 'noGate' : g.state === 'stranded' ? 'unreachable' : g.state === 'waitingFacility' ? 'facilityClosed' : 'late');
    leaveFacility(state, g);
    g.state = reason === 'cancelled' ? 'cancelled' : 'missed';
    g.reason = reason;
    g.finishedAt = state.now;
    g.area = null;
    g.route = [];
    delete g.busTrip;
    if (reason !== 'cancelled') {
      p.missed += g.count;
      state.paxStats.missed += g.count;
      missed += g.count;
      if (g.transfer) transferMissed += g.count;
    }
  }
  // 乗継の失敗は補償が別（600/人）。乗り遅れ率には p.missed として含まれる
  if (missed - transferMissed > 0) onPaxMissed(sim, f, missed - transferMissed);
  if (transferMissed > 0) {
    onTransferMissed(sim, transferMissed);
    hubStatsOf(state).missed += transferMissed;
  }
  return missed;
}

/** 搭乗締切: 搭乗していない旅客は乗り遅れとして記録する */
function closeBoarding(sim: Simulation, f: Flight, forced: MissReason | null): void {
  const { state } = sim;
  const p = f.pax;
  // 乗継のノーショー（フェーズ 4 §5.4）: 到着便の欠航などで、計画された乗継客が現れなかった分
  if (f.plannedTransferIn !== undefined) {
    const noShow = Math.max(0, f.plannedTransferIn - (p.transferIn ?? 0) - (p.transferNoShow ?? 0));
    if (noShow > 0) {
      p.transferNoShow = (p.transferNoShow ?? 0) + noShow;
      hubStatsOf(state).noShow += noShow;
    }
  }
  const missed = missGroups(sim, f, forced);
  // 欠航便の預け手荷物は、地上作業が走らないので締め処理で終端状態（leftBehind / offloaded）にする（1-09 / B-1）
  if (forced === 'cancelled') reconcileDepartureBags(sim, f.id, true);
  p.boarding = 'closed';
  log(state, { t: state.now, kind: 'boardingClosed', aircraftId: f.aircraftId, note: `${f.number} 搭乗 ${p.boarded} / 乗り遅れ ${p.missed}` });
  if (missed > 0) log(state, { t: state.now, kind: 'paxMissed', aircraftId: f.aircraftId, note: `${f.number} ${missed}人` });
}

function generateDeparturePax(sim: Simulation, f: Flight): void {
  const { state, ctx } = sim;
  const p = f.pax;
  p.generated = true;
  const aircraft = state.aircraft[f.aircraftId];
  const stand = aircraft?.standId ? ctx.stands[aircraft.standId] : undefined;
  const remote = !!stand && !stand.contact;
  const terminalCount = Object.keys(ctx.terminal.byTerminal).length;
  if (remote && !p.gateId && (ctx.layout.stands[stand.id]?.remoteBoarding !== undefined || !!state.bus)) {
    p.generated = false;
    p.booked = 0;
    const firstFailure = !p.busFailure;
    p.busFailure ??= ctx.layout.stands[stand.id]?.remoteBoarding === 'none' ? 'disabled' : 'unconfigured';
    if (firstFailure) {
      const reason = ctx.layout.stands[stand.id]?.remoteBoarding === 'none' ? '無効' : '未設定または利用不可';
      log(state, { t: state.now, kind: 'disruption', aircraftId: f.aircraftId, note: `リモートスポット ${stand.id} のバスゲートが${reason}のため出発旅客を生成しません` });
    }
    return;
  }
  const terminal = (p.gateId ? ctx.terminal.gates[p.gateId]?.terminalId : null) ?? (terminalCount === 1 ? ctx.paxTerminal : null);
  if (terminalCount === 0) return; // ターミナルのない空港では従来どおり旅客なし
  const seats = f.seats ?? resolveType(sim.ctx.types, state.aircraft[f.aircraftId]!.typeId).seats;
  // 需要の急増（障害）で予約が増える。座席数が上限
  const surge = demandFactorAt(state);
  withRng(state, (rng) => {
    let remaining = f.plannedPax ?? Math.round(seats * (LOAD_FACTOR.min + rng.next() * (LOAD_FACTOR.max - LOAD_FACTOR.min)));
    if (surge !== 1) remaining = Math.min(seats, Math.round(remaining * surge));
    // 既に降機して生成済みの乗継グループは、この代入で消えないよう足して戻す（生成後に来た分は生成時に加算済み）
    p.booked = remaining + (p.transferIn ?? 0);
    while (remaining > 0) {
      const count = Math.min(remaining, rng.int(1, MAX_GROUP_SIZE));
      remaining -= count;
      const table = f.routeType === 'international' ? PAX_ARRIVAL_MIN_INTL : PAX_ARRIVAL_MIN;
      const minutesBefore = triangular(rng.next(), table.latest, table.mode, table.earliest);
      addGroup(sim, rng, f, count, Math.round(f.scheduled - minutesBefore * 60), terminal);
    }
  });
}

/** Reassigns passengers after an operational gate change, preserving their current location. */
function reconcileDepartureGate(sim: Simulation, f: Flight, gateId: string | null): void {
  const terminalCount = Object.keys(sim.ctx.terminal.byTerminal).length;
  const terminalId = (gateId ? sim.ctx.terminal.gates[gateId]?.terminalId : null) ?? (terminalCount === 1 ? sim.ctx.paxTerminal : null);
  for (const g of groupsOf(sim.state, f.id)) {
    if (PAX_FINAL_STATES.includes(g.state)) continue;
    if (g.state === 'toAirport' && g.area === null) {
      g.terminalId = terminalId;
      delete g.targetTerminalId;
      continue;
    }
    g.targetTerminalId = terminalId !== g.terminalId ? terminalId : null;
    if (!g.targetTerminalId) delete g.targetTerminalId;
    if (g.steps[g.stepIndex] !== 'gate') continue;
    if (g.facility?.startsWith('gate:')) leaveFacility(sim.state, g);
    if (g.terminalLinkId && g.route.length > 0 && g.legProgress > 0) {
      g.replanAfterTerminalLink = true;
      continue;
    }
    releaseUnstartedTransportReservation(sim, g);
    delete g.terminalLinkWaitingId;
    delete g.terminalLinkPaxAccumulated;
    delete g.replanAfterTerminalLink;
    g.route = [];
    g.legProgress = 0;
    g.legLength = 0;
    if (g.area) planStep(sim, g);
  }
}

/** 出発旅客グループを追加する（テスト・デバッグ用にも公開） */
export interface PassengerAccess {
  stepFree?: boolean;
}

export function addDepartureGroup(
  sim: Simulation,
  flightId: string,
  count: number,
  appearAt: number,
  bags = 0,
  access: PassengerAccess = {},
): PaxGroup | null {
  const f = sim.state.flights[flightId];
  const terminalCount = Object.keys(sim.ctx.terminal.byTerminal).length;
  const terminal = (f?.pax.gateId ? sim.ctx.terminal.gates[f.pax.gateId]?.terminalId : null) ?? (terminalCount === 1 ? sim.ctx.paxTerminal : null);
  if (!f || f.direction !== 'departure' || terminalCount === 0) return null;
  f.pax.generated = true;
  f.pax.booked += count;
  return withRng(sim.state, (rng) => addGroup(sim, rng, f, count, appearAt, terminal, bags, access));
}

function addGroup(
  sim: Simulation,
  rng: Rng,
  f: Flight,
  count: number,
  appearAt: number,
  terminalId: string | null,
  bagsFixed?: number,
  access: PassengerAccess = {},
): PaxGroup {
  const { state } = sim;
  let bags = 0;
  for (let i = 0; i < count; i++) if (rng.next() < BAG_PROB) bags++;
  if (bagsFixed !== undefined) bags = bagsFixed;
  const steps: PaxStep[] = [];
  // フェーズ 4 §4.4: 国際は手荷物なしでも 90% がチェックインに寄る（乱数の消費は国内と同じ 1 回）
  const intl = f.routeType === 'international';
  if (bags > 0 || rng.next() < (intl ? 0.9 : COUNTER_WITHOUT_BAGS_PROB)) steps.push('checkIn');
  steps.push('security');
  if (intl) steps.push('emigration');
  // 店舗・飲食店があるターミナルでは、一部の旅客が出発区域で立ち寄る（時間に余裕があるときだけ）
  if (shopAreas(sim, terminalId).length > 0 && rng.next() < BALANCE.retail.shopVisitProb) steps.push('shop');
  if (rng.next() < RESTROOM_PROB) steps.push('restroom');
  steps.push('gate');
  const id = nextId(state, 'pg');
  const g: PaxGroup = {
    id,
    flightId: f.id,
    direction: 'departure',
    terminalId,
    count,
    bags,
    state: 'toAirport',
    steps,
    stepIndex: 0,
    area: null,
    route: [],
    legProgress: 0,
    legLength: 0,
    facility: null,
    serviceUntil: null,
    appearAt,
    finishedAt: null,
    securityCleared: false,
    ...((access.stepFree ?? needsStepFreeRoute(state.seed, id)) ? { stepFree: true } : {}),
    boardedGate: null,
    waitSec: 0,
    walkSec: 0,
    reason: null,
    retryAt: 0,
  };
  registerGroup(state, g);
  return g;
}

/** 三角分布（u: [0,1) の一様乱数） */
function triangular(u: number, a: number, c: number, b: number): number {
  const fc = (c - a) / (b - a);
  return u < fc ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

// ---------------------------------------------------------------- 乗継（フェーズ 4 §5.4）

type TransferKind = NonNullable<PaxGroup['transfer']>['kind'];

const TRANSFER_STEPS: Record<TransferKind, PaxStep[]> = {
  DD: ['transferSecurity', 'gate'],
  DI: ['transferSecurity', 'emigration', 'gate'],
  ID: ['immigration', 'transferSecurity', 'gate'],
  II: ['transferSecurity', 'gate'],
};

/** 乗継専用の乱数（便ごとに保持し、状態を書き戻す） */
function withTransferRng<T>(state: SimState, p: FlightPax, flightId: string, fn: (rng: Rng) => T): T {
  const rng = new Rng(p.transferRng ?? seedFromString(`${state.seed}:xfer:${flightId}`));
  const v = fn(rng);
  p.transferRng = rng.state();
  return v;
}

/** まだ降機していない乗継の計画（先頭のもの）。進み具合は生成済みの乗継グループから数える */
function nextTransferEntry(state: SimState, f: Flight): { depFlightId: string; kind: TransferKind; remaining: number } | null {
  for (const entry of f.transferPlan ?? []) {
    const done = groupsOf(state, entry.depFlightId)
      .filter((g) => g.transfer?.fromFlightId === f.id)
      .reduce((s, g) => s + g.count, 0);
    if (done < entry.pax) return { depFlightId: entry.depFlightId, kind: entry.kind, remaining: entry.pax - done };
  }
  return null;
}

/** 乗継グループを作る: 出発便のグループとして登録し、到着便の索引にも入れる（人数保存のため） */
function addTransferGroup(
  sim: Simulation,
  f: Flight,
  entry: { depFlightId: string; kind: TransferKind },
  size: number,
  bags: number,
  gateId: string | null,
  trng: Rng,
): void {
  const { state, ctx } = sim;
  const dep = state.flights[entry.depFlightId];
  const access = gateId ? ctx.terminal.gates[gateId] : undefined;
  const arrIntl = f.routeType === 'international';
  const deplaneArea = arrIntl ? (access?.deplaneIntl ?? null) : (access?.deplane ?? null);
  const terminalId = access?.terminalId ?? null;
  const steps: PaxStep[] = [...TRANSFER_STEPS[entry.kind]];
  // 任意の立ち寄りは専用の乱数で決める（地元の出発と同じ確率・順序）
  if (shopAreas(sim, terminalId).length > 0 && trng.next() < BALANCE.retail.shopVisitProb) steps.splice(steps.length - 1, 0, 'shop');
  if (trng.next() < RESTROOM_PROB) steps.splice(steps.length - 1, 0, 'restroom');
  const depGateTerminal = dep?.pax.gateId ? ctx.terminal.gates[dep.pax.gateId]?.terminalId ?? null : null;
  const id = nextId(state, 'pg');
  const g: PaxGroup = {
    id,
    flightId: entry.depFlightId,
    direction: 'departure',
    terminalId,
    ...(depGateTerminal && depGateTerminal !== terminalId ? { targetTerminalId: depGateTerminal } : {}),
    transfer: { fromFlightId: f.id, kind: entry.kind },
    count: size,
    bags,
    state: 'walking',
    steps,
    stepIndex: 0,
    area: deplaneArea,
    route: [],
    legProgress: 0,
    legLength: 0,
    facility: null,
    serviceUntil: null,
    appearAt: state.now,
    finishedAt: null,
    securityCleared: false,
    accessDone: true,
    ...(needsStepFreeRoute(state.seed, id) ? { stepFree: true } : {}),
    boardedGate: null,
    waitSec: 0,
    walkSec: 0,
    reason: null,
    retryAt: 0,
  };
  registerGroup(state, g);
  (state.flightPax[f.id] ??= []).push(g.id);
  // 手荷物は到着便の手荷物として作る（搬送の完了時に出発便へ付け替える）
  transferArrivalBags(sim, g, f.aircraftId, f.id, entry.depFlightId);
  if (dep) {
    dep.pax.transferIn = (dep.pax.transferIn ?? 0) + size;
    // 出発旅客の生成が済んでいれば予約数にも足す。まだなら生成時に transferIn から足される（二重に数えない）
    if (dep.pax.generated) dep.pax.booked += size;
  }
  f.pax.transferOut = (f.pax.transferOut ?? 0) + size;
  hubStatsOf(state).spawned += size;
  if (dep && (dep.pax.boarding === 'closed' || dep.status === 'completed' || dep.status === 'cancelled')) {
    // 出発便の締切後に生まれた乗継は、その場で乗り遅れにする（人数保存を保つため）
    const cancelled = dep.status === 'cancelled';
    g.state = cancelled ? 'cancelled' : 'missed';
    g.reason = cancelled ? 'cancelled' : 'late';
    g.finishedAt = state.now;
    g.area = null;
    if (!cancelled) {
      dep.pax.missed += size;
      state.paxStats.missed += size;
      onTransferMissed(sim, size);
      hubStatsOf(state).missed += size;
    }
    return;
  }
  if (f.pax.bus && gateId && deplaneArea) {
    g.state = 'waitingBus';
    g.area = null;
  } else if (!g.area) {
    g.state = 'stranded';
    g.reason = 'unreachable';
  } else {
    planStep(sim, g);
  }
}

// ---------------------------------------------------------------- 到着便

function stepArrivalFlight(sim: Simulation, f: Flight): void {
  const { state, ctx } = sim;
  const p = f.pax;
  if (f.block === null) return;
  const ac = state.aircraft[f.aircraftId]!;
  let gateId = ac.standId ? (ctx.standGate[ac.standId] ?? null) : null;
  // バスゲートがある運航: ゲートのないスポットの到着旅客は、スポットでランプバスを待ち、バスゲートの降機口へ運ばれる
  if (ac.standId && (state.bus || ctx.layout.stands[ac.standId]?.remoteBoarding !== undefined)) {
    const busGate = applyBusArrival(sim, f, ac);
    if (busGate !== undefined) gateId = busGate;
  }
  const assignedStand = ac.standId ? ctx.stands[ac.standId] : undefined;
  const remoteGateMissing = !!assignedStand && !assignedStand.contact && !gateId && (
    ctx.layout.stands[assignedStand.id]?.remoteBoarding !== undefined || !!state.bus
  );
  if (remoteGateMissing) p.busFailure ??= 'unconfigured';
  if (remoteGateMissing) return;
  if (!p.generated) {
    const seats = f.seats ?? resolveType(ctx.types, ac.typeId).seats;
    const access = gateId ? ctx.terminal.gates[gateId] : undefined;
    const stand = ac.standId ? ctx.stands[ac.standId] : undefined;
    const legacyRemote = !!stand && !stand.contact && ctx.layout.stands[stand.id]?.remoteBoarding === undefined && !state.bus;
    p.generated = true;
    withRng(state, (rng) => {
      p.booked = (access?.terminalId || (stand?.contact && ctx.paxTerminal) || legacyRemote)
        ? (f.plannedPax ?? Math.round(seats * (LOAD_FACTOR.min + rng.next() * (LOAD_FACTOR.max - LOAD_FACTOR.min))))
        : 0;
      p.deplaneRemaining = p.booked;
      // 手荷物受取所: 降機口から近い受取所。ベルトが空くまで手荷物は出ない
      const deplaneArea = f.routeType === 'international' ? (access?.deplaneIntl ?? null) : (access?.deplane ?? null);
      if (access && deplaneArea) {
        const claims = new Map(
          (ctx.terminal.byTerminal[access.terminalId!] ?? []).filter((id) => ctx.terminal.areas[id]!.kind === 'baggageClaim').map((id) => [id, 0] as const),
        );
        const r = findPaxRoute(ctx.terminal, { from: deplaneArea, goals: claims });
        // 手荷物は荷下ろし作業で受取所へ運ばれ、ベルトに空きがあれば流れる（baggage.ts）
        if (r) p.claimAreaId = r.areas[r.areas.length - 1]!;
      }
    });
  }
  if (p.deplaneRemaining <= 0) return;
  const rate = hasBridge(sim, gateId) ? DEPLANE_PAX_PER_MIN.bridge : DEPLANE_PAX_PER_MIN.stairs;
  p.deplaneAcc += rate / 60;
  withRng(state, (rng) => {
    while (p.deplaneRemaining > 0) {
      // 乗継分は先に降機する（フェーズ 4 §5.4）。大きさ・手荷物は専用の乱数で決める
      const xferEntry = nextTransferEntry(state, f);
      if (xferEntry) {
        const advanced = withTransferRng(state, p, f.id, (trng) => {
          const size = Math.min(p.deplaneRemaining, xferEntry.remaining, 1 + Math.floor(trng.next() * MAX_GROUP_SIZE));
          if (p.deplaneAcc < size) return false;
          p.deplaneAcc -= size;
          p.deplaneRemaining -= size;
          p.deplaned += size;
          state.paxStats.deplaned += size;
          onPaxDeplaned(sim, f, size);
          let bags = 0;
          for (let i = 0; i < size; i++) if (trng.next() < BAG_PROB) bags++;
          addTransferGroup(sim, f, xferEntry, size, bags, gateId, trng);
          return true;
        });
        if (!advanced) break;
        continue;
      }
      const size = Math.min(p.deplaneRemaining, 1 + Math.floor(rng.next() * MAX_GROUP_SIZE));
      if (p.deplaneAcc < size) break;
      p.deplaneAcc -= size;
      p.deplaneRemaining -= size;
      p.deplaned += size;
      state.paxStats.deplaned += size;
      onPaxDeplaned(sim, f, size);
      const access = gateId ? ctx.terminal.gates[gateId] : undefined;
      let bags = 0;
      for (let i = 0; i < size; i++) if (rng.next() < BAG_PROB) bags++;
      // フェーズ 4 §4.4: 国際の到着は 入国審査 →（手荷物があれば）受取 → 税関 → 出口
      const intl = f.routeType === 'international';
      const deplaneArea = intl ? (access?.deplaneIntl ?? null) : (access?.deplane ?? null);
      const steps: PaxStep[] = intl
        ? ['immigration', ...(bags > 0 && p.claimAreaId ? ['claim' as const] : []), 'customs', 'exit']
        : bags > 0 && p.claimAreaId ? ['claim', 'exit'] : ['exit'];
      const id = nextId(state, 'pg');
      const g: PaxGroup = {
        id,
        flightId: f.id,
        direction: 'arrival',
        // 到着側は便のゲートが決めたターミナルだけを使う。ゲート未割当て時は
        // 出発用の既定ターミナルへ流さず、降機口なしとして stranded にする。
        terminalId: access?.terminalId ?? null,
        count: size,
        bags,
        state: 'walking',
        steps,
        stepIndex: 0,
        area: deplaneArea,
        route: [],
        legProgress: 0,
        legLength: 0,
        facility: null,
        serviceUntil: null,
        appearAt: state.now,
        finishedAt: null,
        securityCleared: false,
        ...(needsStepFreeRoute(state.seed, id) ? { stepFree: true } : {}),
        boardedGate: null,
        waitSec: 0,
        walkSec: 0,
        reason: null,
        retryAt: 0,
      };
      registerGroup(state, g);
      arrivalBags(sim, g, ac.id);
      if (p.bus && gateId && deplaneArea) {
        // スポットでランプバスを待つ（降機口へはバスが運ぶ）
        g.state = 'waitingBus';
        g.area = null;
      } else if (!g.area) {
        // 降機口がない（ゲートなし・到着通路なし）: 到達不能として記録する
        g.state = 'stranded';
        g.reason = 'unreachable';
      } else {
        planStep(sim, g);
      }
    }
  });
}

// ---------------------------------------------------------------- グループ

function stepGroup(sim: Simulation, g: PaxGroup, occupancy: Map<string, number>): void {
  const { state } = sim;
  switch (g.state) {
    case 'toAirport':
      if (state.now >= g.appearAt) {
        const f = state.flights[g.flightId]!;
        if (f.pax.boarding === 'closed') return; // 締切後は closeBoarding が処理済み
        if (!g.terminalId) {
          g.state = 'stranded';
          g.reason = 'noGate';
          return;
        }
        // 空港アクセス: 交通手段の制約（満車・混雑・満員）と徒歩で遅れることがある
        if (state.access && !g.accessDone) {
          const delay = accessDeparture(sim, g);
          if (delay > 0) {
            g.appearAt = state.now + delay;
            return;
          }
        }
        const entrances = (sim.ctx.terminal.byTerminal[g.terminalId!] ?? []).filter(
          (id) => sim.ctx.terminal.areas[id]!.kind === 'entrance' && !isClosed(state, id),
        );
        if (entrances.length === 0) {
          g.state = 'waitingFacility';
          g.retryAt = state.now + PAX_RETRY_SEC;
          return;
        }
        // 複数入口は、次の必須工程まで実際に歩ける入口だけから選ぶ。
        // 入口の並び順や距離だけで選ぶと、孤立した入口に旅客を流すことがある。
        const model = sim.ctx.terminal;
        const nextStep = g.steps.slice(g.stepIndex).find((step) => step !== 'shop' && step !== 'restroom');
        const targets = nextStep === 'gate'
          ? [f.pax.gateId ? model.gates[f.pax.gateId]?.boarding : null].filter((id): id is string => !!id)
          : nextStep
            ? (model.byTerminal[g.terminalId!] ?? []).filter((id) => model.areas[id]!.kind === STEP_KIND[nextStep])
            : [];
        const goals = new Map(targets.map((id) => [id, 0] as const));
        const closed = new Set(state.closedAreas);
        const reachable = goals.size > 0
          ? entrances.filter((id) => !!findPaxRoute(model, { from: id, goals, closed, uncleared: uncleared(g), stepFree: g.stepFree }))
          : entrances;
        if (reachable.length === 0) {
          // 閉鎖が原因なら再開を待つ。構造的に接続されていない場合はすぐに到達不能として記録する。
          const structurallyReachable = entrances.some((id) => !!findPaxRoute(model, { from: id, goals, uncleared: uncleared(g), stepFree: g.stepFree }));
          if (structurallyReachable || targets.some((id) => serversOf(sim, id) === 0)) {
            g.state = 'waitingFacility';
            g.retryAt = state.now + PAX_RETRY_SEC;
          } else {
            g.state = 'stranded';
            g.reason = 'unreachable';
          }
          return;
        }
        g.area = withRng(state, (rng) => reachable[rng.int(0, reachable.length - 1)]!);
        state.paxStats.spawned += g.count;
        planStep(sim, g);
      }
      return;
    case 'walking':
      if (g.route.some((areaId) => state.closedAreas.includes(areaId))) {
        planStep(sim, g);
        return;
      }
      walk(sim, g, occupancy);
      return;
    case 'queuing':
    case 'boardingQueue':
    case 'waitingTransport':
      if (g.terminalLinkWaitingId && state.now >= g.retryAt && g.route.length > 0) {
        g.state = 'walking';
        startLeg(sim, g);
      } else {
        g.waitSec++;
      }
      return;
    case 'waitingBus':
    case 'onBus':
      g.waitSec++;
      return;
    case 'waitingBaggage': {
      g.waitSec++;
      if (groupBagsOnBelt(state, g.id)) {
        g.state = 'inService';
        g.serviceUntil = state.now + PICKUP_SEC;
      }
      return;
    }
    case 'inService':
      // 手荷物の受け取り（施設キーなし）はここで終える。窓口の処理は stepFacility
      if (!g.facility && g.serviceUntil !== null && state.now >= g.serviceUntil) {
        g.serviceUntil = null;
        if (g.steps[g.stepIndex] === 'claim') collectBags(sim, g.id);
        g.stepIndex++;
        planStep(sim, g);
      }
      return;
    case 'stranded':
    case 'waitingFacility':
      g.waitSec++;
      // 防御（1-07 / P-1）: ゲート未確定で空港に着いただけ（まだ建物に入っていない）の旅客は、ターミナルが決まっていれば入口へ戻す（旧版の進行中データにも効く）
      if (g.state === 'stranded' && !g.area && g.reason === 'noGate' && g.terminalId) {
        g.state = 'toAirport';
        g.reason = null;
        return;
      }
      if (state.now >= g.retryAt && g.area) planStep(sim, g);
      else if (state.now >= g.retryAt && g.state === 'waitingFacility' && !g.area) {
        g.state = 'toAirport';
      }
      return;
    case 'dwelling':
      if (state.now >= g.retryAt) planStep(sim, g);
      return;
    default:
      return;
  }
}

/** 現在のステップの目的地を決め、歩き出す（または並ぶ・待つ） */
function planStep(sim: Simulation, g: PaxGroup): void {
  const { state, ctx } = sim;
  const model = ctx.terminal;
  releaseUnstartedTransportReservation(sim, g);
  const step = g.steps[g.stepIndex];
  const closed = new Set(state.closedAreas);
  g.route = [];
  if (!step || !g.area) return;

  if (step === 'gate') {
    planGate(sim, g, closed);
    return;
  }
  if (step === 'shop') {
    planShop(sim, g, closed);
    return;
  }
  const kind = STEP_KIND[step]!;
  let ids = (model.byTerminal[g.terminalId ?? ''] ?? []).filter((id) => model.areas[id]!.kind === kind);
  // 乗継グループは到着ターミナルに工程の設備がないとき、出発側のターミナルの設備も候補にする（連絡設備で移動する）
  if (g.transfer && ids.length === 0) {
    ids = Object.values(model.byTerminal).flat().filter((id) => model.areas[id]!.kind === kind);
  }
  // 受取所は便ごとに決まっている
  const candidates = step === 'claim' ? ids.filter((id) => id === state.flights[g.flightId]!.pax.claimAreaId) : ids;
  const usable = candidates.filter((id) => !closed.has(id) && (step === 'exit' || step === 'claim' || serversOf(sim, id) > 0));
  const goals = new Map(usable.map((id) => [id, step === 'exit' || step === 'claim' ? 0 : expectedWait(sim, id)] as const));
  const route = goals.size > 0 ? findPaxRoute(model, { from: g.area, goals, closed, uncleared: uncleared(g), stepFree: g.stepFree }) : null;
  if (route) {
    startRoute(sim, g, route.areas);
    return;
  }
  if (step === 'restroom') {
    // トイレは任意
    g.stepIndex++;
    planStep(sim, g);
    return;
  }
  // 閉鎖が原因なら待機、構造的に行けないなら到達不能
  const ignoringClosure = candidates.length > 0 && findPaxRoute(model, { from: g.area, goals: new Map(candidates.map((id) => [id, 0] as const)), uncleared: uncleared(g), stepFree: g.stepFree });
  setWaiting(state, g, ignoringClosure || candidates.some((id) => closed.has(id) || serversOf(sim, id) === 0) ? 'waitingFacility' : 'stranded');
}

function planGate(sim: Simulation, g: PaxGroup, closed: Set<string>): void {
  const { state, ctx } = sim;
  const model = ctx.terminal;
  const f = state.flights[g.flightId]!;
  const gateId = f.pax.gateId;
  // フェーズ 4 §4.3: 国際の便は国際区域の搭乗口を使う
  const boarding = gateId ? (f.routeType === 'international' ? (model.gates[gateId]?.boardingIntl ?? null) : (model.gates[gateId]?.boarding ?? null)) : null;
  if (gateId && !boarding) {
    // ゲートに接する出発区域のエリアがない: 到達不能
    setWaiting(state, g, 'stranded');
    return;
  }
  if (boarding) {
    if (g.area === boarding) {
      if (f.pax.boarding === 'open') joinQueue(state, g, `gate:${gateId}`, 'boardingQueue');
      else dwell(state, g);
      return;
    }
    const route = findPaxRoute(model, { from: g.area!, goals: new Map([[boarding, 0]]), closed, stepFree: g.stepFree });
    if (route) {
      startRoute(sim, g, route.areas);
      return;
    }
    const structural = !findPaxRoute(model, { from: g.area!, goals: new Map([[boarding, 0]]), stepFree: g.stepFree });
    setWaiting(state, g, structural ? 'stranded' : 'waitingFacility');
    return;
  }
  // ゲート未定: 出発区域の待合スペースで待つ（国際は出国審査の後の区域）
  const cur = model.areas[g.area!]!;
  if (cur.kind !== 'waiting') {
    const waitZone = f.routeType === 'international' ? 'departureIntl' : 'departure';
    const waits = new Map(
      (model.byTerminal[g.terminalId ?? ''] ?? []).filter((id) => model.areas[id]!.kind === 'waiting' && model.areas[id]!.zone === waitZone && !closed.has(id)).map((id) => [id, 0] as const),
    );
    const route = waits.size > 0 ? findPaxRoute(model, { from: g.area!, goals: waits, closed, stepFree: g.stepFree }) : null;
    if (route && route.areas.length > 1) {
      startRoute(sim, g, route.areas);
      return;
    }
  }
  dwell(state, g);
}

/** ターミナル内の店舗・飲食店 */
function shopAreas(sim: Simulation, terminalId: string | null): string[] {
  const model = sim.ctx.terminal;
  return (model.byTerminal[terminalId ?? ''] ?? []).filter((id) => model.areas[id]!.kind === 'shop' || model.areas[id]!.kind === 'restaurant');
}

/** 店舗・飲食店に立ち寄る余裕（搭乗開始まで minSlackSec 以上）と、混雑（見込み待ち10分以内）を確かめて向かう。無理なら飛ばす */
function planShop(sim: Simulation, g: PaxGroup, closed: Set<string>): void {
  const { state } = sim;
  const f = state.flights[g.flightId]!;
  const slack = f.estimated - boardingLeadSec(sim, f) - state.now;
  const goals = new Map<string, number>();
  if (slack >= BALANCE.retail.minSlackSec) {
    for (const id of shopAreas(sim, g.terminalId)) {
      if (closed.has(id) || serversOf(sim, id) <= 0) continue;
      const w = expectedWait(sim, id);
      if (w <= 10 * 60) goals.set(id, w);
    }
  }
  const route = goals.size > 0 ? findPaxRoute(sim.ctx.terminal, { from: g.area!, goals, closed, uncleared: uncleared(g), stepFree: g.stepFree }) : null;
  if (route) {
    startRoute(sim, g, route.areas);
    return;
  }
  g.stepIndex++;
  planStep(sim, g);
}

const uncleared = (g: PaxGroup): boolean => g.direction === 'departure' && !g.securityCleared;

function dwell(state: SimState, g: PaxGroup): void {
  g.state = 'dwelling';
  g.retryAt = state.now + PAX_RETRY_SEC;
}

function setWaiting(state: SimState, g: PaxGroup, s: 'stranded' | 'waitingFacility'): void {
  g.state = s;
  g.retryAt = state.now + PAX_RETRY_SEC;
}

function startRoute(sim: Simulation, g: PaxGroup, areas: string[]): void {
  g.route = areas.slice(1);
  delete g.terminalLinkWaitingId;
  delete g.terminalLinkPaxAccumulated;
  delete g.replanAfterTerminalLink;
  if (g.route.length === 0) {
    arrive(sim, g);
    return;
  }
  g.state = 'walking';
  startLeg(sim, g);
}

function startLeg(sim: Simulation, g: PaxGroup): void {
  const link = linkBetween(sim.ctx.terminal, g.area!, g.route[0]!);
  g.legProgress = 0;
  g.legLength = link ? link.lengthM + link.travelSec * WALK_SPEED_MPS : 0;
  const transferLinkId = link?.transferLinkId;
  const transportId = transferLinkId ?? (link?.verticalTransportId ? `vertical:${link.verticalTransportId}` : undefined);
  if (!transportId) {
    delete g.terminalLinkId;
    delete g.terminalLinkReservedHour;
    delete g.terminalLinkWaitingId;
    delete g.terminalLinkPaxAccumulated;
    return;
  }
  if (g.terminalLinkId === transportId) return;
  if (g.terminalLinkWaitingId !== transportId) delete g.terminalLinkPaxAccumulated;
  const layoutLink = transferLinkId ? sim.ctx.layout.terminalLinks?.[transferLinkId] : undefined;
  if (transferLinkId && !layoutLink) {
    g.state = 'stranded';
    g.reason = 'unreachable';
    return;
  }
  const hour = Math.floor(sim.state.now / 3600);
  const runtime = sim.state.terminalTransit;
  if (!runtime || runtime.hour !== hour) {
    sim.state.terminalTransit = { hour, passengersByLink: {} };
  }
  const usage = sim.state.terminalTransit!.passengersByLink;
  const used = usage[transportId] ?? 0;
  const capacity = layoutLink
    ? terminalLinkCapacityPerHour(layoutLink)
    : link?.capacityPerHour ?? 1;
  const alreadyReserved = g.terminalLinkPaxAccumulated ?? 0;
  const remaining = Math.max(0, g.count - alreadyReserved);
  const available = Math.max(0, capacity - used);
  const reservedNow = g.count > capacity
    ? Math.min(remaining, available)
    : (alreadyReserved === 0 && g.count <= available ? g.count : 0);
  if (reservedNow > 0) usage[transportId] = used + reservedNow;
  const totalReserved = alreadyReserved + reservedNow;
  if (totalReserved < g.count) {
    if (totalReserved > 0) g.terminalLinkPaxAccumulated = totalReserved;
    else delete g.terminalLinkPaxAccumulated;
    g.state = 'waitingTransport';
    g.terminalLinkWaitingId = transportId;
    g.retryAt = (hour + 1) * 3600;
    return;
  }
  g.terminalLinkId = transportId;
  g.terminalLinkReservedHour = hour;
  delete g.terminalLinkWaitingId;
  delete g.terminalLinkPaxAccumulated;
}

function releaseUnstartedTransportReservation(sim: Simulation, g: PaxGroup): void {
  if (g.legProgress > 0) return;
  if (!g.terminalLinkId) {
    delete g.terminalLinkPaxAccumulated;
    return;
  }
  const runtime = sim.state.terminalTransit;
  if (runtime && runtime.hour === g.terminalLinkReservedHour) {
    const used = runtime.passengersByLink[g.terminalLinkId] ?? 0;
    const remaining = Math.max(0, used - g.count);
    if (remaining > 0) runtime.passengersByLink[g.terminalLinkId] = remaining;
    else delete runtime.passengersByLink[g.terminalLinkId];
  }
  delete g.terminalLinkId;
  delete g.terminalLinkReservedHour;
}

function walk(sim: Simulation, g: PaxGroup, occupancy: Map<string, number>): void {
  const { state, ctx } = sim;
  if (g.route.length === 0) {
    arrive(sim, g);
    return;
  }
  const next = g.route[0]!;
  const link = linkBetween(ctx.terminal, g.area!, next);
  if (!link) {
    planStep(sim, g);
    return;
  }
  // 次のエリアが閉鎖されたら、今いるエリアから経路を探し直す
  if (isClosed(state, next) && g.legProgress === 0) {
    planStep(sim, g);
    return;
  }
  const here = ctx.terminal.areas[g.area!]!;
  const crowd = (occupancy.get(here.id) ?? 0) / here.capacity;
  const speed = WALK_SPEED_MPS * (crowd > 1 ? Math.max(0.3, 1 / crowd) : 1);
  g.legProgress += speed;
  g.walkSec++;
  if (g.legProgress >= g.legLength) {
    const completedTransfer = (link.transferLinkId ?? (link.verticalTransportId ? `vertical:${link.verticalTransportId}` : undefined)) === g.terminalLinkId;
    // 乗継グループが連絡設備を通ったら利用実績に数える（フェーズ 4 §5.6）
    if (g.transfer && link.transferLinkId) {
      const hs = hubStatsOf(state);
      hs.byLink[link.transferLinkId] = (hs.byLink[link.transferLinkId] ?? 0) + g.count;
    }
    g.area = next;
    const nextTerminal = ctx.terminal.areas[next]?.terminalId;
    if (nextTerminal && nextTerminal !== g.terminalId) {
      g.terminalId = nextTerminal;
      if (g.targetTerminalId === nextTerminal) delete g.targetTerminalId;
    }
    g.route.shift();
    if (completedTransfer) {
      delete g.terminalLinkId;
      delete g.terminalLinkReservedHour;
    }
    if (completedTransfer && g.replanAfterTerminalLink) {
      delete g.replanAfterTerminalLink;
      g.route = [];
      planStep(sim, g);
      return;
    }
    // 保安検査を通らずに出発区域へ入らないことは不変条件 P4 で検査する
    if (g.route.length === 0) arrive(sim, g);
    else startLeg(sim, g);
  }
}

/** 目的地に着いた: 並ぶ / 受け取りを待つ / 退出する */
function arrive(sim: Simulation, g: PaxGroup): void {
  const { state } = sim;
  const step = g.steps[g.stepIndex];
  g.route = [];
  switch (step) {
    case 'checkIn':
    case 'security':
    case 'shop':
    case 'restroom':
    case 'emigration':
    case 'immigration':
    case 'customs':
    case 'transferSecurity':
      joinQueue(state, g, g.area!, 'queuing');
      return;
    case 'gate':
      planGate(sim, g, new Set(state.closedAreas));
      return;
    case 'claim':
      g.state = 'waitingBaggage';
      return;
    case 'exit':
      // 空港アクセス: タクシー・バス・鉄道は乗り場で待ってから退出する
      if (state.access && !g.accessDone && accessArrival(sim, g)) return;
      completeExit(sim, g);
      return;
    default:
      return;
  }
}

/** 到着グループの退出を確定する（出口、またはアクセスの乗り場で乗車したとき） */
export function completeExit(sim: Simulation, g: PaxGroup): void {
  const { state } = sim;
  const f = state.flights[g.flightId]!;
  g.state = 'exited';
  g.finishedAt = state.now;
  g.area = null;
  f.pax.exited += g.count;
  finish(state, g);
  state.paxStats.exited += g.count;
}

function joinQueue(state: SimState, g: PaxGroup, key: string, s: 'queuing' | 'boardingQueue'): void {
  const fac = facility(state, key);
  fac.queue.push(g.id);
  g.facility = key;
  g.state = s;
  const queued = fac.queue.reduce((sum, id) => sum + (state.paxGroups[id]?.count ?? 0), 0);
  fac.maxQueue = Math.max(fac.maxQueue, queued);
}

function leaveFacility(state: SimState, g: PaxGroup): void {
  if (!g.facility) return;
  const fac = state.facilities[g.facility];
  if (fac) {
    fac.queue = fac.queue.filter((id) => id !== g.id);
    fac.inService = fac.inService.filter((id) => id !== g.id);
  }
  g.facility = null;
  g.serviceUntil = null;
}

function finish(state: SimState, g: PaxGroup): void {
  state.paxStats.waitTotal += g.waitSec * g.count;
  state.paxStats.walkTotal += g.walkSec * g.count;
  state.paxStats.finished += g.count;
}

// ---------------------------------------------------------------- 施設（待ち行列）

function stepFacility(sim: Simulation, key: string): void {
  const { state } = sim;
  const fac = state.facilities[key]!;
  // 処理の完了
  for (const id of [...fac.inService]) {
    const g = state.paxGroups[id]!;
    if (state.now < g.serviceUntil!) continue;
    fac.inService = fac.inService.filter((x) => x !== id);
    g.facility = null;
    g.serviceUntil = null;
    if (key.startsWith('gate:') && state.flights[g.flightId]!.pax.bus) {
      // バスゲート: 搭乗券の確認を終えたらランプバスを待つ（搭乗済みになるのはスポットで降車したとき）
      g.state = 'waitingBus';
      g.boardedGate = key.slice('gate:'.length);
      continue;
    }
    if (key.startsWith('gate:')) {
      const f = state.flights[g.flightId]!;
      g.state = 'boarded';
      g.boardedGate = key.slice('gate:'.length);
      g.finishedAt = state.now;
      g.area = null;
      if (g.transfer) hubStatsOf(state).connected += g.count;
      f.pax.boarded += g.count;
      state.paxStats.boarded += g.count;
      finish(state, g);
      continue;
    }
    const area = sim.ctx.terminal.areas[key];
    if (area?.kind === 'security') g.securityCleared = true;
    // 乗継保安検査を出たら保安検査済みとして扱う（フェーズ 4 §5.4）
    if (area?.kind === 'transferSecurity') g.securityCleared = true;
    // フェーズ 4 §4.4: 審査・税関を通ったら印を付ける（不変条件 C1・C2 の根拠）
    if (area?.kind === 'emigration') (g.ciq ??= {}).emigration = true;
    if (area?.kind === 'immigration') (g.ciq ??= {}).immigration = true;
    if (area?.kind === 'customs') (g.ciq ??= {}).customs = true;
    if (area?.kind === 'checkIn') checkInBags(sim, g, key);
    if (area?.kind === 'shop' || area?.kind === 'restaurant') onShopDone(sim, g, area.kind);
    g.stepIndex++;
    planStep(sim, g);
  }

  const servers = serversOf(sim, key);
  if (servers === 0 && !key.startsWith('gate:')) {
    // 閉鎖・窓口0: 並んでいる旅客は他の施設へ迂回するか、その場で待機する
    for (const id of [...fac.queue]) {
      const g = state.paxGroups[id]!;
      leaveFacility(state, g);
      planStep(sim, g);
    }
    return;
  }
  if (key.startsWith('gate:')) {
    const gateId = key.slice('gate:'.length);
    // 搭乗中でない便の旅客は並ばせない（締切は closeBoarding が処理）
    fac.queue = fac.queue.filter((id) => {
      const g = state.paxGroups[id]!;
      const ok = state.flights[g.flightId]!.pax.boarding === 'open' && state.flights[g.flightId]!.pax.gateId === gateId;
      if (!ok && g.state === 'boardingQueue') {
        g.facility = null;
        dwell(state, g);
      }
      return ok;
    });
  }
  // 処理の開始（窓口数まで）
  while (fac.inService.length < servers && fac.queue.length > 0) {
    const id = fac.queue.shift()!;
    const g = state.paxGroups[id]!;
    fac.inService.push(id);
    g.state = 'inService';
    g.serviceUntil = state.now + serviceSec(sim, key, g);
    fac.served += g.count;
    fac.waitTotal += g.waitSec * g.count;
  }
}

function serviceSec(sim: Simulation, key: string, g: PaxGroup): number {
  if (key.startsWith('gate:')) {
    if (sim.state.flights[g.flightId]!.pax.bus) return Math.max(1, Math.round(BUS_GATE_SEC_PER_PAX * g.count));
    const per = hasBridge(sim, key.slice('gate:'.length)) ? BOARD_SEC_PER_PAX.bridge : BOARD_SEC_PER_PAX.stairs;
    return Math.max(1, Math.round(per * g.count));
  }
  const a = sim.ctx.terminal.areas[key]!;
  if (a.kind === 'restroom') return RESTROOM_SEC;
  if (a.kind === 'shop') return BALANCE.retail.shopSec;
  if (a.kind === 'restaurant') return BALANCE.retail.restaurantSec;
  return withRng(sim.state, (rng) => Math.max(1, Math.round(g.count * perPaxSec(sim, key) * (0.8 + rng.next() * 0.4))));
}

// ---------------------------------------------------------------- ランプバス（sim/apronBus.ts から呼ぶ）

/** 出発旅客がスポットでバスを降りて搭乗済みになる */
export function finishBusBoarded(sim: Simulation, g: PaxGroup): void {
  const { state } = sim;
  const f = state.flights[g.flightId]!;
  g.state = 'boarded';
  g.finishedAt = state.now;
  g.area = null;
  delete g.busTrip;
  if (g.transfer) hubStatsOf(state).connected += g.count;
  f.pax.boarded += g.count;
  state.paxStats.boarded += g.count;
  finish(state, g);
}

/** 到着旅客がバスを降りて、降機口から手荷物受取・出口へ歩き出す */
export function releaseBusArrival(sim: Simulation, g: PaxGroup, gateId: string): void {
  delete g.busTrip;
  const area = sim.ctx.terminal.gates[gateId]?.deplane ?? null;
  if (!area) {
    g.state = 'stranded';
    g.reason = 'unreachable';
    g.area = null;
    return;
  }
  g.area = area;
  g.state = 'walking';
  planStep(sim, g);
}

/** 乗車中・乗車待ちだった旅客を乗車待ちに戻す（バスの故障・配車のやり直し）。出発はバスゲートの搭乗口、到着はスポット */
export function returnToBusQueue(sim: Simulation, g: PaxGroup, depGateId: string | null): void {
  delete g.busTrip;
  g.state = 'waitingBus';
  g.area = depGateId ? (sim.ctx.terminal.gates[depGateId]?.boarding ?? null) : null;
}

// ---------------------------------------------------------------- 施設の閉鎖

export function setAreaClosed(sim: Simulation, areaId: string, closed: boolean): boolean {
  const { state } = sim;
  if (!sim.ctx.terminal.areas[areaId]) return false;
  const set = new Set(state.closedAreas);
  if (closed) set.add(areaId);
  else set.delete(areaId);
  state.closedAreas = [...set].sort(compareIds);
  log(state, { t: state.now, kind: closed ? 'areaClosed' : 'areaOpened', note: areaId });
  return true;
}

/** 施設キーの待ち人数・処理中人数 */
export function facilityLoad(state: SimState, key: string): { queued: number; inService: number } {
  const f = state.facilities[key];
  const sum = (ids: string[]) => ids.reduce((s, id) => s + (state.paxGroups[id]?.count ?? 0), 0);
  return { queued: sum(f?.queue ?? []), inService: sum(f?.inService ?? []) };
}
