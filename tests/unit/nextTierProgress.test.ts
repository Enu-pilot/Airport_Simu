import { describe, expect, it } from 'vitest';
import { createCompany, type CompanyState, type DailyReport } from '../../src/core/economy/company';
import { defaultGame } from '../../src/core/economy/game';
import { initialGoals, nextTierProgress, type Tier } from '../../src/core/economy/goals';
import type { FlightRecord } from '../../src/core/analytics/records';

/**
 * 5-20 T6: 次の格までの到達度（表示専用の純粋関数）。
 * 現在値は判定（meetsTier）と同じ定義 — 発着・旅客は直近の日報、評価は現在の会社評価、
 * 大型機・国際線・乗継は渡された材料（運航可否・直近の締め日の記録）で見る。
 */
function companyAtTier(tier: Tier): CompanyState {
  const c = createCompany('career', `ntp-${tier}`);
  c.game = defaultGame();
  c.goals = { ...initialGoals(), tier };
  return c;
}

function report(day: number, movements: number, paxTotal: number): DailyReport {
  return {
    day, partial: false, revenue: {}, costs: {},
    kpi: {
      flights: movements / 2, movements, paxDeparted: paxTotal / 2, paxArrived: paxTotal / 2,
      otp: 0.9, avgDelayMin: 5, runwayUtil: 0.5, gateUtil: 0.5, facilityUtil: 0.5,
      avgWaitMin: 5, avgWalkMin: 5, avgGroundMin: 30, unprocessedPax: 0, missedPax: 0,
      leftBags: 0, diverted: 0, cancelled: 0, paxSatisfaction: 80, airlineSatisfaction: 80, rating: 80,
    },
  } as unknown as DailyReport;
}

const intlRecord = { result: 'completed', international: true } as unknown as FlightRecord;
const intlDiverted = { result: 'diverted', international: true } as unknown as FlightRecord;
const transferRecord = { result: 'completed', transferPax: 120 } as unknown as FlightRecord;

const item = (p: NonNullable<ReturnType<typeof nextTierProgress>>, key: string) => p.items.find((i) => i.key === key);

describe('5-20 T6 次の格までの到達度', () => {
  it('goals を持たない会社は対象外（null）', () => {
    const c = createCompany('career', 'ntp-nogoals');
    expect(c.goals).toBeUndefined();
    expect(nextTierProgress(c)).toBeNull();
  });

  it('要件ごとに現在値・不足分を返す（格 2 → 3、mainplay1 の実例）', () => {
    const c = companyAtTier(2);
    c.rating = 81.3;
    c.goals!.streaks.tier = 3;
    c.reports.push(report(17, 176, 12_045));
    const p = nextTierProgress(c, { largeOperable: true })!;
    expect(p.tier).toBe(2);
    expect(p.next).toBe(3);
    expect(p.reportDay).toBe(17);
    expect(item(p, 'movements')).toMatchObject({ required: 200, current: 176, met: false, shortfall: 24 });
    expect(item(p, 'pax')).toMatchObject({ required: 30_000, current: 12_045, met: false, shortfall: 17_955 });
    expect(item(p, 'rating')).toMatchObject({ required: 70, current: 81.3, met: true, shortfall: 0 });
    expect(item(p, 'heavy')).toMatchObject({ met: true });
    expect(item(p, 'intlOps')).toBeUndefined();
    expect(item(p, 'transferOps')).toBeUndefined();
    expect(p.streak).toEqual({ current: 3, required: 5 });
  });

  it('大型機は材料がなければ不明（null）、不可なら未達', () => {
    const c = companyAtTier(2);
    c.reports.push(report(0, 200, 30_000));
    c.rating = 70;
    expect(item(nextTierProgress(c)!, 'heavy')!.met).toBeNull();
    expect(item(nextTierProgress(c, { largeOperable: false })!, 'heavy')!.met).toBe(false);
  });

  it('日報がまだない場合は発着・旅客を 0 として扱い reportDay は null', () => {
    const c = companyAtTier(0);
    const p = nextTierProgress(c)!;
    expect(p.reportDay).toBeNull();
    expect(item(p, 'movements')).toMatchObject({ required: 20, current: 0, met: false, shortfall: 20 });
    expect(item(p, 'pax')).toMatchObject({ required: 2_000, current: 0, met: false, shortfall: 2_000 });
    // 格 1 の評価要件は 0 なので、評価 0 でも達成扱い
    expect(item(p, 'rating')).toMatchObject({ required: 0, met: true, shortfall: 0 });
    expect(p.streak).toEqual({ current: 0, required: 3 });
  });

  it('国際線の実績（格 4 → 5）: 完了した国際線の記録があるときだけ達成', () => {
    const c = companyAtTier(4);
    c.reports.push(report(0, 450, 75_000));
    c.rating = 78;
    expect(item(nextTierProgress(c, { largeOperable: true })!, 'intlOps')!.met).toBeNull();
    expect(item(nextTierProgress(c, { largeOperable: true, records: [] })!, 'intlOps')!.met).toBe(false);
    expect(item(nextTierProgress(c, { largeOperable: true, records: [intlDiverted] })!, 'intlOps')!.met).toBe(false);
    expect(item(nextTierProgress(c, { largeOperable: true, records: [intlRecord] })!, 'intlOps')!.met).toBe(true);
  });

  it('乗継の実績（格 5 → 6）: 乗継旅客を運んだ記録があるときだけ達成', () => {
    const c = companyAtTier(5);
    c.reports.push(report(0, 650, 120_000));
    c.rating = 82;
    expect(item(nextTierProgress(c, { largeOperable: true, records: [intlRecord] })!, 'transferOps')!.met).toBe(false);
    expect(item(nextTierProgress(c, { largeOperable: true, records: [transferRecord] })!, 'transferOps')!.met).toBe(true);
    expect(p6Streak(c)).toEqual({ current: 0, required: 10 });
  });

  it('最高格（7）では次がない', () => {
    const c = companyAtTier(7);
    const p = nextTierProgress(c)!;
    expect(p.next).toBeNull();
    expect(p.req).toBeNull();
    expect(p.items).toEqual([]);
    expect(p.streak).toBeNull();
  });
});

function p6Streak(c: CompanyState) {
  return nextTierProgress(c, { largeOperable: true, records: [] })!.streak;
}
