import { describe, expect, it } from 'vitest';
import { placeFacility } from '../../src/core/layout/operations';
import { facilityValue } from '../../src/core/economy/construction';
import { cargoHandlingCapacityM3PerHour, limitCargoByHandling, type CargoDayPlan } from '../../src/core/economy/cargo';
import { validateCatalog, CATALOG_RAW } from '../../src/core/data/index';
import { emptyLayout, must } from './helpers';

/**
 * 5-12 CARGO-04 の基盤: 貨物上屋（新施設種別）と荷役能力。
 * 能力は旅客ターミナル能力と合算せず、運用中・非内包の上屋だけを数える。
 */
describe('5-12 CARGO-04 貨物上屋', () => {
  it('カタログに貨物上屋があり、価格と能力プロパティを持つ', () => {
    expect(validateCatalog(CATALOG_RAW)).toEqual([]);
    let layout = emptyLayout(60, 60);
    const placed = must(placeFacility(layout, 'cargoTerminal', { x: 5, y: 5 }));
    layout = placed.layout;
    const f = Object.values(layout.facilities).find((x) => x.kind === 'cargoTerminal')!;
    expect(f.props.throughputM3PerHour).toBe(60);
    expect(facilityValue(f)).toBe(1_500_000);
    expect(cargoHandlingCapacityM3PerHour(layout)).toBe(60);
  });

  it('計画中・内包の上屋は能力に数えない', () => {
    let layout = emptyLayout(80, 80);
    layout = must(placeFacility(layout, 'cargoTerminal', { x: 5, y: 5 })).layout;
    layout = must(placeFacility(layout, 'cargoTerminal', { x: 30, y: 5 })).layout;
    const [a, b] = Object.values(layout.facilities).filter((x) => x.kind === 'cargoTerminal');
    b!.buildState = 'planned';
    expect(cargoHandlingCapacityM3PerHour(layout)).toBe(60);
    a!.parentFacilityId = 'fac_parent';
    expect(cargoHandlingCapacityM3PerHour(layout)).toBe(0);
  });

  it('荷役能力で頭打ちにすると超過分が積み残しへ移り、保存式が保たれる', () => {
    const plan: CargoDayPlan = {
      day: 0, demandM3: 1000, carriedM3: 800, leftoverM3: 200,
      contracts: [
        { contractId: 'k1', destinationId: 'TWN', capacityM3: 500, allocatedM3: 500, carriedM3: 500 },
        { contractId: 'k2', destinationId: 'TWN', capacityM3: 300, allocatedM3: 500, carriedM3: 300 },
      ],
    };
    const limited = limitCargoByHandling(plan, 400);
    expect(limited.carriedM3).toBeCloseTo(400);
    expect(limited.carriedM3 + limited.leftoverM3).toBeCloseTo(limited.demandM3, 6);
    expect(limitCargoByHandling(plan, 900)).toBe(plan); // 能力内なら無変更
  });
});
