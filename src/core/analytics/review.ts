import type { CompanyState, DailyAirlineAnalysis, DailyReport } from '../economy/company';
import { analyzeDayPlan, planDayWithDemand, type PlanIssue } from '../economy/planning';
import type { Simulation } from '../sim/simulation';
import { dailyAirlineAnalysis } from '../economy/ops';
import { forecastForDay, weatherPlan, type WeatherForecast } from '../sim/weather';
import { DAY_SEC } from '../sim/rules';
import type { AircraftState, DisruptionKind, TaskKind, WxLevel } from '../sim/types';
import type { FlightRecord } from './records';
import type { AirlineRequest, RequestKind } from '../economy/airlineEval';
import type { ScoreComponent, ScoreKey } from '../economy/airlineScore';
import { takeoffDelaySec } from '../economy/takeoffDelay';
import { evaluateDelayPair } from '../economy/delayEvaluation';
import { resolveType } from '../sim/aircraftTypes';
import { designatorsOf } from '../layout/designators';
import { internationalProcessingFor, routeCapabilitiesForAirport } from '../economy/registry';
import type { MissBottleneck, MissBreakdownEntry } from '../sim/missBreakdown';

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

/** 便記録から得られる実測値だけで構成する、日次振り返り用の便別情報。 */
export interface ReviewFlight {
  aircraftId: string;
  arrNumber: string;
  depNumber: string;
  airlineId: string | null;
  typeId: string;
  typeName: string;
  result: FlightRecord['result'];
  arrRunway: string | null;
  depRunway: string | null;
  arrRunwayName: string | null;
  depRunwayName: string | null;
  standId: string | null;
  standName: string | null;
  gateId: string | null;
  gateName: string | null;
  arrScheduled: number;
  landedAt: number | null;
  blockIn: number | null;
  readyAt: number | null;
  blockOut: number | null;
  depScheduled: number;
  takeoffAt: number | null;
  actualArrivalDelaySec: number | null;
  evaluatedArrivalDelaySec: number | null;
  arrivalExternalDelaySec: Partial<Record<string, number>>;
  actualDepartureDelaySec: number | null;
  evaluatedDepartureDelaySec: number | null;
  departureGraceSec: number | null;
  /** 離陸の遅れ（秒。city.nightOps があるときだけ。出発の実遅延・評価対象の遅延とは別の指標。docs/36） */
  takeoffDelaySec?: number | null;
  arrivalCauses: string[] | null;
  departureCauses: string[] | null;
  causes: string[];
  paxBooked: number;
  paxBoarded: number;
  paxMissed: number;
  paxArrived: number;
  bagsLoaded: number;
  bagsLeft: number;
  taxiInSec: number;
  taxiOutSec: number;
  airborneHoldSec: number;
  groundStopSec: number;
  taskBlockedSec: number;
  busWaitSec: number | null;
  taskSec: Partial<Record<string, number>>;
  taskRecords: { kind: TaskKind; createdAt: number; startedAt: number | null; doneAt: number | null; blockedSec: number; note: string | null }[];
  timeline: { t: number; state: AircraftState; note?: string }[];
  events: { t: number; kind: string; reason?: string; note?: string }[];
  disruptionIds: string[];
  impactKeys: ScoreKey[];
}

/** 乗り遅れ内訳の分類ごとの集約（振り返り表示用） */
export interface MissedBreakdownSummary {
  category: MissBottleneck;
  /** 分類の合計人数 */
  count: number;
  /** その分類で最も詰まったエリア/施設（同数は先に記録された方） */
  topSpotId: string | null;
  topSpotCount: number;
}

/** 日報の乗り遅れ内訳を分類ごとに集約する（人数の多い順、同数は分類名順） */
export function summarizeMissedBreakdown(entries: readonly MissBreakdownEntry[]): MissedBreakdownSummary[] {
  const byCategory = new Map<MissBottleneck, MissedBreakdownSummary>();
  for (const e of entries) {
    const row = byCategory.get(e.category) ?? { category: e.category, count: 0, topSpotId: null, topSpotCount: 0 };
    row.count += e.count;
    if (e.spotId !== null && e.count > row.topSpotCount) {
      row.topSpotId = e.spotId;
      row.topSpotCount = e.count;
    }
    byCategory.set(e.category, row);
  }
  return [...byCategory.values()].sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1));
}

/** 乗り遅れの分類ごとの改善の助言（記録された内訳に基づくものだけを出す） */
export const MISSED_ADVICE: Record<MissBottleneck, string> = {
  checkIn: 'チェックインカウンターの数や1人あたり処理時間を見直し、ピークの便に合わせて増強を検討してください。',
  security: '保安検査のレーン数や処理時間を見直し、出発ピークに合わせて増強を検討してください。',
  emigration: '出国審査の窓口数を見直し、国際線の出発ピークに合わせて増強を検討してください。',
  immigration: '入国審査の窓口数を見直し、国際線の到着ピークに合わせて増強を検討してください。',
  customs: '税関の窓口数を見直し、国際線の到着ピークに合わせて増強を検討してください。',
  transferSecurity: '乗継保安検査の能力と、乗継に使える時間の余裕を確認してください。',
  gate: '搭乗口までの動線・ゲート割当・搭乗開始のタイミングを確認してください。',
  walking: 'ターミナル内の移動距離が長くなっています。動線の配置や連絡設備を確認してください。',
  bus: 'ランプバスの台数・配車間隔とバスゲートの運用を確認してください。',
  access: '空港へのアクセス（鉄道・バス・道路）の容量と所要時間を確認してください。',
  transferLate: '乗継便同士の間隔が接続に必要な時間に対して不足しています。乗継便の時刻を確認してください。',
  unreachable: '到達できない動線があります。ターミナル内の接続（エリア同士・上下移動）を確認してください。',
  noGate: '便に搭乗口が割り当てられていません。ゲートとスポットの割当を確認してください。',
  facilityClosed: '閉鎖中の施設が旅客の動線を塞いでいます。閉鎖の解除や代替の動線を確認してください。',
  other: '乗り遅れた旅客の便記録とイベントを確認して原因を切り分けてください。',
};

export interface ReviewFlightDetails {
  arrRunwayName?: string | null;
  depRunwayName?: string | null;
  standName?: string | null;
  gateName?: string | null;
  arrivalCauses?: string[];
  departureCauses?: string[];
  taskRecords?: ReviewFlight['taskRecords'];
  timeline?: ReviewFlight['timeline'];
  events?: ReviewFlight['events'];
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
  /** 乗り遅れの詰まり箇所の内訳と助言（日報に乗り遅れ内訳があるときだけ） */
  missedBreakdown?: { summary: MissedBreakdownSummary[]; advice: { category: MissBottleneck; recommendation: string }[] };
  /** 新しい記録形式では当日内の問題便と実時系列を含む。旧保存レビューでは欠落する。 */
  flights?: ReviewFlight[];
  disruptions: ReviewDisruption[];
  /**
   * その日の天候（5 段階）の変化（会社の game.weather === 'levels' のときだけ。旧保存レビュー・従来の天候では欠落）。
   * 計画天候（weatherPlan）の 1 時間ごとの段階が前の時間と変わった時刻だけを並べる（最初の時間は直前を晴れ 0 として比べる）。
   * 手動・シナリオの天候の障害による上書きは disruptions 側に出る。
   */
  weather?: { maxLevel: WxLevel; changes: { t: number; level: WxLevel }[] };
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
    components?: ScoreComponent[];
    emaBefore?: Partial<Record<ScoreKey, number>>;
    emaAfter?: Partial<Record<ScoreKey, number>>;
    complaintsBefore?: ScoreKey[];
    complaintsAfter?: ScoreKey[];
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

const inPeriod = (t: number | null, from: number, to: number): boolean => t !== null && t >= from && t < to;

/** 当日の便記録を便単位に整え、既存の評価根拠に便名がある場合だけひも付ける。 */
export function buildReviewFlights(input: {
  records: readonly FlightRecord[];
  from: number;
  to: number;
  types: ReviewInput['sim']['ctx']['types'];
  airlineAnalysis?: DailyAirlineAnalysis;
  details?: Record<string, ReviewFlightDetails>;
  /** 機体 ID → 離陸の遅れ（秒）。渡したときだけ各便に takeoffDelaySec を付ける */
  takeoffDelays?: Record<string, number | null>;
}): ReviewFlight[] {
  const { records, from, to, types, airlineAnalysis, details = {}, takeoffDelays } = input;
  const all = records.filter((r) => inPeriod(r.landedAt, from, to) || inPeriod(r.blockOut, from, to) || inPeriod(r.takeoffAt, from, to) || (r.result !== 'completed' && inPeriod(recordTime(r), from, to)));
  const rows = all.map((r): ReviewFlight => {
    const detail = details[r.aircraftId] ?? {};
    const delay = evaluateDelayPair({
      arrScheduled: r.arrScheduled,
      arrActual: r.landedAt,
      depScheduled: r.depScheduled,
      depBlockOut: r.blockOut,
      turnaroundSec: resolveType(types, r.typeId).turnaroundSec,
      arrivalExternalDelaySec: r.arrivalExternalDelaySec,
    });
    const impactKeys = (airlineAnalysis?.[r.airlineId ?? '']?.components ?? [])
      .filter((component) => component.facts.flightNumbers?.includes(r.arrNumber) || component.facts.flightNumbers?.includes(r.depNumber))
      .map((component) => component.key);
    return {
      aircraftId: r.aircraftId,
      arrNumber: r.arrNumber,
      depNumber: r.depNumber,
      airlineId: r.airlineId,
      typeId: r.typeId,
      typeName: resolveType(types, r.typeId).label,
      result: r.result,
      arrRunway: r.arrRunway,
      depRunway: r.depRunway,
      arrRunwayName: detail.arrRunwayName ?? null,
      depRunwayName: detail.depRunwayName ?? null,
      standId: r.standId,
      standName: detail.standName ?? null,
      gateId: r.gateId,
      gateName: detail.gateName ?? null,
      arrScheduled: r.arrScheduled,
      landedAt: r.landedAt,
      blockIn: r.blockIn,
      readyAt: r.readyAt,
      blockOut: r.blockOut,
      depScheduled: r.depScheduled,
      takeoffAt: r.takeoffAt,
      actualArrivalDelaySec: r.landedAt === null ? null : delay.actualArrivalSec,
      evaluatedArrivalDelaySec: r.landedAt === null ? null : delay.arrivalSec,
      arrivalExternalDelaySec: { ...(r.arrivalExternalDelaySec ?? {}) },
      actualDepartureDelaySec: r.blockOut === null ? null : delay.actualDepartureSec,
      evaluatedDepartureDelaySec: r.blockOut === null ? null : delay.departureSec,
      departureGraceSec: r.blockOut === null ? null : delay.departureGraceSec,
      ...(takeoffDelays ? { takeoffDelaySec: takeoffDelays[r.aircraftId] ?? null } : {}),
      arrivalCauses: detail.arrivalCauses ? [...detail.arrivalCauses] : null,
      departureCauses: detail.departureCauses ? [...detail.departureCauses] : null,
      causes: [...r.causes],
      paxBooked: r.paxBooked,
      paxBoarded: r.paxBoarded,
      paxMissed: r.paxMissed,
      paxArrived: r.paxArrived,
      bagsLoaded: r.bagsLoaded,
      bagsLeft: r.bagsLeft,
      taxiInSec: r.taxiInSec,
      taxiOutSec: r.taxiOutSec,
      airborneHoldSec: r.airborneHoldSec,
      groundStopSec: r.groundStopSec,
      taskBlockedSec: r.taskBlockedSec,
      busWaitSec: r.busWaitSec ?? null,
      taskSec: { ...r.taskSec },
      taskRecords: structuredClone((detail.taskRecords ?? []).filter((task) => task.createdAt < to && (task.doneAt ?? task.createdAt) >= from).sort((a, b) => a.createdAt - b.createdAt)),
      timeline: structuredClone((detail.timeline ?? []).filter((entry) => entry.t >= from && entry.t < to)),
      events: structuredClone((detail.events ?? []).filter((e) => e.t >= from && e.t < to).sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind))),
      disruptionIds: [...r.disruptions],
      impactKeys: [...new Set(impactKeys)],
    };
  });
  const hasIssue = (r: ReviewFlight) => r.result !== 'completed' || r.causes.length > 0 || (r.actualArrivalDelaySec ?? 0) > 0 || (r.actualDepartureDelaySec ?? 0) > 0 || r.paxMissed > 0 || r.bagsLeft > 0 || r.taskBlockedSec > 0;
  return rows.filter(hasIssue).sort((a, b) => {
    const failed = Number(b.result !== 'completed') - Number(a.result !== 'completed');
    if (failed) return failed;
    const passengerImpact = (b.paxMissed + b.bagsLeft) - (a.paxMissed + a.bagsLeft);
    if (passengerImpact) return passengerImpact;
    const delay = Math.max(b.evaluatedArrivalDelaySec ?? 0, b.evaluatedDepartureDelaySec ?? 0) - Math.max(a.evaluatedArrivalDelaySec ?? 0, a.evaluatedDepartureDelaySec ?? 0);
    if (delay) return delay;
    const wait = b.taskBlockedSec + b.groundStopSec - a.taskBlockedSec - a.groundStopSec;
    return wait || a.depNumber.localeCompare(b.depNumber);
  });
}

/** その日の計画天候（5 段階）の最大の段階と、段階が変わった時刻（S-2） */
function weatherOfDay(company: CompanyState, day: number, dayStart: number): NonNullable<DayReview['weather']> {
  const hours = weatherPlan(company.seed, day, company.game!.climate, company.game!.difficulty);
  const base = Math.floor(dayStart / DAY_SEC) * DAY_SEC;
  const changes: { t: number; level: WxLevel }[] = [];
  let previous: WxLevel = 0;
  hours.forEach((h, i) => {
    if (h.level !== previous) changes.push({ t: base + i * 3600, level: h.level });
    previous = h.level;
  });
  return { maxLevel: hours.reduce<WxLevel>((m, h) => (h.level > m ? h.level : m), 0), changes };
}

export function buildDayReview(input: ReviewInput): DayReview {
  const { sim, company, dayStart, airlinesBefore, responses, access } = input;
  const reports = company.reports;
  const report = reports[reports.length - 1]!;
  const prev = reports.length >= 2 ? reports[reports.length - 2]! : null;
  const end = sim.state.economy?.periodStart ?? sim.state.now;
  const records = sim.state.analytics.records;
  const airlineSnapshot = dailyAirlineAnalysis(report);

  const disruptions: ReviewDisruption[] = sim.state.disruptions
    .filter((d) => d.start < end && (d.resolvedAt ?? (d.status === 'resolved' ? d.end : null) ?? Infinity) >= dayStart)
    .map((d) => ({ id: d.id, kind: d.kind, target: d.targetId, start: d.start, end: d.resolvedAt ?? d.end, resolvedBy: d.resolvedBy }));

  const airlines = Object.entries(airlineSnapshot ?? {}).map(([id, saved]) => {
    const worst = saved.components
      .filter((component) => component.level === 'bad' || component.level === 'warn')
      .sort((a, b) => (a.score ?? 100) - (b.score ?? 100))
      .slice(0, 2)
      .map((component) => component.key);
    return {
      id,
      before: airlinesBefore[id] ?? saved.satisfactionBefore,
      after: saved.satisfactionAfter,
      delta: saved.satisfactionDelta,
      worst,
      ...(saved.complaintsAfter ? { complaints: [...saved.complaintsAfter] } : {}),
      ...(saved.newComplaints ? { newComplaints: [...saved.newComplaints] } : {}),
      ...(saved.requests ? { requests: structuredClone(saved.requests) } : {}),
      ...(saved.fulfilled ? { fulfilled: [...saved.fulfilled] } : {}),
      components: structuredClone(saved.components),
      ...(saved.emaBefore ? { emaBefore: { ...saved.emaBefore } } : {}),
      ...(saved.emaAfter ? { emaAfter: { ...saved.emaAfter } } : {}),
      ...(saved.complaintsBefore ? { complaintsBefore: [...saved.complaintsBefore] } : {}),
      ...(saved.complaintsAfter ? { complaintsAfter: [...saved.complaintsAfter] } : {}),
    };
  });
  const details: Record<string, ReviewFlightDetails> = {};
  for (const record of records) {
    if (!(inPeriod(record.landedAt, dayStart, end) || inPeriod(record.blockOut, dayStart, end) || inPeriod(record.takeoffAt, dayStart, end) || (record.result !== 'completed' && inPeriod(recordTime(record), dayStart, end)))) continue;
    const aircraft = sim.state.aircraft[record.aircraftId];
    if (!aircraft) continue;
    const arrival = sim.state.flights[aircraft.arrivalFlightId];
    const departure = sim.state.flights[aircraft.departureFlightId];
    const facilityName = (id: string | null | undefined): string | null => id ? sim.ctx.layout.facilities[id]?.name ?? null : null;
    const runwayName = (id: string | null | undefined): string | null => {
      const runway = id ? sim.ctx.layout.runways[id] : undefined;
      return runway ? `${runway.name} ${designatorsOf(runway, sim.ctx.layout).text.join('/')}` : null;
    };
    const taskRecords = (sim.state.aircraftTasks[aircraft.id] ?? []).flatMap((id) => {
      const task = sim.state.tasks[id];
      return task ? [{ kind: task.kind, createdAt: task.createdAt, startedAt: task.startedAt, doneAt: task.doneAt, blockedSec: task.blockedTotal, note: task.note }] : [];
    });
    details[record.aircraftId] = {
      arrRunwayName: runwayName(arrival?.runwayId),
      depRunwayName: runwayName(departure?.runwayId),
      standName: record.standId ? sim.ctx.layout.stands[record.standId]?.name ?? null : null,
      gateName: facilityName(departure?.pax.gateId ?? record.gateId),
      arrivalCauses: arrival ? [...arrival.delayCauses] : undefined,
      departureCauses: departure ? [...departure.delayCauses] : undefined,
      taskRecords,
      timeline: [...aircraft.history].sort((a, b) => a.t - b.t).map((entry) => ({ t: entry.t, state: entry.state, ...(entry.note ? { note: entry.note } : {}) })),
      events: [
        ...sim.state.events.filter((event) => event.aircraftId === aircraft.id).map((event) => ({ t: event.t, kind: event.kind, ...(event.reason ? { reason: event.reason } : {}), ...(event.note ? { note: event.note } : {}) })),
        ...(arrival?.actual !== null && arrival?.actual !== undefined ? [{ t: arrival.actual, kind: 'flightLanded' }] : []),
        ...(arrival?.block !== null && arrival?.block !== undefined ? [{ t: arrival.block, kind: 'blockIn' }] : []),
        ...(arrival?.pax.bagsReadyAt !== null && arrival?.pax.bagsReadyAt !== undefined ? [{ t: arrival.pax.bagsReadyAt, kind: 'bagsReady' }] : []),
        ...(departure?.readyAt !== null && departure?.readyAt !== undefined ? [{ t: departure.readyAt, kind: 'groundReady' }] : []),
        ...(departure?.pax.boardingOpenedAt !== null && departure?.pax.boardingOpenedAt !== undefined ? [{ t: departure.pax.boardingOpenedAt, kind: 'boardingOpened' }] : []),
        ...(departure?.block !== null && departure?.block !== undefined ? [{ t: departure.block, kind: 'blockOut' }] : []),
        ...(departure?.actual !== null && departure?.actual !== undefined ? [{ t: departure.actual, kind: 'takeoff' }] : []),
      ],
    };
  }
  // 離陸の遅れは夜間の運用設定（city.nightOps）があるときだけ付ける。従来のレビューは変わらない
  const takeoffDelays = company.city?.nightOps
    ? Object.fromEntries(records.map((r) => [r.aircraftId, takeoffDelaySec(sim, r.aircraftId)]))
    : undefined;
  const flights = buildReviewFlights({ records, from: dayStart, to: end, types: sim.ctx.types, airlineAnalysis: airlineSnapshot, details, takeoffDelays });
  // Tomorrow's constraints are shown in their own section and are never used as today's evaluation reasons.
  const tomorrowPlan = planDayWithDemand(company, company.day, access, sim.ctx.types, routeCapabilitiesForAirport(sim.ctx.layout.countryId, { international: internationalProcessingFor(company, sim.ctx.terminal) }));
  const tomorrowAnalysis = analyzeDayPlan(tomorrowPlan, sim.ctx);
  const weather = company.game?.weather === 'levels' ? weatherOfDay(company, report.day, dayStart) : undefined;
  // 乗り遅れの内訳（日報にあるときだけ）: 分類ごとに集約し、多い分類から助言を作る
  const missedSummary = report.missedBreakdown && report.missedBreakdown.length > 0 ? summarizeMissedBreakdown(report.missedBreakdown) : null;

  return {
    day: report.day,
    report: structuredClone(report),
    prev: prev ? structuredClone(prev) : null,
    compare: compareReports(prev, report),
    delayCauses: delayCauseCounts(records, dayStart, end),
    bottlenecks: buildReviewBottlenecks(records, dayStart, end),
    ...(missedSummary
      ? {
          missedBreakdown: {
            summary: missedSummary,
            advice: missedSummary.slice(0, 3).map((s) => ({ category: s.category, recommendation: MISSED_ADVICE[s.category] })),
          },
        }
      : {}),
    flights,
    disruptions,
    ...(weather ? { weather } : {}),
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
      flights: tomorrowPlan.flights.length,
      issues: tomorrowAnalysis.issues,
      completing: Object.values(company.projects)
        .filter((p) => p.remaining === 1 && p.kind !== 'closure')
        .map((p) => ({ id: p.id, kind: p.kind })),
      weather: company.game?.weather === 'levels' ? forecastForDay(company.seed, company.day, company.game) : null,
    },
  };
}
