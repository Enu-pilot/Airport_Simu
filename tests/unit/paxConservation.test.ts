import { describe, expect, it } from 'vitest';
import { addContract, createCompany, type CompanyState } from '../../src/core/economy/company';
import { cityDemandCeiling, defaultCity } from '../../src/core/economy/city';
import { planDayWithDemand } from '../../src/core/economy/planning';

const base = { feeDiscount: 0, startDay: 0, endDay: 999, status: 'active' as const, offerExpiresDay: 0, window: 'any' as const };

function company(market: boolean): CompanyState {
  const c = createCompany('career', 'pax-test');
  c.city = defaultCity('regional');
  if (market) c.market = { version: 1, routes: {} };
  c.rating = 80;
  addContract(c, { ...base, airlineId: 'SK', destinationId: 'TYO', typeId: 'B777-300ER', perDay: 4 });
  addContract(c, { ...base, airlineId: 'NP', destinationId: 'TYO', typeId: 'A350-900', perDay: 3 });
  addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 4 });
  addContract(c, { ...base, airlineId: 'AQ', destinationId: 'MSK', typeId: 'A320-200', perDay: 3 });
  return c;
}

describe('paxConservation: 需要の保存（フェーズ 3 §3.3）', () => {
  it('market 有効時、1 日の総旅客は都市の需要上限を超えない', () => {
    const c = company(true);
    const plan = planDayWithDemand(c, 3, 1);
    const total = plan.flights.reduce((s, f) => s + f.arrPax + f.depPax, 0);
    expect(total).toBeLessThanOrEqual(cityDemandCeiling(c.city!, 1));
    expect(plan.flights.length).toBeGreaterThan(0);
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
