import { airlineScorecard, type ScoreKey } from '../economy/airlineScore';
import type { CompanyState, DailyReport } from '../economy/company';
import { analyzeDayPlan, planDayWithDemand, type PlanIssue } from '../economy/planning';
import type { Simulation } from '../sim/simulation';
import { forecastForDay, type WeatherForecast } from '../sim/weather';
import type { DisruptionKind } from '../sim/types';
import type { FlightRecord } from './records';
import type { AirlineRequest, RequestKind } from '../economy/airlineEval';

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

export interface ReviewBottleneck {
  cause: string;
  flights: number;
  flightNumbers: string[];
  /** 実発生時刻を個別に記録していない原因は、運航記録の時刻で概況を示す */
  firstRecordAt: number;
  lastRecordAt: number;
  evidence: string;
  recommendation: string;
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
  /** 日中に終了記録が作られた便の実ログに基づく原因・影響便・対応案 */
  bottlenecks: ReviewBottleneck[];
  disruptions: ReviewDisruption[];
  responses: ReviewResponses;
  airlines: {
    id: string;
    before: number;
    after: number;
    delta: number;
    worst: ScoreKey[];
    /** 航空会社の評価（game.airlineEval のときだけ）: 現在の不満、この日に生じた不満、未達の要望、この日に達成した要望 */
    complaints?: ScoreKey[];
    newComplaints?: ScoreKey[];
    requests?: AirlineRequest[];
    fulfilled?: RequestKind[];
  }[];
  /** 目標（game.goals のときだけ）: この日に達成した目標・報酬の現金・昇格した格 */
  goals?: { completed: { id: string; cash: number }[]; tier: number; tierUp: boolean };
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

const recordTime = (r: FlightRecord): number => r.takeoffAt ?? r.blockOut ?? r.landedAt ?? r.depScheduled;

/** 保存済みの実便記録だけを使う。設定値から不足台数や処理能力を推定しない。 */
export function buildReviewBottlenecks(records: readonly FlightRecord[], from: number, to: number): ReviewBottleneck[] {
  const groups = new Map<string, FlightRecord[]>();
  for (const r of records) {
    if (recordTime(r) < from || recordTime(r) >= to) continue;
    for (const cause of new Set(r.causes)) groups.set(cause, [...(groups.get(cause) ?? []), r]);
  }
  const meanMin = (values: number[]): number | null => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length / 60 * 10) / 10 : null;
  return [...groups.entries()].map(([cause, rs]) => {
    const times = rs.map(recordTime).sort((a, b) => a - b);
    const taxi = meanMin(rs.map((r) => r.taxiOutSec));
    const stops = meanMin(rs.map((r) => r.groundStopSec));
    const taskWait = meanMin(rs.map((r) => r.taskBlockedSec));
    const busWait = meanMin(rs.flatMap((r) => r.busWaitSec === undefined ? [] : [r.busWaitSec]));
    let evidence = `対象 ${rs.length}便`;
    if (cause === 'apronBus') evidence += busWait === null ? '・バス待ち時間の記録なし' : `・平均バス待ち ${busWait}分`;
    else if (cause === 'taxiCongestion') evidence += `・平均出発地上走行 ${taxi ?? 0}分・平均地上停止 ${stops ?? 0}分`;
    else if (cause === 'turnaround' || cause === 'groundHandling') evidence += `・平均作業待ち ${taskWait ?? 0}分`;
    else if (cause === 'runwayQueue') evidence += `・平均地上停止 ${stops ?? 0}分`;
    const recommendation = cause === 'apronBus'
      ? 'ピーク時のバス待ちと配車を確認し、バス配置または便の時間を調整してください。'
      : cause === 'taxiCongestion'
        ? '記録便の地上走行・停止を確認し、誘導路の経路または便の時間を見直してください。'
        : cause === 'runwayQueue'
          ? '滑走路の待機と離着陸の集中を確認し、運用方向または便の時間を調整してください。'
          : cause === 'turnaround' || cause === 'groundHandling'
            ? '機種別の作業記録を確認し、不足する人員・車両を補うか折り返し時刻を分散してください。'
            : '対象便の運航記録とイベントを確認して原因を切り分けてください。';
    return {
      cause,
      flights: rs.length,
      flightNumbers: [...new Set(rs.map((r) => `${r.arrNumber}/${r.depNumber}`))].sort(),
      firstRecordAt: times[0]!,
      lastRecordAt: times[times.length - 1]!,
      evidence,
      recommendation,
    };
  }).sort((a, b) => b.flights - a.flights || (a.cause < b.cause ? -1 : 1));
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

  const plan = planDayWithDemand(company, company.day, access, sim.ctx.types);
  const analysis = analyzeDayPlan(plan, sim.ctx);
  const scores = airlineScorecard({ company, ctx: sim.ctx, records: records.filter((r) => (r.takeoffAt ?? r.blockOut ?? r.landedAt ?? r.depScheduled) >= dayStart), plan, analysis });
  const airlines = scores
    .filter((s) => s.active)
    .map((s) => {
      const after = company.airlines[s.airlineId]?.satisfaction ?? s.satisfaction;
      const before = airlinesBefore[s.airlineId] ?? after;
      const ev = company.airlineEval?.[s.airlineId];
      return {
        id: s.airlineId,
        before,
        after,
        delta: Math.round((after - before) * 10) / 10,
        worst: s.lacking.map((c) => c.key),
        ...(ev
          ? {
              complaints: ev.complaints.map((x) => x.key),
              newComplaints: ev.complaints.filter((x) => x.sinceDay === report.day).map((x) => x.key),
              requests: ev.requests.map((x) => ({ ...x })),
              fulfilled: ev.done.filter((x) => x.day === report.day).map((x) => x.kind),
            }
          : {}),
      };
    });

  return {
    day: report.day,
    report: structuredClone(report),
    prev: prev ? structuredClone(prev) : null,
    compare: compareReports(prev, report),
    delayCauses: delayCauseCounts(records, dayStart, end),
    bottlenecks: buildReviewBottlenecks(records, dayStart, end),
    disruptions,
    responses: { ...responses },
    airlines,
    ...(company.goals
      ? {
          goals: {
            completed: company.goals.grants.filter((g) => g.day === report.day).map((g) => ({ id: g.id, cash: g.amount })),
            tier: company.goals.tier,
            tierUp: company.goals.tierDay === report.day,
          },
        }
      : {}),
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
