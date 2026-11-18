import { describe, expect, it } from 'vitest';
import { addContract, createCompany, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { distanceFactor, monthOf, routeDemand, routeDemandSummary, routeLoadFactors, seasonalWeekdayFactor, weekdayOf } from '../../src/core/economy/demand';
import { destinationDef } from '../../src/core/economy/registry';

/**
 * フェーズ 3 §3.6 の計算例（地方都市・アクセス 1.0・料金 1.0・評価 50）で需要モデルを固定する。
 * 注: 計画の計算例のうち TYO を B787-9×1 便にしたときの L=0.78 は、配分後の需要 826 ÷ 532 = 1.55（→ 0.98 にクランプ）と
 * 整合しない（826 の半分で計算した疑い）。式と KTA の例（1.09→0.98、0.54）は整合するので、式どおりの値を正とする。
 */
function marketCompany(): CompanyState {
  const c = createCompany('career', 'demand-test');
  c.city = defaultCity('regional'); // 人口 300,000・距離 25km
  c.market = { version: 1, routes: {} };
  c.rating = 50;
  return c;
}

const base = { feeDiscount: 0, startDay: 0, endDay: 999, status: 'active' as const, offerExpiresDay: 0, window: 'any' as const };

describe('demand: 路線需要モデル（3-05）', () => {
  it('計算例: TYO ≈ 934 人/日、KTA ≈ 172 人/日（配分前）', () => {
    const c = marketCompany();
    expect(routeDemand(c, destinationDef('TYO'), 1)).toBeCloseTo(934, -1);
    expect(routeDemand(c, destinationDef('KTA'), 1)).toBeCloseTo(172, -1);
  });

  it('距離の減衰 g(d): 450km で 0.85、760km で 1', () => {
    expect(distanceFactor(450)).toBeCloseTo(0.85, 10);
    expect(distanceFactor(760)).toBeCloseTo(1, 10);
  });

  it('都市の需要上限で配分する: TYO ≈ 826、KTA ≈ 152', () => {
    const c = marketCompany();
    addContract(c, { ...base, airlineId: 'SK', destinationId: 'TYO', typeId: 'B787-9', perDay: 1 });
    addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 1 });
    const s = routeDemandSummary(c, 0, 1)!;
    expect(s.get('TYO')!.demand).toBeCloseTo(826, -1);
    expect(s.get('KTA')!.demand).toBeCloseTo(152, -1);
    const total = [...s.values()].reduce((sum, x) => sum + x.demand, 0);
    expect(total).toBeLessThanOrEqual(979); // 上限 C ≈ 978
  });

  it('搭乗率: KTA 1 便は 1.09 → 0.98 にクランプ、2 便で 0.54（3-04）', () => {
    const c = marketCompany();
    addContract(c, { ...base, airlineId: 'SK', destinationId: 'TYO', typeId: 'B787-9', perDay: 1 });
    const k1 = addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 1 });
    expect(routeLoadFactors(c, 0, 1)!.get(k1.id)).toBeCloseTo(0.98, 2);
    k1.perDay = 2;
    expect(routeLoadFactors(c, 0, 1)!.get(k1.id)).toBeCloseTo(0.54, 1);
  });

  it('大型化すると搭乗率は下がる（3-05）', () => {
    const c = marketCompany();
    const k = addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 2 });
    const small = routeLoadFactors(c, 0, 1)!.get(k.id)!;
    k.typeId = 'E190'; // 70 席 → 95 席
    const big = routeLoadFactors(c, 0, 1)!.get(k.id)!;
    expect(big).toBeLessThan(small);
  });

  it('同じ路線では運賃の安い会社の搭乗率が高い（q の配分）', () => {
    const c = marketCompany();
    const lcc = addContract(c, { ...base, airlineId: 'AQ', destinationId: 'TYO', typeId: 'A320-200', perDay: 3 }); // fareLevel 0.7（種別既定）
    const fs = addContract(c, { ...base, airlineId: 'SK', destinationId: 'TYO', typeId: 'B737-800W', perDay: 3 }); // fareLevel 1.0
    const lfs = routeLoadFactors(c, 0, 1)!;
    expect(lfs.get(lcc.id)!).toBeGreaterThan(lfs.get(fs.id)!);
  });

  it('city がない会社は null（旧パス）', () => {
    const c = createCompany('career', 'demand-nocity');
    expect(routeDemand(c, destinationDef('TYO'), 1)).toBeNull();
    expect(routeLoadFactors(c, 0, 1)).toBeNull();
  });
});

describe('demand: 季節・曜日（5-06）', () => {
  it('曜日は day % 7（0 = 月曜）、月は 365 日の繰り返し', () => {
    expect(weekdayOf(0)).toBe(0);
    expect(weekdayOf(6)).toBe(6);
    expect(weekdayOf(7)).toBe(0);
    expect(monthOf(0)).toBe(0); // 1月
    expect(monthOf(31)).toBe(1); // 2月
    expect(monthOf(212)).toBe(7); // 8月
    expect(monthOf(364)).toBe(11); // 12月
    expect(monthOf(365)).toBe(0); // 翌年の1月
  });

  it('業務寄りの都市は金曜に、観光寄りの都市は週末と 8 月に需要が寄る', () => {
    const business = { demand: { business: 1, leisure: 0, cargo: 0 } };
    const leisure = { demand: { business: 0, leisure: 1, cargo: 0 } };
    // 2026-01 の月曜（day 0）基準: 業務は金曜（day 4）が月曜より高い
    expect(seasonalWeekdayFactor(business, 4)).toBeGreaterThan(seasonalWeekdayFactor(business, 0));
    // 観光は土曜（day 5）が月曜より高い
    expect(seasonalWeekdayFactor(leisure, 5)).toBeGreaterThan(seasonalWeekdayFactor(leisure, 0));
    // 観光は 8 月（day 212〜）が 2 月（day 31〜）より高い
    expect(seasonalWeekdayFactor(leisure, 212)).toBeGreaterThan(seasonalWeekdayFactor(leisure, 31));
    // 業務は 8 月に下がる
    expect(seasonalWeekdayFactor(business, 212)).toBeLessThan(seasonalWeekdayFactor(business, 31));
  });

  it('係数の年間平均はほぼ 1（年間需要をほぼ変えない）', () => {
    for (const dest of [{ demand: { business: 0.8, leisure: 0.4, cargo: 0 } }, { demand: { business: 0.2, leisure: 0.9, cargo: 0 } }]) {
      let sum = 0;
      for (let d = 0; d < 365; d++) sum += seasonalWeekdayFactor(dest, d);
      expect(sum / 365).toBeCloseTo(1, 1);
    }
  });

  it('配分後の需要にも効く: 観光都市は 8 月の需要が 2 月より多い', () => {
    const c = marketCompany();
    addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 1 });
    const feb = routeDemandSummary(c, 40, 1)!; // 2月
    const aug = routeDemandSummary(c, 220, 1)!; // 8月
    expect(aug.get('KTA')!.demand).toBeGreaterThan(feb.get('KTA')!.demand);
  });
});
