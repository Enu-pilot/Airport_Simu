import { Rng } from '../rng';
import { compareIds, sortedValues } from '../model/ids';
import type { AirportLayout, SizeClass } from '../model/types';
import { canAircraftUse, otherEnd } from '../airside/network';
import { resolveType, takeoffDistanceM, type AircraftType, type AircraftTypeId, type TypeTable } from './aircraftTypes';
import { checkRunway, checkStand } from '../aircraft/compat';
import { createContext, operableTypes, orderedRunway, type SimContext } from './context';
import { findPath } from './pathfinding';
import {
  edgeIndexAt,
  headingOf,
  holdShortOnRoute,
  isFree,
  makeRoute,
  pointAt,
  releaseAll,
  releasePassed,
  reservableParts,
  reserve,
  routeLength,
  turnAngleAt,
} from './routes';
import {
  APPROACH_SEC,
  BLOCK_REQUEST_AHEAD_M,
  ARRIVAL_AFTER_DEPARTURE_SEC,
  CROSSING_WINDOW_SEC,
  DAY_SEC,
  DEPARTED_DESPAWN_SEC,
  DEPARTURE_GIVE_UP_SEC,
  DEPARTURE_STARVATION_SEC,
  DEPARTURE_WINDOW_SEC,
  ENGINE_START_SEC,
  EXIT_SPEED,
  HOLD_DIVERT_SEC,
  INBOUND_LEAD_SEC,
  LINEUP_ALIGN_SEC,
  LINEUP_SPEED,
  MIN_GROUND_SEPARATION_M,
  PUSHBACK_SPEED,
  RETRY_SEC,
  SEPARATION_SEC,
  SIM_START_SEC,
  STAND_SPEED,
  TAXI_ACCEL,
  TAXI_DECEL,
  TICK_SEC,
  TURN_SPEED,
} from './rules';
import {
  EVENT_LOG_LIMIT,
  GROUND_MOVING_STATES,
  TERMINAL_STATES,
  type Aircraft,
  type AircraftState,
  type DelayCause,
  type CrossingGrant,
  type Flight,
  type HoldReason,
  type Route,
  type RunwayConfig,
  type SimSettings,
  type SimState,
} from './types';
import { TILE_M } from '../model/catalog';
import { BOARDING_LEAD_MIN, completeExit, emptyFlightPax, serversOf, stepPassengers } from './passengers';
import { createAccessRuntime, refreshAccess, stepAccess } from '../access/runtime';
import { stepDisruptions, weatherEffects, type ResponseResult } from './disruptions';
import { createWx, rollWeatherGoAround, disruptionScaleFor, stepWeather } from './weatherStep';
import { createAnalytics, stepAnalytics } from '../analytics/records';
import type { CompanyState } from '../economy/company';
import { companyDayOf, createEconomy, onFlightLost, onLanding, onTakeoff, stepEconomy } from '../economy/ops';
import { analyzeDayPlan, planDayWithDemand } from '../economy/planning';
import { internationalProcessingFor, routeCapabilitiesForAirport } from '../economy/registry';
import { stepBaggage } from './baggage';
import { atRiskForNight, lineUpToAirborneSec, nightOpsOf, predictTakeoffAt, standReleaseAt } from './nightOps';
import { acquireNext, acquireRoute, blockMovementLimit, createTaxiBlockState, detectTaxiStall, noteOpposed, opposedMove, pendingChainDistance, releaseBlocksPassed, routeBlocks } from './blockControl';
import { createApronBusRuntime, stepApronBuses } from './apronBus';
import { materializeCarryOver } from './overnight';
import { BALANCE } from '../economy/balance';
import { planConnections } from '../economy/hub';
import { analyzeHub } from '../terminal/hub';
import { isCityNightMovement, nextCityMovementTime } from '../economy/city';
import { addExternalDelay } from '../economy/delayEvaluation';
import {
  allTurnaroundDone,
  cancelPushbackTask,
  cancelTasks,
  completePushback,
  createGroundUnits,
  createPushbackTask,
  createTurnaroundTasks,
  pushbackReady,
  PUSHBACK_DISPATCH_LEAD_SEC,
  stepGround,
  tasksOf,
} from './ground';

/**
 * 運航シミュレーション本体。`stepSimulation` が 1 ティック（1ゲーム秒）を進める。
 * 状態は SimState を直接更新する（性能のため）。実時間・描画には依存しない。
 */

export interface Simulation {
  ctx: SimContext;
  state: SimState;
  /** 空港会社（経営）。あれば契約から運航計画を作り、収支を記録する。運航中はこのオブジェクトを直接更新する */
  company?: CompanyState | null;
}

export interface CreateOptions {
  seed?: string;
  startTime?: number;
  settings?: Partial<SimSettings>;
  company?: CompanyState | null;
  /** 機種テーブル（保存時のスナップショットなど。省略時は現在のカタログ） */
  types?: TypeTable;
}

const DEFAULT_SETTINGS: SimSettings = {
  flightsPerDay: 0,
  inboundDelayProb: 0.25,
  inboundDelayMaxMin: 40,
  autoSchedule: true,
  randomFailures: false,
};

export function createSimulation(layout: AirportLayout, opts: CreateOptions = {}): Simulation {
  const ctx = createContext(layout, opts.types ? { types: opts.types } : {});
  const seed = opts.seed ?? `${layout.site.seed}:ops`;
  const runwayConfig: Record<string, RunwayConfig> = {};
  const runways: SimState['runways'] = {};
  for (const id of Object.keys(ctx.runways).sort(compareIds)) {
    runwayConfig[id] = { direction: 'forward', mode: 'mixed' };
    runways[id] = { occupant: null, booking: null, lastOp: null };
  }
  const contactStands = Object.values(ctx.stands).filter((s) => s.operational).length;
  const state: SimState = {
    version: 1,
    seed,
    now: opts.startTime ?? SIM_START_SEC,
    rng: new Rng(seed).state(),
    counters: {},
    settings: {
      ...DEFAULT_SETTINGS,
      flightsPerDay: Math.min(60, contactStands * 3),
      // ゲームのモデル（会社の game）がある運航だけ、ランダムな障害を難易度の頻度で有効にする（従来の運航は変わらない）
      ...(opts.company?.game ? { randomDisruptions: true, randomDisruptionScale: disruptionScaleFor(opts.company.game.difficulty) } : {}),
      ...opts.settings,
    },
    runwayConfig,
    runways,
    flights: {},
    aircraft: {},
    standAssignments: {},
    airlineStandHomes: { day: Math.floor((opts.startTime ?? SIM_START_SEC) / DAY_SEC), byAirline: {} },
    nodeReservations: {},
    edgeReservations: {},
    scheduledDays: [],
    events: [],
    stats: { arrivals: 0, departures: 0, diverted: 0, cancelled: 0, goArounds: 0, conflicts: 0, taxiInSecTotal: 0, taxiOutSecTotal: 0 },
    paxGroups: {},
    activePax: [],
    flightPax: {},
    facilities: {},
    closedAreas: [],
    terminalTransit: { hour: Math.floor((opts.startTime ?? SIM_START_SEC) / 3600), passengersByLink: {} },
    paxStats: { spawned: 0, boarded: 0, missed: 0, deplaned: 0, exited: 0, waitTotal: 0, walkTotal: 0, finished: 0 },
    units: {},
    tasks: {},
    aircraftTasks: {},
    activeTasks: [],
    bags: {},
    flightBags: {},
    groupBags: {},
    activeBags: [],
    equipment: {},
    sorterAcc: {},
    groundStats: {
      tasksDone: 0,
      blockedSec: {},
      lateReadyFlights: 0,
      lateReadySec: 0,
      bagsLoaded: 0,
      bagsLeftBehind: 0,
      bagsOffloaded: 0,
      bagsCollected: 0,
    },
    economy: null,
    access: null,
    weather: { kind: 'clear', since: opts.startTime ?? SIM_START_SEC },
    disruptions: [],
    closures: { taxiways: [], stands: [], gates: [] },
    analytics: createAnalytics(opts.startTime ?? SIM_START_SEC),
  };
  const sim: Simulation = { ctx, state, company: opts.company ?? null };
  if (sim.company) {
    state.economy = createEconomy(ctx, state, sim.company);
    state.access = createAccessRuntime(sim, sim.company);
    // 天候 5 段階（会社の game.weather === 'levels' の運航だけ。従来の運航にはキー自体を作らない）
    const wx = createWx(sim);
    if (wx) state.wx = wx;
  }
  createGroundUnits(sim);
  // 区間ごとに進む地上走行（taxiMode 'block'）だけ占有の状態を持つ（従来の運航にはキー自体を作らない）
  if (ctx.blocks) state.taxiBlocks = createTaxiBlockState();
  // バスゲートがある運航だけランプバスの運行の状態を持つ（従来の運航にはキー自体を作らない）
  if (ctx.busGates.length > 0) state.bus = createApronBusRuntime();
  // フェーズ 4: 持ち越しの記録があれば、スケジュール生成の前に機体を置き直す
  materializeCarryOver(sim);
  if (state.settings.autoSchedule) generateDaySchedule(sim, Math.floor(state.now / DAY_SEC));
  return sim;
}

// ---------------------------------------------------------------- 乱数・ID・記録

function withRng<T>(state: SimState, fn: (rng: Rng) => T): T {
  const rng = new Rng(state.rng);
  const v = fn(rng);
  state.rng = rng.state();
  return v;
}

export function nextId(state: SimState, prefix: string): string {
  const n = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = n;
  return `${prefix}_${n}`;
}

export function logEvent(state: SimState, e: SimState['events'][number]): void {
  state.events.push(e);
  if (state.events.length > EVENT_LOG_LIMIT) state.events.splice(0, state.events.length - EVENT_LOG_LIMIT);
}

export function setState(state: SimState, ac: Aircraft, next: AircraftState, note?: string): void {
  if (ac.state === next) return;
  ac.state = next;
  ac.stateSince = state.now;
  ac.history.push({ t: state.now, state: next, ...(note ? { note } : {}) });
  logEvent(state, { t: state.now, kind: 'state', aircraftId: ac.id, state: next, ...(note ? { note } : {}) });
}

function setHold(state: SimState, ac: Aircraft, reason: HoldReason | null): void {
  if (reason === ac.holdReason) return;
  const prev = ac.holdReason;
  ac.holdReason = reason;
  if (reason) {
    // 夜間待機（noiseCurfew）から別の理由に変わったら、夜間待機の時間を HOLD_DIVERT_SEC の対象から除くため起点を取り直す（1-12 / D-1）
    if (prev === 'noiseCurfew') ac.waitSince = state.now;
    else ac.waitSince ??= state.now;
    logEvent(state, { t: state.now, kind: 'hold', aircraftId: ac.id, reason });
  } else {
    ac.waitSince = null;
  }
}

export function addDelayCause(f: Flight, c: DelayCause): void {
  if (!f.delayCauses.includes(c)) f.delayCauses.push(c);
}

const HOLD_TO_DELAY: Partial<Record<HoldReason, DelayCause>> = {
  noStand: 'noStand',
  standTooSmall: 'noStand',
  gateRouteMismatch: 'noStand',
  noDepartureRoute: 'noRoute',
  separation: 'runwayQueue',
  runwayBusy: 'runwayQueue',
  departurePriority: 'runwayQueue',
  goAround: 'runwayQueue',
  intersection: 'runwayQueue',
  routeBusy: 'taxiCongestion',
  crossing: 'taxiCongestion',
  noRoute: 'noRoute',
  noRunway: 'noRoute',
  boarding: 'boarding',
  groundCrew: 'groundHandling',
  noiseCurfew: 'noiseRestriction',
  blockFull: 'taxiCongestion',
  opposingTraffic: 'taxiCongestion',
  runwayQueue: 'runwayQueue',
};

const typeOf = (sim: Simulation, ac: Aircraft): AircraftType => resolveType(sim.ctx.types, ac.typeId);

// ---------------------------------------------------------------- 便の生成

const AIRLINES = ['SK', 'NP', 'RJ', 'AQ'] as const;

export { operableTypes };

/** 到着便と折り返しの出発便を1組追加する（同じ機体が到着して出発する） */
export function addTurnaround(
  sim: Simulation,
  typeId: AircraftTypeId,
  arrivalAt: number,
  opts: {
    departureAt?: number;
    inboundDelaySec?: number;
    airline?: string;
    numbers?: [string, string];
    plan?: { contractId: string; destinationId: string; arrPax: number; depPax: number; standId: string | null; seats?: number; overnight?: true; basedAircraftId?: string; routeType?: 'international'; cargo?: { volumeM3: number } };
  } = {},
): Aircraft {
  const { state } = sim;
  const type = resolveType(sim.ctx.types, typeId);
  const acId = nextId(state, 'ac');
  const n = state.counters.ac!;
  const airline = opts.airline ?? AIRLINES[n % AIRLINES.length]!;
  const num = 100 + n * 2;
  const arrId = nextId(state, 'fl');
  const depId = nextId(state, 'fl');
  const depAt = opts.departureAt ?? arrivalAt + type.turnaroundSec + 20 * 60;
  const [arrNumber, depNumber] = opts.numbers ?? [`${airline}${num}`, `${airline}${num + 1}`];
  const plan = opts.plan;
  const flight = (id: string, direction: Flight['direction'], number: string, at: number, est: number): Flight => ({
    id,
    number,
    direction,
    aircraftId: acId,
    scheduled: at,
    estimated: est,
    actual: null,
    block: null,
    status: 'scheduled',
    runwayId: null,
    standId: null,
    delayCauses: [],
    pax: emptyFlightPax(),
    readyAt: null,
    criticalTask: null,
    airlineId: airline,
    contractId: plan?.contractId ?? null,
    destinationId: plan?.destinationId ?? null,
    plannedPax: plan ? (direction === 'arrival' ? plan.arrPax : plan.depPax) : null,
    plannedStandId: plan?.standId ?? null,
    ...(plan?.seats !== undefined ? { seats: plan.seats } : {}),
    ...(plan?.overnight ? { overnight: true as const } : {}),
    ...(plan?.basedAircraftId ? { basedAircraftId: plan.basedAircraftId } : {}),
    ...(plan?.routeType ? { routeType: plan.routeType } : {}),
    ...(plan?.cargo ? { cargo: plan.cargo } : {}),
  });
  const arrEst = arrivalAt + (opts.inboundDelaySec ?? 0);
  state.flights[arrId] = flight(arrId, 'arrival', arrNumber, arrivalAt, arrEst);
  if (arrEst > arrivalAt) {
    addDelayCause(state.flights[arrId]!, 'inboundLate');
    addExternalDelay(state.flights[arrId]!, 'inboundDelay', arrEst - arrivalAt);
  }
  state.flights[depId] = flight(depId, 'departure', depNumber, depAt, Math.max(depAt, arrEst + type.turnaroundSec));
  // 貨物便（5-12）は搭乗手続きを持たない。出発準備の判定（搭乗締切待ち）で止まらないよう締切済みにしておく
  if (plan?.cargo) state.flights[depId]!.pax.boarding = 'closed';
  const ac: Aircraft = {
    id: acId,
    typeId,
    callsign: arrNumber,
    arrivalFlightId: arrId,
    departureFlightId: depId,
    state: 'scheduled',
    stateSince: state.now,
    runwayId: null,
    standId: null,
    route: null,
    dist: 0,
    speed: 0,
    x: 0,
    y: 0,
    heading: 0,
    px: 0,
    py: 0,
    pheading: 0,
    holdReason: null,
    waitSince: null,
    eta: null,
    timerUntil: null,
    queuedSince: null,
    retryAt: 0,
    taxiStartedAt: null,
    crossing: null,
    history: [{ t: state.now, state: 'scheduled' }],
  };
  state.aircraft[acId] = ac;
  return ac;
}

/** 1日分のスケジュールを生成する（06:30〜22:00 に到着、折り返して出発） */
export function generateDaySchedule(sim: Simulation, day: number): void {
  const { state, ctx } = sim;
  if (state.scheduledDays.includes(day)) return;
  state.scheduledDays.push(day);
  if (sim.company) {
    generateContractSchedule(sim, day);
    return;
  }
  // 乱数のスケジュール（会社なしの運航・テスト用）は旧形式の汎用機材だけを使う
  const weights: Record<AircraftTypeId, number> = { regional70: 3, narrow180: 6, wide300: 1.5 };
  const types = operableTypes(ctx).filter((t) => weights[t] !== undefined);
  const count = state.settings.flightsPerDay;
  if (types.length === 0 || count <= 0) return;
  const from = Math.max(day * DAY_SEC + 6.5 * 3600, state.now + 20 * 60);
  const to = day * DAY_SEC + 22 * 3600;
  if (from >= to) return;
  const plans = withRng(state, (rng) => {
    const out: { at: number; type: AircraftTypeId; delay: number }[] = [];
    const total = types.reduce((s, t) => s + weights[t]!, 0);
    for (let i = 0; i < count; i++) {
      const at = Math.round((from + ((to - from) * (i + rng.next())) / count) / 60) * 60;
      let pick = rng.next() * total;
      let type = types[0]!;
      for (const t of types) {
        pick -= weights[t]!;
        if (pick <= 0) {
          type = t;
          break;
        }
      }
      const delay = rng.next() < state.settings.inboundDelayProb ? rng.int(3, state.settings.inboundDelayMaxMin) * 60 : 0;
      out.push({ at, type, delay });
    }
    return out;
  });
  for (const p of plans) addTurnaround(sim, p.type, p.at, { inboundDelaySec: p.delay });
  logEvent(state, { t: state.now, kind: 'scheduleGenerated', note: `day ${day}: ${plans.length}` });
}

/**
 * 契約に基づく1日分のスケジュール（economy/planning.ts）。計画上のスポットを優先して割り当てる。
 * 開始直後で間に合わない便（20分以内）は到着を後ろへずらす。
 */
function generateContractSchedule(sim: Simulation, day: number): void {
  const { state, ctx } = sim;
  // 需要にはアクセス係数（前日の混雑を反映）が掛かる。運航計画タブのプレビューも同じ値を使う
  const plan = planDayWithDemand(sim.company!, companyDayOf(sim, day), refreshAccess(sim, sim.company!), ctx.types, routeCapabilitiesForAirport(ctx.layout.countryId, { international: internationalProcessingFor(sim.company, ctx.terminal) }));
  // 乗継の計画（フェーズ 4 §5.3）: ハブ解析の MCT を使って到着便→出発便の人数を決める
  planConnections(plan, sim.company!, analyzeHub(ctx.layout, ctx.terminal));
  const analysis = analyzeDayPlan(plan, ctx, state.closures.gates);
  const earliest = state.now + 20 * 60;
  // 拠点契約の滞泊便には所属機を ID 順に割り当てる（フェーズ 4 §3.5）
  const basedCounters = new Map<string, number>();
  const basedIdsOf = (contractId: string) => Object.values(sim.company!.basedFleet ?? {}).filter((b) => b.contractId === contractId).sort((a, b) => compareIds(a.id, b.id));
  // 乗継の計画を実便へ移すための key → 便 ID の対応（フェーズ 4 §5.3）
  const arrIdByKey = new Map<string, string>();
  const depIdByKey = new Map<string, string>();
  for (const p of plan.flights) {
    const arrivalAt = Math.max(day * DAY_SEC + p.arrivalAt, Math.ceil(earliest / 60) * 60);
    let basedAircraftId: string | undefined;
    if (p.overnight) {
      const ids = basedIdsOf(p.contractId);
      if (ids.length > 0) {
        const idx = basedCounters.get(p.contractId) ?? 0;
        basedAircraftId = ids[idx % ids.length]!.id;
        basedCounters.set(p.contractId, idx + 1);
      }
    }
    const ac = addTurnaround(sim, p.typeId, arrivalAt, {
      departureAt: Math.max(day * DAY_SEC + p.departureAt, arrivalAt + resolveType(ctx.types, p.typeId).turnaroundSec),
      inboundDelaySec: p.inboundDelaySec,
      airline: p.airlineId,
      numbers: [p.arrNumber, p.depNumber],
      plan: { contractId: p.contractId, destinationId: p.destinationId, arrPax: p.arrPax, depPax: p.depPax, standId: analysis.assignments[p.key]?.standId ?? null, seats: p.seats, ...(p.overnight ? { overnight: true as const } : {}), ...(basedAircraftId ? { basedAircraftId } : {}), ...(p.routeType ? { routeType: p.routeType } : {}) },
    });
    arrIdByKey.set(p.key, ac.arrivalFlightId);
    depIdByKey.set(p.key, ac.departureFlightId);
  }
  // 貨物便の計画（5-12）を実便へ流す。旅客は生成せず、貨物タスクで折り返す通常の機体として運航する
  for (const cf of plan.cargoFlights ?? []) {
    const arrivalAt = Math.max(day * DAY_SEC + cf.arrivalAt, Math.ceil(earliest / 60) * 60);
    addTurnaround(sim, cf.typeId, arrivalAt, {
      departureAt: Math.max(day * DAY_SEC + cf.departureAt, arrivalAt + resolveType(ctx.types, cf.typeId).turnaroundSec),
      airline: cf.airlineId,
      numbers: [cf.arrNumber, cf.depNumber],
      plan: { contractId: cf.contractId, destinationId: cf.destinationId, arrPax: 0, depPax: 0, standId: null, cargo: { volumeM3: cf.volumeM3 } },
    });
  }
  // 乗継の計画を実便へ移す（到着便の transferPlan・出発便の plannedTransferIn）
  for (const p of plan.flights) {
    if (p.connections?.length) {
      const arr = state.flights[arrIdByKey.get(p.key)!]!;
      arr.transferPlan = p.connections.flatMap((cn) => {
        const depFlightId = depIdByKey.get(cn.depKey);
        return depFlightId ? [{ depFlightId, pax: cn.pax, kind: cn.kind }] : [];
      });
    }
    if (p.transferIn) {
      const dep = state.flights[depIdByKey.get(p.key)!]!;
      dep.plannedTransferIn = p.transferIn;
    }
  }
  logEvent(state, { t: state.now, kind: 'scheduleGenerated', note: `day ${day}: ${plan.flights.length}（契約）` });
}

// ---------------------------------------------------------------- 設定

export function setRunwayConfig(sim: Simulation, runwayId: string, cfg: Partial<RunwayConfig>): boolean {
  const cur = sim.state.runwayConfig[runwayId];
  if (!cur) return false;
  sim.state.runwayConfig[runwayId] = { ...cur, ...cfg };
  return true;
}

// ---------------------------------------------------------------- 滑走路・スポットの選択

interface RunwayEndInfo {
  runwayId: string;
  nodes: string[];
  dist: number[];
}

function runwayFor(sim: Simulation, runwayId: string): RunwayEndInfo | null {
  const info = sim.ctx.runways[runwayId];
  const cfg = sim.state.runwayConfig[runwayId];
  if (!info || !cfg || info.nodes.length < 2) return null;
  return { runwayId, ...orderedRunway(info, cfg) };
}

/** 滑走路が機種に適合し（aircraft/compat.ts）、運用モードが到着・出発を受け付けるか */
function runwayUsable(sim: Simulation, runwayId: string, type: AircraftType, kind: 'arr' | 'dep'): boolean {
  const r = sim.ctx.layout.runways[runwayId];
  const mode = sim.state.runwayConfig[runwayId]!.mode;
  if (!r || checkRunway(type, r).status !== 'ok') return false;
  if (mode === 'closed') return false;
  if (kind === 'arr' && mode === 'departures') return false;
  if (kind === 'dep' && mode === 'arrivals') return false;
  return true;
}

/** 滑走路ノードのうち、誘導路（運用中・機体区分可）が接続しているもの */
function hasTaxiwayLink(sim: Simulation, node: string, size: SizeClass): boolean {
  const net = sim.ctx.network;
  return [...(net.outgoing[node] ?? []), ...(net.incoming[node] ?? [])].some((eid) => {
    const e = net.edges[eid]!;
    return e.kind === 'taxiway' && canAircraftUse(e, size, { operationalOnly: true });
  });
}

/** 着陸後の離脱候補（接地から必要な減速距離以上先のノード）と、そこまでの滑走時間 */
function exitCandidates(sim: Simulation, rw: RunwayEndInfo, type: AircraftType): { node: string; index: number; cost: number }[] {
  const out: { node: string; index: number; cost: number }[] = [];
  for (let i = 1; i < rw.nodes.length; i++) {
    if (rw.dist[i]! < type.landingRollM) continue;
    if (!hasTaxiwayLink(sim, rw.nodes[i]!, type.size)) continue;
    out.push({ node: rw.nodes[i]!, index: i, cost: rw.dist[i]! / 30 });
  }
  return out;
}

/** 離陸の進入候補（残り距離が離陸滑走距離以上のノード）。全長に近いほど優先 */
function entryCandidates(sim: Simulation, rw: RunwayEndInfo, type: AircraftType): Map<string, number> {
  const goals = new Map<string, number>();
  const total = rw.dist[rw.dist.length - 1]!;
  const need = takeoffDistanceM(type) + 100;
  for (let i = 0; i < rw.nodes.length - 1; i++) {
    const remaining = total - rw.dist[i]!;
    if (remaining < need) continue;
    if (!hasTaxiwayLink(sim, rw.nodes[i]!, type.size)) continue;
    goals.set(rw.nodes[i]!, rw.dist[i]! / 30);
  }
  return goals;
}

/** 他機の予約を避けるための判定（閉鎖中の誘導路は常に通れない） */
function blockers(state: SimState, acId: string) {
  return {
    blockedEdge: (e: string) => (state.edgeReservations[e] ?? acId) !== acId,
    blockedNode: (n: string) => (state.nodeReservations[n] ?? acId) !== acId,
  };
}

/** 経路探索の通行止め: 閉鎖中の誘導路（障害・整備）と、avoidTraffic なら他機の予約 */
function pathBlockers(sim: Simulation, acId: string, avoidTraffic: boolean) {
  const closed = sim.state.closures.taxiways;
  const net = sim.ctx.network;
  const isClosed = (e: string) => closed.length > 0 && closed.includes(net.edges[e]!.sourceId);
  if (!avoidTraffic) return closed.length > 0 ? { blockedEdge: isClosed } : {};
  if (sim.ctx.blocks) {
    // 区間ごとの走行: 他機が逆向きに確保している回廊を避ける（交差点・区間の枠は確保の待ちで解決する）
    const mv = { blockedMove: (e: string, from: string) => opposedMove(sim, acId, e, from) };
    return closed.length > 0 ? { blockedEdge: isClosed, ...mv } : mv;
  }
  const b = blockers(sim.state, acId);
  return { blockedEdge: (e: string) => isClosed(e) || b.blockedEdge(e), blockedNode: b.blockedNode };
}

function arrivalPath(sim: Simulation, ac: Aircraft, runwayId: string, standId: string, avoidTraffic: boolean) {
  const type = typeOf(sim, ac);
  const rw = runwayFor(sim, runwayId);
  const stand = sim.ctx.stands[standId];
  if (!rw || !stand) return null;
  const exits = exitCandidates(sim, rw, type);
  if (exits.length === 0) return null;
  const path = findPath(sim.ctx.network, {
    sources: exits.map((e) => ({ node: e.node, cost: e.cost })),
    goals: new Map([[stand.node, 0]]),
    size: type.size,
    codeF: type.codeF,
    speed: type.taxiSpeed,
    allowStands: [standId],
    ...pathBlockers(sim, ac.id, avoidTraffic),
  });
  if (!path) return null;
  const exit = exits.find((e) => e.node === path.nodes[0])!;
  return { rw, exit, path };
}

/** 使用可能な滑走路に、この機種が離陸距離を満たして入れる入口候補が1つでもあるか */
function hasDepartureEntry(sim: Simulation, ac: Aircraft): boolean {
  const type = typeOf(sim, ac);
  for (const id of Object.keys(sim.ctx.runways).sort(compareIds)) {
    if (!runwayUsable(sim, id, type, 'dep')) continue;
    const rw = runwayFor(sim, id);
    if (rw && entryCandidates(sim, rw, type).size > 0) return true;
  }
  return false;
}

export function departurePath(sim: Simulation, ac: Aircraft, avoidTraffic: boolean) {
  const type = typeOf(sim, ac);
  const stand = ac.standId ? sim.ctx.stands[ac.standId] : undefined;
  if (!stand) return null;
  const goals = new Map<string, number>();
  const goalRunway = new Map<string, string>();
  for (const id of Object.keys(sim.ctx.runways).sort(compareIds)) {
    if (!runwayUsable(sim, id, type, 'dep')) continue;
    const rw = runwayFor(sim, id);
    if (!rw) continue;
    for (const [node, cost] of entryCandidates(sim, rw, type)) {
      const queue = Object.values(sim.state.aircraft).filter((a) => a.runwayId === id && (a.state === 'holdShort' || a.state === 'taxiOut')).length;
      if (!goals.has(node) || cost + queue * 60 < goals.get(node)!) {
        goals.set(node, cost + queue * 60);
        goalRunway.set(node, id);
      }
    }
  }
  if (goals.size === 0) return null;
  const path = findPath(sim.ctx.network, {
    sources: [{ node: stand.node, cost: 0 }],
    goals,
    size: type.size,
    codeF: type.codeF,
    speed: type.taxiSpeed,
    allowStands: [stand.id],
    ...pathBlockers(sim, ac.id, avoidTraffic),
  });
  if (!path) return null;
  return { path, runwayId: goalRunway.get(path.nodes[path.nodes.length - 1]!)! };
}

/** スポットに紐付くゲートが故障・閉鎖中か */
function gateClosed(sim: Simulation, standId: string): boolean {
  const g = sim.ctx.standGate[standId];
  return !!g && sim.state.closures.gates.includes(g);
}

/**
 * 到着機にスポットと滑走路を割り当てる。空きスポット（1スポットに1機）のうち、
 * 区分が合い、使用可能な滑走路との間を往復できるものを、サイズの無駄が少ない順・ゲート付き優先で選ぶ。
 */
/**
 * ゲートの国内/国際の適合（フェーズ 4 §4.3・§4.5）。routeType のないゲートは国内扱い。
 * swing ゲートは、現在の種別と違う便を受けるとき切り替え間隔（600 秒）が空いていること。
 * リモートスポットはバスゲートの種別で決まり、バスゲートがない空港では国際便は置けない。
 */
function gateRouteCompatible(sim: Simulation, standId: string, flightRt: 'domestic' | 'international'): boolean {
  const { state, ctx } = sim;
  const gid = ctx.standGate[standId];
  if (!gid) {
    if (ctx.busGates.length === 0) return flightRt === 'domestic';
    return ctx.busGates.some((id) => {
      const rt = ctx.terminal.gates[id]?.routeType ?? 'domestic';
      return flightRt === 'international' ? rt !== 'domestic' : rt !== 'international';
    });
  }
  const rt = ctx.terminal.gates[gid]?.routeType ?? 'domestic';
  if (flightRt === 'international' ? rt === 'domestic' : rt === 'international') return false;
  if (rt === 'swing') {
    const cur = state.swingGates?.[gid];
    if (cur && cur.routeType !== flightRt && state.now < cur.busyUntil + BALANCE.phase4.swingChangeSec) return false;
  }
  return true;
}

function assignStand(sim: Simulation, ac: Aircraft): HoldReason | null {
  const { state, ctx } = sim;
  const type = typeOf(sim, ac);
  const runways = Object.keys(ctx.runways)
    .sort(compareIds)
    .filter((id) => runwayUsable(sim, id, type, 'arr'));
  if (runways.length === 0) return 'noRunway';
  const SIZE_RANK: Record<SizeClass, number> = { S: 1, M: 2, L: 3 };
  const arrival = state.flights[ac.arrivalFlightId]!;
  const planned = arrival.plannedStandId;
  const airlineId = arrival.airlineId;
  const day = Math.floor(state.now / DAY_SEC);
  if (!state.airlineStandHomes || state.airlineStandHomes.day !== day) state.airlineStandHomes = { day, byAirline: {} };
  const homes = airlineId ? (state.airlineStandHomes.byAirline[airlineId] ??= []) : [];
  const homeSet = new Set(homes);
  const homeOwners = new Map<string, string[]>();
  for (const [owner, ids] of Object.entries(state.airlineStandHomes.byAirline)) {
    for (const id of ids) homeOwners.set(id, [...(homeOwners.get(id) ?? []), owner]);
  }
  const homeDistance = (id: string) => {
    const node = ctx.network.nodes[ctx.stands[id]?.node ?? ''];
    if (!node || homes.length === 0) return Infinity;
    return Math.min(...homes.map((homeId) => {
      const homeNode = ctx.network.nodes[ctx.stands[homeId]?.node ?? ''];
      return homeNode ? Math.hypot(node.pos.x - homeNode.pos.x, node.pos.y - homeNode.pos.y) : Infinity;
    }));
  };
  const flightRt = arrival.routeType === 'international' ? 'international' : 'domestic';
  // 候補なしの理由を分ける: 空き自体がないのか、区分が合わないのか、ゲートの国内/国際が合わないのか
  const freeStands = Object.values(ctx.stands).filter(
    (s) => s.entry && !state.standAssignments[s.id] && !state.closures.stands.includes(s.id),
  );
  if (freeStands.length === 0) return 'noStand';
  const sizeOkStands = freeStands.filter((s) => checkStand(type, ctx.layout.stands[s.id]!).status === 'ok');
  if (sizeOkStands.length === 0) return 'standTooSmall';
  if (!sizeOkStands.some((s) => gateRouteCompatible(sim, s.id, flightRt))) return 'gateRouteMismatch';
  // 専用スポット（5-08）: 自契約の専用スポットを優先し、他契約の専用スポットは代替がないときだけ使う
  const myContract = arrival.contractId ? sim.company?.contracts[arrival.contractId] : undefined;
  const dedicatedMine = myContract?.dedicatedStandId;
  const dedicatedOthers = new Set(
    Object.values(sim.company?.contracts ?? {}).filter((k) => k.status === 'active' && k.dedicatedStandId && k.id !== arrival.contractId).map((k) => k.dedicatedStandId!),
  );
  const baseCandidates = Object.values(ctx.stands)
    .filter(
      (s) =>
        s.entry &&
        !state.standAssignments[s.id] &&
        !state.closures.stands.includes(s.id) &&
        checkStand(type, ctx.layout.stands[s.id]!).status === 'ok' &&
        gateRouteCompatible(sim, s.id, flightRt),
    );
  const nonDedicated = baseCandidates.filter((s) => !dedicatedOthers.has(s.id));
  const candidates = (nonDedicated.length > 0 ? nonDedicated : baseCandidates)
    .sort(
      (a, b) =>
        // 運航者が reassignStand で指定したスポットは、ホームスポット等より先に評価する（1-14 / E-3）
        Number(b.id === ac.requestedStandId) - Number(a.id === ac.requestedStandId) ||
        Number(b.id === dedicatedMine) - Number(a.id === dedicatedMine) ||
        Number(gateClosed(sim, a.id)) - Number(gateClosed(sim, b.id)) ||
        Number(!homeSet.has(a.id)) - Number(!homeSet.has(b.id)) ||
        Number(!!homeOwners.get(a.id)?.some((owner) => owner !== airlineId)) - Number(!!homeOwners.get(b.id)?.some((owner) => owner !== airlineId)) ||
        (homeSet.has(a.id) && homeSet.has(b.id) ? homes.indexOf(a.id) - homes.indexOf(b.id) : 0) ||
        (homes.length > 0 ? homeDistance(a.id) - homeDistance(b.id) : 0) ||
        (homeSet.size === 0 ? Number(b.id === planned) - Number(a.id === planned) : 0) ||
        SIZE_RANK[a.size] - SIZE_RANK[b.size] ||
        Number(b.contact) - Number(a.contact) ||
        compareIds(a.id, b.id),
    );
  if (candidates.length === 0) return 'noStand';
  let anyRoute = false;
  for (const s of candidates) {
    // 到着経路があり、出発もできるスポット
    const queueLen = (id: string) =>
      Object.values(state.aircraft).filter((a) => a.runwayId === id && ['inbound', 'holding', 'approach'].includes(a.state)).length;
    let best: { runwayId: string; cost: number } | null = null;
    for (const r of runways) {
      const p = arrivalPath(sim, ac, r, s.id, false);
      if (p && (!best || p.path.cost + queueLen(r) * 120 < best.cost)) best = { runwayId: r, cost: p.path.cost + queueLen(r) * 120 };
    }
    if (!best) continue;
    anyRoute = true;
    const prevStand = ac.standId;
    ac.standId = s.id;
    const dep = departurePath(sim, ac, false);
    ac.standId = prevStand;
    if (!dep) continue;
    state.standAssignments[s.id] = ac.id;
    ac.standId = s.id;
    // swing ゲートの現在の種別と占有終了を記録する（次の切り替え判定に使う）
    const swingGateId = ctx.standGate[s.id];
    if (swingGateId && ctx.terminal.gates[swingGateId]?.routeType === 'swing') {
      const depF = state.flights[ac.departureFlightId];
      (state.swingGates ??= {})[swingGateId] = { routeType: flightRt, busyUntil: depF?.estimated ?? depF?.scheduled ?? state.now };
    }
    if (ac.requestedStandId === s.id) delete ac.requestedStandId; // 指定したスポットへ割り当てられた
    ac.runwayId = best.runwayId;
    const arr = state.flights[ac.arrivalFlightId]!;
    arr.standId = s.id;
    arr.runwayId = best.runwayId;
    state.flights[ac.departureFlightId]!.standId = s.id;
    if (airlineId) {
      const fromExistingHome = homeSet.has(s.id);
      if (!fromExistingHome) {
        const occupiedUsableHome = homes.some((id) => !!state.standAssignments[id] && ctx.stands[id]?.operational && !state.closures.stands.includes(id) && checkStand(type, ctx.layout.stands[id]!, ctx.network).status === 'ok');
        const reason: NonNullable<SimState['events'][number]['standAssignmentReason']> = homes.length === 0
          ? 'initial'
          : occupiedUsableHome ? 'overflow' : 'fallback';
        if (reason === 'fallback') homes.unshift(s.id);
        else homes.push(s.id);
        logEvent(state, {
          t: state.now,
          kind: 'standAssigned',
          aircraftId: ac.id,
          airlineId,
          standId: s.id,
          standAssignmentReason: reason,
          note: `${ac.callsign}: ${reason === 'initial' ? '初回ホームスポット' : reason === 'overflow' ? '同社便の追加スポット' : 'ホームスポット利用不能の代替'}として ${s.id} を割当`,
        });
      } else {
        logEvent(state, {
          t: state.now,
          kind: 'standAssigned',
          aircraftId: ac.id,
          airlineId,
          standId: s.id,
          standAssignmentReason: 'home',
          note: `${ac.callsign}: ${s.id} は ${airlineId} のホームスポット`,
        });
      }
    }
    return null;
  }
  // 到着経路はあるのに全候補で出発経路が作れない場合は、スポット不足ではなく出発経路の問題として返す
  return anyRoute ? 'noDepartureRoute' : 'noRoute';
}

// ---------------------------------------------------------------- 1ティック

export function stepSimulation(sim: Simulation): void {
  const { state } = sim;
  const day = Math.floor(state.now / DAY_SEC);
  if (!state.airlineStandHomes || state.airlineStandHomes.day !== day) state.airlineStandHomes = { day, byAirline: {} };
  if (sim.company) {
    // 0:00 に日次締めを行い、その日の運航計画を作る
    if (stepEconomy(sim, (key) => serversOf(sim, key)) && state.settings.autoSchedule) generateDaySchedule(sim, day);
  } else if (state.settings.autoSchedule && state.now % DAY_SEC >= 23 * 3600) generateDaySchedule(sim, day + 1);

  const all = sortedValues(state.aircraft);
  for (const ac of all) {
    ac.px = ac.x;
    ac.py = ac.y;
    ac.pheading = ac.heading;
  }
  stepDisruptions(sim);
  if (state.wx) stepWeather(sim, cancelTurnaround);
  runwayControl(sim);
  if (state.taxiBlocks) {
    taxiBlockControl(sim);
    // 規則 4: 停止の検出と解消（5 秒ごと。待機機だけ）
    if (state.now % RETRY_SEC === 0) {
      for (const r of detectTaxiStall(sim)) {
        if (r.action === 'unresolved') logEvent(state, { t: state.now, kind: 'disruption', aircraftId: r.aircraftId, note: `taxiGridlock: ${r.cycle.join(',')}` });
      }
    }
  }
  for (const ac of all) stepAircraft(sim, ac);
  stepPassengers(sim);
  if (state.bus) stepApronBuses(sim);
  for (const g of stepAccess(sim)) completeExit(sim, g);
  stepBaggage(sim);
  stepGround(sim);
  detectConflicts(sim);
  stepAnalytics(sim);
  state.now += TICK_SEC;
}

/**
 * 滑走路 rid の離陸待ちの列（先頭 = 次に離陸許可を得る機体）。待ち始めた順（同じなら ID 順）。
 * nightOps.prioritizeAtRisk のときだけ、持ち越しの危険がある機体（予測離陸が制限開始の warnLeadMin 分前を越える）を先にする。既定 false では並びは変わらない。
 */
export function departureQueue(sim: Simulation, rid: string, aircraft: Aircraft[] = sortedValues(sim.state.aircraft)): Aircraft[] {
  const queue = aircraft
    .filter((a) => a.state === 'holdShort' && a.runwayId === rid)
    .sort((a, b) => a.queuedSince! - b.queuedSince! || compareIds(a.id, b.id));
  if (nightOpsOf(sim)?.prioritizeAtRisk) queue.sort((a, b) => Number(atRiskForNight(sim, b)) - Number(atRiskForNight(sim, a)) || a.queuedSince! - b.queuedSince! || compareIds(a.id, b.id));
  return queue;
}

/** 滑走路ごとの出発・横断の許可（到着の進入許可は到着機側の処理で行う） */
function runwayControl(sim: Simulation): void {
  const { state } = sim;
  const aircraft = sortedValues(state.aircraft);
  for (const rid of Object.keys(state.runways).sort(compareIds)) {
    const rs = state.runways[rid]!;
    // 出発: 離陸待ちの先頭（到着順）
    const queue = departureQueue(sim, rid, aircraft);
    const head = queue[0];
    if (head) {
      let reason = departureBlocked(sim, rid, typeOf(sim, head), head);
      // 区間ごとの走行: 整列の進入ノードを確保してから整列に入る（他機の横断・予約と重ならない）
      if (!reason && sim.ctx.blocks && head.route) {
        const node = head.route.nodes[head.route.nodes.length - 1]!;
        if ((state.nodeReservations[node] ?? head.id) !== head.id) reason = 'runwayBusy';
        else state.nodeReservations[node] = head.id;
      }
      if (!reason) {
        rs.occupant = { aircraftId: head.id, purpose: 'takeoff', since: state.now };
        setHold(state, head, null);
        setState(state, head, 'lineUp');
      } else {
        // 夜間のスポット待機の予測が外れて滑走路手前で夜間待機になった機体（取りこぼし）を数える（block のときだけ統計を持つ）
        if (reason === 'noiseCurfew' && head.holdReason !== 'noiseCurfew' && nightOpsOf(sim) && state.taxiBlocks) state.taxiBlocks.stats.nightStranded++;
        setHold(state, head, reason);
        if (reason === 'noiseCurfew') addDelayCause(state.flights[head.departureFlightId]!, 'noiseRestriction');
        else if (state.now - head.queuedSince! > 5 * 60) addDelayCause(state.flights[head.departureFlightId]!, 'runwayQueue');
      }
      for (const other of queue.slice(1)) setHold(state, other, 'runwayBusy');
    }
    // 横断: 停止位置の手前 100m 以内まで来た機体
    for (const ac of aircraft) {
      const req = pendingCrossing(sim, ac);
      if (!req || req.runwayId !== rid || req.distToHold > 100) continue;
      // 交差点ノードで横断するときは、交差する滑走路も同時に予約する（すべて空いているときだけ。部分的な予約はしない）
      // 連続横断: 次の滑走路の停止位置がこの滑走路の解放位置より手前なら（間で止まれない）、まとめて予約する
      const chain = crossingChain(sim, ac, req.index);
      const free = chain.every((c) => [c.runwayId, ...(c.alsoRunwayIds ?? [])].every((id) => {
        const s = state.runways[id]!;
        return !s.occupant && (!s.booking || s.booking.eta - state.now >= CROSSING_WINDOW_SEC);
      }));
      // 区間ごとの走行: 向こう側の入口の小片から、止まれる最初の区間までのチェーンを確保できるときだけ許可する（滑走路上で止まらない）
      if (free && sim.ctx.blocks && ac.route && acquireNext(sim, ac, { allowAfterRunway: true }).ok === false) continue;
      if (free) {
        for (const c of chain) for (const id of [c.runwayId, ...(c.alsoRunwayIds ?? [])]) state.runways[id]!.occupant = { aircraftId: ac.id, purpose: 'crossing', since: state.now };
        if (ac.crossing) (ac.heldCrossings ??= []).push(ac.crossing);
        if (chain.length > 1) (ac.heldCrossings ??= []).push(...chain.slice(0, -1));
        ac.crossing = chain[chain.length - 1]!;
        if (ac.holdReason === 'crossing') setHold(state, ac, null);
      }
    }
  }
}

/**
 * 区間ごとの走行（taxiMode 'block'）: 停止位置が近づいた機体の次のチェーンの確保を、待ち始めた順（同じなら ID 順）にまとめて試す。
 * 確保できない機体は、止まっているときだけ待機の理由（blockFull）を付ける。
 */
function taxiBlockControl(sim: Simulation): void {
  const { state } = sim;
  const reqs: Aircraft[] = [];
  for (const ac of sortedValues(state.aircraft)) {
    if (!ac.route || !['taxiOut', 'taxiIn', 'vacating', 'landing'].includes(ac.state)) continue;
    const d = pendingChainDistance(sim, ac);
    if (d === null) continue;
    const brake = (ac.speed * ac.speed) / (2 * TAXI_DECEL);
    if (d < brake + BLOCK_REQUEST_AHEAD_M) reqs.push(ac);
  }
  reqs.sort((a, b) => (a.waitSince ?? state.now) - (b.waitSince ?? state.now) || compareIds(a.id, b.id));
  for (const ac of reqs) {
    const res = acquireNext(sim, ac);
    if (res.ok === true) {
      if (ac.holdReason === 'blockFull' || ac.holdReason === 'opposingTraffic') setHold(state, ac, null);
    } else if (res.ok === false && ac.speed < 0.5) {
      setHold(state, ac, res.reason);
      const f = state.flights[ac.state === 'taxiOut' ? ac.departureFlightId : ac.arrivalFlightId];
      if (f) addDelayCause(f, 'taxiCongestion');
    }
  }
}

/** 区間ごとの走行: 追従で止まっている機体の待機の理由（前の機体が滑走路手前の列なら runwayQueue、満杯の列なら blockFull）。動き出したら外す */
function blockHoldReason(sim: Simulation, ac: Aircraft): void {
  const { state } = sim;
  const bl = blockMovementLimit(sim, ac);
  const stopped = ac.speed < 0.5 && ac.dist >= Math.min(bl.limit, Infinity) - 1;
  if (bl.cause === 'follow' && stopped && bl.leader) {
    const p = state.aircraft[bl.leader]!;
    const reason: HoldReason | null = p.state === 'holdShort' || p.state === 'lineUp' || p.holdReason === 'runwayQueue' ? 'runwayQueue' : p.holdReason === 'blockFull' ? 'blockFull' : null;
    if (reason) {
      setHold(state, ac, reason);
      const f = state.flights[ac.state === 'taxiOut' ? ac.departureFlightId : ac.arrivalFlightId];
      if (f) addDelayCause(f, HOLD_TO_DELAY[reason]!);
    }
    return;
  }
  if (ac.speed >= 0.5 && ac.holdReason && ['blockFull', 'opposingTraffic', 'runwayQueue'].includes(ac.holdReason)) setHold(state, ac, null);
}

function departureBlocked(sim: Simulation, rid: string, type: AircraftType, aircraft: Aircraft): HoldReason | null {
  const size = type.size;
  const { state } = sim;
  const rs = state.runways[rid]!;
  if (sim.company?.city) {
    if (isCityNightMovement(state.now + lineUpToAirborneSec(sim, aircraft))) return 'noiseCurfew';
  }
  if (!runwayUsable(sim, rid, type, 'dep')) return 'runwayBusy';
  if (rs.occupant && rs.occupant.aircraftId !== aircraft.id) return 'runwayBusy';
  if (rs.booking && rs.booking.eta - state.now < DEPARTURE_WINDOW_SEC) return 'runwayBusy';
  // 交差する滑走路（従属運用: 2 本の離着陸を 1 本とみなす。自由形が関与する交差だけ）
  const partners = partnersOf(sim, rid);
  for (const p of partners) {
    const ps = state.runways[p]!;
    // 自分自身の横断占有は妨げにならない（出発滑走路へ向けて横断中の機体が、自分の横断を理由に永遠に整列できない）
    if (ps.occupant && ps.occupant.aircraftId !== aircraft.id) return 'intersection';
    if (ps.booking && ps.booking.eta - state.now < DEPARTURE_WINDOW_SEC) return 'intersection';
  }
  const wx = weatherEffects(state).separation;
  if (rs.lastOp?.kind === 'dep' && state.now < rs.lastOp.at + SEPARATION_SEC[rs.lastOp.size][size] * wx) return 'separation';
  for (const p of partners) {
    const l = state.runways[p]!.lastOp;
    if (l?.kind === 'dep' && state.now < l.at + SEPARATION_SEC[l.size][size] * wx) return 'separation';
  }
  return null;
}

/** 到着機の進入許可の判定（理由を返す。null なら許可） */
function approachBlocked(sim: Simulation, ac: Aircraft, rid: string, eta: number): HoldReason | null {
  const { state } = sim;
  const rs = state.runways[rid]!;
  const size = typeOf(sim, ac).size;
  if (!runwayUsable(sim, rid, typeOf(sim, ac), 'arr')) return 'runwayBusy';
  if (rs.booking) return 'separation';
  // 交差する滑走路（従属運用。自由形が関与する交差だけ）: 進入できる到着は組全体で 1 機、離着陸中なら待つ
  const partners = partnersOf(sim, rid);
  for (const p of partners) {
    const ps = state.runways[p]!;
    if (ps.booking) return 'intersection';
    if (ps.occupant?.purpose === 'crossing') return 'intersection';
    if (ps.occupant) return 'runwayBusy';
  }
  const group = partners.length === 0 ? null : [rid, ...partners];
  const inGroup = (id: string | null): boolean => (group ? id !== null && group.includes(id) : id === rid);
  // 進入順: 同じ滑走路（交差する滑走路を含む）の待機機のうち、予定の早い順
  const ahead = Object.values(state.aircraft).some(
    (o) =>
      o.id !== ac.id &&
      inGroup(o.runwayId) &&
      (o.state === 'inbound' || o.state === 'holding') &&
      o.standId &&
      state.now >= arrivalReadyAt(state, o) &&
      (arrivalReadyAt(state, o) < arrivalReadyAt(state, ac) ||
        (arrivalReadyAt(state, o) === arrivalReadyAt(state, ac) && compareIds(o.id, ac.id) < 0)),
  );
  if (ahead) return 'separation';
  const starving = Object.values(state.aircraft).some(
    (o) => o.state === 'holdShort' && inGroup(o.runwayId) && state.now - o.queuedSince! >= DEPARTURE_STARVATION_SEC,
  );
  if (starving) return 'departurePriority';
  const last = rs.lastOp;
  // 天候で間隔を広げる（ゲーム値。sim/disruptions.ts の WEATHER_EFFECTS）
  const wx = weatherEffects(state).separation;
  if (last?.kind === 'arr' && eta < last.at + SEPARATION_SEC[last.size][size] * wx) return 'separation';
  if (last?.kind === 'dep' && eta < last.at + ARRIVAL_AFTER_DEPARTURE_SEC * wx) return 'separation';
  // 整列中の出発機は、これから滑走を始める
  if (rs.occupant?.purpose === 'takeoff' && eta < state.now + LINEUP_ALIGN_SEC + 30 + ARRIVAL_AFTER_DEPARTURE_SEC) return 'runwayBusy';
  for (const p of partners) {
    const l = state.runways[p]!.lastOp;
    if (l?.kind === 'arr' && eta < l.at + SEPARATION_SEC[l.size][size] * wx) return 'separation';
    if (l?.kind === 'dep' && eta < l.at + ARRIVAL_AFTER_DEPARTURE_SEC * wx) return 'separation';
  }
  return null;
}

/** 交差する（従属運用の）滑走路 ID。従来形だけのレイアウトでは常に空 */
function partnersOf(sim: Simulation, rid: string): string[] {
  const list = sim.ctx.crossingsByRunway[rid];
  return list ? list.map((c) => (c.a === rid ? c.b : c.a)) : [];
}

/** 到着機が進入を始められる時刻（予定時刻 − 進入所要時間） */
function arrivalReadyAt(state: SimState, ac: Aircraft): number {
  return state.flights[ac.arrivalFlightId]!.estimated - APPROACH_SEC;
}

function stepAircraft(sim: Simulation, ac: Aircraft): void {
  const { state } = sim;
  const type = typeOf(sim, ac);
  switch (ac.state) {
    case 'scheduled': {
      const arr = state.flights[ac.arrivalFlightId]!;
      if (state.now >= arr.estimated - INBOUND_LEAD_SEC) {
        // 夜間にかかる到着は出発地で待機させ、朝に現れる（city.nightOps のときだけ。上空で一晩待たない）
        if (nightOpsOf(sim) && isCityNightMovement(arr.estimated)) {
          holdAtOrigin(sim, ac);
          return;
        }
        arr.status = 'active';
        setState(state, ac, 'inbound');
        logEvent(state, { t: state.now, kind: 'spawn', aircraftId: ac.id });
        placeAirborne(sim, ac);
      }
      return;
    }
    case 'inbound':
    case 'holding':
      stepInbound(sim, ac);
      placeAirborne(sim, ac);
      return;
    case 'approach': {
      const rs = state.runways[ac.runwayId!]!;
      if (state.now >= ac.eta!) {
        if (!rs.occupant && !partnersOf(sim, ac.runwayId!).some((p) => { const o = state.runways[p]!.occupant; return !!o && o.purpose !== 'crossing'; })) {
          // 天候 5 段階: 着陸の瞬間に、段階に応じた確率で着陸復行（state.wx がなければ判定しない）
          if (state.wx && rollWeatherGoAround(state)) {
            goAround(sim, ac, 'weather');
            placeAirborne(sim, ac);
            return;
          }
          rs.occupant = { aircraftId: ac.id, purpose: 'landing', since: state.now };
          rs.lastOp = { kind: 'arr', size: type.size, at: state.now };
          rs.booking = null;
          ac.dist = 0;
          ac.speed = type.approachSpeed;
          const arr = state.flights[ac.arrivalFlightId]!;
          arr.actual = state.now;
          onLanding(sim, ac);
          setState(state, ac, 'landing');
          placeOnRoute(sim, ac);
        } else {
          // 滑走路（交差する滑走路を含む）が空いていなければ着陸復行
          goAround(sim, ac);
          placeAirborne(sim, ac);
        }
      } else {
        placeAirborne(sim, ac);
      }
      return;
    }
    case 'landing': {
      const r = ac.route!;
      const exitDist = r.cum[r.runwayEnd]!;
      const a = (type.approachSpeed ** 2 - EXIT_SPEED ** 2) / (2 * Math.max(1, exitDist));
      ac.speed = Math.max(EXIT_SPEED, ac.speed - a * TICK_SEC);
      ac.dist = Math.min(ac.dist + ac.speed * TICK_SEC, movementLimit(sim, ac));
      placeOnRoute(sim, ac);
      if (ac.dist >= exitDist) setState(state, ac, 'vacating');
      return;
    }
    case 'vacating': {
      moveTaxi(sim, ac);
      const r = ac.route!;
      const exitIdx = r.runwayEnd;
      if (ac.dist >= r.cum[exitIdx]! + Math.max(holdShortOnRoute(sim.ctx, r, exitIdx, 1), type.lengthM)) {
        const rs = state.runways[ac.runwayId!]!;
        if (rs.occupant?.aircraftId === ac.id) rs.occupant = null;
        ac.taxiStartedAt = state.now;
        setState(state, ac, 'taxiIn');
      }
      return;
    }
    case 'taxiIn': {
      moveTaxi(sim, ac);
      const r = ac.route!;
      if (ac.dist >= r.cum[r.nodes.length - 2]!) setState(state, ac, 'docking');
      return;
    }
    case 'docking': {
      moveTaxi(sim, ac);
      const r = ac.route!;
      if (ac.dist >= routeLength(r) - 0.01) {
        if (ac.crossing || ac.heldCrossings) { releaseOpenCrossings(sim, ac); }
        releaseAll(state, ac.id);
        ac.route = null;
        ac.speed = 0;
        const arr = state.flights[ac.arrivalFlightId]!;
        arr.block = state.now;
        arr.status = 'completed';
        state.stats.arrivals++;
        if (ac.taxiStartedAt !== null) state.stats.taxiInSecTotal += state.now - ac.taxiStartedAt;
        ac.taxiStartedAt = null;
        placeAtStand(sim, ac);
        ac.timerUntil = state.now + 60;
        setState(state, ac, 'parked');
        createTurnaroundTasks(sim, ac);
      }
      return;
    }
    case 'parked':
      if (state.now >= ac.timerUntil!) {
        ac.timerUntil = null;
        setState(state, ac, 'turnaround');
      }
      return;
    case 'turnaround':
      // 出発準備完了 = プッシュバック以外の地上作業がすべて完了
      if (allTurnaroundDone(state, ac.id)) {
        const dep = state.flights[ac.departureFlightId]!;
        const tasks = tasksOf(state, ac.id).filter((t) => t.kind !== 'pushback');
        const critical = tasks.reduce((a, b) => ((b.doneAt ?? 0) > (a.doneAt ?? 0) ? b : a));
        dep.readyAt = state.now;
        dep.criticalTask = critical.kind;
        if (state.now > dep.scheduled) {
          addDelayCause(dep, critical.kind === 'board' ? 'boarding' : 'groundHandling');
          state.groundStats.lateReadyFlights++;
          state.groundStats.lateReadySec += state.now - dep.scheduled;
        }
        dep.estimated = dep.nightHold ? Math.max(dep.estimated, dep.scheduled, state.now) : Math.max(dep.scheduled, state.now);
        setState(state, ac, 'readyForPushback');
        return;
      }
      // 夜間のスポット待機: 搭乗を始める前に、予測離陸が夜間なら止める（早い判定。city.nightOps のときだけ）
      if (nightOpsOf(sim)) {
        const dep = state.flights[ac.departureFlightId]!;
        const lead = BOARDING_LEAD_MIN[type.size] * 60 + 300;
        if (state.now >= dep.estimated - lead && !(dep.nightHold && state.now < dep.nightHold.releaseAt)) holdDepartureAtStand(sim, ac);
      }
      return;
    case 'readyForPushback':
      stepReadyForPushback(sim, ac);
      return;
    case 'pushback': {
      const r = ac.route!;
      if (ac.timerUntil === null) {
        ac.speed = PUSHBACK_SPEED;
        ac.dist = Math.min(ac.dist + PUSHBACK_SPEED * TICK_SEC, r.cum[1]!);
        placeOnRoute(sim, ac, true);
        if (ac.dist >= r.cum[1]!) {
          ac.speed = 0;
          ac.timerUntil = state.now + ENGINE_START_SEC;
        }
      } else if (state.now >= ac.timerUntil) {
        ac.timerUntil = null;
        // スポットを離れたので割り当てを解除する
        if (ac.standId && state.standAssignments[ac.standId] === ac.id) delete state.standAssignments[ac.standId];
        ac.standId = null;
        ac.taxiStartedAt = state.now;
        completePushback(sim, ac.id);
        setState(state, ac, 'taxiOut');
      }
      return;
    }
    case 'taxiOut': {
      moveTaxi(sim, ac);
      const r = ac.route!;
      const limit = movementLimit(sim, ac);
      const runwayHoldAt = r.cum[r.nodes.length - 1]! - holdShortOnRoute(sim.ctx, r, r.nodes.length - 1, -1);
      let holdAt = runwayHoldAt;
      if (sim.ctx.blocks) {
        // 滑走路手前の区間の終わりが停止位置より手前なら、そこで止まる（区間の外へは出ない）
        const refs = routeBlocks(sim.ctx, r).refs;
        const lastRef = refs[refs.length - 1];
        if (lastRef && lastRef.exitDist < holdAt) holdAt = lastRef.exitDist;
      }
      // 横断許可を得て区間の終わりを越え、滑走路の停止位置まで進んだ場合も列に加わる。
      // 区間の終わりだけを見ると、停止位置で止まった機体がいつまでも holdShort へ移らず、
      // 横断中の滑走路を占有したまま後続の着陸を永遠に妨げる（freeShallow のデッドロック）
      const stoppedAt = (p: number) => ac.dist >= p - 0.01 && limit <= p + 0.01;
      if (stoppedAt(holdAt) || stoppedAt(runwayHoldAt)) {
        ac.speed = 0;
        ac.queuedSince = state.now;
        setState(state, ac, 'holdShort');
      }
      return;
    }
    case 'holdShort':
      return;
    case 'lineUp': {
      const r = ac.route!;
      const end = routeLength(r);
      if (ac.timerUntil === null) {
        ac.speed = LINEUP_SPEED;
        ac.dist = Math.min(ac.dist + LINEUP_SPEED * TICK_SEC, end);
        placeOnRoute(sim, ac);
        if (ac.dist >= end) {
          ac.speed = 0;
          ac.timerUntil = state.now + LINEUP_ALIGN_SEC;
        }
      } else if (state.now >= ac.timerUntil) {
        startTakeoff(sim, ac);
      }
      return;
    }
    case 'takeoff': {
      ac.speed += type.takeoffAccel * TICK_SEC;
      ac.dist += ac.speed * TICK_SEC;
      placeOnRoute(sim, ac);
      if (ac.dist >= takeoffDistanceM(type)) {
        const rs = state.runways[ac.runwayId!]!;
        if (rs.occupant?.aircraftId === ac.id) rs.occupant = null;
        const dep = state.flights[ac.departureFlightId]!;
        dep.actual = state.now;
        dep.status = 'completed';
        state.stats.departures++;
        onTakeoff(sim, ac);
        setState(state, ac, 'departed');
      }
      return;
    }
    case 'departed':
      if (state.now - ac.stateSince < DEPARTED_DESPAWN_SEC && ac.route) {
        ac.speed = Math.min(ac.speed + 1, 90);
        ac.dist += ac.speed * TICK_SEC;
        placeOnRoute(sim, ac);
      } else {
        ac.route = null;
      }
      return;
    default:
      return;
  }
}

function stepInbound(sim: Simulation, ac: Aircraft): void {
  const { state } = sim;
  const arr = state.flights[ac.arrivalFlightId]!;
  const dep = state.flights[ac.departureFlightId]!;
  const ready = state.now >= arr.estimated - APPROACH_SEC;
  // 上空の夜間待機の上限（city.nightOps のときだけ）: 超えたらダイバート。既存の HOLD_DIVERT_SEC の判定とは別（夜間待機の時間は数えない）
  const nightCap = nightOpsOf(sim);
  if (nightCap && arr.nightHold?.kind === 'airborne' && ac.holdReason === 'noiseCurfew' && state.now - arr.nightHold.decidedAt >= nightCap.airborneHoldMaxMin * 60) {
    divert(sim, ac);
    return;
  }

  if (ready && sim.company?.city && isCityNightMovement(state.now + APPROACH_SEC)) {
    const allowedAt = nextCityMovementTime(state.now + APPROACH_SEC);
    arr.estimated = allowedAt;
    dep.estimated = Math.max(dep.scheduled, allowedAt + typeOf(sim, ac).turnaroundSec);
    ac.retryAt = Math.max(state.now + 1, allowedAt - APPROACH_SEC);
    setHold(state, ac, 'noiseCurfew');
    addDelayCause(arr, 'noiseRestriction');
    // 上空の夜間待機の始まりを記録する（上限の判定は関数の先頭）
    if (nightOpsOf(sim)) arr.nightHold ??= { kind: 'airborne', decidedAt: state.now, releaseAt: allowedAt };
    return;
  }

  if (!ac.standId && state.now >= ac.retryAt) {
    const reason = assignStand(sim, ac);
    if (reason) {
      ac.retryAt = state.now + 30;
      if (ready) holdArrival(sim, ac, reason);
    }
  }
  if (ac.standId && ac.runwayId && ready && state.now >= ac.retryAt) {
    const eta = state.now + APPROACH_SEC;
    let reason = approachBlocked(sim, ac, ac.runwayId, eta);
    let blkReason: HoldReason | null = null;
    if (!reason) {
      // 着陸後に滑走路を離脱してスポットまで行ける経路を先に確保する
      const p = arrivalPath(sim, ac, ac.runwayId, ac.standId, true);
      if (p) {
        const nodes = [...p.rw.nodes.slice(0, p.exit.index), ...p.path.nodes];
        const runwayEdges: string[] = [];
        for (let i = 0; i < p.exit.index; i++) runwayEdges.push(edgeBetween(sim, p.rw.nodes[i]!, p.rw.nodes[i + 1]!));
        const route = makeRoute(sim.ctx, 'landing', nodes, [...runwayEdges, ...p.path.edges], p.exit.index);
        const parts = reservableParts(sim.ctx, route, p.exit.index);
        // 区間ごとの走行: 全回廊の向き + 出口の小片・解放位置を越えて止まれる最初の区間までのチェーンを確保する（スポットまでの全区間の枠は要求しない）
        const blk = sim.ctx.blocks ? acquireRoute(sim, ac, route) : null;
        if (blk && !blk.ok) blkReason = blk.reason;
        if (blk ? blk.ok : isFree(state, ac.id, parts)) {
          if (!blk) reserve(state, ac.id, parts);
          route.released = p.exit.index;
          ac.route = route;
          ac.dist = 0;
          ac.eta = eta;
          state.runways[ac.runwayId]!.booking = { aircraftId: ac.id, eta };
          arr.estimated = Math.max(arr.estimated, eta);
          dep.estimated = Math.max(dep.scheduled, arr.estimated + typeOf(sim, ac).turnaroundSec + 60);
          setHold(state, ac, null);
          setState(state, ac, 'approach');
          return;
        }
      }
      reason = arrivalPath(sim, ac, ac.runwayId, ac.standId, false) ? (sim.ctx.blocks ? blkReason ?? 'opposingTraffic' : 'routeBusy') : 'noRoute';
    }
    ac.retryAt = state.now + RETRY_SEC;
    holdArrival(sim, ac, reason);
  }
  if (ac.holdReason !== 'noiseCurfew' && ac.waitSince !== null && state.now - ac.waitSince >= HOLD_DIVERT_SEC) {
    divert(sim, ac);
  }
}

function holdArrival(sim: Simulation, ac: Aircraft, reason: HoldReason): void {
  const { state } = sim;
  setHold(state, ac, reason);
  const arr = state.flights[ac.arrivalFlightId]!;
  const cause = HOLD_TO_DELAY[reason];
  if (cause) addDelayCause(arr, cause);
  arr.estimated = Math.max(arr.estimated, state.now + APPROACH_SEC);
  if (ac.state !== 'holding') setState(state, ac, 'holding', reason);
}

function goAround(sim: Simulation, ac: Aircraft, reason?: HoldReason): void {
  const { state } = sim;
  const rs = state.runways[ac.runwayId!]!;
  if (rs.booking?.aircraftId === ac.id) rs.booking = null;
  releaseAll(state, ac.id);
  ac.route = null;
  ac.eta = null;
  ac.retryAt = state.now + 4 * 60;
  state.stats.goArounds++;
  if (reason === 'weather') addExternalDelay(state.flights[ac.arrivalFlightId]!, 'weather', 4 * 60);
  logEvent(state, { t: state.now, kind: 'goAround', aircraftId: ac.id, ...(reason ? { reason } : {}) });
  holdArrival(sim, ac, 'goAround');
}

/**
 * 機体がまだ現れていない折り返し（到着・出発）をまとめて欠航にする（docs/30 §1）。到着・出発の便は cancelled、機体は cannotOperate。
 * - 'weather': 天候 5 段階の欠航。補償は他の欠航と同じ（満足度のペナルティは半分。ops.ts の AirlineDayResult.weatherCancelled）。
 * - 'early': プレイヤーの先行欠航（運航表の行メニュー）。補償なし・航空会社の満足度 −1 だけ（直前の欠航より安い。日の締めで 1 回だけ引く）。
 */
export function cancelTurnaround(sim: Simulation, ac: Aircraft, reason: 'weather' | 'early'): void {
  const { state } = sim;
  if (ac.state !== 'scheduled') return;
  const arr = state.flights[ac.arrivalFlightId]!;
  const dep = state.flights[ac.departureFlightId]!;
  arr.status = 'cancelled';
  dep.status = 'cancelled';
  state.stats.cancelled++;
  if (reason === 'weather') {
    addDelayCause(arr, 'weather');
    addDelayCause(dep, 'weather');
    onFlightLost(sim);
    logEvent(state, { t: state.now, kind: 'cannotOperate', aircraftId: ac.id, reason: 'weather' });
  } else {
    // 満足度の −1 は日の締めで引く（AirlineDayResult.earlyCancelled。ここで引くと二重になる）
    logEvent(state, { t: state.now, kind: 'cannotOperate', aircraftId: ac.id, note: 'early' });
  }
  setState(state, ac, 'cannotOperate', reason);
}

/** 先行欠航（プレイヤーの対応。まだ現れていない折り返しだけ。補償なし・満足度 −1。会社のゲーム設定があるときだけ） */
export function cancelFlightEarly(sim: Simulation, acId: string): ResponseResult {
  const ac = sim.state.aircraft[acId];
  if (!ac || !sim.company?.game) return { ok: false, reason: 'NOT_FOUND' };
  if (ac.state !== 'scheduled') return { ok: false, reason: 'TOO_LATE' };
  cancelTurnaround(sim, ac, 'early');
  logEvent(sim.state, { t: sim.state.now, kind: 'disruption', note: `先行欠航: ${ac.callsign}` });
  return { ok: true };
}

function divert(sim: Simulation, ac: Aircraft): void {
  const { state } = sim;
  releaseEverything(sim, ac);
  state.flights[ac.arrivalFlightId]!.status = 'diverted';
  state.flights[ac.departureFlightId]!.status = 'cancelled';
  state.stats.diverted++;
  onFlightLost(sim);
  logEvent(state, { t: state.now, kind: 'diverted', aircraftId: ac.id, ...(ac.holdReason ? { reason: ac.holdReason } : {}) });
  setState(state, ac, 'diverted', ac.holdReason ?? undefined);
}

function releaseEverything(sim: Simulation, ac: Aircraft): void {
  const { state } = sim;
  cancelTasks(sim, ac.id);
  releaseAll(state, ac.id);
  if (ac.standId && state.standAssignments[ac.standId] === ac.id) delete state.standAssignments[ac.standId];
  for (const rs of Object.values(state.runways)) {
    if (rs.booking?.aircraftId === ac.id) rs.booking = null;
    if (rs.occupant?.aircraftId === ac.id) rs.occupant = null;
  }
  ac.route = null;
  ac.standId = null;
  ac.crossing = null;
  delete ac.heldCrossings;
}

/**
 * 夜間のスポット待機（フェーズ 2、R8・R9(a)。city.nightOps があるときだけ呼ぶ）: 予測離陸（プッシュバック開始 + 標準の所要 + 列 + 余裕）が夜間なら、
 * スポットを離れず翌朝まで待つ。持つのはスポットだけ（誘導路・区間・滑走路・トーイングカーは持たない）。止めたら true。
 */
function holdDepartureAtStand(sim: Simulation, ac: Aircraft, path?: { nodes: string[]; edges: string[] }): boolean {
  const { state } = sim;
  const dep = state.flights[ac.departureFlightId]!;
  const pred = predictTakeoffAt(sim, ac, Math.max(state.now, dep.estimated), path);
  if (pred === null || !isCityNightMovement(pred)) return false;
  const releaseAt = standReleaseAt(sim, ac);
  dep.estimated = Math.max(dep.estimated, releaseAt);
  dep.nightHold = { kind: 'stand', decidedAt: state.now, releaseAt };
  setHold(state, ac, 'noiseCurfew');
  addDelayCause(dep, 'noiseRestriction');
  ac.retryAt = Math.max(ac.retryAt, releaseAt - PUSHBACK_DISPATCH_LEAD_SEC);
  cancelPushbackTask(sim, ac.id);
  return true;
}

/** 夜間にかかる到着を、出発地で待たせて朝に現れさせる（R10）。同じ朝の順番は SEPARATION_SEC[L][L] ずつずらす */
function holdAtOrigin(sim: Simulation, ac: Aircraft): void {
  const { state } = sim;
  const arr = state.flights[ac.arrivalFlightId]!;
  const dep = state.flights[ac.departureFlightId]!;
  const morning = nextCityMovementTime(arr.estimated);
  let last = -Infinity;
  for (const f of Object.values(state.flights)) {
    if (f.id === arr.id || f.nightHold?.kind !== 'origin' || f.nightHold.releaseAt < morning || f.nightHold.releaseAt > morning + 6 * 3600) continue;
    last = Math.max(last, f.nightHold.releaseAt);
  }
  const at = last === -Infinity ? morning : Math.max(morning, last + SEPARATION_SEC.L.L);
  arr.estimated = at;
  dep.estimated = Math.max(dep.scheduled, at + typeOf(sim, ac).turnaroundSec);
  arr.nightHold = { kind: 'origin', decidedAt: state.now, releaseAt: at };
  addDelayCause(arr, 'noiseRestriction');
}

function stepReadyForPushback(sim: Simulation, ac: Aircraft): void {
  const { state } = sim;
  const dep = state.flights[ac.departureFlightId]!;
  // 整備の不具合による保留（フェーズ 4 §3.6）: 時刻まではプッシュバックしない
  if (dep.techHoldUntil !== undefined && state.now < dep.techHoldUntil) {
    setHold(state, ac, 'groundCrew');
    addDelayCause(dep, 'technical');
    return;
  }
  // 出発の10分前にトーイングカーと作業員を手配する
  if (state.now >= dep.estimated - PUSHBACK_DISPATCH_LEAD_SEC) createPushbackTask(sim, ac);
  if (state.now < dep.estimated || state.now < ac.retryAt) return;
  // 搭乗締切（搭乗手続きの完了）まではプッシュバックしない
  if (dep.pax.boarding !== 'closed') {
    setHold(state, ac, 'boarding');
    addDelayCause(dep, 'boarding');
    if (dep.pax.bus) addDelayCause(dep, 'apronBus');
    return;
  }
  // トーイングカーと作業員が機体に着いていること
  if (!pushbackReady(state, ac.id)) {
    setHold(state, ac, 'groundCrew');
    if (state.now > dep.estimated + 60) addDelayCause(dep, 'groundHandling');
    return;
  }
  const p = departurePath(sim, ac, true);
  // 夜間のスポット待機（最後の判定）: 実際の経路でもう一度予測し、夜間なら止める（プッシュバックの直前）
  if (nightOpsOf(sim) && holdDepartureAtStand(sim, ac, p?.path)) return;
  let blkReason: HoldReason | null = null;
  if (p) {
    const route = makeRoute(sim.ctx, 'pushback', p.path.nodes, p.path.edges);
    const parts = reservableParts(sim.ctx, route, 0);
    // 区間ごとの走行: 全回廊の向き + 最初のチェーン（スポット入口〜止まれる最初の区間）を確保できたらプッシュバックする
    const blk = sim.ctx.blocks ? acquireRoute(sim, ac, route) : null;
    if (blk && !blk.ok) blkReason = blk.reason;
    if (blk ? blk.ok : isFree(state, ac.id, parts)) {
      if (!blk) reserve(state, ac.id, parts);
      ac.route = route;
      ac.dist = 0;
      ac.runwayId = p.runwayId;
      dep.runwayId = p.runwayId;
      dep.block = state.now;
      dep.status = 'active';
      setHold(state, ac, null);
      setState(state, ac, 'pushback');
      return;
    }
  }
  const alt = p ? null : departurePath(sim, ac, false);
  // 区間ごとの走行: 逆向きの回廊で通れないときは、対向待ちの公平性（DIR_FAIRNESS_SEC）のために待ちを記録する
  if (sim.ctx.blocks && alt) noteOpposed(sim, ac, makeRoute(sim.ctx, 'pushback', alt.path.nodes, alt.path.edges));
  const reason: HoldReason = p || alt
    ? (sim.ctx.blocks ? blkReason ?? 'opposingTraffic' : 'routeBusy')
    : hasDepartureEntry(sim, ac) ? 'noRoute' : 'noDepartureRoute';
  setHold(state, ac, reason);
  addDelayCause(dep, reason === 'noRoute' || reason === 'noDepartureRoute' ? 'noRoute' : 'taxiCongestion');
  ac.retryAt = state.now + RETRY_SEC;
  if ((reason === 'noRoute' || reason === 'noDepartureRoute') && ac.waitSince !== null && state.now - ac.waitSince >= DEPARTURE_GIVE_UP_SEC) {
    releaseEverything(sim, ac);
    dep.status = 'cancelled';
    state.stats.cancelled++;
    onFlightLost(sim);
    logEvent(state, { t: state.now, kind: 'cannotOperate', aircraftId: ac.id, reason });
    setState(state, ac, 'cannotOperate', reason);
  }
}

function startTakeoff(sim: Simulation, ac: Aircraft): void {
  const { state } = sim;
  const rw = runwayFor(sim, ac.runwayId!)!;
  const startNode = ac.route!.nodes[ac.route!.nodes.length - 1]!;
  const idx = rw.nodes.indexOf(startNode);
  if (ac.crossing || ac.heldCrossings) { releaseOpenCrossings(sim, ac); }
  releaseAll(state, ac.id);
  const nodes = rw.nodes.slice(idx);
  const edges: string[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) edges.push(edgeBetween(sim, nodes[i]!, nodes[i + 1]!));
  ac.route = makeRoute(sim.ctx, 'takeoff', nodes, edges, nodes.length - 1);
  ac.dist = 0;
  ac.speed = 0;
  ac.timerUntil = null;
  state.runways[ac.runwayId!]!.lastOp = { kind: 'dep', size: typeOf(sim, ac).size, at: state.now };
  if (ac.taxiStartedAt !== null) state.stats.taxiOutSecTotal += state.now - ac.taxiStartedAt;
  ac.taxiStartedAt = null;
  setState(state, ac, 'takeoff');
}

function edgeBetween(sim: Simulation, a: string, b: string): string {
  for (const eid of sim.ctx.network.outgoing[a] ?? []) {
    const e = sim.ctx.network.edges[eid]!;
    if (otherEnd(e, a) === b) return eid;
  }
  throw new Error(`no edge between ${a} and ${b}`);
}

// ---------------------------------------------------------------- 移動

/** 横断を終えた許可（解放位置を過ぎたもの）の滑走路を解放する。同じ機体の、まだ開いている別の許可に書かれた滑走路は解放しない */
function releaseFinishedCrossings(sim: Simulation, ac: Aircraft, lengthM: number): void {
  const r = ac.route!;
  const done = (c: CrossingGrant): boolean => ac.dist >= r.cum[c.index]! + Math.max(holdShortOnRoute(sim.ctx, r, c.index, 1), lengthM);
  const all = [...(ac.heldCrossings ?? []), ...(ac.crossing ? [ac.crossing] : [])];
  const finished = all.filter(done);
  if (finished.length === 0) return;
  const stillOpen = new Set(all.filter((c) => !finished.includes(c)).flatMap((c) => [c.runwayId, ...(c.alsoRunwayIds ?? [])]));
  for (const c of finished) {
    for (const id of [c.runwayId, ...(c.alsoRunwayIds ?? [])]) {
      if (stillOpen.has(id)) continue;
      const rs = sim.state.runways[id]!;
      if (rs.occupant?.aircraftId === ac.id) rs.occupant = null;
    }
  }
  if (ac.heldCrossings) {
    ac.heldCrossings = ac.heldCrossings.filter((c) => !finished.includes(c));
    if (ac.heldCrossings.length === 0) delete ac.heldCrossings;
  }
  if (ac.crossing && finished.includes(ac.crossing)) ac.crossing = null;
}

function releaseOpenCrossings(sim: Simulation, ac: Aircraft): void {
  for (const c of [...(ac.heldCrossings ?? []), ...(ac.crossing ? [ac.crossing] : [])]) {
    for (const id of [c.runwayId, ...(c.alsoRunwayIds ?? [])]) {
      const rs = sim.state.runways[id]!;
      if (rs.occupant?.aircraftId === ac.id && rs.occupant.purpose === 'crossing') rs.occupant = null;
    }
  }
  ac.crossing = null;
  delete ac.heldCrossings;
}

function crossingGrantAt(sim: Simulation, ac: Aircraft, i: number): { index: number; runwayId: string; alsoRunwayIds?: string[] } {
  const r = ac.route!;
  const rid = sim.ctx.network.nodes[r.nodes[i]!]!.runwayIds[0]!;
  const group = sim.ctx.crossingNodeRunways[r.nodes[i]!];
  const ids = group && group.includes(rid) ? group : [rid];
  const also = ids.filter((id) => id !== rid);
  return also.length > 0 ? { index: i, runwayId: rid, alsoRunwayIds: also } : { index: i, runwayId: rid };
}

function crossingChain(sim: Simulation, ac: Aircraft, first: number): { index: number; runwayId: string; alsoRunwayIds?: string[] }[] {
  const r = ac.route!;
  const len = typeOf(sim, ac).lengthM;
  const chain = [crossingGrantAt(sim, ac, first)];
  let k = first;
  for (let j = k + 1; j < r.nodes.length - 1; j++) {
    if (sim.ctx.network.nodes[r.nodes[j]!]!.runwayIds.length === 0) continue;
    const release = r.cum[k]! + Math.max(holdShortOnRoute(sim.ctx, r, k, 1), len);
    const hold = r.cum[j]! - holdShortOnRoute(sim.ctx, r, j, -1);
    if (hold >= release) break;
    const next = crossingGrantAt(sim, ac, j);
    // 同じ滑走路をもう一度横切る経路: 解放の取り違えを避けるため、ここで連鎖を止める（別々の許可になる）
    const used = new Set(chain.flatMap((c) => [c.runwayId, ...(c.alsoRunwayIds ?? [])]));
    if ([next.runwayId, ...(next.alsoRunwayIds ?? [])].some((id) => used.has(id))) break;
    chain.push(next);
    k = j;
  }
  return chain;
}

/** 次に横断許可が必要な滑走路ノード（経路の途中にある滑走路ノード） */
function pendingCrossing(sim: Simulation, ac: Aircraft): { index: number; runwayId: string; distToHold: number } | null {
  if (!['taxiIn', 'taxiOut', 'vacating'].includes(ac.state) || !ac.route) return null;
  const r = ac.route;
  const from = edgeIndexAt(r, ac.dist) + 1;
  for (let i = Math.max(from, r.runwayEnd + 1, 1); i < r.nodes.length - 1; i++) {
    const n = sim.ctx.network.nodes[r.nodes[i]!]!;
    if (n.runwayIds.length === 0) continue;
    if (ac.crossing?.index === i || ac.heldCrossings?.some((c) => c.index === i)) return null;
    const hold = r.cum[i]! - holdShortOnRoute(sim.ctx, r, i, -1);
    return { index: i, runwayId: n.runwayIds[0]!, distToHold: hold - ac.dist };
  }
  return null;
}

/** 現在進んでよい最遠の位置（経路上の距離） */
function movementLimit(sim: Simulation, ac: Aircraft): number {
  const r = ac.route!;
  const last = r.nodes.length - 1;
  let limit = r.cum[last]!;
  // 出発機は滑走路手前の停止位置まで（離陸許可後は滑走路ノードまで）
  if (r.kind === 'pushback' && ac.state !== 'lineUp') limit = r.cum[last]! - holdShortOnRoute(sim.ctx, r, last, -1);
  const req = pendingCrossing(sim, ac);
  if (req) limit = Math.min(limit, req.distToHold + ac.dist);
  // 区間ごとの走行: 確保した範囲の停止位置と、前の機体への追従の上限
  if (sim.state.taxiBlocks) limit = Math.min(limit, Math.max(blockMovementLimit(sim, ac).limit, ac.dist));
  return limit;
}

/** 速度と位置を更新する。停止位置を越えないよう、毎ティック制動距離を考慮する */
function moveTaxi(sim: Simulation, ac: Aircraft): void {
  const r = ac.route!;
  const type = typeOf(sim, ac);
  const limit = movementLimit(sim, ac);
  const i = edgeIndexAt(r, ac.dist);
  const edge = sim.ctx.network.edges[r.edges[i]!]!;
  const wxTaxi = weatherEffects(sim.state).taxi;
  let vmax = edge.kind === 'standLink' ? STAND_SPEED : type.taxiSpeed * wxTaxi;
  // 次のノードでの制限（曲がり角・スポット進入）
  for (let k = i + 1; k < r.nodes.length - 1 && r.cum[k]! - ac.dist < 300; k++) {
    const nextEdge = sim.ctx.network.edges[r.edges[k]!]!;
    let vNode = nextEdge.kind === 'standLink' ? STAND_SPEED : type.taxiSpeed;
    if (turnAngleAt(sim.ctx, r, k) >= 45) vNode = Math.min(vNode, TURN_SPEED);
    const d = Math.max(0, r.cum[k]! - ac.dist);
    vmax = Math.min(vmax, Math.sqrt(vNode * vNode + 2 * TAXI_DECEL * d));
  }
  const toLimit = Math.max(0, limit - ac.dist);
  const vBrake = Math.sqrt(2 * TAXI_DECEL * toLimit);
  const target = Math.min(vmax, vBrake);
  ac.speed = ac.speed < target ? Math.min(target, ac.speed + TAXI_ACCEL * TICK_SEC) : Math.max(target, ac.speed - TAXI_DECEL * 4 * TICK_SEC);
  ac.dist = Math.min(ac.dist + ac.speed * TICK_SEC, limit);
  if (limit - ac.dist < 0.01 && ac.speed < 0.5) ac.speed = 0;
  releasePassed(sim.state, ac, type.lengthM);
  if (sim.state.taxiBlocks) releaseBlocksPassed(sim, ac);
  // 横断を終えたら滑走路を解放する
  releaseFinishedCrossings(sim, ac, type.lengthM);
  if (ac.state === 'taxiIn' || ac.state === 'taxiOut' || ac.state === 'vacating') {
    const req = pendingCrossing(sim, ac);
    if (req && req.distToHold < 1 && ac.speed === 0) setHold(sim.state, ac, 'crossing');
    else if (ac.holdReason === 'crossing') setHold(sim.state, ac, null);
    else if (sim.state.taxiBlocks) blockHoldReason(sim, ac);
  }
  placeOnRoute(sim, ac);
}

// ---------------------------------------------------------------- 表示位置

function placeOnRoute(sim: Simulation, ac: Aircraft, reverse = false): void {
  const r = ac.route!;
  const end = routeLength(r);
  if (ac.dist <= end) {
    const p = pointAt(sim.ctx, r, ac.dist);
    ac.x = p.x;
    ac.y = p.y;
    ac.heading = reverse ? (p.heading + 180) % 360 : p.heading;
  } else {
    // 経路の先（離陸後の上昇）は最後の区間の延長線上
    const a = sim.ctx.network.nodes[r.nodes[r.nodes.length - 2]!]!.pos;
    const b = sim.ctx.network.nodes[r.nodes[r.nodes.length - 1]!]!.pos;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const extra = (ac.dist - end) / TILE_M;
    ac.x = b.x + ((b.x - a.x) / len) * extra;
    ac.y = b.y + ((b.y - a.y) / len) * extra;
    ac.heading = headingOf(b.x - a.x, b.y - a.y);
  }
}

export function placeAtStand(sim: Simulation, ac: Aircraft): void {
  const s = sim.ctx.stands[ac.standId!]!;
  const p = sim.ctx.network.nodes[s.node]!.pos;
  ac.x = p.x;
  ac.y = p.y;
  ac.heading = s.heading;
}

/** 空中の機体の表示位置（表示用に距離を縮めた進入経路・待機旋回） */
function placeAirborne(sim: Simulation, ac: Aircraft): void {
  const { state } = sim;
  const rw = ac.runwayId ? runwayFor(sim, ac.runwayId) : null;
  const firstRwy = rw ?? (Object.keys(sim.ctx.runways).length > 0 ? runwayFor(sim, Object.keys(sim.ctx.runways).sort(compareIds)[0]!) : null);
  if (!firstRwy) return;
  const t0 = sim.ctx.network.nodes[firstRwy.nodes[0]!]!.pos;
  const t1 = sim.ctx.network.nodes[firstRwy.nodes[1]!]!.pos;
  const len = Math.hypot(t1.x - t0.x, t1.y - t0.y) || 1;
  const ux = (t1.x - t0.x) / len;
  const uy = (t1.y - t0.y) / len;
  if (ac.state === 'approach' && ac.eta !== null) {
    const back = 40 * Math.max(0, (ac.eta - state.now) / APPROACH_SEC);
    ac.x = t0.x - ux * back;
    ac.y = t0.y - uy * back;
    ac.heading = headingOf(ux, uy);
    return;
  }
  // 待機: 進入経路の手前で旋回
  const cx = t0.x - ux * 55;
  const cy = t0.y - uy * 55;
  const n = Number(ac.id.slice(3));
  const ang = (state.now / 120) * 2 * Math.PI + n;
  const rad = 6 + (n % 3) * 2;
  ac.x = cx + Math.cos(ang) * rad;
  ac.y = cy + Math.sin(ang) * rad;
  ac.heading = headingOf(-Math.sin(ang), Math.cos(ang));
}

// ---------------------------------------------------------------- 競合の検知

/** 地上で動いている機体同士が近づきすぎていないか（予約制御が正しければ常に 0 件） */
function detectConflicts(sim: Simulation): void {
  const { state } = sim;
  const moving = sortedValues(state.aircraft).filter((a) => GROUND_MOVING_STATES.includes(a.state) && a.state !== 'takeoff');
  for (let i = 0; i < moving.length; i++) {
    for (let j = i + 1; j < moving.length; j++) {
      const a = moving[i]!;
      const b = moving[j]!;
      const d = Math.hypot(a.x - b.x, a.y - b.y) * TILE_M;
      if (d < MIN_GROUND_SEPARATION_M) {
        state.stats.conflicts++;
        logEvent(state, { t: state.now, kind: 'conflict', aircraftId: a.id, note: b.id });
      }
    }
  }
}

export const isTerminal = (ac: Aircraft): boolean => TERMINAL_STATES.includes(ac.state);

/** 予定時刻に対する遅れ（分）。到着便は着陸時刻、出発便はブロックアウト時刻で判定する */
export function flightDelayMin(f: Flight, now: number): number | null {
  if (f.status === 'diverted' || f.status === 'cancelled') return null;
  let ref: number;
  if (f.direction === 'arrival') ref = f.actual ?? f.estimated;
  else ref = f.block ?? Math.max(f.estimated, now);
  return Math.max(0, Math.round((ref - f.scheduled) / 60));
}

export type { Route };
