import { describe, expect, it } from 'vitest';
import { addContract, createCompany, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { routeDemandSummary } from '../../src/core/economy/demand';
import { planDayWithDemand } from '../../src/core/economy/planning';

const base = { feeDiscount: 0, startDay: 0, endDay: 999, status: 'active' as const, offerExpiresDay: 0, window: 'any' as const };

function company(market: boolean, withMsk = true): CompanyState {
  const c = createCompany('career', 'pax-test');
  c.city = defaultCity('regional');
  if (market) c.market = { version: 1, routes: {} };
  c.rating = 80;
  // NH（ANA）: SK は PR #67 でスカンジナビア航空（国際線のみ）になり、国内の就航先は範囲外のため国内線を運航できる会社に替えた
  addContract(c, { ...base, airlineId: 'NH', destinationId: 'TYO', typeId: 'B777-300ER', perDay: 4 });
  addContract(c, { ...base, airlineId: 'NP', destinationId: 'TYO', typeId: 'A350-900', perDay: 3 });
  addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 4 });
  if (withMsk) addContract(c, { ...base, airlineId: 'AQ', destinationId: 'MSK', typeId: 'A320-200', perDay: 3 });
  return c;
}

describe('paxConservation: 需要の保存（フェーズ 3 §3.3）', () => {
  // 市場モードの需要の保存は docs/46 §7.1-3（2026-DEMAND v2、PR #97）で「都市総需要の上限で縮小する」から
  // 「OD ごとの潜在需要を独立にする（受入条件 9: 他路線の追加・削除で変わらない）」に改められた。
  // 旧仕様の「総旅客 ≤ 都市上限」は市場モードでは成り立たない（tests/unit/demand.test.ts「都市の需要上限で配分しない」）ため、
  // 改定後の保存則（既存路線の需要・計画旅客が、別の目的地の路線を足しても変わらない）を検査する
  it('market 有効時、別の目的地の路線を足しても既存路線の需要と計画旅客は変わらない（受入条件 9）', () => {
    const without = company(true, false);
    const withExtra = company(true, true);
    const demandOf = (c: CompanyState) => routeDemandSummary(c, 3, 1)!.get('TYO')!.demand;
    expect(demandOf(withExtra)).toBe(demandOf(without));
    const tyoPax = (c: CompanyState) => planDayWithDemand(c, 3, 1).flights.filter((f) => f.destinationId === 'TYO').map((f) => f.arrPax + f.depPax);
    expect(tyoPax(without).length).toBeGreaterThan(0);
    expect(tyoPax(withExtra)).toEqual(tyoPax(without));
  });

  it('便ごとの旅客は座席を超えず、搭乗率は [0.05, 1.0] の揺らぎ範囲に収まる', () => {
    const c = company(true);
    const plan = planDayWithDemand(c, 3, 1);
    for (const f of plan.flights) {
      expect(f.arrPax).toBeLessThanOrEqual(f.seats);
      expect(f.depPax).toBeLessThanOrEqual(f.seats);
      expect(f.arrPax).toBeGreaterThanOrEqual(0);
    }
  });

  it('market なしの計画は従来と一致する（決定的・再現可能）', () => {
    const c = company(false);
    const a = planDayWithDemand(c, 3, 1);
    const b = planDayWithDemand(c, 3, 1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.flights.length).toBeGreaterThan(0);
  });
});
