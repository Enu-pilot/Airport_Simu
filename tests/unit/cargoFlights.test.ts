import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { planCargoDay } from '../../src/core/economy/cargo';
import { planDayWithDemand } from '../../src/core/economy/planning';
import { routeCapabilitiesForAirport } from '../../src/core/economy/registry';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';

function cargoCompany(): CompanyState {
  const c = createSandboxCompany('cargo-flights');
  c.city = defaultCity('regional');
  c.rating = 80;
  c.features = { cargo: true };
  addContract(c, {
    airlineId: 'NH', destinationId: 'TWN', typeId: 'B777-300ER', perDay: 2, window: 'any',
    feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo',
  });
  return c;
}

describe('5-12 貨物便の計画（DayPlan）', () => {
  it('貨物契約は旅客便とは別枠の貨物便になり、量の合計が運搬集計と一致する', () => {
    const c = cargoCompany();
    const plan = planDayWithDemand(c, 0, 1, AIRCRAFT_TYPES, routeCapabilitiesForAirport());
    const cargoContract = Object.values(c.contracts).find((k) => k.kind === 'cargo')!;
    expect(plan.flights.some((f) => f.contractId === cargoContract.id)).toBe(false);
    expect(plan.cargoFlights).toHaveLength(2);
    const total = plan.cargoFlights!.reduce((a, f) => a + f.volumeM3, 0);
    // 片道ごとの量 × 便数 × 往復分が、その日の運搬量に一致する
    expect(total * 2).toBeCloseTo(planCargoDay(c, 0).carriedM3, 6);
    for (const f of plan.cargoFlights!) {
      expect(f.departureAt).toBeGreaterThan(f.arrivalAt);
      expect(f.volumeM3).toBeGreaterThan(0);
    }
  });

  it('貨物契約がなければ cargoFlights は付かない（従来の計画と同一）', () => {
    const c = createSandboxCompany('cargo-flights-none');
    c.city = defaultCity('regional');
    const plan = planDayWithDemand(c, 0, 1, AIRCRAFT_TYPES, routeCapabilitiesForAirport());
    expect(plan.cargoFlights).toBeUndefined();
  });

  it('同じ入力では同じ計画になる（決定的）', () => {
    const a = planDayWithDemand(cargoCompany(), 3, 1, AIRCRAFT_TYPES, routeCapabilitiesForAirport());
    const b = planDayWithDemand(cargoCompany(), 3, 1, AIRCRAFT_TYPES, routeCapabilitiesForAirport());
    expect(a.cargoFlights).toEqual(b.cargoFlights);
  });
});
