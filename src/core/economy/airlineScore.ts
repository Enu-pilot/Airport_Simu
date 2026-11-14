import type { FlightRecord } from '../analytics/records';
import { resolveType, type TypeTable } from '../sim/aircraftTypes';
import { operableTypes, type SimContext } from '../sim/context';
import { ON_TIME_SEC } from './balance';
import { contractsOf, type CompanyState } from './company';
import { evaluateDelayPair } from './delayEvaluation';
import { otpAddOf } from './game';
import type { DayPlan, PlanAnalysis } from './planning';
import { AIRLINES, type AirlineDef } from './registry';

/**
 * 航空会社の評価カード（読み取り専用の導出）。既存のデータ（実績の記録・運航計画の分析・料金・機材）だけから、
 * 要素ごとの判定と「足りないもの」を作る。シミュレーションも会社も変更せず、満足度の計算規則も変えない
 * （総合の満足度は company.airlines[id].satisfaction をそのまま表示する）。値はゲーム用の簡易な指標。
 * 文言は UI 側（i18n/ja.ts）が、ここで返す構造化された事実から作る。
 */
export type ScoreKey = 'otp' | 'turnaround' | 'stand' | 'fees' | 'slots' | 'aircraft' | 'pax';
export type ScoreLevel = 'good' | 'warn' | 'bad' | 'n/a';

export const SCORE_KEYS: readonly ScoreKey[] = ['otp', 'turnaround', 'stand', 'fees', 'slots', 'aircraft', 'pax'];

export interface ScoreFacts {
  /** 主な数値（定時率 0〜1、折り返しの超過分、スポット不足の便数、料金倍率、枠から外れた便数、非対応機種の数、乗り遅れ率） */
  value?: number;
  /** 比べる値（求める定時率、標準の折り返し分、割引後の倍率 など） */
  target?: number;
  /** 件数・標本数 */
  n?: number;
  /** 補足の名前（主な遅延理由、非対応の機種 ID など） */
  names?: string[];
  /** 全体の値で代用した（航空会社別の実績がない） */
  fallback?: boolean;
  /** スポット要素: 計画の便のうちランプバスで搭乗する便の割合（0〜1。バスがなければキーなし。表示のみ） */
  busShare?: number;
  /** 評価要素の根拠として記録できた便名。便に帰属しない要素では欠落する。 */
  flightNumbers?: string[];
}

export interface ScoreComponent {
  key: ScoreKey;
  level: ScoreLevel;
  /** 0〜100（判定できないときは null） */
  score: number | null;
  facts: ScoreFacts;
}

export interface AirlineScore {
  airlineId: string;
  /** 有効な契約がある */
  active: boolean;
  /** 既存の航空会社満足度（0〜100。計算規則は変更しない） */
  satisfaction: number;
  components: ScoreComponent[];
  /** 足りないもの（悪い順に最大 2 つ。なければ空） */
  lacking: ScoreComponent[];
}

export interface ScorecardInput {
  company: CompanyState;
  ctx: SimContext;
  /** 運航中の実績の記録（建設中は空） */
  records: readonly FlightRecord[];
  /** 当日（次の運航日）の計画とその分析 */
  plan: DayPlan;
  analysis: PlanAnalysis;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const LEVEL_RANK: Record<ScoreLevel, number> = { bad: 0, warn: 1, good: 2, 'n/a': 3 };

const na = (key: ScoreKey, facts: ScoreFacts = {}): ScoreComponent => ({ key, level: 'n/a', score: null, facts });

/** 記録から、到着（着陸）・出発（ブロックアウト）の各区間の遅れ（秒、運航不能は null） */
function legDelays(records: readonly FlightRecord[], types: TypeTable): (number | null)[] {
  const out: (number | null)[] = [];
  for (const r of records) {
    if (r.result !== 'completed') {
      out.push(null);
      continue;
    }
    const pair = evaluateDelayPair({
      arrScheduled: r.arrScheduled,
      arrActual: r.landedAt,
      depScheduled: r.depScheduled,
      depBlockOut: r.blockOut,
      turnaroundSec: resolveType(types, r.typeId).turnaroundSec,
      arrivalExternalDelaySec: r.arrivalExternalDelaySec,
    });
    if (r.landedAt !== null) out.push(pair.arrivalSec);
    if (r.blockOut !== null) out.push(pair.departureSec);
  }
  return out;
}

function otpComponent(a: AirlineDef, recs: readonly FlightRecord[], company: CompanyState, types: TypeTable): ScoreComponent {
  const legs = legDelays(recs, types);
  let otp: number | null = null;
  let fallback = false;
  if (legs.length > 0) otp = legs.filter((d) => d !== null && d <= ON_TIME_SEC).length / legs.length;
  else {
    const latest = company.reports[company.reports.length - 1];
    if (latest && latest.kpi.otp !== null) {
      otp = latest.kpi.otp;
      fallback = true;
    }
  }
  if (otp === null) return na('otp');
  // 難易度（game）があれば、航空会社の求める定時率が上がる（なければ加算 0 で従来と同じ）
  const minOtp = a.minOtp + otpAddOf(company);
  const tally = new Map<string, number>();
  for (const r of recs) for (const c of r.causes) if (!c.startsWith('hold:')) tally.set(c, (tally.get(c) ?? 0) + 1);
  const main = [...tally.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0];
  const level: ScoreLevel = otp >= minOtp ? 'good' : otp >= minOtp - 0.1 ? 'warn' : 'bad';
  const late = recs.filter((r) => {
    if (r.result !== 'completed') return false;
    const pair = evaluateDelayPair({ arrScheduled: r.arrScheduled, arrActual: r.landedAt, depScheduled: r.depScheduled, depBlockOut: r.blockOut, turnaroundSec: resolveType(types, r.typeId).turnaroundSec, arrivalExternalDelaySec: r.arrivalExternalDelaySec });
    return (r.landedAt !== null && pair.arrivalSec > ON_TIME_SEC) || (r.blockOut !== null && pair.departureSec > ON_TIME_SEC);
  });
  const flightNumbers = late.flatMap((r) => [r.arrNumber, r.depNumber]);
  return { key: 'otp', level, score: Math.round(clamp((otp / minOtp) * 100)), facts: { value: otp, target: minOtp, n: legs.length, ...(main ? { names: [main] } : {}), ...(flightNumbers.length ? { flightNumbers: [...new Set(flightNumbers)] } : {}), ...(fallback ? { fallback } : {}) } };
}

function turnaroundComponent(recs: readonly FlightRecord[], types: TypeTable): ScoreComponent {
  const rows = recs.filter((r) => r.blockIn !== null && r.readyAt !== null);
  if (rows.length === 0) return na('turnaround');
  const actual = rows.reduce((s, r) => s + (r.readyAt! - r.blockIn!), 0) / rows.length;
  const std = rows.reduce((s, r) => s + resolveType(types, r.typeId).turnaroundSec, 0) / rows.length;
  const over = (actual - std) / 60;
  const level: ScoreLevel = over <= 5 ? 'good' : over <= 15 ? 'warn' : 'bad';
  const flightNumbers = rows.filter((r) => (r.readyAt! - r.blockIn!) > resolveType(types, r.typeId).turnaroundSec).flatMap((r) => [r.arrNumber, r.depNumber]);
  return { key: 'turnaround', level, score: Math.round(clamp(100 - Math.max(0, over) * 4)), facts: { value: Math.round(over), target: Math.round(std / 60), n: rows.length, ...(flightNumbers.length ? { flightNumbers: [...new Set(flightNumbers)] } : {}) } };
}

function standComponent(plan: DayPlan, planKeys: Set<string>, analysis: PlanAnalysis, recs: readonly FlightRecord[], hasFlights: boolean): ScoreComponent {
  if (!hasFlights && recs.length === 0) return na('stand');
  const conflict = new Set<string>();
  const noGate = new Set<string>();
  const busKeys = new Set<string>();
  for (const i of analysis.issues) {
    if (i.code === 'BUS_BOARDING') for (const k of i.keys) if (planKeys.has(k)) busKeys.add(k);
    if (i.code === 'STAND_CONFLICT') for (const k of i.keys) if (planKeys.has(k)) conflict.add(k);
    if (i.code === 'NO_GATE') for (const k of i.keys) if (planKeys.has(k)) noGate.add(k);
  }
  const heldNoStand = recs.filter((r) => r.causes.includes('noStand')).length;
  const level: ScoreLevel = conflict.size > 0 ? 'bad' : noGate.size > 0 || heldNoStand > 0 ? 'warn' : 'good';
  const score = clamp(100 - conflict.size * 40 - noGate.size * 15 - heldNoStand * 10);
  const facts: ScoreFacts = { value: conflict.size, target: noGate.size, n: heldNoStand };
  if (busKeys.size > 0 && planKeys.size > 0) facts.busShare = busKeys.size / planKeys.size;
  const problemKeys = new Set([...conflict, ...noGate, ...busKeys]);
  const planNumbers = plan.flights.filter((f) => problemKeys.has(f.key)).flatMap((f) => [f.arrNumber, f.depNumber]);
  const recordNumbers = recs.filter((r) => r.causes.includes('noStand') || r.causes.includes('noGate') || r.causes.includes('noBus')).flatMap((r) => [r.arrNumber, r.depNumber]);
  const flightNumbers = [...new Set([...planNumbers, ...recordNumbers])];
  if (flightNumbers.length) facts.flightNumbers = flightNumbers;
  return { key: 'stand', level, score: Math.round(score), facts };
}

function feesComponent(a: AirlineDef, company: CompanyState): ScoreComponent {
  const active = contractsOf(company, 'active').filter((k) => k.airlineId === a.id);
  const f = company.fees;
  const avg = (f.landing + f.terminal + f.parking) / 3;
  const disc = active.length > 0 ? active.reduce((s, k) => s + k.feeDiscount, 0) / active.length : 0;
  const eff = avg * (1 - disc);
  const penalty = Math.max(0, eff - 1) * (0.4 + a.priceSensitivity);
  const level: ScoreLevel = penalty <= 0.1 ? 'good' : penalty <= 0.25 ? 'warn' : 'bad';
  return { key: 'fees', level, score: Math.round(clamp(100 - penalty * 200)), facts: { value: avg, target: eff } };
}

function slotsComponent(company: CompanyState, airlineId: string, plan: DayPlan, analysis: PlanAnalysis, planKeys: Set<string>): ScoreComponent {
  const contracts = new Set(contractsOf(company, 'active').filter((k) => k.airlineId === airlineId).map((k) => k.id));
  if (contracts.size === 0) return na('slots');
  const dropped = plan.dropped.filter((id) => contracts.has(id)).length;
  const over = new Set<string>();
  for (const i of analysis.issues) if (i.code === 'RUNWAY_OVERLOAD' || i.code === 'OUTSIDE_HOURS') for (const k of i.keys) if (planKeys.has(k) || contracts.has(k)) over.add(k);
  const level: ScoreLevel = dropped > 0 ? 'bad' : over.size > 0 ? 'warn' : 'good';
  const planNumbers = plan.flights.filter((f) => over.has(f.key)).flatMap((f) => [f.arrNumber, f.depNumber]);
  return { key: 'slots', level, score: Math.round(clamp(100 - dropped * 40 - over.size * 15)), facts: { value: over.size, n: dropped, ...(planNumbers.length ? { flightNumbers: [...new Set(planNumbers)] } : {}) } };
}

function aircraftComponent(a: AirlineDef, company: CompanyState, operable: ReadonlySet<string>): ScoreComponent {
  const contracts = contractsOf(company, 'active').filter((k) => k.airlineId === a.id);
  const fleet = company.fleets?.[a.id] ?? a.fleet;
  if (contracts.length === 0 && fleet.length === 0) return na('aircraft');
  const contractMissing = [...new Set(contracts.map((k) => k.typeId).filter((t) => !operable.has(t)))];
  const fleetMissing = [...new Set(fleet.map((e) => e.typeId).filter((t) => !operable.has(t)))];
  const level: ScoreLevel = contractMissing.length > 0 ? 'bad' : fleetMissing.length > 0 && contracts.length > 0 ? 'warn' : 'good';
  const names = contractMissing.length > 0 ? contractMissing : fleetMissing;
  return {
    key: 'aircraft',
    level,
    score: Math.round(clamp(100 - contractMissing.length * 40 - fleetMissing.length * 10)),
    facts: { value: contractMissing.length, target: fleetMissing.length, ...(names.length ? { names: names.slice(0, 3) } : {}) },
  };
}

function paxComponent(recs: readonly FlightRecord[]): ScoreComponent {
  const booked = recs.reduce((s, r) => s + r.paxBooked, 0);
  const bags = recs.reduce((s, r) => s + r.bagsLoaded + r.bagsLeft, 0);
  if (recs.length === 0 || (booked === 0 && bags === 0)) return na('pax');
  const missed = booked > 0 ? recs.reduce((s, r) => s + r.paxMissed, 0) / booked : 0;
  const left = bags > 0 ? recs.reduce((s, r) => s + r.bagsLeft, 0) / bags : 0;
  const bad = missed + left;
  const level: ScoreLevel = bad <= 0.01 ? 'good' : bad <= 0.05 ? 'warn' : 'bad';
  const affected = recs.filter((r) => r.paxMissed > 0 || r.bagsLeft > 0).flatMap((r) => [r.arrNumber, r.depNumber]);
  return { key: 'pax', level, score: Math.round(clamp(100 - bad * 800)), facts: { value: missed, target: left, n: recs.length, ...(affected.length ? { flightNumbers: [...new Set(affected)] } : {}) } };
}

/** 全航空会社の評価カード（AIRLINES の順） */
export function airlineScorecard(input: ScorecardInput): AirlineScore[] {
  const { company, ctx, records, plan, analysis } = input;
  const operable = new Set<string>(operableTypes(ctx));
  return AIRLINES.map((a) => {
    const recs = records.filter((r) => r.airlineId === a.id);
    const planKeys = new Set(plan.flights.filter((f) => f.airlineId === a.id).map((f) => f.key));
    const components: ScoreComponent[] = [
      otpComponent(a, recs, company, ctx.types),
      turnaroundComponent(recs, ctx.types),
      standComponent(plan, planKeys, analysis, recs, planKeys.size > 0),
      feesComponent(a, company),
      slotsComponent(company, a.id, plan, analysis, planKeys),
      aircraftComponent(a, company, operable),
      paxComponent(recs),
    ];
    const lacking = components
      .filter((c) => c.level === 'bad' || c.level === 'warn')
      .sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level] || (x.score ?? 100) - (y.score ?? 100))
      .slice(0, 2);
    return {
      airlineId: a.id,
      active: contractsOf(company, 'active').some((k) => k.airlineId === a.id),
      satisfaction: company.airlines[a.id]?.satisfaction ?? 0,
      components,
      lacking,
    };
  });
}
