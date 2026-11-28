import { describe, expect, it } from 'vitest';
import { airportFireCategory, requiredFireCategory, towerCapacityPerHour, towerLevel } from '../../src/core/safety';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { addContract, createCompany } from '../../src/core/economy/company';
import { analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { createContext } from '../../src/core/sim/context';

/**
 * 5-05: 消防区分・管制塔レベル。施設の props に役割を持たせ、不足は警告と能力表示に出す。
 * 運航そのものは止めない（既存の空港の結果を変えない）。
 */
describe('消防区分・管制塔（5-05）', () => {
  it('必要区分は機体長の ICAO 基準: A320 は 6、737-800 は 7、777-300 は 9', () => {
    expect(requiredFireCategory(37.57)).toBe(6); // A320
    expect(requiredFireCategory(39.47)).toBe(7); // B737-800
    expect(requiredFireCategory(73.86)).toBe(9); // B777-300
    expect(requiredFireCategory(72.72)).toBe(9); // A380-800
    expect(requiredFireCategory(27.17)).toBe(5); // ATR 72
    expect(requiredFireCategory(0)).toBe(1);
  });

  it('空港の区分は消防施設の最大値、管制塔レベルも最大値', () => {
    const sample = createSampleAirport();
    expect(airportFireCategory(sample)).toBe(7); // 既定の category
    expect(towerLevel(sample)).toBe(1); // 既定の level
    expect(towerCapacityPerHour(1)).toBe(30);
    expect(towerCapacityPerHour(3)).toBe(120);
    expect(towerCapacityPerHour(0)).toBe(0);
  });

  it('能力表示に消防区分と管制塔が出る（スターター: 区分 7、管制 30 回/時）', () => {
    const result = analyzeAirportCapacity(createCompany('career', 'safety-cap'), createContext(createStarterAirfield()));
    const fire = result.summary.find((m) => m.name === '消防区分')!;
    expect(fire.capacity).toBe(7);
    const tower = result.summary.find((m) => m.name === '管制塔')!;
    expect(tower.capacity).toBe(30);
  });

  it('777-300 の計画があると消防区分の警告が出る（運航は止めない助言的な制限）', () => {
    const company = createCompany('career', 'safety-fire');
    // NH（ANA）の B777-300。SK は PR #67 でスカンジナビア航空（国際線のみ）になり、国内の就航先の契約は計画に入らない
    addContract(company, { airlineId: 'NH', destinationId: 'TYO', typeId: 'B777-300', perDay: 1, feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, window: 'any' });
    const result = analyzeAirportCapacity(company, createContext(createSampleAirport()));
    const issue = result.analysis.issues.find((i) => i.code === 'FIRE_CATEGORY_LOW');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.detail).toContain('必要区分 9');
    const fire = result.summary.find((m) => m.name === '消防区分')!;
    expect(fire.demand).toBe(9);
    expect(fire.capacity).toBe(7);
  });

  it('小さな機材だけなら消防区分の警告は出ない', () => {
    const company = createCompany('career', 'safety-small');
    addContract(company, { airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 2, feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, window: 'any' });
    const result = analyzeAirportCapacity(company, createContext(createSampleAirport()));
    expect(result.analysis.issues.some((i) => i.code === 'FIRE_CATEGORY_LOW')).toBe(false);
  });
});
