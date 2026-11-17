import { describe, expect, it } from 'vitest';
import { CATALOG_RAW, buildCatalog, validateCatalog, CatalogError, type CatalogRaw } from '../../src/core/data/index';

const raw = (): CatalogRaw => JSON.parse(JSON.stringify(CATALOG_RAW)) as CatalogRaw;
const errors = (r: CatalogRaw) => validateCatalog(r).filter((i) => i.level === 'error');

describe('catalogValidation: 登録データの検証（3-03）', () => {
  it('出荷データは issue 0 件（warn 含む）', () => {
    expect(validateCatalog(raw())).toEqual([]);
    expect(() => buildCatalog(raw())).not.toThrow();
  });

  it('重複 ID（都市）', () => {
    const r = raw();
    r.destinations.push({ ...r.destinations[0]! });
    const es = errors(r);
    expect(es.some((e) => e.id === 'KTA' && e.field === 'id' && e.message.includes('重複'))).toBe(true);
    expect(() => buildCatalog(r)).toThrow(CatalogError);
  });

  it('未知の国', () => {
    const r = raw();
    r.destinations[0]!.countryId = 'QQ';
    expect(errors(r).some((e) => e.field === 'countryId' && e.message.includes('QQ'))).toBe(true);
  });

  it('未知の機種と座席超過', () => {
    const r = raw();
    r.airlines[0]!.fleet[0]!.typeId = 'B999';
    expect(errors(r).some((e) => e.field === 'fleet[0].typeId')).toBe(true);
    const r2 = raw();
    r2.airlines[1]!.fleet[0]!.seats = 9999; // NP の A320neo（maxPax が設定されている機種）
    expect(errors(r2).some((e) => e.field === 'fleet[0].seats')).toBe(true);
  });

  it('人口 0・負・NaN・Infinity、指数 3.01', () => {
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = raw();
      r.destinations[0]!.population = v;
      expect(errors(r).some((e) => e.field === 'population'), String(v)).toBe(true);
    }
    const r = raw();
    r.destinations[0]!.demand = { business: 3.01 };
    expect(errors(r).some((e) => e.field === 'demand.business')).toBe(true);
  });

  it('unlock の範囲（rating 101・tier 1.5）', () => {
    const r = raw();
    r.destinations[0]!.unlock = { minRating: 101 };
    expect(errors(r).some((e) => e.field === 'unlock.minRating')).toBe(true);
    const r2 = raw();
    r2.airlines[0]!.unlock = { minTier: 1.5 };
    expect(errors(r2).some((e) => e.field === 'unlock.minTier')).toBe(true);
  });

  it('空の fleet / services', () => {
    const r = raw();
    r.airlines[0]!.fleet = [];
    expect(errors(r).some((e) => e.field === 'fleet')).toBe(true);
    const r2 = raw();
    r2.airlines[0]!.services = [];
    expect(errors(r2).some((e) => e.field === 'services')).toBe(true);
  });

  it('legacy の順序を入れ替えるとエラー', () => {
    const r = raw();
    const [a, b] = [r.destinations[0]!, r.destinations[1]!];
    r.destinations[0] = b;
    r.destinations[1] = a;
    expect(errors(r).some((e) => e.field === 'legacy')).toBe(true);
  });

  it('別名の先がない・元が既存 ID と衝突', () => {
    const r = raw();
    r.aliases = { OLD: 'ZZZ' };
    expect(errors(r).some((e) => e.kind === '別名')).toBe(true);
    const r2 = raw();
    r2.aliases = { TYO: 'OSA' };
    expect(errors(r2).some((e) => e.kind === '別名' && e.field === 'id')).toBe(true);
  });

  it('ID の形式（都市 3 文字・会社 2 文字）', () => {
    const r = raw();
    r.destinations.push({ id: 'TOOLONG', name: 'x', countryId: 'JP', distanceKm: 500, population: 100_000 });
    expect(errors(r).some((e) => e.field === 'id')).toBe(true);
  });
});
