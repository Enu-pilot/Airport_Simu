import { describe, expect, it } from 'vitest';
import { GOALS, chainGoalAt, chainGoalInfo, checkGoals, evaluateGoals, initialGoals, nextGoals } from '../../src/core/economy/goals';
import { createSandboxCompany, type DailyReport } from '../../src/core/economy/company';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';
import type { AirportLayout } from '../../src/core/model/types';
import { cityEventCost, cityEventEffects, cityEventOutcome, cityEventRisk, type CityConfig, type CityEvent } from '../../src/core/economy/city';

const layout = { facilities: {} } as unknown as AirportLayout;
function report(day: number, kpi: Partial<DailyReport['kpi']>): DailyReport {
  return { day, partial: false, revenue: {}, cost: {}, construction: 0, totalRevenue: 0, totalCost: 0, operatingProfit: 0, cashEnd: 0, kpi: { flights: 0, movements: 0, paxDeparted: 0, paxArrived: 0, otp: null, missedPax: 0, ...kpi } as DailyReport['kpi'] };
}
const ctx = (r: DailyReport) => ({ report: r, layout, records: [], types: AIRCRAFT_TYPES, largeOperable: false });

function allDoneCompany() {
  const c = createSandboxCompany();
  const g = initialGoals();
  for (const d of GOALS) g.done[d.id] = 0;
  c.goals = g;
  return c;
}

describe('5-07 目標の連鎖', () => {
  it('生成規則: 3 種が順に出て、1 周ごとに目標値と報酬が上がる', () => {
    expect(chainGoalInfo(0)).toMatchObject({ kind: 'movements', target: 600, cash: 2_000_000 });
    expect(chainGoalInfo(1)).toMatchObject({ kind: 'pax', target: 20_000, cash: 4_000_000 });
    expect(chainGoalInfo(2)).toMatchObject({ kind: 'otp', target: 0.92, streakDays: 5, cash: 6_000_000 });
    expect(chainGoalInfo(3)).toMatchObject({ kind: 'movements', target: 1000 });
    expect(chainGoalAt(2).streak).toBe(5);
  });

  it('固定 12 個の達成後だけ連鎖が進み、達成すると次が出る', () => {
    const c = createSandboxCompany();
    // 固定が残っている間は連鎖は始まらない
    expect(nextGoals(c.goals)[0]?.id).toBe('flights10');
    const done = allDoneCompany();
    expect(nextGoals(done.goals).map((d) => d.id)).toEqual(['chain-0']);
    const cash = done.cash;
    const r = evaluateGoals(done, ctx(report(1, { movements: 600 })));
    expect(r.completed).toEqual(['chain-0']);
    expect(done.cash).toBe(cash + 2_000_000);
    expect(done.goals!.chain).toEqual({ index: 1, streak: 0 });
    expect(nextGoals(done.goals).map((d) => d.id)).toEqual(['chain-1']);
    expect(checkGoals(done.goals)).toEqual([]);
  });

  it('連鎖の定時率目標は連続日数が必要で、途切れると数え直し', () => {
    const c = allDoneCompany();
    c.goals!.chain = { index: 2, streak: 0 };
    for (let d = 1; d <= 4; d++) expect(evaluateGoals(c, ctx(report(d, { otp: 0.93 }))).completed).toEqual([]);
    evaluateGoals(c, ctx(report(5, { otp: 0.8 })));
    expect(c.goals!.chain!.streak).toBe(0);
    for (let d = 6; d <= 9; d++) evaluateGoals(c, ctx(report(d, { otp: 0.93 })));
    expect(evaluateGoals(c, ctx(report(10, { otp: 0.93 }))).completed).toEqual(['chain-2']);
    expect(c.goals!.chain!.index).toBe(3);
  });
});

const city: CityConfig = { version: 1, type: 'core', population: 500_000, distanceKm: 10, roadQuality: 3, railQuality: 3, residents: 1000 };
const ev = (id: string, extra: Partial<CityEvent> = {}): CityEvent => ({ id, day: 3, durationDays: 2, kind: 'sports', scale: 2, location: 'cityCenter', ...extra });

describe('5-07 都市イベントの判断化（費用とリスク）', () => {
  it('協力費は規模の二乗 × 日数、リスクは規模で上がる', () => {
    expect(cityEventCost({ scale: 1, durationDays: 1 })).toBe(40_000);
    expect(cityEventCost({ scale: 3, durationDays: 7 })).toBe(2_520_000);
    expect(cityEventRisk({ scale: 1 })).toBeCloseTo(0.2);
    expect(cityEventRisk({ scale: 3 })).toBeCloseTo(0.3);
  });

  it('結果は決定的で、無償（従来）のイベントは常に対象外=順調', () => {
    const w = ev('city-event-1', { wagered: true });
    expect(cityEventOutcome(w)).toBe(cityEventOutcome(w));
    for (let n = 1; n <= 30; n++) expect(cityEventOutcome(ev(`legacy-${n}`))).toBe('smooth');
    // 協力費つきの中には混雑になるものが存在する（リスクが実在する）
    const outcomes = Array.from({ length: 30 }, (_, i) => cityEventOutcome(ev(`city-event-${i + 1}`, { wagered: true, scale: 3 })));
    expect(outcomes).toContain('congested');
    expect(outcomes).toContain('smooth');
  });

  it('混雑のイベントは需要の伸びが半分・交通が倍、順調なものは従来どおり', () => {
    let congestedId = '';
    let smoothId = '';
    for (let n = 1; n <= 60 && (!congestedId || !smoothId); n++) {
      const e = ev(`city-event-${n}`, { wagered: true, scale: 3 });
      if (cityEventOutcome(e) === 'congested') congestedId = e.id;
      else smoothId = e.id;
    }
    const smooth = cityEventEffects({ ...city, events: [ev(smoothId, { wagered: true, scale: 3 })] }, 3);
    const congested = cityEventEffects({ ...city, events: [ev(congestedId, { wagered: true, scale: 3 })] }, 3);
    expect(smooth.demandMultiplier).toBeCloseTo(1 + 0.08 * 3);
    expect(congested.demandMultiplier).toBeCloseTo(1 + 0.08 * 3 * 0.5);
    expect(congested.trafficMultiplier).toBeCloseTo(1 + 0.12 * 3 * 2);
    expect(congested.trafficMultiplier).toBeGreaterThan(smooth.trafficMultiplier);
  });
});
