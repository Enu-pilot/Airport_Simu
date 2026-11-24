import { describe, expect, it } from 'vitest';
import { createCompany, createSandboxCompany, importCompany, type CompanyState, type DailyReport } from '../../src/core/economy/company';
import { defaultGame } from '../../src/core/economy/game';
import { checkGoals, evaluateGoals, initialGoals, tierRoadmap, TIER_REQ, type Tier } from '../../src/core/economy/goals';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';
import type { AirportLayout } from '../../src/core/model/types';
import type { FlightRecord } from '../../src/core/analytics/records';

/**
 * 2026-GOALS: 格のロードマップと最長記録（bestStreaks）。
 * 最長記録は日次評価で連続が伸びたときだけ更新される記録専用の項目で、昇格判定には使わない。
 * ロードマップは表示専用の組み立てで、現在値の定義は nextTierProgress（meetsTier）と同じ。
 */
const layout = { facilities: {} } as unknown as AirportLayout;
function report(day: number, kpi: Partial<DailyReport['kpi']>): DailyReport {
  return { day, partial: false, revenue: {}, cost: {}, construction: 0, totalRevenue: 0, totalCost: 0, operatingProfit: 0, cashEnd: 0, kpi: { flights: 0, movements: 0, paxDeparted: 0, paxArrived: 0, otp: null, missedPax: 0, ...kpi } as DailyReport['kpi'] };
}
const ctx = (r: DailyReport) => ({ report: r, layout, records: [] as FlightRecord[], types: AIRCRAFT_TYPES, largeOperable: false });

function goalsCompany(): CompanyState {
  const c = createSandboxCompany('roadmap');
  c.game = defaultGame();
  c.goals = initialGoals();
  return c;
}

/** 格 1 の要件（20 発着・旅客 2,000・評価 0）を満たす日報 */
const tier1Day = (day: number) => report(day, { movements: 20, paxDeparted: 1_000, paxArrived: 1_000 });
const badDay = (day: number) => report(day, { movements: 0 });

describe('2026-GOALS 最長記録（bestStreaks）', () => {
  it('格の連続が伸びると最長記録も伸び、途切れても最長記録は残る', () => {
    const c = goalsCompany();
    evaluateGoals(c, ctx(tier1Day(0)));
    expect(c.goals!.streaks.tier).toBe(1);
    expect(c.goals!.bestStreaks).toEqual({ tier: 1 });
    evaluateGoals(c, ctx(tier1Day(1)));
    expect(c.goals!.bestStreaks!.tier).toBe(2);
    evaluateGoals(c, ctx(badDay(2)));
    expect(c.goals!.streaks.tier).toBe(0);
    expect(c.goals!.bestStreaks!.tier).toBe(2);
    evaluateGoals(c, ctx(tier1Day(3)));
    expect(c.goals!.streaks.tier).toBe(1);
    expect(c.goals!.bestStreaks!.tier).toBe(2);
  });

  it('昇格した日に最長記録が残り、連続は数え直しになる', () => {
    const c = goalsCompany();
    evaluateGoals(c, ctx(tier1Day(0)));
    evaluateGoals(c, ctx(tier1Day(1)));
    const r = evaluateGoals(c, ctx(tier1Day(2)));
    expect(r.tierUp).toBe(1);
    expect(c.goals!.tier).toBe(1);
    expect(c.goals!.streaks.tier).toBe(0);
    expect(c.goals!.bestStreaks!.tier).toBe(TIER_REQ[1].streakDays);
  });

  it('連続が必要な固定目標（otp85x3）も最長記録が残る', () => {
    const c = goalsCompany();
    evaluateGoals(c, ctx(report(0, { otp: 0.9 })));
    evaluateGoals(c, ctx(report(1, { otp: 0.9 })));
    expect(c.goals!.streaks.otp85x3).toBe(2);
    expect(c.goals!.bestStreaks!.otp85x3).toBe(2);
    evaluateGoals(c, ctx(report(2, { otp: 0.5 })));
    expect(c.goals!.streaks.otp85x3).toBe(0);
    expect(c.goals!.bestStreaks!.otp85x3).toBe(2);
  });

  it('checkGoals: bestStreaks は任意項目として検証する（欠落は旧セーブとして通る）', () => {
    expect(checkGoals(initialGoals())).toEqual([]);
    expect(checkGoals({ ...initialGoals(), bestStreaks: { tier: 3, otp85x3: 2 } })).toEqual([]);
    expect(checkGoals({ ...initialGoals(), bestStreaks: { tier: -1 } }).join()).toContain('bestStreaks');
    expect(checkGoals({ ...initialGoals(), bestStreaks: { tier: 1.5 } }).join()).toContain('bestStreaks');
    expect(checkGoals({ ...initialGoals(), bestStreaks: 'x' }).join()).toContain('bestStreaks');
  });

  it('旧セーブ（bestStreaks なし）は読み込み時に現在の連続から種付けされる', () => {
    const c = goalsCompany();
    c.goals!.streaks = { tier: 2, otp85x3: 1 };
    const loaded = importCompany(JSON.stringify(c))!;
    expect(loaded.goals!.bestStreaks).toEqual({ tier: 2, otp85x3: 1 });
  });

  it('最長記録は保存→復元で保持される（種付けで上書きされない）', () => {
    const c = goalsCompany();
    c.goals!.streaks = { tier: 1 };
    c.goals!.bestStreaks = { tier: 5 };
    const loaded = importCompany(JSON.stringify(c))!;
    expect(loaded.goals!.bestStreaks).toEqual({ tier: 5 });
    expect(checkGoals(loaded.goals)).toEqual([]);
  });
});

describe('2026-GOALS 格のロードマップ（tierRoadmap）', () => {
  function companyAtTier(tier: Tier): CompanyState {
    const c = createCompany('career', `roadmap-${tier}`);
    c.game = defaultGame();
    c.goals = { ...initialGoals(), tier };
    return c;
  }
  const item = (e: NonNullable<ReturnType<typeof tierRoadmap>>['entries'][number], key: string) => e.items.find((i) => i.key === key);

  it('goals を持たない会社は対象外（null）', () => {
    const c = createCompany('career', 'roadmap-nogoals');
    expect(tierRoadmap(c)).toBeNull();
  });

  it('全 8 格の行と状態（達成済み・現在・次・未到達）を返す', () => {
    const rm = tierRoadmap(companyAtTier(2))!;
    expect(rm.tier).toBe(2);
    expect(rm.entries.map((e) => e.tier)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(rm.entries.map((e) => e.status)).toEqual(['achieved', 'achieved', 'current', 'next', 'locked', 'locked', 'locked', 'locked']);
    expect(rm.entries[0]).toMatchObject({ req: null, items: [] });
  });

  it('各格の要件と現在の達成状況（現在値・不足分）を返す', () => {
    const c = companyAtTier(2);
    c.rating = 65;
    c.reports.push(report(17, { movements: 100, paxDeparted: 6_000, paxArrived: 6_000 }));
    const rm = tierRoadmap(c, { largeOperable: true })!;
    const next = rm.entries[3]!;
    expect(next.req).toEqual(TIER_REQ[3]);
    expect(item(next, 'movements')).toMatchObject({ required: 200, current: 100, met: false, shortfall: 100 });
    expect(item(next, 'pax')).toMatchObject({ required: 30_000, current: 12_000, met: false, shortfall: 18_000 });
    expect(item(next, 'rating')).toMatchObject({ required: 70, current: 65, met: false, shortfall: 5 });
    expect(item(next, 'heavy')).toMatchObject({ met: true });
    expect(rm.reportDay).toBe(17);
    // 達成済みの格 1 も同じ現在値で判定し直す（要件は満たす）
    expect(item(rm.entries[1]!, 'movements')).toMatchObject({ required: 20, current: 100, met: true });
  });

  it('国際線・乗継の実績は facts の記録で判定し、材料がなければ不明（null）', () => {
    const c = companyAtTier(4);
    const intl = { result: 'completed', international: true } as unknown as FlightRecord;
    const rmNoFacts = tierRoadmap(c)!;
    expect(item(rmNoFacts.entries[5]!, 'intlOps')).toMatchObject({ met: null });
    const rm = tierRoadmap(c, { records: [intl] })!;
    expect(item(rm.entries[5]!, 'intlOps')).toMatchObject({ met: true });
    expect(item(rm.entries[6]!, 'transferOps')).toMatchObject({ met: false });
  });

  it('連続の要約: 現在・必要・最長（最長は bestStreaks、未記録なら現在の連続が下限）', () => {
    const c = companyAtTier(2);
    c.goals!.streaks.tier = 2;
    expect(tierRoadmap(c)!.streak).toEqual({ current: 2, required: TIER_REQ[3].streakDays, best: 2 });
    c.goals!.bestStreaks = { tier: 4 };
    expect(tierRoadmap(c)!.streak).toEqual({ current: 2, required: TIER_REQ[3].streakDays, best: 4 });
  });

  it('現在の格には昇格日（tierDay）を出し、それ以外は null', () => {
    const c = companyAtTier(3);
    c.goals!.tierDay = 9;
    const rm = tierRoadmap(c)!;
    expect(rm.entries[3]!.reachedDay).toBe(9);
    expect(rm.entries[2]!.reachedDay).toBeNull();
    expect(rm.entries[4]!.reachedDay).toBeNull();
  });

  it('最高格では連続の要約が null で、全行が達成済み・現在になる', () => {
    const rm = tierRoadmap(companyAtTier(7))!;
    expect(rm.streak).toBeNull();
    expect(rm.entries.map((e) => e.status)).toEqual(['achieved', 'achieved', 'achieved', 'achieved', 'achieved', 'achieved', 'achieved', 'current']);
  });
});
