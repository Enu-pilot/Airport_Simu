import { airlineScorecard, type ScoreKey } from '../economy/airlineScore';
import type { CompanyState, DailyReport } from '../economy/company';
import { analyzeDayPlan, planDay, type PlanIssue } from '../economy/planning';
import type { Simulation } from '../sim/simulation';
import { forecastForDay, type WeatherForecast } from '../sim/weather';
import type { DisruptionKind } from '../sim/types';
import type { FlightRecord } from './records';

/**
 * 1 日の振り返り（docs/14_management_rules.md §N）。日次の締めの直後に、既存の日報・運航の記録・障害の記録・
 * 航空会社の評価から作る純関数。シミュレーションも会社も変更しない（読み取りのみ）。
 */

export type ReviewMetric =
  | 'totalRevenue'
  | 'totalCost'
  | 'operatingProfit'
  | 'otp'
  | 'avgDelayMin'
  | 'pax'
  | 'paxSatisfaction'
  | 'airlineSatisfaction'
  | 'rating'
  | 'flights'
  | 'missedPax'
  | 'leftBags'
  | 'diverted'
  | 'cancelled';

/** 良くなる向き（比較の判定。シナリオ比較 KPI_DIRECTION と同じ向きで、重複する指標は揃える） */
export const REVIEW_DIRECTION: Record<ReviewMetric, 'higher' | 'lower'> = {
  totalRevenue: 'higher',
  totalCost: 'lower',
  operatingProfit: 'higher',
  otp: 'higher',
  avgDelayMin: 'lower',
  pax: 'higher',
  paxSatisfaction: 'higher',
  airlineSatisfaction: 'higher',
  rating: 'higher',
  flights: 'higher',
  missedPax: 'lower',
  leftBags: 'lower',
  diverted: 'lower',
  cancelled: 'lower',
};

export interface ReviewCompareRow {
  metric: ReviewMetric;
  a: number | null;
  b: number | null;
  verdict: 'improved' | 'worse' | 'same' | 'n/a';
}

export interface ReviewDisruption {
  id: string;
  kind: DisruptionKind;
  target: string | null;
  start: number;
  end: number | null;
  resolvedBy: 'time' | 'player' | null;
}

/** プレイヤーの対応の回数（UI が数える。シミュレーションには入れない） */
export interface ReviewResponses {
  delays: number;
  reassigns: number;
  priorities: number;
  repairs: number;
}

export const emptyResponses = (): ReviewResponses => ({ delays: 0, reassigns: 0, priorities: 0, repairs: 0 });

/** 天候予報（会社の game.weather === 'levels' のときだけ。それ以外は null。sim/weather.ts） */
export type { WeatherForecast };

export interface DayReview {
  /** 締めた日（0 始まり） */
  day: number;
  report: DailyReport;
  prev: DailyReport | null;
  compare: ReviewCompareRow[];
  delayCauses: { cause: string; flights: number }[];
  disruptions: ReviewDisruption[];
  responses: ReviewResponses;
  airlines: { id: string; before: number; after: number; delta: number; worst: ScoreKey[] }[];
  tomorrow: { flights: number; issues: PlanIssue[]; completing: { id: string; kind: string }[]; weather: WeatherForecast | null };
}

export interface ReviewInput {
  sim: Simulation;
  company: CompanyState;
  /** 振り返る日の初め（ゲーム内の秒） */
  dayStart: number;
  /** 日の初めの航空会社の満足度 */
  airlinesBefore: Record<string, number>;
  responses: ReviewResponses;
  /** アクセス係数（運航の値） */
  access: number;
}

function metricValue(r: DailyReport, m: ReviewMetric): number | null {
  switch (m) {
    case 'totalRevenue':
    case 'totalCost':
    case 'operatingProfit':
      return r[m];
    case 'pax':
      return r.kpi.paxDeparted + r.kpi.paxArrived;
    default:
      return r.kpi[m];
  }
}

/** 前日比の判定（compareResults と同じ規則: 差が 0 なら同じ、向きに合えば改善） */
export function compareReports(a: DailyReport | null, b: DailyReport): ReviewCompareRow[] {
  return (Object.keys(REVIEW_DIRECTION) as ReviewMetric[]).map((metric) => {
    const y = metricValue(b, metric);
    const x = a ? metricValue(a, metric) : null;
    if (x === null || y === null) return { metric, a: x, b: y, verdict: 'n/a' };
    const diff = Math.round((y - x) * 1000) / 1000;
    const verdict = Math.abs(diff) < 1e-9 ? 'same' : (diff > 0) === (REVIEW_DIRECTION[metric] === 'higher') ? 'improved' : 'worse';
    return { metric, a: x, b: y, verdict };
  });
}

/** その日に終わった便の遅延・運航不能の原因を便数で集計する（多い順、同数は名前順） */
export function delayCauseCounts(records: readonly FlightRecord[], from: number, to: number): { cause: string; flights: number }[] {
  const n = new Map<string, number>();
  for (const r of records) {
    const t = r.takeoffAt ?? r.blockOut ?? r.landedAt ?? r.depScheduled;
    if (t < from || t >= to) continue;
    for (const c of new Set(r.causes)) n.set(c, (n.get(c) ?? 0) + 1);
  }
  return [...n].map(([cause, flights]) => ({ cause, flights })).sort((a, b) => b.flights - a.flights || (a.cause < b.cause ? -1 : 1));
}

export function buildDayReview(input: ReviewInput): DayReview {
  const { sim, company, dayStart, airlinesBefore, responses, access } = input;
  const reports = company.reports;
  const report = reports[reports.length - 1]!;
  const prev = reports.length >= 2 ? reports[reports.length - 2]! : null;
  const end = sim.state.economy?.periodStart ?? sim.state.now;
  const records = sim.state.analytics.records;

  const disruptions: ReviewDisruption[] = sim.state.disruptions
    .filter((d) => d.start < end && (d.resolvedAt ?? (d.status === 'resolved' ? d.end : null) ?? Infinity) >= dayStart)
    .map((d) => ({ id: d.id, kind: d.kind, target: d.targetId, start: d.start, end: d.resolvedAt ?? d.end, resolvedBy: d.resolvedBy }));

  const plan = planDay(company, company.day, access, sim.ctx.types);
  const analysis = analyzeDayPlan(plan, sim.ctx);
  const scores = airlineScorecard({ company, ctx: sim.ctx, records: records.filter((r) => (r.takeoffAt ?? r.blockOut ?? r.landedAt ?? r.depScheduled) >= dayStart), plan, analysis });
  const airlines = scores
    .filter((s) => s.active)
    .map((s) => {
      const after = company.airlines[s.airlineId]?.satisfaction ?? s.satisfaction;
      const before = airlinesBefore[s.airlineId] ?? after;
      return { id: s.airlineId, before, after, delta: Math.round((after - before) * 10) / 10, worst: s.lacking.map((c) => c.key) };
    });

  return {
    day: report.day,
    report: structuredClone(report),
    prev: prev ? structuredClone(prev) : null,
    compare: compareReports(prev, report),
    delayCauses: delayCauseCounts(records, dayStart, end),
    disruptions,
    responses: { ...responses },
    airlines,
    tomorrow: {
      flights: plan.flights.length,
      issues: analysis.issues,
      completing: Object.values(company.projects)
        .filter((p) => p.remaining === 1 && p.kind !== 'closure')
        .map((p) => ({ id: p.id, kind: p.kind })),
      weather: company.game?.weather === 'levels' ? forecastForDay(company.seed, company.day, company.game) : null,
    },
  };
}
