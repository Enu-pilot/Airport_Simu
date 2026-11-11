import { describe, expect, it } from 'vitest';
import { addTaxiwayPath, placeFacility, placeFreeRunway, placeRunway, updateLayoutSettings } from '../../src/core/layout/operations';
import { analyzeLayout, type Issue, type IssueCode } from '../../src/core/validation/validate';
import type { AirportLayout } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

type G = { start: { x: number; y: number }; headingDeg: number; lengthM: number };
const free = (l: AirportLayout, g: G, o = {}) => must(placeFreeRunway(l, g, o)).layout;
const issues = (l: AirportLayout, code: IssueCode): Issue[] => analyzeLayout(l).issues.filter((i) => i.code === code);
const east = (y: number, x = 20): G => ({ start: { x, y }, headingDeg: 90, lengthM: 1000 });
const realistic = (l: AirportLayout) => must(updateLayoutSettings(l, { ruleSet: 'realistic' })).layout;

describe('自由形の実寸の占有（S6）', () => {
  it('着陸帯内の施設は IN_RUNWAY_STRIP、RESA 内は IN_RUNWAY_RESA（criterion = real）', () => {
    const base = free(emptyLayout(), east(30));
    const strip = must(placeFacility(base, 'tower', { x: 30, y: 24 })).layout;
    const s = issues(strip, 'IN_RUNWAY_STRIP');
    expect(s).toHaveLength(1);
    expect(s[0]!.related).toEqual(['rwy_1']);
    expect(s[0]!.params).toEqual({ criterion: 'real' });
    expect(issues(strip, 'IN_RUNWAY_RESA')).toHaveLength(0);
    const resa = must(placeFacility(base, 'tower', { x: 15, y: 30 })).layout;
    expect(issues(resa, 'IN_RUNWAY_RESA')).toHaveLength(1);
    expect(issues(resa, 'IN_RUNWAY_STRIP')).toHaveLength(0);
    const far = must(placeFacility(base, 'tower', { x: 30, y: 10 })).layout;
    expect(analyzeLayout(far).issues.filter((i) => ['IN_RUNWAY_STRIP', 'IN_RUNWAY_RESA', 'OVERLAP'].includes(i.code))).toHaveLength(0);
  });

  it('舗装の上の施設は OVERLAP（実寸）', () => {
    const l = must(placeFacility(free(emptyLayout(), east(30)), 'tower', { x: 30, y: 30 })).layout;
    const o = issues(l, 'OVERLAP');
    expect(o).toHaveLength(1);
    expect(o[0]!.params).toEqual({ criterion: 'real' });
  });

  it('混在: 従来形の着陸帯は従来の判定のまま（params に criterion を付けない）', () => {
    let l = must(placeRunway(emptyLayout(), { x: 20, y: 30 }, 90, 40)).layout;
    l = must(placeFacility(l, 'tower', { x: 30, y: 26 })).layout;
    const s = issues(l, 'IN_RUNWAY_STRIP');
    expect(s).toHaveLength(1);
    expect(s[0]!.params).toEqual({});
  });

  it('自由形の舗装に接する誘導路・外にある誘導路は OVERLAP にならず、着陸帯内の誘導路も可', () => {
    let l = free(emptyLayout(), { start: { x: 30, y: 40 }, headingDeg: 20, lengthM: 1500 });
    l = must(addTaxiwayPath(l, [{ x: 29, y: 25 }, { x: 41, y: 25 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 10, y: 5 }, { x: 20, y: 5 }])).layout;
    expect(analyzeLayout(l).issues.filter((i) => ['OVERLAP', 'IN_RUNWAY_STRIP', 'TAXIWAY_CROSSES_RUNWAY_NO_ENTRY', 'TAXIWAY_ON_RUNWAY'].includes(i.code))).toHaveLength(0);
  });

  it('先に引いた誘導路を横切る自由形は TAXIWAY_CROSSES_RUNWAY_NO_ENTRY', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 35, y: 20 }, { x: 35, y: 40 }])).layout;
    l = free(l, { start: { x: 30, y: 30.3 }, headingDeg: 90, lengthM: 500 });
    expect(issues(l, 'TAXIWAY_CROSSES_RUNWAY_NO_ENTRY')).toHaveLength(1);
  });
});

describe('交差する滑走路（S6）', () => {
  const cross = (deg: number) => free(free(emptyLayout(), east(30)), { start: { x: 30 - 12 * Math.sin((deg * Math.PI) / 180), y: 30 + 12 * Math.cos((deg * Math.PI) / 180) }, headingDeg: deg, lengthM: 600 });

  it.each([30, 60, 0])('交差点ノードがある自由形の組はエラーなし（方位 %i°）', (deg) => {
    const l = cross(deg);
    expect(analyzeLayout(l).network.crossings).toHaveLength(1);
    expect(analyzeLayout(l).issues.filter((i) => ['OVERLAP', 'IN_RUNWAY_STRIP', 'IN_RUNWAY_RESA'].includes(i.code))).toHaveLength(0);
  });

  it('従来形 × 自由形の交差もエラーなし。従来形どうしの交差は従来どおり OVERLAP', () => {
    const legacy = must(placeRunway(emptyLayout(), { x: 30, y: 20 }, 180, 20)).layout;
    const mixed = free(legacy, east(30));
    expect(issues(mixed, 'OVERLAP')).toHaveLength(0);
    let ll = must(placeRunway(emptyLayout(), { x: 20, y: 30 }, 90, 40)).layout;
    ll = must(placeRunway(ll, { x: 30, y: 20 }, 180, 20)).layout;
    expect(issues(ll, 'OVERLAP')).toHaveLength(1);
  });

  it('同一直線上の重なり・中心線が交わらない舗装の重なりは OVERLAP のまま', () => {
    const collinear = free(free(emptyLayout(), east(30)), east(30, 40));
    expect(issues(collinear, 'OVERLAP')).toHaveLength(1);
    const adjacent = free(free(emptyLayout(), east(30)), east(32));
    expect(issues(adjacent, 'OVERLAP')).toHaveLength(1);
  });
});

describe('平行滑走路の間隔・番号（S6）', () => {
  it('150 m は warning、300 m は realistic のときだけ info', () => {
    const near = free(free(emptyLayout(), east(30)), east(36));
    const w = issues(near, 'RUNWAY_PARALLEL_TOO_CLOSE');
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe('warning');
    expect(w[0]!.params).toEqual({ distanceM: 150, refM: 210 });
    const mid = free(free(emptyLayout(), east(20)), east(32));
    expect(issues(mid, 'RUNWAY_PARALLEL_TOO_CLOSE')).toHaveLength(0);
    expect(issues(mid, 'RUNWAY_PARALLEL_DEPENDENT')).toHaveLength(0);
    const d = issues(realistic(mid), 'RUNWAY_PARALLEL_DEPENDENT');
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe('info');
    expect(d[0]!.params).toEqual({ distanceM: 300, refM: 1035 });
  });

  it('長さ方向に重ならない平行滑走路・平行でない組は対象外', () => {
    expect(issues(free(free(emptyLayout(), east(30)), east(36, 70)), 'RUNWAY_PARALLEL_TOO_CLOSE')).toHaveLength(0);
    const skew = free(free(emptyLayout(), east(30)), { start: { x: 20, y: 36 }, headingDeg: 100, lengthM: 1000 });
    expect(issues(skew, 'RUNWAY_PARALLEL_TOO_CLOSE')).toHaveLength(0);
  });

  it('従来形どうしの平行は既定（classic）では何も出ず、realistic で評価される', () => {
    let l = must(placeRunway(emptyLayout(), { x: 20, y: 30 }, 90, 40)).layout;
    l = must(placeRunway(l, { x: 20, y: 36 }, 90, 40)).layout;
    const classic = analyzeLayout(l).issues.map((i) => i.code);
    expect(classic).not.toContain('RUNWAY_PARALLEL_TOO_CLOSE');
    expect(classic).not.toContain('RUNWAY_DESIGNATOR_CONFLICT');
    const real = analyzeLayout(realistic(l)).issues.map((i) => i.code);
    expect(real).toContain('RUNWAY_PARALLEL_TOO_CLOSE');
    expect(real).toContain('RUNWAY_DESIGNATOR_CONFLICT');
  });

  it('自動の接尾辞があれば番号は重複せず、手動の上書きが同じなら RUNWAY_DESIGNATOR_CONFLICT', () => {
    const auto = free(free(emptyLayout(), east(20)), east(32));
    expect(issues(auto, 'RUNWAY_DESIGNATOR_CONFLICT')).toHaveLength(0);
    const manual = free(free(emptyLayout(), east(20), { designatorSuffix: 'L' }), east(32), { designatorSuffix: 'L' });
    const c = issues(manual, 'RUNWAY_DESIGNATOR_CONFLICT');
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]!.targets).toEqual(['rwy_1', 'rwy_2']);
  });
});

describe('多角形の判定の性能（S6）', () => {
  it('自由形 10 本 × 施設 300 でも妥当な時間で終わる', () => {
    let l = emptyLayout(120, 100);
    for (let i = 0; i < 10; i++) l = free(l, { start: { x: 10, y: 5 + i * 9 }, headingDeg: 85 + i, lengthM: 1500 });
    for (let i = 0; i < 300; i++) {
      const r = placeFacility(l, 'tower', { x: 2 + (i % 30) * 3, y: 2 + Math.floor(i / 30) * 9 });
      if (r.ok) l = r.layout;
    }
    const t0 = Date.now();
    analyzeLayout(l);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
