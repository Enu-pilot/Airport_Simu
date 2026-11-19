import { nightDayReport } from './takeoffDelay';
import { morningWave, settlePhase4 } from '../sim/overnight';
import { AIRCRAFT_TYPES, resolveType, type TypeTable } from '../sim/aircraftTypes';
import { attributeRevenue } from '../analytics/records';
import { operableTypes, type SimContext } from '../sim/context';
import { DAY_SEC } from '../sim/rules';
import type { Simulation } from '../sim/simulation';
import {
  EVENT_LOG_LIMIT,
  PAX_FINAL_STATES,
  isOvernightStay,
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
import { terminalLinkCapacityPerHour } from '../terminal/model';
import { runwaySystemCapacity } from '../runwayCapacity';
import { takeLinkUsage } from '../sim/linkUsage';
import { takeMissBreakdown } from '../sim/missBreakdown';
import { takePortalUsage } from '../sim/portalUsage';
import { PROCESS_STEPS, takeProcessStats } from '../sim/processStats';
import { takeJourneyStats } from '../sim/journeyStats';
import { peakWindowPerHour } from './peakDemand';
import { areaProcessingPerHour } from '../terminal/capacity';
import { takeCargoHandled } from '../sim/cargoStats';
import { cargoActualFinance, planCargoDay } from './cargo';
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
import { CHECKIN_SHARE, isPeak, analyzeDayPlan, planDayWithDemand, PAX_PROCESS_LEAD_SEC } from './planning';
import { airlineScorecard } from './airlineScore';
import { stepAirlineEval } from './airlineEval';
import { evaluateGoals } from './goals';
import { airlineDef, internationalProcessingFor, routeCapabilitiesForAirport } from './registry';
import { routeDemandSummary } from './demand';
import { stepMarket } from './market';
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
    if (f.kind === 'taxiStand' || f.kind === 'busStop' || f.kind === 'busTerminal' || f.kind === 'hotel') accessOps += D.access[f.kind];
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

/** 乗継の失敗は通常の乗り遅れより高い補償（フェーズ 4 §5.4） */
export function onTransferMissed(sim: Simulation, count: number): void {
  if (!enabled(sim)) return;
  post(sim.company, 'compensation', -count * BALANCE.compensation.missedConnection);
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
  // 合成の到着便（フェーズ 4 の置き直し）は集計に数えない
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
    if (f.carryOver) continue; // 合成の到着便は数えない（フェーズ 4 §3.3）
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
  // 地上作業時間 = 準備完了 − ブロックイン（期間内に準備完了した出発便。夜間滞泊は折り返しではなく、貨物便は旅客とは別軸なので除く）
  const ground: number[] = [];
  for (const f of Object.values(state.flights)) {
    if (f.direction !== 'departure' || f.readyAt === null || f.readyAt < from || f.readyAt >= state.now) continue;
    const acf = state.aircraft[f.aircraftId];
    const arr = acf ? state.flights[acf.arrivalFlightId] : undefined;
    if (arr && arr.block !== null && !isOvernightStay(arr, f) && !f.cargo) ground.push(f.readyAt - arr.block);
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
  let paxSatisfactionDetail: DailyKpi['paxSatisfactionDetail'];
  if (dPax.finished + dPax.missed > 0) {
    const missedRate = paxTotal > 0 ? dPax.missed / paxTotal : 0;
    const leftRate = e.leftBags / Math.max(1, bagsLoaded + e.leftBags);
    // 内訳（5-04 / D1）: 満足度 = 100 − 各減点。表示用に材料も残す
    paxSatisfactionDetail = {
      waitPenalty: round1(2 * avgWaitMin),
      walkPenalty: round1(Math.max(0, avgWalkMin - 10)),
      delayPenalty: round1(avgDelayMin),
      missedPenalty: round1(300 * missedRate),
      bagsPenalty: round1(100 * leftRate),
      avgWaitMin: round1(avgWaitMin),
      avgWalkMin: round1(avgWalkMin),
      avgDelayMin: round1(avgDelayMin),
      missedRate,
      leftRate,
    };
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
    runwayUtil: runways > 0 ? Math.min(1, movements / (runwaySystemCapacity(ctx.layout, (r) => ctx.runways[r.id]?.operational ?? false).perHour * (elapsed / 3600))) : 0,
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
    ...(paxSatisfactionDetail ? { paxSatisfactionDetail } : {}),
    airlineSatisfaction: null,
    rating: c.rating,
  };
  return { kpi, byAirline };
}

/** 航空会社満足度 = 有効な契約がある航空会社の満足度の平均（フェーズ 4 §3.5: 拠点の会社は features.based のとき加重 2 倍） */
export function airlineSatisfaction(c: CompanyState): number | null {
  const active = contractsOf(c, 'active');
  const ids = [...new Set(active.map((k) => k.airlineId))];
  if (ids.length === 0) return null;
  const basedIds = c.features?.based ? new Set(active.filter((k) => k.kind === 'based').map((k) => k.airlineId)) : new Set<string>();
  let sum = 0;
  let weight = 0;
  for (const id of ids) {
    const w = basedIds.has(id) ? 2 : 1;
    sum += c.airlines[id]!.satisfaction * w;
    weight += w;
  }
  return round1(sum / weight);
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
/** 乗継統計の前回締め時点の累計（保存対象にしないため WeakMap で保持する） */
const hubStatsPrev = new WeakMap<object, { spawned: number; connected: number; missed: number; noShow: number }>();
/** 地上支援ユニットの稼働累計の前回締め時点（5-02。保存対象にしないため WeakMap で保持する） */
const unitBusyPrev = new WeakMap<object, { at: number; busyById: Map<string, number> }>();

export function settleDay(sim: Simulation, partial: boolean): DailyReport | null {
  if (!enabled(sim)) return null;
  const { state, ctx } = sim;
  const c = sim.company;
  const e = state.economy!;
  const cityStart = c.city ? { ...c.city } : null;
  const cityAccess = state.access?.factor ?? 1;
  const cityCeiling = cityStart ? cityDemandCeiling(cityStart, cityAccess) : 0;
  const routeCapabilities = routeCapabilitiesForAirport(ctx.layout.countryId, { international: internationalProcessingFor(c, ctx.terminal) });
  const cityExpected = cityStart ? expectedPassengers(c, c.day, ctx.types, routeCapabilities) : 0;
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
  const dayPlan = planDayWithDemand(c, c.day, state.access?.factor ?? 1, ctx.types, routeCapabilities);
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
  if (c.market) {
    // 路線市場の日次更新（フェーズ 3 §4.2）: 搭乗率の実績 → 減便・撤退・増便の要望。契約の更新より前に進める
    const summary = routeDemandSummary(c, c.day, state.access?.factor ?? 1, ctx.types, routeCapabilities);
    const routeLf = new Map<string, number>([...(summary ?? new Map())].map(([id, info]) => [id, info.baseLf] as [string, number]));
    for (const ev of stepMarket(c, recs, routeLf)) log(state, ev);
  }
  for (const ev of updateContracts(c, byAirline, evalIn, operableTypes(ctx))) log(state, ev);
  kpi.airlineSatisfaction = airlineSatisfaction(c);
  c.rating = nextRating(c.rating, kpi);
  kpi.rating = c.rating;
  const offers = generateOffers(c, operableTypes(ctx), routeCapabilities.originCountryId, routeCapabilities.internationalPassengerProcessing);
  for (const k of offers) log(state, `${airlineDef(k.airlineId).name} から新しい契約の提案があります`);

  // 貨物の実績収支（5-12）: 計画値ではなく、その期間に貨物タスクが完了して実際に積み下ろしした量から
  // 計算し、台帳へ計上する。貨物契約のない日は従来どおり何も付けない
  const cargoHandled = takeCargoHandled(state);
  const cargoFinance = cargoHandled || planCargoDay(c, c.day).contracts.length > 0
    ? cargoActualFinance(c, c.day, (cargoHandled?.unloadedM3 ?? 0) + (cargoHandled?.loadedM3 ?? 0))
    : undefined;
  if (cargoFinance) {
    post(c, 'cargo', cargoFinance.revenue);
    post(c, 'cargoHandling', -cargoFinance.handlingCost);
  }
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
    ...(cityStart?.nightOps ? { night: nightDayReport(sim, from, state.now) } : {}),
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
  // フェーズ 4 の締め（整備・不具合・持ち越しの記録・拠点の条件）。c.day++ の前に行う
  const p4 = settlePhase4(sim, e.periodStart);
  for (const ev of p4.events) log(state, ev);
  if (p4.maintenance) report.maintenance = p4.maintenance;
  if (p4.readiness) report.morningReadiness = p4.readiness;
  const wave = morningWave(sim, e.periodStart, state.now);
  if (wave) report.morningWave = wave;
  // 資源別の稼働率と待ちの内訳（5-02）
  {
    const prevBusy = unitBusyPrev.get(state);
    const elapsed = prevBusy ? state.now - prevBusy.at : 0;
    const byKind = new Map<string, { units: number; busyDelta: number }>();
    for (const u of Object.values(state.units)) {
      const row = byKind.get(u.kind) ?? { units: 0, busyDelta: 0 };
      row.units++;
      row.busyDelta += u.busySec - (prevBusy?.busyById.get(u.id) ?? 0);
      byKind.set(u.kind, row);
    }
    if (prevBusy && elapsed > 0) {
      const rows: NonNullable<DailyReport['groundUtilization']> = [];
      for (const [kind, row] of byKind) {
        if (row.units <= 0) continue;
        rows.push({ kind, units: row.units, utilization: Math.round((row.busyDelta / (row.units * elapsed)) * 1000) / 1000 });
      }
      if (rows.length > 0) report.groundUtilization = rows.sort((a, b) => b.utilization - a.utilization);
    }
    unitBusyPrev.set(state, { at: state.now, busyById: new Map(Object.values(state.units).map((u) => [u.id, u.busySec])) });
    const waits: NonNullable<DailyReport['groundWaits']> = [];
    for (const reason of ['noVehicle', 'noStaff', 'noEngineer'] as const) {
      const sec = (state.groundStats.blockedSec[reason] ?? 0) - (e.base.ground.blockedSec[reason] ?? 0);
      if (sec > 0) waits.push({ reason, sec });
    }
    if (waits.length > 0) report.groundWaits = waits;
  }
  // 乗り遅れの内訳: 詰まり箇所ごとの人数を読み取り、記録を消す（乗り遅れがあった日だけ日報に付ける）
  const missedBreakdown = takeMissBreakdown(state);
  if (missedBreakdown) report.missedBreakdown = missedBreakdown;
  // 貨物の実績（5-12。台帳への計上は上で済ませ、日報には量と収支の内訳を付ける）
  if (cargoFinance) {
    report.cargo = {
      carriedM3: Math.round(cargoFinance.carriedM3 * 10) / 10,
      leftoverM3: Math.round(cargoFinance.leftoverM3 * 10) / 10,
      revenue: cargoFinance.revenue,
      handlingCost: cargoFinance.handlingCost,
      truckTrips: cargoFinance.truckTrips,
    };
  }
  // リンク利用実績（5-03）: 連絡設備・上下移動の時間帯別人数を読み取り、記録を消す
  const linkUsageRecord = takeLinkUsage(state);
  if (linkUsageRecord) {
    const entries: NonNullable<DailyReport['linkUsage']> = [];
    for (const [linkId, hourly] of Object.entries(linkUsageRecord)) {
      const total = hourly.reduce((a, b) => a + b, 0);
      if (total <= 0) continue;
      let peakHour = 0;
      for (let h = 1; h < 24; h++) if ((hourly[h] ?? 0) > (hourly[peakHour] ?? 0)) peakHour = h;
      if (linkId.startsWith('vertical:')) {
        const areaId = linkId.slice('vertical:'.length);
        const area = ctx.layout.terminalAreas[areaId];
        const link = Object.values(ctx.terminal.links).flat().find((l) => l.verticalTransportId === areaId);
        entries.push({ linkId, kind: 'vertical', label: linkId, areaKind: area?.kind, total, peakHour, peakCount: hourly[peakHour] ?? 0, capacityPerHour: link?.capacityPerHour ?? null, hourly: [...hourly] });
      } else {
        const tlink = ctx.layout.terminalLinks?.[linkId];
        entries.push({ linkId, kind: 'transfer', label: tlink?.name || `連絡設備（${linkId}）`, total, peakHour, peakCount: hourly[peakHour] ?? 0, capacityPerHour: tlink ? terminalLinkCapacityPerHour(tlink) : null, hourly: [...hourly] });
      }
    }
    if (entries.length > 0) report.linkUsage = entries.sort((a, b) => b.total - a.total);
  }
  // 工程別の最混雑 60 分（5-21）: 理論能力（エリア合計・ターミナル間で重複計上しない）・
  // 計画需要（60 分窓の最大、出発は 90 分前に出現する前提）・ピーク時間帯の実績を並べる
  {
    const fromHour = Math.floor(e.periodStart / 3600);
    const toHour = Math.floor(state.now / 3600);
    const stats = takeProcessStats(state, fromHour, toHour);
    if (stats) {
      const depEvents: { at: number; pax: number }[] = [];
      const arrEvents: { at: number; pax: number }[] = [];
      for (const f of Object.values(state.flights)) {
        if (f.scheduled < e.periodStart || f.scheduled >= state.now) continue;
        if (f.direction === 'departure') depEvents.push({ at: f.scheduled - PAX_PROCESS_LEAD_SEC, pax: f.plannedPax ?? 0 });
        else arrEvents.push({ at: f.estimated, pax: f.plannedPax ?? 0 });
      }
      const depPeak = peakWindowPerHour(depEvents);
      const arrPeak = peakWindowPerHour(arrEvents);
      const demandOf = (step: string): number =>
        step === 'checkIn' ? Math.round(depPeak * CHECKIN_SHARE)
        : step === 'immigration' || step === 'customs' ? arrPeak
        : depPeak;
      const rows: NonNullable<DailyReport['processPeak']> = [];
      for (const step of PROCESS_STEPS) {
        let capacity = 0;
        for (const a of Object.values(ctx.layout.terminalAreas)) {
          if (a.kind === step) capacity += areaProcessingPerHour(a.kind, a.props);
        }
        const mine = stats.filter((s) => s.step === step);
        // 空港全体のピークは、ターミナル別の記録を同じ時間帯で合算してから選ぶ（5-21 T5）
        const byHour = new Map<number, { processed: number; waitSecTotal: number; waitPax: number }>();
        for (const st of mine) {
          const h = byHour.get(st.hour) ?? { processed: 0, waitSecTotal: 0, waitPax: 0 };
          h.processed += st.processed;
          h.waitSecTotal += st.waitSecTotal;
          h.waitPax += st.waitPax;
          byHour.set(st.hour, h);
        }
        let peakHourIdx = -1;
        let peakAgg = { processed: 0, waitSecTotal: 0, waitPax: 0 };
        for (const [hour, agg] of byHour) {
          if (agg.processed > peakAgg.processed) {
            peakAgg = agg;
            peakHourIdx = hour;
          }
        }
        const peakProcessed = peakAgg.processed;
        if (capacity <= 0 && peakProcessed <= 0) continue;
        rows.push({
          step,
          capacityPerHour: capacity,
          demandPerHour: demandOf(step),
          peakHour: peakHourIdx >= 0 ? peakHourIdx % 24 : 0,
          peakProcessed,
          utilization: capacity > 0 ? Math.round((peakProcessed / capacity) * 100) / 100 : null,
          avgWaitSec: peakAgg.waitPax > 0 ? Math.round(peakAgg.waitSecTotal / peakAgg.waitPax) : 0,
        });
      }
      if (rows.length > 0) report.processPeak = rows.sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));
      // ターミナル別内訳（5-21 T5）: 能力はそのターミナルのエリア合計だけを数え、共有施設を二重計上しない
      const termRows: NonNullable<DailyReport['processPeakByTerminal']> = [];
      for (const terminalId of [...new Set(stats.map((x) => x.terminalId).filter((t) => t !== ''))]) {
        for (const step of PROCESS_STEPS) {
          const mine = stats.filter((x) => x.step === step && x.terminalId === terminalId);
          if (mine.length === 0) continue;
          let capacity = 0;
          for (const a of Object.values(ctx.layout.terminalAreas)) {
            if (a.kind === step && ctx.terminal.areas[a.id]?.terminalId === terminalId) capacity += areaProcessingPerHour(a.kind, a.props);
          }
          let peak = mine[0]!;
          for (const x of mine) if (x.processed > peak.processed) peak = x;
          if (capacity <= 0 && peak.processed <= 0) continue;
          termRows.push({
            terminalId,
            step,
            capacityPerHour: capacity,
            peakHour: peak.hour % 24,
            peakProcessed: peak.processed,
            utilization: capacity > 0 ? Math.round((peak.processed / capacity) * 100) / 100 : null,
            avgWaitSec: peak.waitPax > 0 ? Math.round(peak.waitSecTotal / peak.waitPax) : 0,
          });
        }
      }
      if (termRows.length > 0) report.processPeakByTerminal = termRows.sort((a, b) => a.terminalId.localeCompare(b.terminalId) || (b.utilization ?? -1) - (a.utilization ?? -1));
    }
  }
  // Door-to-Door KPI（5-23）: 出現→完了の所要時間を分位点で読み取る
  const journey = takeJourneyStats(state);
  if (journey) report.doorToDoor = journey;
  // Portal 通過人数（5-16 T8）: 方向別に読み取り、記録を消す
  const portalUsage = takePortalUsage(state);
  if (portalUsage) {
    report.portalUsage = portalUsage.map((e) => ({
      portalId: e.portalId,
      facilityId: ctx.layout.portals?.[e.portalId]?.facilityId ?? '',
      enter: e.enter,
      exit: e.exit,
    }));
  }
  // アクセスの時間帯別交通量（5-03）: road/curb は台数、bus/rail は出発旅客の人数
  if (state.access) {
    const byMode = new Map<string, number[]>();
    for (const [key, value] of Object.entries(state.access.hourly)) {
      const [mode, hourText] = key.split(':');
      const hour = Number(hourText);
      if (!mode || !Number.isInteger(hour) || hour < 0 || hour > 23 || value <= 0) continue;
      const arr = byMode.get(mode) ?? new Array(24).fill(0);
      arr[hour] += value;
      byMode.set(mode, arr);
    }
    const usage: NonNullable<DailyReport['accessUsage']> = [];
    for (const [mode, hourly] of byMode) {
      const total = hourly.reduce((a, b) => a + b, 0);
      let peakHour = 0;
      for (let h = 1; h < 24; h++) if (hourly[h]! > hourly[peakHour]!) peakHour = h;
      usage.push({ mode, total, peakHour, peakCount: hourly[peakHour] ?? 0 });
    }
    if (usage.length > 0) report.accessUsage = usage;
  }
  // 乗継の当日分（フェーズ 4 §5.6）。累計ではなく当日の増分を記録する
  if (c.features?.hub && state.hubStats) {
    const h = state.hubStats;
    const prev = hubStatsPrev.get(state) ?? { spawned: 0, connected: 0, missed: 0, noShow: 0 };
    report.hub = { spawned: h.spawned - prev.spawned, connected: h.connected - prev.connected, missed: h.missed - prev.missed, noShow: h.noShow - prev.noShow };
    hubStatsPrev.set(state, { spawned: h.spawned, connected: h.connected, missed: h.missed, noShow: h.noShow });
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
