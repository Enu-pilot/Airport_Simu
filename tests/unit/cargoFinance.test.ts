import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { cargoDailyFinance, planCargoDay } from '../../src/core/economy/cargo';
import { BALANCE } from '../../src/core/economy/balance';

function cargoCompany(): CompanyState {
  const c = createSandboxCompany('cargo-fin');
  c.city = defaultCity('regional');
  c.rating = 80;
  c.features = { cargo: true };
  addContract(c, {
    airlineId: 'NH', destinationId: 'TWN', typeId: 'B777-300ER', perDay: 1, window: 'any',
    feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo',
  });
  return c;
}

describe('5-12 CARGO-05/06 貨物収支・トラック集計', () => {
  it('収入・荷役費・トラック台数が運搬量から一貫して出る', () => {
    const c = cargoCompany();
    const plan = planCargoDay(c, 0);
    const fin = cargoDailyFinance(c, 0, Number.POSITIVE_INFINITY);
    expect(fin.carriedM3).toBeCloseTo(plan.carriedM3, 6);
    expect(fin.revenue).toBe(Math.round(plan.carriedM3 * BALANCE.cargo.revenuePerM3));
    expect(fin.handlingCost).toBe(Math.round(plan.carriedM3 * BALANCE.cargo.handlingCostPerM3));
    expect(fin.truckTrips).toBe(Math.ceil(plan.carriedM3 / BALANCE.cargo.truckCapacityM3));
    expect(fin.revenue).toBeGreaterThan(fin.handlingCost);
  });

  it('荷役能力が小さいと運搬が減り、積み残しと収支が連動する', () => {
    const c = cargoCompany();
    const full = cargoDailyFinance(c, 0, Number.POSITIVE_INFINITY);
    const limited = cargoDailyFinance(c, 0, full.carriedM3 / 2);
    expect(limited.carriedM3).toBeCloseTo(full.carriedM3 / 2, 6);
    expect(limited.leftoverM3).toBeGreaterThan(full.leftoverM3);
    expect(limited.revenue).toBeLessThan(full.revenue);
    expect(limited.carriedM3 + limited.leftoverM3).toBeCloseTo(full.carriedM3 + full.leftoverM3, 6);
  });

  it('貨物契約がない会社はすべて 0', () => {
    const c = createSandboxCompany('cargo-none');
    c.city = defaultCity('regional');
    const fin = cargoDailyFinance(c, 0, 1000);
    expect(fin).toEqual({ day: 0, carriedM3: 0, leftoverM3: 0, revenue: 0, handlingCost: 0, truckTrips: 0 });
  });
});
