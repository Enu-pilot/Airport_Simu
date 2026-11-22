import { Rng } from '../rng';
import { compareIds } from '../model/ids';
import { serviceSecPerPax } from '../terminal/capacity';
import type { SizeClass } from '../model/types';
import { AIRCRAFT_TYPES, resolveType, type AircraftType, type AircraftTypeId, type TypeTable } from '../sim/aircraftTypes';
import { taskNeeds } from '../sim/tasks';
import type { UnitKind } from '../sim/types';
import { checkStand } from '../aircraft/compat';
import { operableTypes, type SimContext } from '../sim/context';
import { BALANCE } from './balance';
import { activeContractsOn, allowedTerminalsFor, seatsFor, type CompanyState, type Contract, type OperatingHours, type TimeWindow } from './company';
import { planCargoDay } from './cargo';
import { airlineDef, classifyRoute, destinationDef, HOME_COUNTRY_ID, routeAvailability, routeCapabilitiesForAirport, type RouteCapabilities } from './registry';
import { CITY_NIGHT_CURFEW, cityDemandCeiling, cityEventEffects, cityOperatingHours, expectedLocalPassengers } from './city';
import { airportFireCategory, requiredFireCategory, towerCapacityPerHour, towerLevel } from '../safety';
import { runwaySystemCapacity } from '../runwayCapacity';
import { featureOn } from './unlocks';
import { routeLoadFactors } from './demand';
import type { TransferKind } from './phase4Types';
import { resolveBusGateForStand } from '../terminal/busGateAssignment';
import { standTerminalId } from '../terminal/standTerminal';

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
  /** 夜間滞泊の便（フェーズ 4）: 到着便はその晩泊まり、出発便は前泊の朝発 */
  overnight?: true;
  /** 国際線の便（フェーズ 4） */
  routeType?: 'international';
  /** 乗継の計画（到着便）: 出発便の key への人数 */
  connections?: { depKey: string; pax: number; kind: TransferKind }[];
  /** 乗継で入ってくる人数（出発便） */
  transferIn?: number;
  /** 乗継の波（バンク）の ID */
  bankId?: string;
  /** 専用スポット（5-08。契約から写す） */
  dedicatedStandId?: string;
}

/** 貨物便の計画（5-12。旅客便とは別枠で、旅客グループは生成しない） */
export interface PlannedCargoFlight {
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
  /** この便（片道）が運ぶ貨物量 (m3) */
  volumeM3: number;
}

export interface DayPlan {
  day: number;
  flights: PlannedFlight[];
  /** 貨物便の計画（5-12）。貨物契約がない日は undefined */
  cargoFlights?: PlannedCargoFlight[];
  /** 前日の夜間滞泊の便（当日の朝に出発する。分析で朝までスポットを占有する分。フェーズ 4 §3.2） */
  prevOvernight?: PlannedFlight[];
  /** 運用時間・時間帯に収まらず計画できなかった便（契約ID） */
  dropped: string[];
  /** 最終出発時刻（日内の分。city.nightOps があるときだけ。dropped の理由の表示に使う） */
  departureCutoffMin?: number;
  /** Carrier or airport route requirements prevent these contracts from being scheduled. */
  unsupportedRoutes?: { contractId: string; destinationId: string; reason: 'airline-unsupported' | 'international-processing-required' }[];
  /** 航空会社の使用ターミナル制限の写し（planDay が会社から引き継ぐ。分析の仮割り当てで参照する） */
  airlineTerminals?: CompanyState['airlineTerminals'];
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

const DAY_SEC_P = 86400;

/**
 * 夜間滞泊の 1 機分（フェーズ 4 §3.2）: 夕方に到着し、翌朝に出発する。
 * 到着は [閉場 − 240 分, 閉場 − 30 分]、出発は翌日の [m, m + 90 分]（m = max(開場 + 30 分, 夜間制限の終わり)）。
 * 乱数は通常の便と同じ種（`${seed}:${契約}:${日}:${i}`）から、位置・旅客数・遅れの順に使う。
 */
export function overnightFlightFor(
  c: CompanyState,
  k: Contract,
  day: number,
  i: number,
  count: number,
  access = 1,
  types: TypeTable = AIRCRAFT_TYPES,
  paxModel?: (k: Contract, u: number) => number,
): PlannedFlight {
  const rng = new Rng(`${c.seed}:${k.id}:${day}:${i}`);
  const seats = seatsFor(c, k.airlineId, k.typeId, types, k.spec);
  const code = airlineDef(k.airlineId).code;
  const from = c.hours.closeMin - 240;
  const to = c.hours.closeMin - 30;
  const pos = (i + 0.5 + (rng.next() - 0.5) * 0.6) / count;
  const arrMin = Math.min(to, Math.max(from, Math.round((from + (to - from) * pos) / 5) * 5));
  const m = Math.max(c.hours.openMin + 30, c.city?.nightOps ? CITY_NIGHT_CURFEW.toMin : 0);
  const posD = (i + 0.5 + (rng.next() - 0.5) * 0.6) / count;
  const depMin = Math.min(m + 90, Math.max(m, Math.round((m + 90 * posD) / 5) * 5));
  const arrPax = Math.round(seats * (paxModel ? paxModel(k, rng.next()) : loadFactor(c, k, rng.next(), access)));
  const depPax = Math.round(seats * (paxModel ? paxModel(k, rng.next()) : loadFactor(c, k, rng.next(), access)));
  const D = BALANCE.demand;
  const inboundDelaySec = rng.next() < D.inboundDelayProb ? rng.int(3, D.inboundDelayMaxMin) * 60 : 0;
  const n = k.numberBase + i * 2;
  return {
    key: `${k.id}:${day}:${i}`,
    contractId: k.id,
    airlineId: k.airlineId,
    destinationId: k.destinationId,
    typeId: k.typeId,
    arrNumber: `${code}${n}`,
    depNumber: `${code}${n + 1}`,
    arrivalAt: arrMin * 60,
    departureAt: DAY_SEC_P + depMin * 60,
    arrPax,
    depPax,
    seats,
    inboundDelaySec,
    overnight: true,
    ...(k.dedicatedStandId ? { dedicatedStandId: k.dedicatedStandId } : {}),
    ...(classifyRoute(HOME_COUNTRY_ID, destinationDef(k.destinationId)) === 'international' ? { routeType: 'international' as const } : {}),
  };
}

/** その晩に泊まる機数（overnight 契約は perDay、based 契約は常駐機数） */
export function overnightCountFor(k: Contract): number {
  if (k.kind === 'overnight') return k.perDay;
  if (k.kind === 'based') return k.basedAircraft ?? 1;
  return 0;
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
  /** 搭乗率の差し替え（フェーズ 3 §3.3。market 有効時の路線需要モデル）。u は従来と同じ位置の乱数 */
  paxModel?: (k: Contract, u: number) => number,
): DayPlan {
  const flights: PlannedFlight[] = [];
  const cargoFlights: PlannedCargoFlight[] = [];
  const dropped: string[] = [];
  const unsupportedRoutes: DayPlan['unsupportedRoutes'] = [];
  const cargoPlan = planCargoDay(c, day);
  for (const k of activeContractsOn(c, day)) {
    // 貨物契約（5-12）は旅客便を生成しない。貨物便として別枠に計画する
    if (k.kind === 'cargo') {
      const range = arrivalRange(k.window, k.typeId, c.hours, types);
      if (!range) {
        dropped.push(k.id);
        continue;
      }
      const code = airlineDef(k.airlineId).code;
      const alloc = cargoPlan.contracts.find((r) => r.contractId === k.id);
      const perLegM3 = alloc && k.perDay > 0 ? alloc.carriedM3 / (k.perDay * 2) : 0;
      for (let i = 0; i < k.perDay; i++) {
        const rng = new Rng(`${c.seed}:${k.id}:${day}:${i}`);
        const [from, to] = range;
        const pos = (i + 0.5 + (rng.next() - 0.5) * 0.6) / k.perDay;
        const arrMin = Math.round((from + (to - from) * pos) / 5) * 5;
        const arrivalAt = Math.min(to, Math.max(from, arrMin)) * 60;
        const departureAt = arrivalAt + resolveType(types, k.typeId).turnaroundSec + PLAN_TURN_BUFFER_SEC;
        const n = k.numberBase + i * 2;
        cargoFlights.push({
          key: `${k.id}:${day}:${i}`, contractId: k.id, airlineId: k.airlineId, destinationId: k.destinationId,
          typeId: k.typeId, arrNumber: `${code}${n}`, depNumber: `${code}${n + 1}`, arrivalAt, departureAt, volumeM3: perLegM3,
        });
      }
      continue;
    }
    const availability = routeAvailability(airlineDef(k.airlineId), destinationDef(k.destinationId), routeCapabilities);
    if (availability !== 'available') {
      unsupportedRoutes.push({ contractId: k.id, destinationId: k.destinationId, reason: availability });
      continue;
    }
    const range = arrivalRange(k.window, k.typeId, c.hours, types);
    const seats = seatsFor(c, k.airlineId, k.typeId, types, k.spec);
    const code = airlineDef(k.airlineId).code;
    // 夜間滞泊（フェーズ 4 §3.2）: overnight 契約は滞泊だけ、based 契約は日中の折り返しに加えて常駐機が滞泊する
    if (k.kind === 'overnight' || k.kind === 'based') {
      const count = overnightCountFor(k);
      const offset = k.kind === 'based' ? k.perDay : 0;
      for (let j = 0; j < count; j++) flights.push(overnightFlightFor(c, k, day, offset + j, count, access, types, paxModel));
      if (k.kind === 'overnight') continue;
    }
    // 波（バンク、フェーズ 4 §5.6）: bankId のある契約は到着・出発を波の時間帯に寄せる（乱数の値は従来と同じ）
    const bank = k.bankId && featureOn(c, 'hub') ? c.hub?.banks.find((b) => b.id === k.bankId) : undefined;
    for (let i = 0; i < k.perDay; i++) {
      if (!range && !bank) {
        dropped.push(k.id);
        continue;
      }
      const rng = new Rng(`${c.seed}:${k.id}:${day}:${i}`);
      const [from, to] = bank ? [bank.arriveFromMin, bank.arriveToMin] : range!;
      const pos = (i + 0.5 + (rng.next() - 0.5) * 0.6) / k.perDay;
      const arrMin = Math.round((from + (to - from) * pos) / 5) * 5;
      const arrivalAt = Math.min(to, Math.max(from, arrMin)) * 60;
      let departureAt = arrivalAt + resolveType(types, k.typeId).turnaroundSec + PLAN_TURN_BUFFER_SEC;
      if (bank) {
        const depMin = Math.round((bank.departFromMin + (bank.departToMin - bank.departFromMin) * pos) / 5) * 5;
        departureAt = Math.max(departureAt, depMin * 60);
      }
      const arrPax = Math.round(seats * (paxModel ? paxModel(k, rng.next()) : loadFactor(c, k, rng.next(), access)));
      const depPax = Math.round(seats * (paxModel ? paxModel(k, rng.next()) : loadFactor(c, k, rng.next(), access)));
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
        ...(bank ? { bankId: bank.id } : {}),
        ...(k.dedicatedStandId ? { dedicatedStandId: k.dedicatedStandId } : {}),
        ...(classifyRoute(routeCapabilities.originCountryId, destinationDef(k.destinationId)) === 'international' ? { routeType: 'international' as const } : {}),
      });
    }
  }
  flights.sort((a, b) => a.arrivalAt - b.arrivalAt || compareIds(a.key, b.key));
  // 前日の滞泊（分析で当日の朝までスポットを占有する分。契約から決定的に求める）
  let prevOvernight: PlannedFlight[] | undefined;
  if (day > 0) {
    const prev: PlannedFlight[] = [];
    for (const k of activeContractsOn(c, day - 1)) {
      if (k.kind !== 'overnight' && k.kind !== 'based') continue;
      if (routeAvailability(airlineDef(k.airlineId), destinationDef(k.destinationId), routeCapabilities) !== 'available') continue;
      const count = overnightCountFor(k);
      const offset = k.kind === 'based' ? k.perDay : 0;
      for (let j = 0; j < count; j++) prev.push(overnightFlightFor(c, k, day - 1, offset + j, count, access, types, paxModel));
    }
    if (prev.length > 0) prevOvernight = prev;
  }
  return { day, flights, dropped, unsupportedRoutes, ...(prevOvernight ? { prevOvernight } : {}), ...(c.airlineTerminals ? { airlineTerminals: c.airlineTerminals } : {}), ...(cargoFlights.length > 0 ? { cargoFlights: cargoFlights.sort((a, b) => a.arrivalAt - b.arrivalAt || compareIds(a.key, b.key)) } : {}) };
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
  // 路線需要モデル（フェーズ 3 §3.3）: market 有効時は契約ごとの搭乗率で計画する。
  // docs/46 §7.1-3: 市場モードでは都市総需要上限による最終スケーリングをしない
  // （OD 別潜在需要を独立させる）。上限は非市場/レガシー経路と都市成長側に残る。
  if (c.market && c.city) {
    const lfs = routeLoadFactors(c, day, access, types, routeCapabilities);
    if (lfs) {
      const noise = BALANCE.market.noise;
      const plan = planDay(planningCompany, day, access, types, routeCapabilities, (k, u) => {
        const lk = lfs.get(k.id);
        if (lk === undefined) return loadFactor(c, k, u, access);
        return Math.min(1, Math.max(0.05, lk * (1 + noise * (2 * u - 1))));
      });
      return { ...plan, ...cutoff };
    }
  }
  const base = planDay(planningCompany, day, access, types, routeCapabilities);
  if (!c.city) return base;
  const event = cityEventEffects(c.city, day);
  // 係数の分母も地元分だけにする（乗継分まで上限で割ると、ハブ交通の源泉である到着旅客ごと削れてしまう）
  const expected = expectedLocalPassengers(c, day, types, routeCapabilities);
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
  | 'OUTSIDE_HOURS' // 運用時間・契約の時間帯に収まらない
  | 'OVERNIGHT_CAPACITY_EXCEEDED' // 滞泊できる機数を超える
  | 'BASED_CONDITIONS_UNMET' // 拠点契約の条件を満たさない
  | 'INTL_GATE_MISSING' // 国際のゲートがない
  | 'TERMINAL_RESTRICTED' // 航空会社の使用ターミナル制限の範囲内にスポットがない
  | 'MCT_UNAVAILABLE' // 乗継の経路がなく MCT が出せない
  | 'FIRE_CATEGORY_LOW' // 消防区分が機体に必要な区分に足りない（5-05、警告）
  | 'TOWER_CAPACITY_LOW'; // 管制塔レベルの処理能力をピークの発着回数が超える（5-05、警告）

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
 * 資源ごとの実効同時処理率（5-02 で実測に当て直し。2026-11-18、サンプル空港・narrow180 の同時到着で測定）:
 * 旧式（ベルト・牽引車 ×1、給油・清掃・ケータリング ×2）では能力 3 だった構成で、同時 3 機から
 * 1 機あたり約 790 秒の資源待ちが出た（待ちゼロは同時 2 機まで）。手荷物系は 1 折り返しで
 * 降ろし・積みの 2 作業が同じ車両を取り合うため 2/3、給油・清掃・ケータリングは 1 作業でも
 * 窓が重なると競合するため 3/2 とし、実測の待ちゼロ同時数（2 機）と一致させた。
 */
export const TURNAROUND_DUTY: Record<string, number> = {
  beltLoader: 2 / 3,
  baggageTractor: 2 / 3,
  fuelTruck: 3 / 2,
  cleaningVan: 3 / 2,
  cateringTruck: 3 / 2,
};

/**
 * 地上支援で同時に扱える折り返しの目安。
 * 燃料施設・整備士・トーイングカーのいずれかがなければ 0（運航は給油・点検・プッシュバックで止まり続ける。ground.ts の noFuelFarm・noEngineer・noVehicle）。
 * 給油の制約は 給油車 × 実効同時処理率 ＋ ハイドラントにつながったスポットの数（1 スポット = 給油能力 1）。
 * トーイングカー・整備士は「有無」として扱う。ランプバスは式に入れない（今後の課題。1-20 / TA-2）。
 */
export function turnaroundCapacity(ctx: SimContext): number {
  const u = groundUnitTotals(ctx);
  const v = (k: string) => u[k] ?? 0;
  if (!ctx.hasFuelFarm || v('engineer') <= 0 || v('tug') <= 0) return 0;
  const eff = (k: string) => Math.floor(v(k) * (TURNAROUND_DUTY[k] ?? 1));
  return Math.max(
    0,
    Math.min(Math.floor(v('staff') / STAFF_PER_TURNAROUND), eff('beltLoader'), eff('baggageTractor'), eff('fuelTruck') + ctx.hydrantStands.size, eff('cleaningVan'), eff('cateringTruck')),
  );
}

export interface TurnaroundCapacityDetail {
  /** 同時に滞りなく処理できる折り返し機数（turnaroundCapacity と同じ前提） */
  capacity: number;
  /**
   * 能力を 0 にしている前提不足（燃料施設・整備士・トーイングカー）。
   * これらが 1 つでもある間は他の資源を増やしても能力は 0 のまま。
   */
  gates: { kind: 'fuelFarm' | 'engineer' | 'tug'; add: number }[];
  /**
   * 能力を決めている（ボトルネックの）資源と、同時処理を +1 機するために必要な追加数。
   * 複数ある場合はすべてそろって初めて +1 機になる。
   */
  limiting: { kind: UnitKind; have: number; add: number }[];
}

/**
 * turnaroundCapacity の内訳: どの資源が同時処理数を決めているかと、+1 機に必要な追加。
 * 表示用（PropertiesPanel の地上支援詳細）。運航判定には使わない。
 */
export function turnaroundCapacityDetail(ctx: SimContext): TurnaroundCapacityDetail {
  const u = groundUnitTotals(ctx);
  const v = (k: string) => u[k] ?? 0;
  const gates: TurnaroundCapacityDetail['gates'] = [];
  if (!ctx.hasFuelFarm) gates.push({ kind: 'fuelFarm', add: 1 });
  if (v('engineer') <= 0) gates.push({ kind: 'engineer', add: 1 });
  if (v('tug') <= 0) gates.push({ kind: 'tug', add: 1 });
  const capacity = turnaroundCapacity(ctx);
  if (gates.length > 0) return { capacity, gates, limiting: [] };

  const target = capacity + 1;
  // 資源ごとの実効能力（turnaroundCapacity の式そのまま）と、target に届く最小の所持数
  const rows: { kind: UnitKind; have: number; eff: number; add: number }[] = [];
  const dutyRow = (kind: 'beltLoader' | 'baggageTractor' | 'fuelTruck' | 'cleaningVan' | 'cateringTruck') => {
    const have = v(kind);
    const duty = TURNAROUND_DUTY[kind] ?? 1;
    const bonus = kind === 'fuelTruck' ? ctx.hydrantStands.size : 0;
    let n = have;
    while (Math.floor(n * duty) + bonus < target) n++;
    rows.push({ kind, have, eff: Math.floor(have * duty) + bonus, add: n - have });
  };
  const staffHave = v('staff');
  rows.push({ kind: 'staff', have: staffHave, eff: Math.floor(staffHave / STAFF_PER_TURNAROUND), add: Math.max(0, target * STAFF_PER_TURNAROUND - staffHave) });
  dutyRow('beltLoader');
  dutyRow('baggageTractor');
  dutyRow('fuelTruck');
  dutyRow('cleaningVan');
  dutyRow('cateringTruck');
  return { capacity, gates, limiting: rows.filter((r) => r.eff <= capacity).map(({ kind, have, add }) => ({ kind, have, add })) };
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
  // ゲートの国内/国際の振り分け（フェーズ 4 §4.3・§4.5）。routeType のないゲートは国内扱い。
  // swing ゲートは種別が変わるとき 600 秒の切り替え間隔が要る（計画の分析でも同じ規則で判定する）
  const gateSwing = new Map<string, { type: 'domestic' | 'international'; until: number }>();
  const gateRtOf = (gateId: string): 'domestic' | 'international' | 'swing' => ctx.terminal.gates[gateId]?.routeType ?? 'domestic';
  const busRts = new Set(ctx.busGates.map((id) => gateRtOf(id)));
  const standRouteOk = (standId: string, intl: boolean, arrivalAt: number, checkSwing = true): boolean => {
    const gid = ctx.standGate[standId];
    if (gid) {
      const rt = gateRtOf(gid);
      if (intl ? rt === 'domestic' : rt === 'international') return false;
      if (checkSwing && rt === 'swing') {
        const cur = gateSwing.get(gid);
        const t = intl ? 'international' : 'domestic';
        if (cur && cur.type !== t && arrivalAt < cur.until + BALANCE.phase4.swingChangeSec) return false;
      }
      return true;
    }
    // リモートスポットはバスゲートの種別で決まる。バスゲート自体がない空港では国際便は置けない
    if (ctx.busGates.length === 0) return !intl;
    return intl ? busRts.has('international') || busRts.has('swing') : busRts.has('domestic') || busRts.has('swing');
  };
  const noteSwingUse = (standId: string, type: 'domestic' | 'international', until: number) => {
    const gid = ctx.standGate[standId];
    if (gid && gateRtOf(gid) === 'swing') gateSwing.set(gid, { type, until });
  };
  // 前日の滞泊は当日の朝までスポットを占有する（出発の早い順に仮割り当て）
  for (const f of [...(plan.prevOvernight ?? [])].sort((a, b) => a.departureAt - b.departureAt)) {
    const type = resolveType(ctx.types, f.typeId);
    const s = stands.find((x) => checkStand(type, ctx.layout.stands[x.id]!, ctx.network).status === 'ok' && (freeAt.get(x.id) ?? -Infinity) <= 0 && standRouteOk(x.id, f.routeType === 'international', 0, false));
    if (s) {
      freeAt.set(s.id, f.departureAt - DAY_SEC_P + STAND_GAP_SEC);
      noteSwingUse(s.id, f.routeType === 'international' ? 'international' : 'domestic', f.departureAt - DAY_SEC_P);
    }
  }
  const blockersByType = new Map<string, string[]>();
  // 専用スポット（5-08）: 契約ごとの専用スポットは、その契約の便が優先し、他契約の便は空きがないときだけ使う
  const dedicatedByStand = new Map<string, string>();
  for (const f of plan.flights) if (f.dedicatedStandId) dedicatedByStand.set(f.dedicatedStandId, f.contractId);
  // 使用ターミナル制限の判定用: スポット→所属ターミナルのキャッシュ（分析中は不変）
  const policyTerminalCache = new Map<string, string | null>();
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
    const intl = f.routeType === 'international';
    // 航空会社の使用ターミナル制限: 許可ターミナル外のスポットは仮割り当ての候補にしない（運航の assignStand と同じ規則。
    // 契約の専用スポットはより具体的な指定として制限より優先する）
    const allowedTerminals = allowedTerminalsFor({ airlineTerminals: plan.airlineTerminals }, f.airlineId, intl ? 'international' : 'domestic');
    const policyOk = (x: (typeof stands)[number]): boolean => {
      if (!allowedTerminals || x.id === f.dedicatedStandId) return true;
      if (!policyTerminalCache.has(x.id)) policyTerminalCache.set(x.id, standTerminalId(ctx, x.id, closedBusGateIds));
      const t = policyTerminalCache.get(x.id);
      return t != null && allowedTerminals.has(t);
    };
    const fitsBase = (x: (typeof stands)[number]) => checkStand(type, ctx.layout.stands[x.id]!, ctx.network).status === 'ok' && (freeAt.get(x.id) ?? -Infinity) <= f.arrivalAt && standRouteOk(x.id, intl, f.arrivalAt);
    const fits = (x: (typeof stands)[number]) => fitsBase(x) && policyOk(x);
    const s = (f.dedicatedStandId ? stands.find((x) => x.id === f.dedicatedStandId && fits(x)) : undefined)
      ?? stands.find((x) => fits(x) && (!dedicatedByStand.has(x.id) || dedicatedByStand.get(x.id) === f.contractId))
      ?? stands.find(fits);
    if (!s) {
      assignments[f.key] = { standId: null, gateId: null, terminalId: null };
      // 国際便で、空き時間に関係なく置けるスポット自体がない場合はゲート不足として区別する（フェーズ 4 §4.5）
      const anyRouteOk = intl && stands.some((x) => checkStand(type, ctx.layout.stands[x.id]!, ctx.network).status === 'ok' && standRouteOk(x.id, true, f.arrivalAt, false));
      // 制限を外せば置けるスポットがある場合は、スポット不足ではなくターミナル制限として区別する
      const blockedByPolicy = !!allowedTerminals && stands.some((x) => fitsBase(x));
      add(blockedByPolicy ? 'TERMINAL_RESTRICTED' : intl && !anyRouteOk ? 'INTL_GATE_MISSING' : 'STAND_CONFLICT', 'error', f.key);
      continue;
    }
    freeAt.set(s.id, f.departureAt + STAND_GAP_SEC);
    noteSwingUse(s.id, intl ? 'international' : 'domestic', f.departureAt);
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
  const capacity = {
    // 滑走路の能力は構成から算出する（5-01。平行の間隔・交差で変わる）
    movementsPerHour: runwaySystemCapacity(ctx.layout, (r) => ctx.runways[r.id]?.operational ?? false).perHour,
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
  // 消防区分・管制塔レベル（5-05）: 助言的な制限として警告だけを出す（運航は止めない）
  const fireCat = airportFireCategory(ctx.layout);
  const fireSeen = new Set<string>();
  for (const f of plan.flights) {
    const t = resolveType(ctx.types, f.typeId);
    const req = requiredFireCategory(t.lengthM);
    if (req > fireCat && !fireSeen.has(f.typeId)) {
      fireSeen.add(f.typeId);
      add('FIRE_CATEGORY_LOW', 'warning', f.key, `${t.label}: 必要区分 ${req} / 空港の区分 ${fireCat === 0 ? 'なし' : fireCat}`);
    }
  }
  const towerCap = towerCapacityPerHour(towerLevel(ctx.layout));
  if (towerCap > 0) {
    for (let h = 0; h < 24; h++) {
      if (movements[h]! > towerCap) {
        for (const k of flightsInHour(h, (f) => hourOf(f.arrivalAt + f.inboundDelaySec) === h || hourOf(f.departureAt) === h)) add('TOWER_CAPACITY_LOW', 'warning', k, `${String(h).padStart(2, '0')}時`);
      }
    }
  }
  // 同時に折り返す機数のピーク
  const points = plan.flights.flatMap((f) => [
    { t: f.arrivalAt + f.inboundDelaySec, d: 1, key: f.key },
    { t: f.departureAt, d: -1, key: f.key },
  ]);
  for (const f of plan.prevOvernight ?? []) points.push({ t: f.departureAt - DAY_SEC_P, d: -1, key: f.key });
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = (plan.prevOvernight ?? []).length;
  let peak = 0;
  const overloaded: string[] = [];
  for (const p of points) {
    cur += p.d;
    peak = Math.max(peak, cur);
    if (p.d > 0 && cur > capacity.turnarounds) overloaded.push(p.key);
  }
  for (const k of overloaded) add('GROUND_OVERLOAD', capacity.turnarounds === 0 ? 'error' : 'warning', k);
  // フェーズ 4 §3.4: 今夜の滞泊の必要数が、運用中で誘導路につながったスポットの能力を超えたらエラー。
  // capacity.ts の overnightFeasible と同じ貪欲判定（planning → capacity の循環 import を避けるためここに置く）
  const ovnFlights = plan.flights.filter((f) => f.overnight);
  if (ovnFlights.length > 0) {
    const req = new Map<string, number>();
    for (const f of ovnFlights) req.set(resolveType(ctx.types, f.typeId).size, (req.get(resolveType(ctx.types, f.typeId).size) ?? 0) + 1);
    const standsAsc = Object.values(ctx.stands).filter((s) => s.operational && s.entry).sort((a, b) => SIZE_RANK[a.size] - SIZE_RANK[b.size]);
    const used = new Set<string>();
    let feasible = true;
    for (const size of ['L', 'M', 'S'] as const) {
      let need = req.get(size) ?? 0;
      for (const st of standsAsc) {
        if (need <= 0) break;
        if (used.has(st.id) || SIZE_RANK[st.size] < SIZE_RANK[size]) continue;
        used.add(st.id);
        need--;
      }
      if (need > 0) { feasible = false; break; }
    }
    if (!feasible) for (const f of ovnFlights) add('OVERNIGHT_CAPACITY_EXCEEDED', 'error', f.key);
  }
  return { assignments, issues, hourly: { movements, depPax }, capacity, terminalCapacity, hourlyByTerminal, peakTurnarounds: peak };
}

/** 時間帯（日内の分）がピークかどうか */
export function isPeak(hours: OperatingHours, minuteOfDay: number): boolean {
  return hours.peaks.some((p) => minuteOfDay >= p.fromMin && minuteOfDay < p.toMin);
}
