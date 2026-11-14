import { AIRCRAFT_TYPES, resolveType, type TypeTable } from '../sim/aircraftTypes';
import { attributeRevenue } from '../analytics/records';
import { operableTypes, type SimContext } from '../sim/context';
import { DAY_SEC } from '../sim/rules';
import type { Simulation } from '../sim/simulation';
import {
  EVENT_LOG_LIMIT,
  PAX_FINAL_STATES,
  type Aircraft,
  type Flight,
  type GroundStats,
  type GroundTask,
  type PaxGroup,
  type PaxStats,
  type SimState,
  type SimStats,
} from '../sim/types';
import { BALANCE, ON_TIME_SEC } from './balance';
import { railServiceOf, RAIL_SERVICE } from '../access/rail';
import { evaluateDelayPair } from './delayEvaluation';
import {
  COST_CATEGORIES,
  REPORT_LIMIT,
  REVENUE_CATEGORIES,
  activeContractsOn,
  contractsOf,
  generateOffers,
  post,
  updateContracts,
  type AirlineDayResult,
  type CompanyState,
  type CostCategory,
  type DailyKpi,
  type DailyAirlineAnalysis,
  type DailyReport,
} from './company';
import { layoutValue, scaleFactor } from './construction';
import { advanceProjects } from './expansion';
import { analyzeAccess, type AccessAnalysis, type AccessFeedback } from '../access/model';
import { takeAccessStats } from '../access/runtime';
import { isPeak, RUNWAY_HOURLY_CAPACITY, analyzeDayPlan, planDayWithDemand } from './planning';
import { airlineScorecard } from './airlineScore';
import { stepAirlineEval } from './airlineEval';
import { evaluateGoals } from './goals';
import { airlineDef } from './registry';
import { aircraftNoisePoints, applyCityNoiseImpact, cityDemandCeiling, cityDemandFactor, cityEventEffects, expectedPassengers, growCity, isCityNightMovement } from './city';

/**
 * 運航中の経営処理（docs/14_management_rules.md §3・§5・§6）。
 *
 * - 収入・費用は発生した時点で会社の当日の収支に記録する（着陸料は着陸時、作業費は作業完了時など）。
 * - 1日単位の固定費と契約料は、時間の経過に比例して1時間ごとに計上する（途中で運航を止めても公平になる）。
 * - 0:00 と運航停止時に日次締めを行い、KPI・航空会社の満足度・契約・空港評価を更新する。
 * 会社（CompanyState）がないシミュレーション（テスト・手動の運航）では何もしない。
 */

export interface SimEconomy {
  /** 会社の日 − シミュレーションの日 */
  dayOffset: number;
  /** 集計期間の開始時刻と、固定費を計上済みの時刻 */
  periodStart: number;
  accruedAt: number;
  /** 期間開始時点の累計値（差分で当日の値を出す） */
  base: { pax: PaxStats; ground: GroundStats; stats: SimStats };
  /** スポット割り当て時間の合計（スポット・秒） */
  standBusySec: number;
  /** チェックイン・保安検査の窓口の使用時間と、開いていた窓口の時間（窓口・秒） */
  facilityBusy: number;
  facilityCap: number;
  /** 補償の対象になった積み残し手荷物 */
  leftBags: number;
  /** 1日あたりの固定費（費目ごと）と契約料 */
  fixedDaily: Partial<Record<CostCategory, number>>;
  contractDaily: number;
  /** 窓口の稼働率を測るエリア */
  processingAreas: string[];
  /** 空港ホテルの客室数（外部とつながりターミナルに近いもの） */
  hotelRooms: number;
}

// Evaluation details are consumed immediately when the daily review is built. Keeping them outside
// CompanyState preserves the serialized simulation/economy state and existing deterministic results.
const dailyAnalysisByReport = new WeakMap<DailyReport, DailyAirlineAnalysis>();
export const dailyAirlineAnalysis = (report: DailyReport): DailyAirlineAnalysis | undefined => dailyAnalysisByReport.get(report);

const enabled = (sim: Simulation): sim is Simulation & { company: CompanyState } => !!sim.company && !!sim.state.economy;

function log(state: SimState, note: string): void {
  state.events.push({ t: state.now, kind: 'finance', note });
  if (state.events.length > EVENT_LOG_LIMIT) state.events.splice(0, state.events.length - EVENT_LOG_LIMIT);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------------------------------------------------------------- 固定費

/**
 * 1日あたりの固定費:
 *   人件費 = 作業員数 × 1,200 + 整備士数 × 2,000
 *   窓口要員 = チェックインカウンター数 × 800 + 保安検査レーン数 × 2,500 + ゲート数 × 600
 *   車両維持費 = 車両台数 × 300
 *   施設維持費 = 資産額 × 0.0003 × 規模係数
 *   光熱費 = ターミナルの面積（タイル）× 階数 × 30
 *   交通施設の運営費 = タクシー乗り場 300 / バス乗り場 800 / 駅 6,000 / ホテル 2,000（1か所あたり）
 *   通勤対策費 = 職員用駐車場の不足台数 × 600（必要台数 = 職員数 × 0.5）
 */
export function dailyFixedCosts(ctx: SimContext, access: AccessAnalysis = analyzeAccess(ctx.layout)): Partial<Record<CostCategory, number>> {
  const D = BALANCE.daily;
  let salary = 0;
  let vehicles = 0;
  for (const b of ctx.bases) {
    for (const [kind, n] of Object.entries(b.units)) {
      const s = D.salary[kind as keyof typeof D.salary];
      if (s !== undefined) {
        salary += s * (n ?? 0);
        // ランプバスは運転士の給与に加えて車両の維持費もかかる
        if (kind === 'apronBus') vehicles += n ?? 0;
      } else vehicles += n ?? 0;
    }
  }
  let counterStaff = 0;
  for (const a of Object.values(ctx.layout.terminalAreas)) {
    if (a.kind === 'checkIn') counterStaff += Number(a.props.counters ?? 0) * D.checkInCounter;
    if (a.kind === 'security') counterStaff += Number(a.props.lanes ?? 0) * D.securityLane;
  }
  let utilities = 0;
  let accessOps = 0;
  for (const f of Object.values(ctx.layout.facilities)) {
    if (f.buildState !== 'operational') continue;
    if (f.kind === 'gate') counterStaff += D.gate;
    if (f.kind === 'terminal') utilities += f.w * f.h * Math.max(1, Number(f.props.levels ?? 1)) * D.utilitiesPerTerminalTile;
    if (f.kind === 'taxiStand' || f.kind === 'busStop' || f.kind === 'hotel') accessOps += D.access[f.kind];
    if (f.kind === 'railStation') accessOps += D.access.railStation * RAIL_SERVICE[railServiceOf(f.props.railService)].operatingCostMultiplier;
  }
  return {
    salary,
    counterStaff,
    vehicles: vehicles * D.vehicle,
    maintenance: Math.round(layoutValue(ctx.layout) * D.maintenanceRate * scaleFactor(ctx.layout)),
    utilities,
    accessOps,
    staffCommute: Math.max(0, access.staffSpacesNeeded - access.staffSpaces) * D.staffCommutePerMissing,
  };
}

/** 契約料（1日あたり）= 有効な契約の1日の便数の合計 × 3,000 */
export function dailyContractRevenue(c: CompanyState, day: number): number {
  return activeContractsOn(c, day).reduce((s, k) => s + k.perDay * BALANCE.fees.contractPerDailyFlight, 0);
}

// ---------------------------------------------------------------- 開始

export function createEconomy(ctx: SimContext, state: SimState, c: CompanyState): SimEconomy {
  const simDay = Math.floor(state.now / DAY_SEC);
  const access = analyzeAccess(ctx.layout, { fees: c.fees, feedback: c.accessFeedback, city: c.city, day: c.day });
  return {
    dayOffset: c.day - simDay,
    periodStart: state.now,
    accruedAt: state.now,
    base: { pax: clone(state.paxStats), ground: clone(state.groundStats), stats: clone(state.stats) },
    standBusySec: 0,
    facilityBusy: 0,
    facilityCap: 0,
    leftBags: 0,
    fixedDaily: dailyFixedCosts(ctx, access),
    contractDaily: dailyContractRevenue(c, c.day),
    processingAreas: Object.keys(ctx.terminal.areas)
      .filter((id) => ['checkIn', 'security'].includes(ctx.terminal.areas[id]!.kind))
      .sort(),
    hotelRooms: access.hotelRooms,
  };
}

/** シミュレーションの日に対応する会社の日 */
export function companyDayOf(sim: Simulation, simDay: number): number {
  return simDay + (sim.state.economy?.dayOffset ?? 0);
}

// ---------------------------------------------------------------- 料金

function contractOf(sim: Simulation & { company: CompanyState }, f: Flight) {
  return f.contractId ? sim.company.contracts[f.contractId] : undefined;
}

/** 契約の割引を反映した倍率 */
function discount(sim: Simulation & { company: CompanyState }, f: Flight): number {
  return 1 - (contractOf(sim, f)?.feeDiscount ?? 0);
}

/** 着陸料 = 最大離陸重量(t) × 150 × 料金倍率 × (ピーク時 1.25) × (1 − 契約割引) */
export function landingFee(c: CompanyState, ac: Pick<Aircraft, 'typeId'>, at: number, disc: number, types: TypeTable = AIRCRAFT_TYPES): number {
  const F = BALANCE.fees;
  const peak = isPeak(c.hours, Math.floor((at % DAY_SEC) / 60)) ? 1 + F.peakSurcharge : 1;
  return resolveType(types, ac.typeId).mtowT * F.landingPerTonne * c.fees.landing * peak * disc;
}

/** 駐機料 = 切り上げ(駐機時間 − 2時間) × 区分の時間料金 × 料金倍率 × (1 − 契約割引) */
export function parkingFee(c: CompanyState, ac: Pick<Aircraft, 'typeId'>, parkedSec: number, disc: number, types: TypeTable = AIRCRAFT_TYPES): number {
  const F = BALANCE.fees;
  const hours = Math.max(0, Math.ceil(parkedSec / 3600 - F.parkingFreeHours));
  return hours * F.parkingPerHour[resolveType(types, ac.typeId).size] * c.fees.parking * disc;
}

// ---------------------------------------------------------------- イベントごとの計上

export function onLanding(sim: Simulation, ac: Aircraft): void {
  if (!enabled(sim)) return;
  const arr = sim.state.flights[ac.arrivalFlightId]!;
  const fee = landingFee(sim.company, ac, sim.state.now, discount(sim, arr), sim.ctx.types);
  post(sim.company, 'landing', fee);
  attributeRevenue(sim, ac.id, fee);
}

/** 到着旅客のターミナル使用料 = 人数 × 60 × 料金倍率 × (1 − 契約割引) */
export function onPaxDeplaned(sim: Simulation, f: Flight, count: number): void {
  if (!enabled(sim)) return;
  const fee = count * BALANCE.fees.paxArriving * sim.company.fees.terminal * discount(sim, f);
  post(sim.company, 'terminal', fee);
  attributeRevenue(sim, f.aircraftId, fee);
}

/**
 * 離陸時: 出発旅客のターミナル使用料（搭乗者数 × 120 × 倍率 × 割引）、地上支援料、駐機料、
 * 60分を超える遅延の補償。
 */
export function onTakeoff(sim: Simulation, ac: Aircraft): void {
  if (!enabled(sim)) return;
  const c = sim.company;
  const dep = sim.state.flights[ac.departureFlightId]!;
  const arr = sim.state.flights[ac.arrivalFlightId]!;
  const disc = discount(sim, dep);
  const terminal = dep.pax.boarded * BALANCE.fees.paxDeparting * c.fees.terminal * disc;
  const handling = BALANCE.fees.groundHandling[resolveType(sim.ctx.types, ac.typeId).size] * disc;
  const parking = arr.block !== null && dep.block !== null ? parkingFee(c, ac, dep.block - arr.block, disc, sim.ctx.types) : 0;
  post(c, 'terminal', terminal);
  post(c, 'groundHandling', handling);
  post(c, 'parking', parking);
  attributeRevenue(sim, ac.id, terminal + handling + parking);
  if (dep.block !== null && dep.block - dep.scheduled > 60 * 60) post(c, 'compensation', -BALANCE.compensation.delayedFlight60);
}

/** ダイバート・欠航した便: 遅延と同額の補償 */
export function onFlightLost(sim: Simulation): void {
  if (!enabled(sim)) return;
  post(sim.company, 'compensation', -BALANCE.compensation.delayedFlight60);
}

/** 地上作業の運営費（作業の種類ごと。点検で不具合が見つかれば追加） */
export function onTaskDone(sim: Simulation, t: GroundTask): void {
  if (!enabled(sim)) return;
  let cost = BALANCE.taskCost[t.kind] ?? 0;
  if (t.kind === 'inspect' && t.note?.startsWith('不具合')) cost += BALANCE.taskCost.defect ?? 0;
  post(sim.company, 'groundOps', -cost);
}

/** ランプバスの運行ごとの運営費 */
export function onBusTrip(sim: Simulation): void {
  if (!enabled(sim)) return;
  post(sim.company, 'groundOps', -(BALANCE.taskCost.busTrip ?? 0));
}

/** 店舗・飲食店の売上（人数 × 1人あたりの売上） */
export function onShopDone(sim: Simulation, g: PaxGroup, kind: 'shop' | 'restaurant'): void {
  if (!enabled(sim)) return;
  if (kind === 'shop') post(sim.company, 'retail', g.count * BALANCE.retail.shopPerPax);
  else post(sim.company, 'dining', g.count * BALANCE.retail.restaurantPerPax);
}

export function onPaxMissed(sim: Simulation, _f: Flight, count: number): void {
  if (!enabled(sim)) return;
  post(sim.company, 'compensation', -count * BALANCE.compensation.missedPax);
}

export function onBagLeftBehind(sim: Simulation): void {
  if (!enabled(sim)) return;
  sim.state.economy!.leftBags++;
  post(sim.company, 'compensation', -BALANCE.compensation.leftBag);
}

// ---------------------------------------------------------------- 毎ティック

/** 固定費と契約料を、前回からの経過時間に比例して計上する */
function accrue(sim: Simulation & { company: CompanyState }, until: number): void {
  const e = sim.state.economy!;
  const frac = (until - e.accruedAt) / DAY_SEC;
  if (frac <= 0) return;
  for (const k of COST_CATEGORIES) {
    const v = e.fixedDaily[k];
    if (v) post(sim.company, k, -v * frac);
  }
  post(sim.company, 'contract', e.contractDaily * frac);
  e.accruedAt = until;
}

/**
 * 経営の1ティック。日付が変わったら true を返す（呼び出し側が翌日の運航計画を作る）。
 */
export function stepEconomy(sim: Simulation, serversOf: (key: string) => number): boolean {
  if (!enabled(sim)) return false;
  const { state } = sim;
  const e = state.economy!;
  let newDay = false;
  if (state.now % 3600 === 0 && state.now > e.accruedAt) accrue(sim, state.now);
  if (state.now % DAY_SEC === 0 && state.now > e.periodStart) {
    settleDay(sim, false);
    newDay = true;
  }
  e.standBusySec += Object.keys(state.standAssignments).length;
  for (const id of e.processingAreas) {
    const servers = serversOf(id);
    e.facilityCap += servers;
    e.facilityBusy += Math.min(servers, state.facilities[id]?.inService.length ?? 0);
  }
  return newDay;
}

// ---------------------------------------------------------------- 日次締め・KPI

interface Leg {
  f: Flight;
  at: number;
  lost: boolean;
  delaySec: number;
  actualDelaySec: number;
}

/** 期間内に終わった便の区間（到着 = 着陸、出発 = ブロックアウト、運航不能 = その時刻） */
function legsInPeriod(sim: Simulation, from: number, to: number): Leg[] {
  const { state } = sim;
  const legs: Leg[] = [];
  const inP = (t: number | null) => t !== null && t >= from && t < to;
  const evaluationFor = (f: Flight) => {
    const ac = state.aircraft[f.aircraftId];
    const arr = ac ? state.flights[ac.arrivalFlightId] : undefined;
    const dep = ac ? state.flights[ac.departureFlightId] : undefined;
    if (!arr || !dep || !ac) {
      const actualAt = f.direction === 'arrival' ? f.actual : f.block;
      const actual = actualAt === null ? 0 : Math.max(0, actualAt - f.scheduled);
      return { evaluated: actual, actual };
    }
    const pair = evaluateDelayPair({
      arrScheduled: arr.scheduled,
      arrActual: arr.actual,
      depScheduled: dep.scheduled,
      depBlockOut: dep.block,
      turnaroundSec: resolveType(sim.ctx.types, ac.typeId).turnaroundSec,
      arrivalExternalDelaySec: arr.externalDelaySec,
    });
    return f.direction === 'arrival'
      ? { evaluated: pair.arrivalSec, actual: pair.actualArrivalSec }
      : { evaluated: pair.departureSec, actual: pair.actualDepartureSec };
  };
  for (const f of Object.values(state.flights)) {
    if (f.status === 'diverted' || f.status === 'cancelled') {
      const ac = state.aircraft[f.aircraftId];
      if (ac && (ac.state === 'diverted' || ac.state === 'cannotOperate') && inP(ac.stateSince)) legs.push({ f, at: ac.stateSince, lost: true, delaySec: 0, actualDelaySec: 0 });
      continue;
    }
    const ref = f.direction === 'arrival' ? f.actual : f.block;
    if (inP(ref)) {
      const delay = evaluationFor(f);
      legs.push({ f, at: ref!, lost: false, delaySec: delay.evaluated, actualDelaySec: delay.actual });
    }
  }
  return legs;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 当日の KPI（式は docs/14 §6）。
 */
export function computeKpi(sim: Simulation, c: CompanyState): { kpi: DailyKpi; byAirline: Record<string, AirlineDayResult> } {
  const { state, ctx } = sim;
  const e = state.economy!;
  const from = e.periodStart;
  const elapsed = Math.max(1, state.now - from);
  const legs = legsInPeriod(sim, from, state.now);
  const done = legs.filter((l) => !l.lost);
  const onTime = done.filter((l) => l.delaySec <= ON_TIME_SEC).length;
  const movements = done.filter((l) => l.f.direction === 'arrival' || l.f.actual !== null).length;
  const pax = state.paxStats;
  const b = e.base;
  const dPax = {
    boarded: pax.boarded - b.pax.boarded,
    missed: pax.missed - b.pax.missed,
    deplaned: pax.deplaned - b.pax.deplaned,
    finished: pax.finished - b.pax.finished,
    wait: pax.waitTotal - b.pax.waitTotal,
    walk: pax.walkTotal - b.pax.walkTotal,
  };
  const bagsLoaded = state.groundStats.bagsLoaded - b.ground.bagsLoaded;
  const avgWaitMin = dPax.finished > 0 ? dPax.wait / dPax.finished / 60 : 0;
  const avgWalkMin = dPax.finished > 0 ? dPax.walk / dPax.finished / 60 : 0;
  const avgDelayMin = done.length > 0 ? done.reduce((s, l) => s + l.delaySec, 0) / done.length / 60 : 0;
  const actualAvgDelayMin = done.length > 0 ? done.reduce((s, l) => s + l.actualDelaySec, 0) / done.length / 60 : 0;
  // 地上作業時間 = 準備完了 − ブロックイン（期間内に準備完了した出発便）
  const ground: number[] = [];
  for (const f of Object.values(state.flights)) {
    if (f.direction !== 'departure' || f.readyAt === null || f.readyAt < from || f.readyAt >= state.now) continue;
    const acf = state.aircraft[f.aircraftId];
    const arr = acf ? state.flights[acf.arrivalFlightId] : undefined;
    if (arr && arr.block !== null) ground.push(f.readyAt - arr.block);
  }
  const runways = Object.values(ctx.runways).filter((r) => r.operational).length;
  const stands = Object.values(ctx.stands).filter((s) => s.operational).length;
  const unprocessed = state.activePax.reduce((s, id) => {
    const g = state.paxGroups[id];
    if (!g) return s;
    return s + (g.state !== 'toAirport' && !PAX_FINAL_STATES.includes(g.state) ? g.count : 0);
  }, 0);
  const paxTotal = dPax.boarded + dPax.missed;
  let paxSatisfaction: number | null = null;
  if (dPax.finished + dPax.missed > 0) {
    const missedRate = paxTotal > 0 ? dPax.missed / paxTotal : 0;
    const leftRate = e.leftBags / Math.max(1, bagsLoaded + e.leftBags);
    paxSatisfaction = round1(clamp(100 - 2 * avgWaitMin - Math.max(0, avgWalkMin - 10) - avgDelayMin - 300 * missedRate - 100 * leftRate));
  }

  const byAirline: Record<string, AirlineDayResult> = {};
  for (const l of legs) {
    const id = l.f.airlineId;
    if (!id || !c.airlines[id]) continue;
    const r = (byAirline[id] ??= { flights: 0, onTime: 0, paxBoarded: 0, missedPax: 0, leftBags: 0, cancelled: 0 });
    if (l.lost) {
      r.cancelled++;
      const lostAc = state.aircraft[l.f.aircraftId];
      const note = lostAc?.state === 'cannotOperate' ? lostAc.history[lostAc.history.length - 1]?.note : undefined;
      if (state.wx && note === 'weather') r.weatherCancelled = (r.weatherCancelled ?? 0) + 1;
      if (c.game && note === 'early') r.earlyCancelled = (r.earlyCancelled ?? 0) + 1;
      continue;
    }
    r.flights++;
    if (l.delaySec <= ON_TIME_SEC) r.onTime++;
    if (l.f.direction === 'departure') {
      r.paxBoarded += l.f.pax.boarded;
      r.missedPax += l.f.pax.missed;
      r.leftBags += (state.flightBags[l.f.id] ?? []).filter((bid) => {
        const bag = state.bags[bid];
        if (!bag) return false;
        const g = state.paxGroups[bag.paxGroupId];
        return bag.state === 'leftBehind' && g?.state !== 'missed' && g?.state !== 'cancelled';
      }).length;
    }
  }

  const kpi: DailyKpi = {
    flights: done.length,
    movements,
    paxDeparted: dPax.boarded,
    paxArrived: dPax.deplaned,
    otp: legs.length > 0 ? onTime / legs.length : null,
    avgDelayMin: round1(avgDelayMin),
    actualAvgDelayMin: round1(actualAvgDelayMin),
    runwayUtil: runways > 0 ? Math.min(1, movements / (runways * RUNWAY_HOURLY_CAPACITY * (elapsed / 3600))) : 0,
    gateUtil: stands > 0 ? Math.min(1, e.standBusySec / (stands * elapsed)) : 0,
    facilityUtil: e.facilityCap > 0 ? e.facilityBusy / e.facilityCap : 0,
    avgWaitMin: round1(avgWaitMin),
    avgWalkMin: round1(avgWalkMin),
    avgGroundMin: ground.length > 0 ? round1(ground.reduce((s, v) => s + v, 0) / ground.length / 60) : 0,
    unprocessedPax: unprocessed,
    missedPax: dPax.missed,
    leftBags: e.leftBags,
    diverted: state.stats.diverted - b.stats.diverted,
    cancelled: state.stats.cancelled - b.stats.cancelled,
    paxSatisfaction,
    airlineSatisfaction: null,
    rating: c.rating,
  };
  return { kpi, byAirline };
}

/** 航空会社満足度 = 有効な契約がある航空会社の満足度の平均 */
function airlineSatisfaction(c: CompanyState): number | null {
  const ids = [...new Set(contractsOf(c, 'active').map((k) => k.airlineId))];
  if (ids.length === 0) return null;
  return round1(ids.reduce((s, id) => s + c.airlines[id]!.satisfaction, 0) / ids.length);
}

/**
 * 空港評価の更新（便があった日のみ）:
 *   当日の評価 = 0.4 × 旅客満足度 + 0.4 × 航空会社満足度 + 0.2 × 定時運航率(%)
 *   新しい評価 = 0.7 × 前日の評価 + 0.3 × 当日の評価
 * 値がない項目は前日の評価で代用する。
 */
export function nextRating(prev: number, kpi: Pick<DailyKpi, 'paxSatisfaction' | 'airlineSatisfaction' | 'otp' | 'flights'>): number {
  if (kpi.flights === 0) return prev;
  const today = 0.4 * (kpi.paxSatisfaction ?? prev) + 0.4 * (kpi.airlineSatisfaction ?? prev) + 0.2 * (kpi.otp !== null ? kpi.otp * 100 : prev);
  return round1(clamp(0.7 * prev + 0.3 * today));
}

function cityNoiseMetrics(state: SimState, ctx: SimContext, from: number, to: number) {
  let movements = 0;
  let nightMovements = 0;
  let noisePoints = 0;
  for (const flight of Object.values(state.flights)) {
    const at = flight.actual;
    if (at === null || at < from || at >= to) continue;
    const aircraft = state.aircraft[flight.aircraftId];
    if (!aircraft) continue;
    const type = resolveType(ctx.types, aircraft.typeId);
    movements++;
    noisePoints += aircraftNoisePoints(type.size, type.engines);
    if (isCityNightMovement(at)) nightMovements++;
  }
  return { movements, nightMovements, noisePoints: Math.round(noisePoints * 10) / 10 };
}

/**
 * 日次締め。partial = true は運航の途中停止（その日を途中で締める）。
 * 収支を日報に移し、航空会社の満足度・契約・評価・新しい提案を更新して、会社の日を進める。
 */
export function settleDay(sim: Simulation, partial: boolean): DailyReport | null {
  if (!enabled(sim)) return null;
  const { state, ctx } = sim;
  const c = sim.company;
  const e = state.economy!;
  const cityStart = c.city ? { ...c.city } : null;
  const cityAccess = state.access?.factor ?? 1;
  const cityCeiling = cityStart ? cityDemandCeiling(cityStart, cityAccess) : 0;
  const cityExpected = cityStart ? expectedPassengers(c, c.day, ctx.types) : 0;
  const cityNoise = cityStart ? cityNoiseMetrics(state, ctx, e.periodStart, state.now) : null;
  const cityEvents = cityStart ? cityEventEffects(cityStart, c.day) : null;
  accrue(sim, state.now);
  const { kpi, byAirline } = computeKpi(sim, c);
  settleAccess(sim, c, kpi);
  for (const ev of advanceProjects(c)) log(state, ev);
  const from = e.periodStart;
  const recs = state.analytics.records.filter((r) => {
    const t = r.takeoffAt ?? r.blockOut ?? r.landedAt ?? r.depScheduled;
    return t >= from && t < state.now;
  });
  // 評価カードは締めた日の実績・計画から一度だけ算出し、翌日の計画と混同しないようレビュー用に保持する。
  const dayPlan = planDayWithDemand(c, c.day, state.access?.factor ?? 1, ctx.types);
  const scorecard = airlineScorecard({ company: c, ctx, records: recs, plan: dayPlan, analysis: analyzeDayPlan(dayPlan, ctx) });
  const evalBefore = structuredClone(c.airlineEval ?? {});
  const satisfactionBefore = Object.fromEntries(Object.entries(c.airlines).map(([id, rel]) => [id, rel.satisfaction]));
  let evalIn: { deltas: Record<string, number>; bonus: Record<string, number> } | undefined;
  if (c.game?.airlineEval) {
    // 航空会社の評価要素（12B-1 の評価カードの 7 要素）→ 移動平均 → 満足度の変化・不満・要望
    const r = stepAirlineEval(c, { scores: scorecard, operable: new Set<string>(operableTypes(ctx)) });
    for (const t of r.events) log(state, t);
    evalIn = { deltas: r.deltas, bonus: r.bonus };
  }
  for (const ev of updateContracts(c, byAirline, evalIn)) log(state, ev);
  kpi.airlineSatisfaction = airlineSatisfaction(c);
  c.rating = nextRating(c.rating, kpi);
  kpi.rating = c.rating;
  const offers = generateOffers(c, operableTypes(ctx));
  for (const k of offers) log(state, `${airlineDef(k.airlineId).name} から新しい契約の提案があります`);

  const revenue: DailyReport['revenue'] = {};
  const cost: DailyReport['cost'] = {};
  for (const k of REVENUE_CATEGORIES) if (c.today[k]) revenue[k] = c.today[k]!;
  for (const k of COST_CATEGORIES) if (c.today[k]) cost[k] = -c.today[k]!;
  const totalRevenue = Object.values(revenue).reduce((s, v) => s + v, 0);
  const totalCost = Object.values(cost).reduce((s, v) => s + v, 0);
  const airlineAnalysis: DailyAirlineAnalysis = Object.fromEntries(scorecard.filter((s) => s.active || (satisfactionBefore[s.airlineId] ?? 0) > 0).map((s) => {
    const id = s.airlineId;
    const beforeEval = evalBefore[id];
    const afterEval = c.airlineEval?.[id];
    const complaintsBefore = beforeEval?.complaints.map((x) => x.key) ?? [];
    const complaintsAfter = afterEval?.complaints.map((x) => x.key) ?? [];
    const satisfaction0 = satisfactionBefore[id] ?? 0;
    const satisfaction1 = c.airlines[id]?.satisfaction ?? satisfaction0;
    return [id, {
      components: structuredClone(s.components),
      satisfactionBefore: satisfaction0,
      satisfactionAfter: satisfaction1,
      satisfactionDelta: Math.round((satisfaction1 - satisfaction0) * 10) / 10,
      ...(beforeEval ? { emaBefore: { ...beforeEval.ema } } : {}),
      ...(afterEval ? { emaAfter: { ...afterEval.ema } } : {}),
      ...(c.game?.airlineEval ? {
        complaintsBefore,
        complaintsAfter,
        newComplaints: complaintsAfter.filter((key) => !complaintsBefore.includes(key)),
        requests: structuredClone(afterEval?.requests ?? []),
        fulfilled: afterEval?.done.filter((x) => x.day === c.day).map((x) => x.kind) ?? [],
      } : {}),
    }];
  }));
  const report: DailyReport = {
    day: c.day,
    partial,
    revenue,
    cost,
    construction: -(c.today.construction ?? 0),
    totalRevenue,
    totalCost,
    operatingProfit: totalRevenue - totalCost,
    cashEnd: c.cash,
    kpi,
    ...(cityStart ? { city: {
      type: cityStart.type,
      populationStart: cityStart.population,
      populationEnd: cityStart.population,
      demandCeiling: Math.round(cityCeiling),
      expectedPax: Math.round(cityExpected),
      actualPax: kpi.paxDeparted + kpi.paxArrived,
      cityFactor: cityDemandFactor(cityStart, cityAccess, cityExpected),
      roadQuality: cityStart.roadQuality,
      railQuality: cityStart.railQuality,
      residentsStart: cityStart.residents,
      residentsEnd: cityStart.residents,
      residentDelta: 0,
      noiseMovements: cityNoise?.movements ?? 0,
      nightMovements: cityNoise?.nightMovements ?? 0,
      noisePoints: cityNoise?.noisePoints ?? 0,
      events: cityEvents?.events ?? [],
      eventDemandMultiplier: cityEvents?.demandMultiplier ?? 1,
      eventTrafficMultiplier: cityEvents?.trafficMultiplier ?? 1,
    } } : {}),
  };
  c.reports.push(report);
  if (c.reports.length > REPORT_LIMIT) c.reports.splice(0, c.reports.length - REPORT_LIMIT);
  c.today = {};
  if (c.game?.goals) {
    // 目標・空港の格（日報を積んだ後、日を進める前）。報酬の現金は営業収支に入れない
    const from = e.periodStart;
    const recs = state.analytics.records.filter((r) => {
      const t = r.takeoffAt ?? r.blockOut ?? r.landedAt ?? r.depScheduled;
      return t >= from && t < state.now;
    });
    const res = evaluateGoals(c, { report, layout: ctx.layout, records: recs, types: ctx.types, largeOperable: operableTypes(ctx).some((t) => resolveType(ctx.types, t).size === 'L') });
    if (res.cash > 0) report.grants = res.cash;
    // 報酬の現金・評価は当日の終わりの値に含める（cashEnd(翌日) − cashEnd(当日) = 翌日の営業利益 + 建設 + 翌日の報酬）。営業利益には入れない
    report.cashEnd = c.cash;
    kpi.rating = c.rating;
    for (const id of res.completed) log(state, `目標を達成しました: ${id}`);
    if (res.tierUp !== null) log(state, `空港の格が上がりました: ${res.tierUp}`);
  }
  dailyAnalysisByReport.set(report, airlineAnalysis);
  checkBankruptcy(c);
  if (c.city && !partial) {
    const residentDelta = applyCityNoiseImpact(c.city, cityNoise?.noisePoints ?? 0, cityNoise?.nightMovements ?? 0);
    for (const event of growCity(c.city, kpi.paxDeparted + kpi.paxArrived, cityCeiling)) log(state, event);
    if (report.city) {
      report.city.populationEnd = c.city.population;
      report.city.roadQuality = c.city.roadQuality;
      report.city.residentsEnd = c.city.residents;
      report.city.residentDelta = residentDelta;
    }
  }
  log(state, `${c.day + 1}日目を締めました: 営業利益 ${report.operatingProfit.toLocaleString('ja-JP')} cr`);
  c.day++;

  // 次の集計期間
  e.periodStart = state.now;
  e.base = { pax: clone(state.paxStats), ground: clone(state.groundStats), stats: clone(state.stats) };
  e.standBusySec = 0;
  e.facilityBusy = 0;
  e.facilityCap = 0;
  e.leftBags = 0;
  e.contractDaily = dailyContractRevenue(c, c.day);
  e.dayOffset = c.day - Math.floor(state.now / DAY_SEC);
  return report;
}

/**
 * アクセスの締め: 手段別の旅客数・満車・混雑の遅れ・乗り場の待ちを KPI に記録し、翌日の手段選択への反映（feedback）と
 * 日をまたぐ駐車を会社に保存する。旅客満足度から 0.5 × 道路の平均遅れ(分) + 20 × 満車率 を引く。
 * 空港ホテルの収入 = min(客室数 × 0.9, 旅客数 × 0.03) × 60（1室1泊あたり）。
 */
function settleAccess(sim: Simulation, c: CompanyState, kpi: DailyKpi): void {
  const e = sim.state.economy!;
  const taken = takeAccessStats(sim);
  if (e.hotelRooms > 0) {
    const nights = Math.min(e.hotelRooms * 0.9, (kpi.paxDeparted + kpi.paxArrived) * 0.03);
    post(c, 'hotel', nights * BALANCE.accessFees.hotelPerRoomNight);
  }
  if (!taken) return;
  const s = taken.stats;
  const roadDelay = s.roadDelayN > 0 ? s.roadDelaySum / s.roadDelayN : 0;
  const curbDelay = s.curbDelayN > 0 ? s.curbDelaySum / s.curbDelayN : 0;
  const fullRate = s.carGroups > 0 ? s.parkingFull / s.carGroups : 0;
  const waitMin: AccessFeedback['waitMin'] = {};
  let waitSum = 0;
  let waitPax = 0;
  for (const m of ['taxi', 'bus', 'rail'] as const) {
    if (s.waitPax[m] > 0) waitMin[m] = round1(s.waitSum[m] / s.waitPax[m] / 60);
    waitSum += s.waitSum[m];
    waitPax += s.waitPax[m];
  }
  kpi.modePax = { ...s.pax };
  kpi.parkingFull = s.parkingFull;
  kpi.roadDelayMin = round1(roadDelay);
  kpi.transitWaitMin = waitPax > 0 ? round1(waitSum / waitPax / 60) : 0;
  kpi.accessFactor = sim.state.access!.factor;
  if (kpi.paxSatisfaction !== null) kpi.paxSatisfaction = round1(clamp(kpi.paxSatisfaction - 0.5 * roadDelay - 20 * fullRate));
  c.accessFeedback = { roadDelayMin: round1(roadDelay), curbDelayMin: round1(curbDelay), parkingFullRate: round1(fullRate * 100) / 100, waitMin };
  c.parkedCars = taken.parkedCars;
}

/** 資金がマイナスの日が続くと経営破綻（キャリアモードのみ） */
export function checkBankruptcy(c: CompanyState): void {
  c.negativeDays = c.cash < 0 ? c.negativeDays + 1 : 0;
  if (c.mode === 'career' && c.negativeDays >= BALANCE.bankruptcyDays) c.bankrupt = true;
}
