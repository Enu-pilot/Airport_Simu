import { Rng } from '../rng';
import { compareIds } from '../model/ids';
import { sizeAtLeast, type SizeClass } from '../model/types';
import { AIRCRAFT_TYPES, type AircraftTypeId } from '../sim/aircraftTypes';
import { operableTypes, type SimContext } from '../sim/context';
import { BALANCE } from './balance';
import { activeContractsOn, type CompanyState, type Contract, type OperatingHours, type TimeWindow } from './company';
import { airlineDef, destinationDef } from './registry';

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
  inboundDelaySec: number;
}

export interface DayPlan {
  day: number;
  flights: PlannedFlight[];
  /** 運用時間・時間帯に収まらず計画できなかった便（契約ID） */
  dropped: string[];
}

/** 契約の時間帯と運用時間から、到着できる時間の範囲（日内の分）。出発が閉場時刻を越えない */
export function arrivalRange(window: TimeWindow, typeId: AircraftTypeId, hours: OperatingHours): [number, number] | null {
  const [wf, wt] = window === 'any' ? [hours.openMin, hours.closeMin] : WINDOWS[window];
  const turnMin = (AIRCRAFT_TYPES[typeId].turnaroundSec + PLAN_TURN_BUFFER_SEC) / 60;
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
  return Math.min(1, Math.max(0.15, base * destinationDef(k.destinationId).demand * fee * rating * access * noise));
}

/** access = アクセス係数（運航では analyzeAccess の値を渡す。プレビューも同じ値を渡せば実際の運航と一致する） */
export function planDay(c: CompanyState, day: number, access = 1): DayPlan {
  const flights: PlannedFlight[] = [];
  const dropped: string[] = [];
  for (const k of activeContractsOn(c, day)) {
    const range = arrivalRange(k.window, k.typeId, c.hours);
    const seats = AIRCRAFT_TYPES[k.typeId].seats;
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
      const departureAt = arrivalAt + AIRCRAFT_TYPES[k.typeId].turnaroundSec + PLAN_TURN_BUFFER_SEC;
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
        inboundDelaySec,
      });
    }
  }
  flights.sort((a, b) => a.arrivalAt - b.arrivalAt || compareIds(a.key, b.key));
  return { day, flights, dropped };
}

// ---------------------------------------------------------------- 計画の分析

export type PlanIssueCode =
  | 'SIZE_UNSUPPORTED' // 運航できない機種（滑走路・スポットが対応していない）
  | 'STAND_CONFLICT' // 到着時に空きスポットがない
  | 'NO_GATE' // ゲートのないスポットに割り当て（旅客が搭乗できない）
  | 'NO_TERMINAL' // 旅客ターミナル（入口）がない
  | 'RUNWAY_OVERLOAD' // 1時間の離着陸回数が滑走路の処理能力の目安を超える
  | 'SECURITY_OVERLOAD' // 保安検査の処理能力を超える時間帯がある
  | 'CHECKIN_OVERLOAD' // チェックインの処理能力を超える時間帯がある
  | 'GROUND_OVERLOAD' // 同時に折り返す機数が地上支援の能力を超える
  | 'OUTSIDE_HOURS'; // 運用時間・契約の時間帯に収まらない

export interface PlanIssue {
  code: PlanIssueCode;
  severity: 'error' | 'warning';
  /** 対象の便（PlannedFlight.key）または契約ID */
  keys: string[];
  /** 該当する時間（時）など */
  detail?: string;
}

export interface PlanAnalysis {
  assignments: Record<string, { standId: string | null; gateId: string | null }>;
  issues: PlanIssue[];
  /** 時間ごとの離着陸回数・出発旅客数（保安検査を通る時間帯）と、その処理能力 */
  hourly: { movements: number[]; depPax: number[] };
  capacity: { movementsPerHour: number; securityPerHour: number; checkInPerHour: number; turnarounds: number };
  peakTurnarounds: number;
}

const SIZE_RANK: Record<SizeClass, number> = { S: 1, M: 2, L: 3 };

function processingPerHour(ctx: SimContext, kind: 'security' | 'checkIn'): number {
  if (!ctx.paxTerminal) return 0;
  let cap = 0;
  for (const id of ctx.terminal.byTerminal[ctx.paxTerminal] ?? []) {
    const node = ctx.terminal.areas[id]!;
    if (node.kind !== kind) continue;
    const a = ctx.layout.terminalAreas[id]!;
    const servers = Number(a.props.counters ?? a.props.lanes ?? 0);
    const sec = Math.max(1, Number(a.props.serviceSecPerPax ?? 30));
    cap += (servers * 3600) / sec;
  }
  return Math.round(cap);
}

/** 地上支援で同時に扱える折り返しの目安 */
export function turnaroundCapacity(ctx: SimContext): number {
  const u: Record<string, number> = {};
  for (const b of ctx.bases) for (const [k, n] of Object.entries(b.units)) u[k] = (u[k] ?? 0) + (n ?? 0);
  const v = (k: string) => u[k] ?? 0;
  return Math.max(
    0,
    Math.min(Math.floor(v('staff') / STAFF_PER_TURNAROUND), v('beltLoader'), v('baggageTractor'), v('fuelTruck') * 2, v('cleaningVan') * 2, v('cateringTruck') * 2),
  );
}

export function analyzeDayPlan(plan: DayPlan, ctx: SimContext): PlanAnalysis {
  const operable = new Set(operableTypes(ctx));
  const issues: PlanIssue[] = [];
  const add = (code: PlanIssueCode, severity: PlanIssue['severity'], key: string, detail?: string) => {
    const found = issues.find((i) => i.code === code && i.detail === detail);
    if (found) {
      if (!found.keys.includes(key)) found.keys.push(key);
    } else issues.push({ code, severity, keys: [key], ...(detail !== undefined ? { detail } : {}) });
  };
  for (const id of plan.dropped) add('OUTSIDE_HOURS', 'warning', id);

  // スポットの仮割り当て（到着順、区分が合う最小のスポット・ゲート付き優先）
  const stands = Object.values(ctx.stands)
    .filter((s) => s.operational && s.entry)
    .sort((a, b) => SIZE_RANK[a.size] - SIZE_RANK[b.size] || Number(b.contact) - Number(a.contact) || compareIds(a.id, b.id));
  const freeAt = new Map<string, number>();
  const assignments: PlanAnalysis['assignments'] = {};
  for (const f of plan.flights) {
    if (!operable.has(f.typeId)) {
      assignments[f.key] = { standId: null, gateId: null };
      add('SIZE_UNSUPPORTED', 'error', f.key);
      continue;
    }
    const size = AIRCRAFT_TYPES[f.typeId].size;
    const s = stands.find((x) => sizeAtLeast(x.size, size) && (freeAt.get(x.id) ?? -Infinity) <= f.arrivalAt);
    if (!s) {
      assignments[f.key] = { standId: null, gateId: null };
      add('STAND_CONFLICT', 'error', f.key);
      continue;
    }
    freeAt.set(s.id, f.departureAt + STAND_GAP_SEC);
    const gateId = ctx.standGate[s.id] ?? null;
    assignments[f.key] = { standId: s.id, gateId };
    if (!gateId) add('NO_GATE', 'warning', f.key);
  }
  if (plan.flights.length > 0 && !ctx.paxTerminal) add('NO_TERMINAL', 'error', plan.flights[0]!.key);

  // 時間帯ごとの需要
  const movements = new Array<number>(24).fill(0);
  const depPax = new Array<number>(24).fill(0);
  const hourOf = (sec: number) => Math.min(23, Math.max(0, Math.floor(sec / 3600)));
  for (const f of plan.flights) {
    movements[hourOf(f.arrivalAt + f.inboundDelaySec)]!++;
    movements[hourOf(f.departureAt)]!++;
    depPax[hourOf(f.departureAt - PAX_PROCESS_LEAD_SEC)]! += f.depPax;
  }
  const runways = Object.values(ctx.runways).filter((r) => r.operational).length;
  const capacity = {
    movementsPerHour: runways * RUNWAY_HOURLY_CAPACITY,
    securityPerHour: processingPerHour(ctx, 'security'),
    checkInPerHour: processingPerHour(ctx, 'checkIn'),
    turnarounds: turnaroundCapacity(ctx),
  };
  const flightsInHour = (h: number, pred: (f: PlannedFlight) => boolean) => plan.flights.filter(pred).map((f) => f.key);
  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, '0')}時`;
    if (movements[h]! > capacity.movementsPerHour) {
      for (const k of flightsInHour(h, (f) => hourOf(f.arrivalAt + f.inboundDelaySec) === h || hourOf(f.departureAt) === h)) add('RUNWAY_OVERLOAD', 'warning', k, label);
    }
    if (ctx.paxTerminal && depPax[h]! > 0) {
      const inHour = flightsInHour(h, (f) => hourOf(f.departureAt - PAX_PROCESS_LEAD_SEC) === h);
      if (depPax[h]! > capacity.securityPerHour * 0.9) for (const k of inHour) add('SECURITY_OVERLOAD', 'warning', k, label);
      if (depPax[h]! * CHECKIN_SHARE > capacity.checkInPerHour * 0.9) for (const k of inHour) add('CHECKIN_OVERLOAD', 'warning', k, label);
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
  return { assignments, issues, hourly: { movements, depPax }, capacity, peakTurnarounds: peak };
}

/** 時間帯（日内の分）がピークかどうか */
export function isPeak(hours: OperatingHours, minuteOfDay: number): boolean {
  return hours.peaks.some((p) => minuteOfDay >= p.fromMin && minuteOfDay < p.toMin);
}
