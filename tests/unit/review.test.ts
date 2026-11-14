import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany, type DailyReport } from '../../src/core/economy/company';
import { planDay } from '../../src/core/economy/planning';
import { createSimulation } from '../../src/core/sim/simulation';
import { stepTicks } from '../../src/core/sim/dayloop';
import { KPI_DIRECTION } from '../../src/core/scenario/scenario';
import { buildDayReview, buildReviewBottlenecks, compareReports, delayCauseCounts, emptyResponses, REVIEW_DIRECTION } from '../../src/core/analytics/review';
import type { FlightRecord } from '../../src/core/analytics/records';

function oneDay() {
  const sim = createSimulation(createSampleAirport(), { seed: 'rv', company: createSandboxCompany('rv') });
  sim.state.disruptions.push({
    id: 'dz1', kind: 'runwayClosed', targetId: Object.keys(sim.state.runways)[0]!, start: sim.state.now + 600, end: sim.state.now + 1800, status: 'scheduled',
    resolvedAt: null, resolvedBy: null, affected: { tasks: [], flights: [], units: [] }, origin: 'manual',
  });
  const dayStart = sim.state.now;
  const before = Object.fromEntries(Object.entries(sim.company!.airlines).map(([id, a]) => [id, a.satisfaction]));
  expect(stepTicks(sim, 200_000, { stopAtDayClose: true }).stop).toBe('dayClose');
  return { sim, dayStart, before };
}

const rep = (kpi: Partial<DailyReport['kpi']>, p: Partial<DailyReport> = {}): DailyReport =>
  ({ day: 0, partial: false, revenue: {}, cost: {}, construction: 0, totalRevenue: 100, totalCost: 50, operatingProfit: 50, cashEnd: 0, kpi: { paxDeparted: 10, paxArrived: 10, otp: 0.8, avgDelayMin: 5, rating: 50, paxSatisfaction: 70, airlineSatisfaction: 60, flights: 4, missedPax: 0, leftBags: 0, diverted: 0, cancelled: 0, ...kpi }, ...p }) as unknown as DailyReport;

describe('振り返りのデータ', () => {
  it('前日比: 改善と悪化を、指標ごとの良くなる向きで判定する', () => {
    const a = rep({});
    const b = rep({ otp: 0.9, avgDelayMin: 8, missedPax: 2, paxSatisfaction: 70 }, { totalRevenue: 90, totalCost: 40 });
    const v = Object.fromEntries(compareReports(a, b).map((r) => [r.metric, r.verdict]));
    expect(v.otp).toBe('improved');
    expect(v.avgDelayMin).toBe('worse');
    expect(v.missedPax).toBe('worse');
    expect(v.paxSatisfaction).toBe('same');
    expect(v.totalRevenue).toBe('worse');
    expect(v.totalCost).toBe('improved');
    expect(compareReports(null, b).every((r) => r.verdict === 'n/a')).toBe(true);
    expect(compareReports(rep({ otp: null }), b).find((r) => r.metric === 'otp')!.verdict).toBe('n/a');
  });

  it('シナリオ比較の KPI_DIRECTION と同じ向き（重複する指標）', () => {
    const pairs: [keyof typeof REVIEW_DIRECTION, keyof typeof KPI_DIRECTION][] = [
      ['totalRevenue', 'revenue'], ['totalCost', 'cost'], ['operatingProfit', 'operatingProfit'], ['otp', 'otp'], ['missedPax', 'missedPax'], ['leftBags', 'bagsLeft'], ['flights', 'flights'],
    ];
    for (const [r, k] of pairs) expect(REVIEW_DIRECTION[r]).toBe(KPI_DIRECTION[k]);
  });

  it('遅延理由の集計: 期間内の便だけを便数で数え、多い順に並べる', () => {
    const mk = (t: number, causes: string[]) => ({ takeoffAt: t, blockOut: t, landedAt: t, depScheduled: t, causes }) as unknown as FlightRecord;
    const r = delayCauseCounts([mk(10, ['a', 'b', 'a']), mk(20, ['b']), mk(30, ['b', 'c']), mk(999, ['z'])], 0, 100);
    expect(r).toEqual([{ cause: 'b', flights: 3 }, { cause: 'a', flights: 1 }, { cause: 'c', flights: 1 }]);
  });

  it('日次の制約分析は便記録の根拠・影響便・時刻を示し、該当ログがない日を除外する', () => {
    const record = {
      takeoffAt: 90,
      blockOut: 80,
      landedAt: 10,
      depScheduled: 60,
      arrNumber: 'SK101',
      depNumber: 'SK102',
      causes: ['apronBus'],
      taxiOutSec: 600,
      groundStopSec: 120,
      taskBlockedSec: 0,
      busWaitSec: 300,
    } as unknown as FlightRecord;
    expect(buildReviewBottlenecks([record], 0, 100)).toEqual([{
      cause: 'apronBus',
      flights: 1,
      flightNumbers: ['SK101/SK102'],
      firstRecordAt: 90,
      lastRecordAt: 90,
      evidence: '対象 1便・平均バス待ち 5分',
      recommendation: 'ピーク時のバス待ちと配車を確認し、バス配置または便の時間を調整してください。',
    }]);
    expect(buildReviewBottlenecks([record], 100, 200)).toEqual([]);
  });

  it('1 日運航の後: 日報・前日・明日の便数・障害・航空会社が既存データと一致し、状態を変えない', { timeout: 120_000 }, () => {
    const { sim, dayStart, before } = oneDay();
    const snap = JSON.stringify({ s: sim.state, c: sim.company });
    const company = sim.company!;
    const review = buildDayReview({ sim, company, dayStart, airlinesBefore: before, responses: { ...emptyResponses(), repairs: 2 }, access: sim.state.access?.factor ?? 1 });
    expect(JSON.stringify({ s: sim.state, c: sim.company })).toBe(snap);
    expect(review.day).toBe(0);
    expect(review.report).toEqual(company.reports[0]);
    expect(review.prev).toBeNull();
    expect(review.tomorrow.flights).toBe(planDay(company, company.day, sim.state.access?.factor ?? 1, sim.ctx.types).flights.length);
    expect(review.tomorrow.weather).toBeNull();
    expect(review.responses.repairs).toBe(2);
    expect(review.disruptions.map((d) => d.id)).toContain('dz1');
    expect(review.compare.find((r) => r.metric === 'totalRevenue')!.b).toBe(company.reports[0]!.totalRevenue);
    for (const a of review.airlines) expect(a.after).toBe(company.airlines[a.id]!.satisfaction);
    for (const c of review.delayCauses) expect(c.flights).toBeGreaterThan(0);
  });

  it('完成する工事: 残り 1 日の新設・改修だけ（一時閉鎖を除く）', { timeout: 120_000 }, () => {
    const { sim, dayStart, before } = oneDay();
    const company = structuredClone(sim.company!);
    company.projects = {
      f1: { id: 'f1', kind: 'build', startDay: 0, days: 3, remaining: 1 },
      f2: { id: 'f2', kind: 'closure', startDay: 0, days: 3, remaining: 1 },
      f3: { id: 'f3', kind: 'renovation', startDay: 0, days: 3, remaining: 2 },
    };
    const r = buildDayReview({ sim, company, dayStart, airlinesBefore: before, responses: emptyResponses(), access: 1 });
    expect(r.tomorrow.completing).toEqual([{ id: 'f1', kind: 'build' }]);
  });
});
