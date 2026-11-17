import { Rng } from '../rng';
import { compareIds } from '../model/ids';
import { serviceSecPerPax } from '../terminal/capacity';
import type { SizeClass } from '../model/types';
import { AIRCRAFT_TYPES, resolveType, type AircraftType, type AircraftTypeId, type TypeTable } from '../sim/aircraftTypes';
import { taskNeeds } from '../sim/tasks';
import { checkStand } from '../aircraft/compat';
import { operableTypes, type SimContext } from '../sim/context';
import { BALANCE } from './balance';
import { activeContractsOn, seatsFor, type CompanyState, type Contract, type OperatingHours, type TimeWindow } from './company';
import { airlineDef, destinationDef, routeAvailability, routeCapabilitiesForAirport, type RouteCapabilities } from './registry';
import { CITY_NIGHT_CURFEW, cityDemandCeiling, cityEventEffects, cityOperatingHours, expectedPassengers } from './city';
import { resolveBusGateForStand } from '../terminal/busGateAssignment';

/**
 * 運航計画（docs/14_management_rules.md §4）。
 *
 * 有効な契約から1日分の便（到着 → 折り返し出発）を決定的に作る。便ごとの乱数は
 * `${seed}:${契約ID}:${日}:${便番号}` から作るので、プレビューと実際の運航で同じ計画になる。
 * 計画の分析（スポット・ゲートの仮割り当て、競合・容量超過の検出）は貪欲法による簡易な見積もり。
 */

/** 到着から出発までの余裕（最小折り返し時間に加える） */
export const PLAN_TURN_BUFFER_SEC = 25 * 60;
/** 滑走路1本あたりの1時間の処理能力の目安（離着陸回数） */
export const RUNWAY_HOURLY_CAPACITY = 30;
/** スポットの使用間隔（出発から次の到着までの余裕） */
export const STAND_GAP_SEC = 10 * 60;
/** 1回の折り返しに同時に必要な作業員の目安 */
export const STAFF_PER_TURNAROUND = 4;
/** 出発旅客が保安検査・チェックインを通る時刻（出発の何秒前か）と、チェックインに寄る割合 */
export const PAX_PROCESS_LEAD_SEC = 90 * 60;
export const CHECKIN_SHARE = 0.65;

const WINDOWS: Record<Exclude<TimeWindow, 'any'>, [number, number]> = {
  morning: [6 * 60, 11 * 60],
  daytime: [10 * 60, 17 * 60],
  evening: [16 * 60, 22 * 60],
};

export interface PlannedFlight {
  key: string;
  contractId: string;
  airlineId: string;
  destinationId: string;
  typeId: AircraftTypeId;
  arrNumber: string;
  depNumber: string;
  /** 日内の秒 */
  arrivalAt: number;
  departureAt: number;
  arrPax: number;
  depPax: number;
  /** 座席数（航空会社の座席構成） */
  seats: number;
  inboundDelaySec: number;
}

export interface DayPlan {
  day: number;
  flights: PlannedFlight[];
  /** 運用時間・時間帯に収まらず計画できなかった便（契約ID） */
  dropped: string[];
  /** 最終出発時刻（日内の分。city.nightOps があるときだけ。dropped の理由の表示に使う） */
  departureCutoffMin?: number;
  /** Carrier or airport route requirements prevent these contracts from being scheduled. */
  unsupportedRoutes?: { contractId: string; destinationId: string; reason: 'airline-unsupported' | 'international-processing-required' }[];
}

/** 契約の時間帯と運用時間から、到着できる時間の範囲（日内の分）。出発が閉場時刻を越えない */
export function arrivalRange(window: TimeWindow, typeId: AircraftTypeId, hours: OperatingHours, types: TypeTable = AIRCRAFT_TYPES): [number, number] | null {
  const [wf, wt] = window === 'any' ? [hours.openMin, hours.closeMin] : WINDOWS[window];
  const turnMin = (resolveType(types, typeId).turnaroundSec + PLAN_TURN_BUFFER_SEC) / 60;
  const from = Math.max(wf, hours.openMin);
  const to = Math.min(wt, hours.closeMin - turnMin);
  return from <= to ? [from, to] : null;
}

/**
 * 搭乗率 = 基本搭乗率（航空会社の種類） × 路線需要 × 料金係数 × 評価係数 × (1 ± 揺らぎ)
 *   料金係数 = 1 − (ターミナル使用料の倍率 − 1) × 0.3
 *   評価係数 = 0.75 + (1.15 − 0.75) × 空港評価 / 100
 *   アクセス係数 = 空港へのアクセスの良さ（access/model.ts、0.3〜1.1。指定なしは 1）
 * 0.15〜1.0 に丸める。
 */
export function loadFactor(c: CompanyState, k: Pick<Contract, 'airlineId' | 'destinationId'>, u: number, access = 1): number {
  const D = BALANCE.demand;
  const base = D.baseLoadFactor[airlineDef(k.airlineId).type];
  const fee = 1 - (c.fees.terminal - 1) * BALANCE.feeSensitivity.loadFactorPerRatio;
  const rating = D.ratingFactorMin + ((D.ratingFactorMax - D.ratingFactorMin) * c.rating) / 100;
  const noise = 1 + D.noise * (2 * u - 1);
  return Math.min(1, Math.max(0.15, base * destinationDef(k.destinationId).passengerDemand * fee * rating * access * noise));
}

/**
 * access = アクセス係数（運航では analyzeAccess の値を渡す。プレビューも同じ値を渡せば実際の運航と一致する）
 * types = 機種テーブル（保存時のスナップショットで再現するときはそれを渡す）
 * 座席数は航空会社の座席構成（company.fleets）、なければ機種の既定値。
 */
export function planDay(
  c: CompanyState,
  day: number,
  access = 1,
  types: TypeTable = AIRCRAFT_TYPES,
  routeCapabilities: RouteCapabilities = routeCapabilitiesForAirport(),
): DayPlan {
  const flights: PlannedFlight[] = [];
  const dropped: string[] = [];
  const unsupportedRoutes: DayPlan['unsupportedRoutes'] = [];
  for (const k of activeContractsOn(c, day)) {
    const availability = routeAvailability(airlineDef(k.airlineId), destinationDef(k.destinationId), routeCapabilities);
    if (availability !== 'available') {
      unsupportedRoutes.push({ contractId: k.id, destinationId: k.destinationId, reason: availability });
      continue;
    }
    const range = arrivalRange(k.window, k.typeId, c.hours, types);
    const seats = seatsFor(c, k.airlineId, k.typeId, types);
    const code = airlineDef(k.airlineId).code;
    for (let i = 0; i < k.perDay; i++) {
      if (!range) {
        dropped.push(k.id);
        continue;
      }
      const rng = new Rng(`${c.seed}:${k.id}:${day}:${i}`);
      const [from, to] = range;
      const pos = (i + 0.5 + (rng.next() - 0.5) * 0.6) / k.perDay;
      const arrMin = Math.round((from + (to - from) * pos) / 5) * 5;
      const arrivalAt = Math.min(to, Math.max(from, arrMin)) * 60;
      const departureAt = arrivalAt + resolveType(types, k.typeId).turnaroundSec + PLAN_TURN_BUFFER_SEC;
      const arrPax = Math.round(seats * loadFactor(c, k, rng.next(), access));
      const depPax = Math.round(seats * loadFactor(c, k, rng.next(), access));
      const D = BALANCE.demand;
      const inboundDelaySec = rng.next() < D.inboundDelayProb ? rng.int(3, D.inboundDelayMaxMin) * 60 : 0;
      const n = k.numberBase + i * 2;
      flights.push({
        key: `${k.id}:${day}:${i}`,
        contractId: k.id,
        airlineId: k.airlineId,
        destinationId: k.destinationId,
        typeId: k.typeId,
        arrNumber: `${code}${n}`,
        depNumber: `${code}${n + 1}`,
        arrivalAt,
        departureAt,
        arrPax,
        depPax,
        seats,
        inboundDelaySec,
      });
    }
  }
  flights.sort((a, b) => a.arrivalAt - b.arrivalAt || compareIds(a.key, b.key));
  return { day, flights, dropped, unsupportedRoutes };
}

/** 都市設定があるときだけ、アクセス性に都市需要上限を反映する計画。設定なしは従来の計画を返す。 */
export function planDayWithDemand(
  c: CompanyState,
  day: number,
  access = 1,
  types: TypeTable = AIRCRAFT_TYPES,
  routeCapabilities: RouteCapabilities = routeCapabilitiesForAirport(),
): DayPlan {
  const planningCompany = c.city ? { ...c, hours: cityOperatingHours(c.hours, c.city) } : c;
  const cutoff = c.city?.nightOps ? { departureCutoffMin: Math.min(c.hours.closeMin, CITY_NIGHT_CURFEW.fromMin, c.city.nightOps.departureCutoffMin) } : {};
  const base = planDay(planningCompany, day, access, types, routeCapabilities);
  if (!c.city) return base;
  const event = cityEventEffects(c.city, day);
  const expected = expectedPassengers(c, day, types, routeCapabilities);
  const factor = Math.min(1.1 * event.demandMultiplier, cityDemandCeiling(c.city, access) * event.demandMultiplier / Math.max(1, expected));
  return { ...planDay(planningCompany, day, access * factor, types, routeCapabilities), ...cutoff };
}

// ---------------------------------------------------------------- 計画の分析

export type PlanIssueCode =
  | 'SIZE_UNSUPPORTED'
  | 'GROUND_SUPPORT_MISSING'
 // 運航できない機種（滑走路・スポットが対応していない）
  | 'STAND_CONFLICT' // 到着時に空きスポットがない
  | 'NO_GATE' // ゲートのないスポットに割り当て（旅客が搭乗できない）
  | 'BUS_BOARDING' // バスゲートがある空港のリモートスポット（ランプバスで搭乗。情報）
  | 'INVALID_BUS_GATE' // 個別指定したバスゲートが未設定・利用不能
  | 'NO_TERMINAL' // 旅客ターミナル（入口）がない
  | 'RUNWAY_OVERLOAD' // 1時間の離着陸回数が滑走路の処理能力の目安を超える
  | 'SECURITY_OVERLOAD' // 保安検査の処理能力を超える時間帯がある
  | 'CHECKIN_OVERLOAD' // チェックインの処理能力を超える時間帯がある
  | 'GROUND_OVERLOAD' // 同時に折り返す機数が地上支援の能力を超える
  | 'AIRLINE_ROUTE_UNSUPPORTED' // 航空会社がこの路線種別を運航しない
  | 'INTERNATIONAL_PROCESSING_REQUIRED' // 国際旅客処理設備が未実装・不足
  | 'OUTSIDE_HOURS'; // 運用時間・契約の時間帯に収まらない

export interface PlanIssue {
  code: PlanIssueCode;
  severity: 'error' | 'warning' | 'info';
  /** 対象の便（PlannedFlight.key）または契約ID */
  keys: string[];
  /** 該当する時間（時）など */
  detail?: string;
}

export interface PlanAnalysis {
  assignments: Record<string, { standId: string | null; gateId: string | null; terminalId: string | null; busGateId?: string | null }>;
  issues: PlanIssue[];
  /** 時間ごとの離着陸回数・出発旅客数（保安検査を通る時間帯）と、その処理能力 */
  hourly: { movements: number[]; depPax: number[] };
  capacity: {
    movementsPerHour: number;
    securityPerHour: number;
    checkInPerHour: number;
    turnarounds: number;
    totalStands: number;
    contactStands: number;
    remoteStands: number;
    /** 機材数は把握できるが、同じ作業員の重複稼働を除いた同時数はモデル化されていない */
    simultaneousPushbacks: null;
    /** 誘導路の通過レートがモデル化されていないため未算出 */
    taxiwayMovementsPerHour: null;
    /** 実際の滑走路処理能力は時間帯・構成差を含むため未算出 */
    dailyMovements: null;
    /** バスの定員・往復時間・道路所要時間を合わせたレートがないため未算出 */
    busPaxPerHour: null;
  };
  /** ターミナルごとの処理能力。出発需要の警告もこの単位で比較する。 */
  terminalCapacity: Record<string, { securityPerHour: number; checkInPerHour: number }>;
  hourlyByTerminal: Record<string, number[]>;
  peakTurnarounds: number;
}

const SIZE_RANK: Record<SizeClass, number> = { S: 1, M: 2, L: 3 };

function processingPerHour(ctx: SimContext, terminalId: string, kind: 'security' | 'checkIn'): number {
  // Planned or in-construction terminals do not contribute operational throughput.
  if (ctx.layout.facilities[terminalId]?.buildState !== 'operational') return 0;
  let cap = 0;
  for (const id of ctx.terminal.byTerminal[terminalId] ?? []) {
    const node = ctx.terminal.areas[id]!;
    if (node.kind !== kind) continue;
    const a = ctx.layout.terminalAreas[id]!;
    const servers = Number(a.props.counters ?? a.props.lanes ?? 0);
    const sec = serviceSecPerPax(node.kind, a.props);
    cap += (servers * 3600) / sec;
  }
  return Math.round(cap);
}

function groundUnitTotals(ctx: SimContext): Record<string, number> {
  const u: Record<string, number> = {};
  for (const b of ctx.bases) for (const [k, n] of Object.entries(b.units)) u[k] = (u[k] ?? 0) + (n ?? 0);
  return u;
}

/**
 * 地上支援で同時に扱える折り返しの目安。
 * 燃料施設・整備士・トーイングカーのいずれかがなければ 0（運航は給油・点検・プッシュバックで止まり続ける。ground.ts の noFuelFarm・noEngineer・noVehicle）。
 * 給油の制約は 給油車 × 2 ＋ ハイドラントにつながったスポットの数（1 スポット = 給油能力 1）。1 台あたりの処理数は根拠がないので作らず、
 * トーイングカー・整備士は「有無」として扱う。ランプバスは式に入れない（今後の課題。1-20 / TA-2）。
 */
export function turnaroundCapacity(ctx: SimContext): number {
  const u = groundUnitTotals(ctx);
  const v = (k: string) => u[k] ?? 0;
  if (!ctx.hasFuelFarm || v('engineer') <= 0 || v('tug') <= 0) return 0;
  return Math.max(
    0,
    Math.min(Math.floor(v('staff') / STAFF_PER_TURNAROUND), v('beltLoader'), v('baggageTractor'), v('fuelTruck') * 2 + ctx.hydrantStands.size, v('cleaningVan') * 2, v('cateringTruck') * 2),
  );
}

/**
 * 折り返しが無期限に止まる地上支援の不足（燃料施設・整備士・トーイングカー、ハイドラントがないときの給油車）の一覧。
 * 運航側の停止条件（ground.ts: noFuelFarm / noEngineer / noVehicle）と同じ判定。空なら不足なし。
 */
export function groundBlockers(ctx: SimContext, type: AircraftType): string[] {
  const u = groundUnitTotals(ctx);
  const out: string[] = [];
  if (!ctx.hasFuelFarm) out.push('燃料施設');
  if ((taskNeeds(type, 'inspect').engineer ?? 0) > 0 && (u.engineer ?? 0) <= 0) out.push('整備士');
  if ((taskNeeds(type, 'pushback').tug ?? 0) > 0 && (u.tug ?? 0) <= 0) out.push('トーイングカー');
  if ((taskNeeds(type, 'fuel').fuelTruck ?? 0) > 0 && (u.fuelTruck ?? 0) <= 0 && ctx.hydrantStands.size === 0) out.push('給油車');
  return out;
}

export function analyzeDayPlan(plan: DayPlan, ctx: SimContext, closedBusGateIds: readonly string[] = []): PlanAnalysis {
  const operable = new Set(operableTypes(ctx));
  const issues: PlanIssue[] = [];
  const add = (code: PlanIssueCode, severity: PlanIssue['severity'], key: string, detail?: string) => {
    const found = issues.find((i) => i.code === code && i.detail === detail);
    if (found) {
      if (!found.keys.includes(key)) found.keys.push(key);
    } else issues.push({ code, severity, keys: [key], ...(detail !== undefined ? { detail } : {}) });
  };

  for (const route of plan.unsupportedRoutes ?? []) {
    add(
      route.reason === 'airline-unsupported' ? 'AIRLINE_ROUTE_UNSUPPORTED' : 'INTERNATIONAL_PROCESSING_REQUIRED',
      'error',
      route.contractId,
      route.destinationId,
    );
  }
  const cutoffDetail = plan.departureCutoffMin !== undefined
    ? `最終出発時刻 ${String(Math.floor(plan.departureCutoffMin / 60)).padStart(2, '0')}:${String(plan.departureCutoffMin % 60).padStart(2, '0')}`
    : undefined;
  for (const id of plan.dropped) add('OUTSIDE_HOURS', 'warning', id, cutoffDetail);

  // スポットの仮割り当て（到着順、区分が合う最小のスポット・ゲート付き優先）
  const stands = Object.values(ctx.stands)
    .filter((s) => s.operational && s.entry)
    .sort((a, b) => SIZE_RANK[a.size] - SIZE_RANK[b.size] || Number(b.contact) - Number(a.contact) || compareIds(a.id, b.id));
  const freeAt = new Map<string, number>();
  const blockersByType = new Map<string, string[]>();
  const assignments: PlanAnalysis['assignments'] = {};
  for (const f of plan.flights) {
    if (!operable.has(f.typeId)) {
      assignments[f.key] = { standId: null, gateId: null, terminalId: null };
      add('SIZE_UNSUPPORTED', 'error', f.key);
      continue;
    }
    // スポットの適合性は aircraft/compat.ts の判定を使う（区分・コード F）
    const type = resolveType(ctx.types, f.typeId);
    // 地上支援の不足（燃料施設・整備士・トーイングカー・給油車）: 運航では折り返しが止まり続けるのでエラー（canOperate / operableTypes は変えない。1-15 / E-2）
    let blockers = blockersByType.get(f.typeId);
    if (!blockers) blockersByType.set(f.typeId, (blockers = groundBlockers(ctx, type)));
    if (blockers.length > 0) add('GROUND_SUPPORT_MISSING', 'error', f.key, blockers.join('・'));
    const s = stands.find((x) => checkStand(type, ctx.layout.stands[x.id]!, ctx.network).status === 'ok' && (freeAt.get(x.id) ?? -Infinity) <= f.arrivalAt);
    if (!s) {
      assignments[f.key] = { standId: null, gateId: null, terminalId: null };
      add('STAND_CONFLICT', 'error', f.key);
      continue;
    }
    freeAt.set(s.id, f.departureAt + STAND_GAP_SEC);
    const gateId = ctx.standGate[s.id] ?? null;
    // A contact gate owns the passenger terminal. Remote stands use the shared
    // preview/live selector, so their bus gate and terminal are fixed together.
    const standPoint = ctx.network.nodes[ctx.stands[s.id]?.node ?? '']?.pos ?? null;
    const busAssignment = !ctx.stands[s.id]?.contact
      ? resolveBusGateForStand(ctx.layout, ctx.terminal, s.id, standPoint, ctx.busGates, closedBusGateIds)
      : null;
    const terminalId = gateId
      ? ctx.terminal.gates[gateId]?.terminalId ?? null
      : busAssignment?.terminalId ?? (s.remoteBoarding === undefined && ctx.busGates.length === 0 && Object.keys(ctx.terminal.byTerminal).length === 1 ? ctx.paxTerminal : null);
    assignments[f.key] = {
      standId: s.id,
      gateId,
      terminalId,
      ...(!ctx.stands[s.id]?.contact && s.remoteBoarding !== 'none' ? { busGateId: busAssignment?.gateId ?? null } : {}),
    };
    if (!gateId) {
      if (busAssignment?.failure === 'invalidGate') add('INVALID_BUS_GATE', 'error', f.key, `指定ゲート ${s.busGateId} が運用中で、同一ターミナルの搭乗口・降機口へ接続されている必要があります`);
      else if (!busAssignment?.gateId && s.remoteBoarding !== 'none' && ctx.busGates.length > 0) add('INVALID_BUS_GATE', 'error', f.key, '利用可能なバスゲートがありません。運用状態・ターミナル接続・搭乗口・降機口を確認してください');
      else if (s.remoteBoarding === 'none') add('NO_GATE', 'warning', f.key, 'このリモートスポットはバス搭乗を無効にしています');
      else if (busAssignment?.terminalId) add('BUS_BOARDING', 'info', f.key);
      else if (busAssignment?.gateId) add('BUS_BOARDING', 'info', f.key);
      else add('NO_GATE', 'warning', f.key);
    }
  }
  if (plan.flights.length > 0 && !ctx.paxTerminal) add('NO_TERMINAL', 'error', plan.flights[0]!.key);

  // 時間帯ごとの需要
  const movements = new Array<number>(24).fill(0);
  const depPax = new Array<number>(24).fill(0);
  const terminalIds = Object.keys(ctx.terminal.byTerminal).sort(compareIds);
  const terminalCapacity = Object.fromEntries(terminalIds.map((id) => [id, {
    securityPerHour: processingPerHour(ctx, id, 'security'),
    checkInPerHour: processingPerHour(ctx, id, 'checkIn'),
  }]));
  const hourlyByTerminal = Object.fromEntries(terminalIds.map((id) => [id, new Array<number>(24).fill(0)]));
  const hourOf = (sec: number) => Math.min(23, Math.max(0, Math.floor(sec / 3600)));
  for (const f of plan.flights) {
    movements[hourOf(f.arrivalAt + f.inboundDelaySec)]!++;
    movements[hourOf(f.departureAt)]!++;
    depPax[hourOf(f.departureAt - PAX_PROCESS_LEAD_SEC)]! += f.depPax;
    // A single-terminal airport has an unambiguous fallback even when stand
    // planning failed. In multi-terminal airports, never guess a terminal.
    const terminalId = assignments[f.key]?.terminalId ?? (terminalIds.length === 1 ? terminalIds[0] : undefined);
    if (terminalId && hourlyByTerminal[terminalId]) hourlyByTerminal[terminalId]![hourOf(f.departureAt - PAX_PROCESS_LEAD_SEC)]! += f.depPax;
  }
  const runways = Object.values(ctx.runways).filter((r) => r.operational).length;
  const capacity = {
    movementsPerHour: runways * RUNWAY_HOURLY_CAPACITY,
    securityPerHour: Object.values(terminalCapacity).reduce((sum, c) => sum + c.securityPerHour, 0),
    checkInPerHour: Object.values(terminalCapacity).reduce((sum, c) => sum + c.checkInPerHour, 0),
    turnarounds: turnaroundCapacity(ctx),
    totalStands: stands.length,
    contactStands: stands.filter((s) => s.contact).length,
    remoteStands: stands.filter((s) => !s.contact).length,
    simultaneousPushbacks: null,
    taxiwayMovementsPerHour: null,
    dailyMovements: null,
    busPaxPerHour: null,
  };
  const flightsInHour = (h: number, pred: (f: PlannedFlight) => boolean) => plan.flights.filter(pred).map((f) => f.key);
  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, '0')}時`;
    if (movements[h]! > capacity.movementsPerHour) {
      for (const k of flightsInHour(h, (f) => hourOf(f.arrivalAt + f.inboundDelaySec) === h || hourOf(f.departureAt) === h)) add('RUNWAY_OVERLOAD', 'warning', k, label);
    }
    for (const terminalId of terminalIds) {
      const pax = hourlyByTerminal[terminalId]![h]!;
      if (pax <= 0) continue;
      const inHour = flightsInHour(h, (f) => hourOf(f.departureAt - PAX_PROCESS_LEAD_SEC) === h && assignments[f.key]?.terminalId === terminalId);
      const detail = terminalIds.length > 1 ? `${terminalId} ${label}` : label;
      const c = terminalCapacity[terminalId]!;
      if (pax > c.securityPerHour * 0.9) for (const k of inHour) add('SECURITY_OVERLOAD', 'warning', k, detail);
      if (pax * CHECKIN_SHARE > c.checkInPerHour * 0.9) for (const k of inHour) add('CHECKIN_OVERLOAD', 'warning', k, detail);
    }
  }
  // 同時に折り返す機数のピーク
  const points = plan.flights.flatMap((f) => [
    { t: f.arrivalAt + f.inboundDelaySec, d: 1, key: f.key },
    { t: f.departureAt, d: -1, key: f.key },
  ]);
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let peak = 0;
  const overloaded: string[] = [];
  for (const p of points) {
    cur += p.d;
    peak = Math.max(peak, cur);
    if (p.d > 0 && cur > capacity.turnarounds) overloaded.push(p.key);
  }
  for (const k of overloaded) add('GROUND_OVERLOAD', capacity.turnarounds === 0 ? 'error' : 'warning', k);
  return { assignments, issues, hourly: { movements, depPax }, capacity, terminalCapacity, hourlyByTerminal, peakTurnarounds: peak };
}

/** 時間帯（日内の分）がピークかどうか */
export function isPeak(hours: OperatingHours, minuteOfDay: number): boolean {
  return hours.peaks.some((p) => minuteOfDay >= p.fromMin && minuteOfDay < p.toMin);
}
