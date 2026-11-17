import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_RAW, buildCatalog, defineAirline, defineDestination, validateCatalog, type CatalogRaw } from '../../src/core/data/index';
import { airlinesFor, destinationsFor } from '../../src/core/economy/registry';
import { DEFAULT_LIVERY, liveryOf } from '../../src/core/assets/registry';

/**
 * データの足し方の検証（3-02 / 3-10）。docs/43_data_extension_guide.md の例と一致させること。
 */
describe('catalogExtension: データの追加（docs/43 の例）', () => {
  it('出荷データ: 航空会社 44 社・就航都市 65 都市・検証 issue 0 件', () => {
    expect(CATALOG.airlines).toHaveLength(44);
    expect(CATALOG.destinations).toHaveLength(65);
    expect(validateCatalog(CATALOG_RAW)).toEqual([]);
  });

  it('実在の都市・航空会社（ユーザー依頼の追加）: market 専用で、塗装が解決できる', () => {
    const lhr = CATALOG.destinations.find((d) => d.id === 'LHR');
    expect(lhr?.name).toBe('ロンドン');
    expect(lhr?.legacy).toBe(false);
    const nh = CATALOG.airlines.find((a) => a.id === 'NH');
    expect(nh?.name).toContain('ANA');
    expect(nh?.legacy).toBe(false);
    expect(liveryOf('NH').airlineId).toBe('NH');
    expect(liveryOf('EK').airlineId).toBe('EK');
    // legacy の対象には入らない（旧ゲームの乱数列を変えない）
    expect(airlinesFor({})).toHaveLength(8);
    expect(destinationsFor({})).toHaveLength(21);
  });

  it('docs/43 の例: 試験市 TST と試験航空 ZZ を足せる', () => {
    const raw: CatalogRaw = {
      destinations: [
        ...CATALOG_RAW.destinations,
        defineDestination({ id: 'TST', name: '試験市', countryId: 'JP', distanceKm: 500, population: 900_000, coordinates: { latitude: 35.0, longitude: 137.0 }, demand: { business: 1.0, leisure: 1.0 }, congestion: 0.3 }),
      ],
      airlines: [
        ...CATALOG_RAW.airlines,
        defineAirline({ id: 'ZZ', name: '試験航空', type: 'regional', services: ['domesticPassenger'], fleet: [{ typeId: 'E175', seats: 76 }] }),
      ],
      countries: CATALOG_RAW.countries,
      regions: CATALOG_RAW.regions,
      aliases: {},
    };
    expect(validateCatalog(raw)).toEqual([]);
    const cat = buildCatalog(raw);
    const tst = cat.destinationById.get('TST')!;
    expect(tst.scope).toBe('domestic');
    expect(tst.passengerDemand).toBe(1.0); // 既定値
    expect(tst.regionId).toBe('east-asia'); // 国の地域が既定
    const zz = cat.airlineById.get('ZZ')!;
    expect(zz.baseLoadFactor).toBe(0.7); // regional の種別既定
    expect(zz.fareLevel).toBe(0.9);
    expect(zz.code).toBe('ZZ');
  });

  it('塗装: データの livery が使われ、なければ既定塗装（ZZ は未登録なので既定）', () => {
    expect(liveryOf('TB').airlineId).toBe('TB');
    expect(liveryOf('TB').tail).toBe(0xf97316);
    expect(liveryOf('IL').airlineId).toBe('IL'); // データの livery
    expect(liveryOf('ZZ')).toBe(DEFAULT_LIVERY); // 未登録は既定塗装
    expect(liveryOf('SK').airlineId).toBe('SK'); // 既存の LIVERIES が優先
  });

  it('対象集合: legacy の会社は 8 社・21 都市、market の会社は 44 社・65 都市', () => {
    expect(airlinesFor({}).map((a) => a.id)).toEqual(['SK', 'NP', 'RJ', 'AQ', 'HB', 'AS', 'NW', 'ML']);
    expect(destinationsFor({})).toHaveLength(21);
    expect(airlinesFor({ market: { version: 1, routes: {} } })).toHaveLength(44);
    expect(destinationsFor({ market: { version: 1, routes: {} } })).toHaveLength(65);
  });
});
