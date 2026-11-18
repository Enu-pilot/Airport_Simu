import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { cargoPlannedTruckTripsPerDay, planCargoDay } from '../../src/core/economy/cargo';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation } from '../../src/core/sim/simulation';
import { congestionDelayMin } from '../../src/core/access/runtime';

/**
 * 5-12 CARGO-05（集約モデル）: 貨物トラックが旅客と共有する道路容量を圧迫する。
 * 背景交通としてバス定期便と同じ式に合流させるだけで、容量の消費は1か所のみ（二重計上しない）。
 * 貨物 OFF・契約なしでは背景交通は 0 で、従来の道路遅れは変わらない。
 */
function cargoCompany(features: CompanyState['features']): CompanyState {
  const c = createSandboxCompany('cargo-road');
  c.city = defaultCity('regional');
  c.rating = 80;
  c.features = features;
  c.airlines['NH'] ??= { satisfaction: 60, lowDays: 0 };
  addContract(c, {
    airlineId: 'NH', destinationId: 'TWN', typeId: 'B777F', perDay: 1, window: 'any',
    feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo',
  });
  return c;
}

describe('CARGO-05 貨物トラックの道路競合（集約モデル）', () => {
  it('計画台数: 運搬計画がある日はトラック台数が出て、契約がなければ 0', () => {
    const withCargo = cargoCompany({ cargo: true });
    expect(planCargoDay(withCargo, 0).carriedM3).toBeGreaterThan(0);
    expect(cargoPlannedTruckTripsPerDay(withCargo, 0)).toBeGreaterThan(0);
    const noContract = createSandboxCompany('cargo-road-none');
    noContract.city = defaultCity('regional');
    expect(cargoPlannedTruckTripsPerDay(noContract, 0)).toBe(0);
  });

  it('運航ランタイム: 貨物有効時のみ cargoTrucksPerHour が立つ', () => {
    const on = createSimulation(createSampleAirport(), { company: cargoCompany({ cargo: true }) });
    expect(on.state.access?.cargoTrucksPerHour ?? 0).toBeGreaterThan(0);
    const off = createSimulation(createSampleAirport(), { company: cargoCompany({}) });
    expect(off.state.access?.cargoTrucksPerHour ?? 0).toBe(0);
  });

  it('背景交通が増えると道路の BPR 遅れは単調に増える（容量そのものは減らさない）', () => {
    const base = congestionDelayMin(10, 100, 200);
    const withTrucks = congestionDelayMin(10, 100 + 24, 200);
    expect(withTrucks).toBeGreaterThan(base);
  });
});
