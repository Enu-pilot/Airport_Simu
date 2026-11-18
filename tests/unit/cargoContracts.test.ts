import { describe, expect, it } from 'vitest';
import { acceptOffer, addContract, createSandboxCompany, generateCargoOffers, generateOffers, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { airlineCargoEligible, cargoHoldM3, planCargoDay } from '../../src/core/economy/cargo';
import { planDayWithDemand } from '../../src/core/economy/planning';
import { routeCapabilitiesForAirport } from '../../src/core/economy/registry';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';

const OPERABLE = Object.keys(AIRCRAFT_TYPES);

function cargoCompany(seed: string): CompanyState {
  const c = createSandboxCompany(seed);
  c.city = defaultCity('regional');
  c.rating = 80;
  c.features = { cargo: true };
  return c;
}

describe('5-12 CARGO-02 貨物契約', () => {
  it('機能 OFF では貨物提案が出ない。有効化すると適格な会社からだけ出る', () => {
    const off = cargoCompany('cargo-off');
    off.features = {};
    expect(generateCargoOffers(off, OPERABLE)).toEqual([]);

    const c = cargoCompany('cargo-on');
    let cargoOffers = 0;
    for (let d = 0; d < 8; d++) {
      c.day = d;
      const offers = generateOffers(c, OPERABLE);
      for (const k of offers) {
        if (k.kind === 'cargo') {
          cargoOffers++;
          expect(airlineCargoEligible(k.airlineId)).toBe(true);
          expect(cargoHoldM3(k.typeId)).not.toBeNull();
        }
        k.status = 'expired';
      }
    }
    expect(cargoOffers).toBeGreaterThan(0);
  });

  it('貨物契約は旅客便を生成せず、運搬計画は保存式（需要 = 運搬 + 積み残し）を満たす', () => {
    const c = cargoCompany('cargo-plan');
    const k = addContract(c, {
      airlineId: 'NH', destinationId: 'TWN', typeId: 'B777-300ER', perDay: 1, window: 'any',
      feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo',
    });
    const plan = planDayWithDemand(c, 0, 1, AIRCRAFT_TYPES, routeCapabilitiesForAirport());
    expect(plan.flights.some((f) => f.contractId === k.id)).toBe(false);

    const day = planCargoDay(c, 0);
    expect(day.contracts).toHaveLength(1);
    const row = day.contracts[0]!;
    expect(row.capacityM3).toBeCloseTo((cargoHoldM3('B777-300ER') ?? 0) * 2);
    expect(row.carriedM3).toBeLessThanOrEqual(row.capacityM3!);
    expect(day.demandM3).toBeGreaterThan(0);
    expect(day.carriedM3 + day.leftoverM3).toBeCloseTo(day.demandM3, 6);
  });

  it('容積が未算出の機種の契約は能力 null で、運搬は 0（推定しない）', () => {
    const c = cargoCompany('cargo-unknown');
    addContract(c, {
      airlineId: 'NH', destinationId: 'TWN', typeId: 'regional70', perDay: 2, window: 'any',
      feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo',
    });
    const day = planCargoDay(c, 0);
    expect(day.contracts[0]!.capacityM3).toBeNull();
    expect(day.contracts[0]!.carriedM3).toBe(0);
    expect(day.leftoverM3).toBeCloseTo(day.demandM3, 6);
  });

  it('機能を切ると貨物提案は受け入れられない（LOCKED）', () => {
    const c = cargoCompany('cargo-lock');
    const k = addContract(c, {
      airlineId: 'NH', destinationId: 'TWN', typeId: 'B777-300ER', perDay: 1, window: 'any',
      feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'offered', offerExpiresDay: 9, kind: 'cargo',
    });
    c.features = {};
    expect(acceptOffer(c, k.id, true)).toEqual({ ok: false, reason: 'LOCKED' });
  });
});
