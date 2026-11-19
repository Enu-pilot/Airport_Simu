import { describe, expect, it } from 'vitest';
import { addContract, createCompany, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { defaultGame } from '../../src/core/economy/game';
import { initialGoals, type Tier } from '../../src/core/economy/goals';
import {
  cargoActualFinance,
  cargoDailyFinance,
  cargoPlannedTruckTripsByHour,
  cargoPlannedTruckTripsPerDay,
  planCargoDay,
} from '../../src/core/economy/cargo';
import { BALANCE } from '../../src/core/economy/balance';

/**
 * CARGO-08 格 6（トラック搬出入の時間帯配分）・格 7（積替貨物、翌日便接続のみ）。
 * PO 承認済み定義（貨物計画 2026-11-19 追記）の境界を固定する。
 */

function cargoCareer(tier: Tier, destinations: string[], endDay = 99, perDay = 1): CompanyState {
  const c = createCompany('career', `cargo-tiers-${tier}`);
  c.game = defaultGame();
  c.goals = { ...initialGoals(), tier };
  c.city = defaultCity('regional');
  c.rating = 80;
  c.features = { cargo: true };
  for (const destinationId of destinations) {
    addContract(c, {
      airlineId: 'NH', destinationId, typeId: 'B777-300ER', perDay, window: 'any',
      feeDiscount: 0.1, startDay: 0, endDay, status: 'active', offerExpiresDay: 0, kind: 'cargo',
    });
  }
  return c;
}

describe('CARGO-08 格 6: トラック時間帯プロファイル', () => {
  it('格 5 以下ではプロファイルは無効（null = 従来の均等配分）', () => {
    const c = cargoCareer(5, ['TWN']);
    expect(planCargoDay(c, 0).carriedM3).toBeGreaterThan(0);
    expect(cargoPlannedTruckTripsByHour(c, 0)).toBeNull();
  });

  it('格 6 では 24 時間配分が立ち、合計は日次台数と一致し、均等ではない', () => {
    const c = cargoCareer(6, ['TWN']);
    const byHour = cargoPlannedTruckTripsByHour(c, 0)!;
    expect(byHour).toHaveLength(24);
    const total = cargoPlannedTruckTripsPerDay(c, 0);
    expect(byHour.reduce((a, v) => a + v, 0)).toBeCloseTo(total, 6);
    // 早朝バンク後（7 時）が深夜（2 時）より多い
    expect(byHour[7]!).toBeGreaterThan(byHour[2]!);
    expect(byHour[7]!).toBeGreaterThan(total / 24);
    expect(byHour[2]!).toBeLessThan(total / 24);
  });

  it('貨物契約がなければ全時間帯 0', () => {
    const c = cargoCareer(6, []);
    const byHour = cargoPlannedTruckTripsByHour(c, 0)!;
    expect(byHour.every((v) => v === 0)).toBe(true);
  });
});

describe('CARGO-08 格 7: 積替貨物（翌日便接続のみ）', () => {
  it('格 6 では積替は成立しない', () => {
    const c = cargoCareer(6, ['TWN', 'OKA']);
    const plan = planCargoDay(c, 0);
    expect(plan.carriedM3).toBeGreaterThan(0);
    expect(plan.transshipmentM3).toBe(0);
  });

  it('格 7・複数路線では積替が立ち、保存式（需要 = 運搬 + 積み残し）は不変', () => {
    const c = cargoCareer(7, ['TWN', 'OKA']);
    const plan = planCargoDay(c, 0);
    expect(plan.transshipmentM3).toBeGreaterThan(0);
    expect(plan.transshipmentM3).toBeLessThanOrEqual(plan.carriedM3 / 2);
    expect(plan.carriedM3 + plan.leftoverM3).toBeCloseTo(plan.demandM3, 6);
    // 接続率の上限: 片方向流量の接続可能量 × share を超えない
    expect(plan.transshipmentM3).toBeLessThanOrEqual(BALANCE.cargo.transshipmentShare * plan.carriedM3 + 1e-9);
  });

  it('単一路線では積替は成立しない（同一路線の折り返しは積替ではない）', () => {
    const c = cargoCareer(7, ['TWN']);
    expect(planCargoDay(c, 0).transshipmentM3).toBe(0);
  });

  it('翌日に便がなければ積替は成立しない（翌日接続のみ）', () => {
    const c = cargoCareer(7, ['TWN', 'OKA'], 0);
    expect(planCargoDay(c, 0).carriedM3).toBeGreaterThan(0);
    expect(planCargoDay(c, 0).transshipmentM3).toBe(0);
  });

  it('積替分はトラック台数から除かれる（空港を出ない貨物）', () => {
    const c7 = cargoCareer(7, ['TWN', 'OKA'], 99, 4);
    const c6 = cargoCareer(6, ['TWN', 'OKA'], 99, 4);
    // 需要を大きくして台数の切り上げ境界を跨がせる（小物量では ceil が同数になる）
    c7.city = defaultCity('metropolitan');
    c6.city = defaultCity('metropolitan');
    const fin7 = cargoDailyFinance(c7, 0, Number.POSITIVE_INFINITY);
    const fin6 = cargoDailyFinance(c6, 0, Number.POSITIVE_INFINITY);
    expect(fin7.transshipmentM3).toBeGreaterThan(0);
    expect(fin6.transshipmentM3).toBe(0);
    expect(fin7.carriedM3).toBeCloseTo(fin6.carriedM3, 6);
    expect(fin7.truckTrips).toBeLessThan(fin6.truckTrips);
    const actual = cargoActualFinance(c7, 0, fin7.carriedM3);
    expect(actual.transshipmentM3).toBeCloseTo(fin7.transshipmentM3, 6);
    expect(actual.truckTrips).toBe(fin7.truckTrips);
  });
});
