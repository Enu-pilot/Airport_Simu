/** 独立監査（Phase 11）で見つかった問題の回帰テストと、不足していた端のケース */
import { describe, expect, it } from 'vitest';
import { bearingToDir, designatorNumber, dirToBearing, magneticFromTrue, normalizeDeg } from '../../../src/core/geometry/angle';
import { arcFromBulge, arcFromTangent } from '../../../src/core/geometry/arc';
import { bboxOf } from '../../../src/core/geometry/bbox';
import { bezierBbox } from '../../../src/core/geometry/bezier';
import {
  arcLengthTable,
  bbox,
  flatten,
  length,
  tAtLength,
  type ArcCurve,
  type Curve,
} from '../../../src/core/geometry/curve';
import { integrateAdaptive } from '../../../src/core/geometry/integrate';
import { intersectCurves, intersectCurvesDetailed } from '../../../src/core/geometry/intersect';
import { polygonMinDistance, polygonsOverlap } from '../../../src/core/geometry/polygon';
import { classifySegmentIntersection } from '../../../src/core/geometry/segment';
import { offsetCurve, strokePolyline } from '../../../src/core/geometry/stroke';
import { MAX_FLATTEN_POINTS, MAX_SUBDIV_DEPTH } from '../../../src/core/geometry/tolerance';

const P = (x: number, y: number) => ({ x, y });
const nanCubic: Curve = { kind: 'cubic', p0: P(0, 0), p1: P(NaN, 1), p2: P(2, 2), p3: P(3, 0) };

describe('flatten: 巨大半径・上限', () => {
  it('r = 1e15 の円弧が有限時間で終わり、端点を含む', () => {
    const c: ArcCurve = { kind: 'arc', c: P(0, 0), r: 1e15, theta0: 0, sweep: 1e-3 };
    const f = flatten(c, 0.01);
    expect(f.length).toBeGreaterThanOrEqual(2);
    expect(f.length).toBeLessThanOrEqual(MAX_FLATTEN_POINTS + 1);
    expect(f[0]!.t).toBe(0);
    expect(f[f.length - 1]!.t).toBe(1);
  });
  it('arcFromBulge で極端に大きい半径', () => {
    const a = arcFromBulge(P(0, 0), P(1e6, 0), 1e-9);
    if (a) expect(flatten(a, 0.01).length).toBeLessThanOrEqual(MAX_FLATTEN_POINTS + 1);
  });
  it('区間数は MAX_FLATTEN_POINTS で打ち切られる（円弧・Bezier）', () => {
    const a = arcFromBulge(P(0, 0), P(10, 0), 1e9)!;
    expect(flatten(a, 1e-9).length).toBeLessThanOrEqual(MAX_FLATTEN_POINTS + 1);
    const c: Curve = { kind: 'cubic', p0: P(0, 0), p1: P(1e6, 1e6), p2: P(-1e6, 1e6), p3: P(0, 0) };
    const f = flatten(c, 1e-9);
    expect(f.length).toBeLessThanOrEqual(MAX_FLATTEN_POINTS + 2 * MAX_SUBDIV_DEPTH + 2);
    expect(f[f.length - 1]!.t).toBe(1);
  });
  it('小さな半径・通常の弦高保証は変わらない', () => {
    const c: ArcCurve = { kind: 'arc', c: P(0, 0), r: 10, theta0: 0, sweep: 3 };
    for (const q of flatten(c, 0.01).slice(0, -1)) expect(q.t).toBeGreaterThanOrEqual(0);
    expect(flatten(c, 0.01).length).toBeGreaterThan(5);
  });
  it('非有限入力でも有限回で終わる', () => {
    expect(flatten(nanCubic, 0.01).length).toBeGreaterThanOrEqual(2);
    const bad: ArcCurve = { kind: 'arc', c: P(0, 0), r: Infinity, theta0: 0, sweep: NaN };
    expect(flatten(bad, 0.01).length).toBeGreaterThanOrEqual(2);
  });
});

describe('integrate: 非有限は NaN を即返す', () => {
  it('NaN を含む被積分関数', () => {
    expect(integrateAdaptive(() => NaN, 0, 1)).toBeNaN();
    expect(integrateAdaptive((t) => (t > 0.3 ? NaN : 1), 0, 1)).toBeNaN();
    expect(integrateAdaptive(() => 1, 0, NaN)).toBeNaN();
  });
  it('NaN 制御点の Bezier: length / arcLengthTable / tAtLength が終わる', { timeout: 2000 }, () => {
    expect(length(nanCubic)).toBeNaN();
    const t = arcLengthTable(nanCubic);
    expect(t.total).toBeNaN();
    expect(Number.isNaN(tAtLength(t, 1)) || typeof tAtLength(t, 1) === 'number').toBe(true);
  });
});

describe('intersect: 予算・共線重なり', () => {
  const nearTangent = (len: number): [Curve, Curve] => {
    const k = len / 100;
    return [
      { kind: 'line', p0: P(0, 0), p1: P(len, 0) },
      { kind: 'cubic', p0: P(0, -3e-6), p1: P(40 * k, -3e-6), p2: P(80 * k, 3e-6), p3: P(len, 3e-6) },
    ];
  };
  it('接線に近い 3 次と直線の交点を黙って落とさない（決定的）', () => {
    const [l, c] = nearTangent(100);
    const r1 = intersectCurvesDetailed(l, c);
    const r2 = intersectCurvesDetailed(l, c);
    expect(r1).toEqual(r2);
    expect(r1.truncated).toBe(true); // 予算超過は検出できる
    expect(r1.intersections.length).toBeGreaterThanOrEqual(1);
    const xs = r1.intersections.map((x) => (x.kind === 'point' ? x.p.x : x.t1a * 100));
    expect(xs.some((x) => Math.abs(x - 57.5) < 1)).toBe(true);
    expect(intersectCurves(l, c)).toEqual(r1.intersections);
  });
  it('予算を使い切ったら truncated = true', () => {
    // 同じ大きさの 2 本の波打つ曲線を重ねて細分を爆発させる
    const a: Curve = { kind: 'cubic', p0: P(0, 0), p1: P(3000, 3e-6), p2: P(6000, -3e-6), p3: P(9000, 0) };
    const b: Curve = { kind: 'cubic', p0: P(0, 3e-6), p1: P(3000, -3e-6), p2: P(6000, 3e-6), p3: P(9000, 0) };
    const r = intersectCurvesDetailed(a, b);
    expect(r.truncated).toBe(true);
    expect(intersectCurvesDetailed(a, b)).toEqual(r);
  });
  it('通常の交差は truncated = false', () => {
    const a: Curve = { kind: 'quad', p0: P(0, 0), p1: P(5, 10), p2: P(10, 0) };
    const b: Curve = { kind: 'line', p0: P(0, 2), p1: P(10, 2) };
    const r = intersectCurvesDetailed(a, b);
    expect(r.truncated).toBe(false);
    expect(r.intersections).toHaveLength(2);
  });
  it('許容内（≤ 1e-6）で共線の Bezier と線分は 1 つの overlap', () => {
    const [l, c] = [
      { kind: 'line', p0: P(0, 0), p1: P(100, 0) } as Curve,
      { kind: 'cubic', p0: P(0, -1e-7), p1: P(40, -1e-7), p2: P(80, 1e-7), p3: P(100, 1e-7) } as Curve,
    ];
    const r = intersectCurves(l, c);
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe('overlap');
  });
  it('共線の線分と Bezier は overlap を 1 つ返す（接点の羅列にしない）', () => {
    const l: Curve = { kind: 'line', p0: P(0, 0), p1: P(10, 0) };
    const q: Curve = { kind: 'quad', p0: P(2, 0), p1: P(5, 0), p2: P(14, 0) };
    for (const [a, b] of [[l, q], [q, l]] as const) {
      const r = intersectCurves(a, b);
      expect(r).toHaveLength(1);
      const o = r[0]!;
      expect(o.kind).toBe('overlap');
      if (o.kind === 'overlap') {
        expect(o.t1a).toBeLessThan(o.t1b);
      }
    }
    const r = intersectCurves(l, q)[0]!;
    if (r.kind === 'overlap') {
      expect(r.t1a).toBeCloseTo(0.2, 6);
      expect(r.t1b).toBeCloseTo(1, 6);
      expect(r.t2a).toBeCloseTo(0, 6);
    }
  });
  it('3 次に次数上げした 2 次との一致は overlap [0, 1]', () => {
    const q: Curve = { kind: 'quad', p0: P(0, 0), p1: P(5, 8), p2: P(10, 0) };
    const e: Curve = {
      kind: 'cubic',
      p0: P(0, 0),
      p1: P((0 + 2 * 5) / 3, (0 + 2 * 8) / 3),
      p2: P((2 * 5 + 10) / 3, (2 * 8 + 0) / 3),
      p3: P(10, 0),
    };
    expect(intersectCurves(q, e)).toEqual([{ kind: 'overlap', t1a: 0, t1b: 1, t2a: 0, t2b: 1 }]);
  });
});

describe('NaN / Infinity', () => {
  it('classifySegmentIntersection は none', () => {
    expect(classifySegmentIntersection(P(NaN, 0), P(1, 1), P(0, 1), P(1, 0))).toEqual({ kind: 'none' });
    expect(classifySegmentIntersection(P(0, 0), P(1, 1), P(0, 1), P(Infinity, 0))).toEqual({ kind: 'none' });
  });
  it('polygonMinDistance は NaN、polygonsOverlap は false', () => {
    const sq = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
    const bad = [P(5, 5), P(NaN, 5), P(6, 6)];
    expect(polygonMinDistance(sq, bad)).toBeNaN();
    expect(polygonsOverlap(sq, bad)).toBe(false);
  });
  it('bboxOf は null、curve.bbox は NaN の箱', () => {
    expect(bboxOf([P(0, 0), P(NaN, 1)])).toBeNull();
    expect(bboxOf([P(0, 0), P(Infinity, 1)])).toBeNull();
    expect(bbox({ kind: 'line', p0: P(NaN, 0), p1: P(1, 1) }).minX).toBeNaN();
    expect(bezierBbox([P(0, 0), P(NaN, 1), P(1, 1)]).maxY).toBeNaN();
    expect(intersectCurves({ kind: 'line', p0: P(NaN, 0), p1: P(1, 1) }, nanCubic)).toEqual([]);
  });
  it('designatorNumber は非有限で RangeError', () => {
    expect(() => designatorNumber(NaN)).toThrow(RangeError);
    expect(() => designatorNumber(Infinity)).toThrow(RangeError);
  });
});

describe('角度の端のケース', () => {
  it('normalizeDeg(-1e-14) は [0, 360) に入る', () => {
    const v = normalizeDeg(-1e-14);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(360);
  });
  it('dirToBearing(-1e-17, -1) は [0, 360)', () => {
    const v = dirToBearing(-1e-17, -1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(360);
  });
  it('designatorNumber(354.9999996) は 36、355 は 36 / 35 の境界で 1〜36', () => {
    expect(designatorNumber(354.9999996)).toBe(36);
    for (const d of [0, 4.9999996, 5, 5.0000004, 354.9999996, 355, 359.9999999, 360]) {
      const n = designatorNumber(d);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(36);
    }
  });
  it('magneticFromTrue は ±180 を超える偏差でも [0, 360)', () => {
    for (const v of [-720, -359, -181, 181, 359, 540, 1e6]) {
      const m = magneticFromTrue(90, v);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThan(360);
    }
    expect(magneticFromTrue(90, 190)).toBeCloseTo(260, 9);
    expect(bearingToDir(magneticFromTrue(0, 360)).y).toBe(-1);
  });
});

describe('arcFromTangent: |sweep| < 2π', () => {
  it('2π 以上・非有限は null、2π − 1e-12 は有効', () => {
    expect(arcFromTangent(P(0, 0), 0, 5, 2 * Math.PI)).toBeNull();
    expect(arcFromTangent(P(0, 0), 0, 5, -2 * Math.PI)).toBeNull();
    expect(arcFromTangent(P(0, 0), 0, 5, 7)).toBeNull();
    expect(arcFromTangent(P(0, 0), 0, 5, NaN)).toBeNull();
    const a = arcFromTangent(P(0, 0), 0, 5, 2 * Math.PI - 1e-12);
    expect(a).not.toBeNull();
    expect(Math.abs(a!.sweep)).toBeLessThan(2 * Math.PI);
    expect(flatten(a!, 0.01).length).toBeGreaterThan(10);
  });
});

describe('stroke の端のケース', () => {
  it('半幅より短い辺を持つ折れ線でも各 join が有限の頂点を返す', () => {
    const pts = [P(0, 0), P(10, 0), P(10.2, 0.1), P(20, 5)];
    for (const join of ['miter', 'bevel', 'round'] as const) {
      const poly = strokePolyline(pts, 2, { join });
      expect(poly.length).toBeGreaterThanOrEqual(8);
      for (const q of poly) {
        expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
      }
    }
  });
  it('巨大な半幅 + 微小 tol の round でも頂点数が打ち切られる', () => {
    const poly = strokePolyline([P(0, 0), P(10, 0), P(10, 10)], 1e9, { join: 'round', cap: 'round', tol: 1e-12 });
    expect(poly.length).toBeLessThan(6 * MAX_FLATTEN_POINTS);
  });
  it('offsetCurve: d > r の内側でも有限の折れ線（クリップしない）', () => {
    const a: ArcCurve = { kind: 'arc', c: P(0, 0), r: 5, theta0: 0, sweep: Math.PI };
    for (const d of [-8, 8]) {
      const o = offsetCurve(a, d);
      expect(o.length).toBeGreaterThanOrEqual(2);
      for (const q of o) expect(Number.isFinite(q.x + q.y)).toBe(true);
    }
  });
  it('sweep = 2π 以上の円弧（手で作った場合）でも flatten は有限', () => {
    const a: ArcCurve = { kind: 'arc', c: P(0, 0), r: 5, theta0: 0, sweep: 2 * Math.PI };
    expect(flatten(a, 0.01).length).toBeGreaterThan(10);
  });
});
