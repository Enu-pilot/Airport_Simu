import { describe, expect, it } from 'vitest';
import { airlineCargoEligible, cargoDistanceFactor, cargoHoldM3, routeCargoDemandM3 } from '../../src/core/economy/cargo';
import { createCompany } from '../../src/core/economy/company';
import { destinationDef } from '../../src/core/economy/registry';
import { validateCatalog, CATALOG_RAW } from '../../src/core/data/index';
import { BALANCE } from '../../src/core/economy/balance';

/**
 * 5-12 CARGO-01/03 の基盤: 貨物需要モデル、航空会社の貨物適格、機種の貨物室容積。
 * すべて opt-in の参照層で、既存の旅客運航には触れない。
 */
describe('5-12 CARGO-01/03 貨物基盤', () => {
  it('貨物需要は決定的で、貨物指数・人口に単調。指数0なら需要0', () => {
    const c = createCompany();
    c.city = { id: 'HOME', name: '自都市', population: 1_000_000, tier: 0 } as never;
    const dest = destinationDef('TWN'); // cargo 1.12
    const d1 = routeCargoDemandM3(c, dest);
    expect(d1).not.toBeNull();
    expect(routeCargoDemandM3(c, dest)).toBe(d1);
    expect(d1!).toBeGreaterThan(0);
    const zero = { ...dest, demand: { ...dest.demand, cargo: 0 } };
    expect(routeCargoDemandM3(c, zero)).toBe(0);
    const bigger = { ...dest, population: dest.population * 4 };
    expect(routeCargoDemandM3(c, bigger)!).toBeGreaterThan(d1!);
    // city がない会社は null（従来どおり貨物を使わない）
    expect(routeCargoDemandM3(createCompany(), dest)).toBeNull();
  });

  it('距離係数は短距離で小さく、長距離で緩やかに減る', () => {
    expect(cargoDistanceFactor(300)).toBeLessThan(cargoDistanceFactor(1500));
    expect(cargoDistanceFactor(1500)).toBe(1);
    expect(cargoDistanceFactor(12000)).toBeLessThan(1);
    expect(cargoDistanceFactor(12000)).toBeGreaterThan(0.3);
  });

  it('貨物適格は services に cargo を持つ会社だけ（LCC・地域航空は対象外）', () => {
    expect(airlineCargoEligible('NH')).toBe(true);
    expect(airlineCargoEligible('JL')).toBe(true);
    expect(airlineCargoEligible('EK')).toBe(true);
    expect(airlineCargoEligible('MM')).toBe(false); // Peach
    expect(airlineCargoEligible('GK')).toBe(false); // Jetstar Japan
    expect(airlineCargoEligible('RJ')).toBe(false); // fictional regional
    expect(validateCatalog(CATALOG_RAW)).toEqual([]);
  });

  it('機種の貨物室容積は出典付きの値だけを使い、未設定は null（推定しない）', () => {
    expect(cargoHoldM3('B777-300ER')).toBeGreaterThan(200);
    expect(cargoHoldM3('B737-800W')).toBeCloseTo(45.1);
    expect(cargoHoldM3('regional70')).toBeNull(); // 汎用機材は未設定
    expect(cargoHoldM3('NO_SUCH_TYPE')).toBeNull();
    void BALANCE;
  });
});
