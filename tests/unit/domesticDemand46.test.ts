import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../src/core/data/index';
import { SEASONALITY_PROFILES } from '../../src/core/data/types';
import { validateCatalog, type CatalogRaw } from '../../src/core/data/validate';
import { BALANCE } from '../../src/core/economy/balance';
import { airMarketPopulationOf, defaultCity, type CityConfig } from '../../src/core/economy/city';
import { addContract, createCompany, type CompanyState } from '../../src/core/economy/company';
import { demandIndex, routeDemand, routeDemandSummary, seasonalWeekdayFactor } from '../../src/core/economy/demand';
import { destinationDef } from '../../src/core/economy/registry';

/**
 * docs/46 国内需要モデルのコード反映の受入条件（§7.3）を固定する。
 * K=1263 は暫定校正値: 羽田基準 3 路線の再現はここで確かめるが、仙台・中部の
 * 過大推計（§3.4）は既知の乖離として記録し、確定は PO 判断待ち。
 */

const domestic = CATALOG.destinations.filter((d) => d.scope === 'domestic');

describe('docs/46 カタログ反映（受入条件 1・2・4）', () => {
  it('国内就航先は 83 件で、全件に利用圏人口・航空依存度・季節プロファイルがある', () => {
    expect(domestic).toHaveLength(83);
    for (const d of domestic) {
      expect(d.catchmentPopulation, d.id).not.toBeNull();
      expect(d.catchmentPopulation!, d.id).toBeGreaterThanOrEqual(1_000);
      expect(d.catchmentPopulation!, d.id).toBeLessThanOrEqual(50_000_000);
      expect(d.aviationDependency, d.id).toBeGreaterThanOrEqual(0.5);
      expect(d.aviationDependency, d.id).toBeLessThanOrEqual(1.0);
      expect(SEASONALITY_PROFILES, d.id).toContain(d.seasonalityProfile);
    }
  });

  it('先頭 21 件の legacy ID・順序は不変', () => {
    const first21 = CATALOG.destinations.slice(0, 21);
    expect(first21.every((d) => d.legacy)).toBe(true);
    expect(first21.map((d) => d.id)).toEqual([
      'KTA', 'TWN', 'MSK', 'YKH', 'KRG', 'AOS', 'NSH', 'HSM', 'TYO', 'OSA', 'SPK', 'FUK', 'OKA',
      'SEL', 'TPE', 'HKG', 'SIN', 'BKK', 'NDB', 'BNH', 'LUM',
    ]);
  });

  it('那覇（OKA）の観光需要指数は 3.0（§3.3 の校正反映）', () => {
    expect(destinationDef('OKA').demand.leisure).toBe(3.0);
  });

  it('カタログ検証が docs/46 の範囲外・未定義プロファイルを検出する', () => {
    const bad: CatalogRaw = {
      destinations: [
        { id: 'XXX', name: '検証用', countryId: 'JP', distanceKm: 500, population: 100_000, catchmentPopulation: 100, aviationDependency: 1.4, seasonalityProfile: 'NOPE' as never },
      ],
      airlines: [],
      countries: [{ id: 'JP', name: '日本', regionId: 'east' } as never],
      regions: [{ id: 'east', name: '東' } as never],
      aliases: {},
    };
    const fields = validateCatalog(bad).map((i) => i.field);
    expect(fields).toContain('catchmentPopulation');
    expect(fields).toContain('aviationDependency');
    expect(fields).toContain('seasonalityProfile');
  });
});

describe('docs/46 互換読み込み（受入条件 3・10）', () => {
  it('essential は business を移行元として読む（全国内目的地で essential = business）', () => {
    for (const d of domestic) expect(d.demand.essential, d.id).toBe(d.demand.business);
    expect(demandIndex({ demand: { business: 1.2, leisure: 0.9 } })).toBeCloseTo(0.55 * 1.2 + 0.45 * 0.9, 10);
    expect(demandIndex({ demand: { essential: 0.5, business: 1.2, leisure: 0.9 } })).toBeCloseTo(0.55 * 0.5 + 0.45 * 0.9, 10);
  });

  it('airMarketPopulation 未設定の都市は population にフォールバックする', () => {
    const city: CityConfig = { ...defaultCity('metropolitan') };
    expect(airMarketPopulationOf(city)).toBe(20_000_000);
    city.airMarketPopulation = 37_000_000;
    expect(airMarketPopulationOf(city)).toBe(37_000_000);
    city.airMarketPopulation = 10; // 範囲外は不正値としてフォールバック
    expect(airMarketPopulationOf(city)).toBe(20_000_000);
  });
});

describe('docs/46 季節プロファイル（受入条件 5・6）', () => {
  it('全プロファイルと essentialMonth は年間平均 1.0', () => {
    for (const p of SEASONALITY_PROFILES) {
      const table = BALANCE.market.seasonalityProfiles[p]!;
      expect(table).toHaveLength(12);
      expect(table.reduce((a, v) => a + v, 0) / 12, p).toBeCloseTo(1.0, 6);
    }
    expect(BALANCE.market.essentialMonth.reduce((a, v) => a + v, 0) / 12).toBeCloseTo(1.0, 6);
  });

  it('季節係数の年間平均は概ね 1（需要総量を不必要に変えない）', () => {
    const spk = destinationDef('SPK');
    let sum = 0;
    for (let day = 0; day < 365; day++) sum += seasonalWeekdayFactor(spk, day);
    expect(sum / 365).toBeGreaterThan(0.97);
    expect(sum / 365).toBeLessThan(1.03);
  });

  it('北海道プロファイルは 4 月が谷・10 月が山（§4.1 の実測傾向）', () => {
    const spk = destinationDef('SPK');
    // day 105 = 4 月中旬、day 288 = 10 月中旬（曜日効果を避けるため同曜日に寄せる）
    const apr = seasonalWeekdayFactor(spk, 105);
    const oct = seasonalWeekdayFactor(spk, 287);
    expect(oct).toBeGreaterThan(apr);
  });
});

/** 羽田再現ケースの会社（航空市場人口 37M・評価 50・料金比 1.0） */
function hanedaCase(): CompanyState {
  const c = createCompany('career', 'docs46-haneda');
  c.city = { ...defaultCity('metropolitan'), airMarketPopulation: 37_000_000 };
  c.rating = 50;
  return c;
}

describe('docs/46 K 暫定校正の再現（§3.3、受入条件 11）', () => {
  it('K は 1263（暫定値）', () => {
    expect(BALANCE.market.K).toBe(1263);
  });

  it('羽田―新千歳/福岡/那覇の予測が文書の校正値と一致する（±2%）', () => {
    const c = hanedaCase();
    // 文書 §3.3: K=1263 の予測/日（那覇は leisure=3.0 適用後の約 19,274）
    const cases: [string, number][] = [['SPK', 28136], ['FUK', 26261], ['OKA', 19274]];
    for (const [id, expected] of cases) {
      const d = routeDemand(c, destinationDef(id), 1)!;
      expect(Math.abs(d - expected) / expected, id).toBeLessThan(0.02);
    }
  });

  it('実績（2025年度・両方向/日）との桁感: 新千歳 28,250・福岡 26,152・那覇 19,235', () => {
    const c = hanedaCase();
    const actual: [string, number][] = [['SPK', 28250], ['FUK', 26152], ['OKA', 19235]];
    for (const [id, real] of actual) {
      const d = routeDemand(c, destinationDef(id), 1)!;
      expect(Math.abs(d - real) / real, id).toBeLessThan(0.05);
    }
  });
});

describe('docs/46 市場モードの上限撤廃（受入条件 8・9）', () => {
  function marketCompany(): CompanyState {
    const c = createCompany('career', 'docs46-ceiling');
    c.city = defaultCity('regional');
    c.rating = 70;
    c.market = { version: 1, routes: {} };
    return c;
  }

  it('別路線を追加しても既存 OD の潜在需要は変わらない', () => {
    const c1 = marketCompany();
    addContract(c1, { airlineId: 'NH', destinationId: 'SPK', typeId: 'B737-800', perDay: 2, window: 'any', feeDiscount: 0, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0 });
    const before = routeDemandSummary(c1, 10, 1)!.get('SPK')!.demand;
    const c2 = marketCompany();
    addContract(c2, { airlineId: 'NH', destinationId: 'SPK', typeId: 'B737-800', perDay: 2, window: 'any', feeDiscount: 0, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0 });
    addContract(c2, { airlineId: 'NH', destinationId: 'FUK', typeId: 'B737-800', perDay: 3, window: 'any', feeDiscount: 0, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0 });
    addContract(c2, { airlineId: 'NH', destinationId: 'OKA', typeId: 'B737-800', perDay: 3, window: 'any', feeDiscount: 0, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0 });
    const after = routeDemandSummary(c2, 10, 1)!.get('SPK')!.demand;
    expect(after).toBeCloseTo(before, 6);
  });

  it('同一 OD の複数契約は座席を分け合い、需要は OD 単位で 1 回だけ数える', () => {
    const c = marketCompany();
    addContract(c, { airlineId: 'NH', destinationId: 'SPK', typeId: 'B737-800', perDay: 2, window: 'any', feeDiscount: 0, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0 });
    const single = routeDemandSummary(c, 10, 1)!.get('SPK')!;
    addContract(c, { airlineId: 'JL', destinationId: 'SPK', typeId: 'B737-800', perDay: 2, window: 'any', feeDiscount: 0, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0 });
    const dual = routeDemandSummary(c, 10, 1)!.get('SPK')!;
    expect(dual.demand).toBeCloseTo(single.demand, 6);
    expect(dual.seats).toBe(single.seats * 2);
  });
});
