import { describe, expect, it } from 'vitest';
import { rectAlong, rectAlongDir, strokePolyline, offsetCurve } from '../../../src/core/geometry/stroke';
import { polygonContains, signedArea, polygonsOverlap } from '../../../src/core/geometry/polygon';
import { closestPoint, evaluate, type Curve } from '../../../src/core/geometry/curve';
import { bboxOf } from '../../../src/core/geometry/bbox';
import { runwayEnd, runwayPolygon, runwayStripPolygon } from '../../../src/core/layout/runway';
import { RUNWAY_HALF_WIDTH, STRIP_END_EXTENSION, STRIP_HALF_WIDTH } from '../../../src/core/model/catalog';
import type { Heading, Runway } from '../../../src/core/model/types';
import { Rng } from '../../../src/core/rng';

const P = (x: number, y: number) => ({ x, y });
const H8: Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];

// ---- オラクル: 旧 layout/runway.ts の headingVector / runwayRect をそのまま複製
const oVec = (h: number) => {
  const rad = (h * Math.PI) / 180;
  return { x: Math.round(Math.sin(rad)), y: Math.round(-Math.cos(rad)) };
};
function oracleRect(start: { x: number; y: number }, h: number, length: number, halfWidth: number, extend: number) {
  const v = oVec(h);
  const len = Math.hypot(v.x, v.y);
  const u = { x: v.x / len, y: v.y / len };
  const n = { x: -u.y, y: u.x };
  const s = start;
  const e = { x: start.x + v.x * length, y: start.y + v.y * length };
  const a = { x: s.x - u.x * extend, y: s.y - u.y * extend };
  const b = { x: e.x + u.x * extend, y: e.y + u.y * extend };
  return [
    { x: a.x + n.x * halfWidth, y: a.y + n.y * halfWidth },
    { x: b.x + n.x * halfWidth, y: b.y + n.y * halfWidth },
    { x: b.x - n.x * halfWidth, y: b.y - n.y * halfWidth },
    { x: a.x - n.x * halfWidth, y: a.y - n.y * halfWidth },
  ];
}
const same = (a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean =>
  a.length === b.length && a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);

describe('rectAlong / rectAlongDir と旧 runwayRect（オラクル）', () => {
  it('rectAlongDir は 8 方位 × 長さ 1..120 × 半幅 2 種で頂点が === 一致する', () => {
    for (const h of H8) {
      const v = oVec(h);
      const len = Math.hypot(v.x, v.y);
      const u = { x: v.x / len, y: v.y / len };
      for (let L = 1; L <= 120; L++) {
        const s = P(5, 7);
        const e = P(s.x + v.x * L, s.y + v.y * L);
        for (const [hw, ext] of [[1.5, 0.5], [3.5, 2.5]] as const) {
          expect(same(rectAlongDir(s, e, u, hw, ext), oracleRect(s, h, L, hw, ext))).toBe(true);
        }
      }
    }
  });

  it('実際の runwayPolygon / runwayStripPolygon とも === 一致する', () => {
    for (const h of H8) {
      for (const L of [1, 2, 7, 33, 80, 120]) {
        const r: Runway = { id: 'r', name: '', start: P(-3, 11), heading: h, length: L, surfaceWidthM: 45, buildState: 'operational' };
        const v = oVec(h);
        const len = Math.hypot(v.x, v.y);
        const u = { x: v.x / len, y: v.y / len };
        expect(same(rectAlongDir(r.start, runwayEnd(r), u, RUNWAY_HALF_WIDTH, 0.5), runwayPolygon(r))).toBe(true);
        expect(same(rectAlongDir(r.start, runwayEnd(r), u, STRIP_HALF_WIDTH, STRIP_END_EXTENSION), runwayStripPolygon(r))).toBe(true);
      }
    }
  });

  it('rectAlong（端点から単位方向を導く版）: 軸方向は === 一致、斜めは 1e-12 以内', () => {
    let exact = 0;
    let total = 0;
    for (const h of H8) {
      const v = oVec(h);
      for (let L = 1; L <= 120; L++) {
        const s = P(5, 7);
        const e = P(s.x + v.x * L, s.y + v.y * L);
        const got = rectAlong(s, e, 1.5, 0.5);
        const exp = oracleRect(s, h, L, 1.5, 0.5);
        total++;
        if (same(got, exp)) exact++;
        else expect(h % 90).toBe(45);
        got.forEach((p, i) => {
          expect(Math.abs(p.x - exp[i]!.x)).toBeLessThan(1e-12);
          expect(Math.abs(p.y - exp[i]!.y)).toBeLessThan(1e-12);
        });
      }
    }
    expect(exact).toBeGreaterThan(total / 2);
    expect(rectAlong(P(1, 1), P(1, 1), 1, 1)).toEqual([]);
  });
});

describe('strokePolyline', () => {
  it('2 点・butt は rectAlong(extend = 0) と同じ頂点', () => {
    const a = P(0, 0);
    const b = P(10, 0);
    expect(strokePolyline([a, b], 2)).toEqual(rectAlong(a, b, 2, 0));
    const c = P(3, 4);
    expect(strokePolyline([a, c], 1.5)).toEqual(rectAlong(a, c, 1.5, 0));
  });

  it('面積: 直線 2·hw·L、square cap は両端に hw ずつ、round cap は π·hw² を追加', () => {
    const pts = [P(0, 0), P(20, 0)];
    expect(Math.abs(signedArea(strokePolyline(pts, 3)))).toBeCloseTo(120, 9);
    expect(Math.abs(signedArea(strokePolyline(pts, 3, { cap: 'square' })))).toBeCloseTo(2 * 3 * 26, 9);
    const rc = Math.abs(signedArea(strokePolyline(pts, 3, { cap: 'round', tol: 0.0005 })));
    expect(rc).toBeGreaterThan(120 + Math.PI * 9 - 0.05);
    expect(rc).toBeLessThan(120 + Math.PI * 9 + 1e-9);
  });

  it('L 字: miter は外側の角を埋める、bevel は削る、round は円弧', () => {
    const pts = [P(0, 0), P(10, 0), P(10, 10)];
    const hw = 1;
    const area = (j: 'miter' | 'bevel' | 'round') => Math.abs(signedArea(strokePolyline(pts, hw, { join: j, tol: 0.0005 })));
    const miter = area('miter');
    const bevel = area('bevel');
    const round = area('round');
    expect(miter).toBeGreaterThan(round);
    expect(round).toBeGreaterThan(bevel);
    // 解析値: 中心線 10 + 10、幅 2。miter は外側の角が埋まって 40、bevel は角の三角形 0.5 を削って 39.5
    expect(miter).toBeCloseTo(40, 6);
    expect(bevel).toBeCloseTo(39.5, 6);
    expect(round).toBeGreaterThan(39.5 + (Math.PI / 4 - 0.5) - 0.01);
    expect(round).toBeLessThan(39.5 + (Math.PI / 4 - 0.5) + 1e-9);
  });

  it('miterLimit を超える鋭角は bevel にフォールバックする', () => {
    const pts = [P(0, 0), P(10, 0), P(0, 1)]; // 鋭角
    const long = strokePolyline(pts, 1, { join: 'miter', miterLimit: 100 });
    const cut = strokePolyline(pts, 1, { join: 'miter', miterLimit: 2 });
    const bb = (p: { x: number; y: number }[]) => bboxOf(p)!;
    expect(bb(long).maxX).toBeGreaterThan(bb(cut).maxX);
    expect(cut.length).toBeGreaterThan(long.length);
  });

  it('外形は中心線の近傍だけを含む（点の包含）', () => {
    const pts = [P(0, 0), P(10, 0), P(10, 10), P(20, 10)];
    const poly = strokePolyline(pts, 1, { join: 'miter' });
    expect(polygonContains(poly, P(5, 0.5))).toBe(true);
    expect(polygonContains(poly, P(10, 5))).toBe(true);
    expect(polygonContains(poly, P(15, 10.5))).toBe(true);
    expect(polygonContains(poly, P(5, 2))).toBe(false);
    expect(polygonContains(poly, P(0, 5))).toBe(false);
    expect(polygonsOverlap(poly, [P(4, 3), P(6, 3), P(6, 5), P(4, 5)])).toBe(false);
  });

  it('退化: 重複点は除く、点が 2 未満なら空', () => {
    expect(strokePolyline([P(1, 1), P(1, 1)], 1)).toEqual([]);
    expect(strokePolyline([P(1, 1)], 1)).toEqual([]);
    expect(strokePolyline([P(0, 0), P(0, 0), P(5, 0)], 1)).toEqual(strokePolyline([P(0, 0), P(5, 0)], 1));
    // 一直線上の中間点は頂点を増やさない
    expect(strokePolyline([P(0, 0), P(5, 0), P(10, 0)], 1)).toHaveLength(6);
  });
});

describe('offsetCurve', () => {
  it('線分: 2 点で距離 d、円弧: 半径 r ∓ d の円上、符号は +n = (−dy, dx)', () => {
    const l = offsetCurve({ kind: 'line', p0: P(0, 0), p1: P(10, 0) }, 2);
    expect(l).toEqual([P(0, 2), P(10, 2)].map((p) => ({ x: p.x, y: p.y })));
    const a: Curve = { kind: 'arc', c: P(0, 0), r: 10, theta0: 0, sweep: Math.PI / 2 };
    const o = offsetCurve(a, 2, 0.001);
    // θ 増加方向（y 下向きで時計回り）の +n = (−dy, dx)、d = (−sin, cos) → n = (−cos, −sin) = 中心側 → 半径 8
    for (const p of o) expect(Math.hypot(p.x, p.y)).toBeCloseTo(8, 9);
    const o2 = offsetCurve(a, -2, 0.001);
    for (const p of o2) expect(Math.hypot(p.x, p.y)).toBeCloseTo(12, 9);
    expect(o.length).toBeGreaterThan(2);
  });

  it('Bezier: 各頂点は曲線から距離 |d|、弦の誤差 ≤ tol（密サンプリング）', () => {
    const rng = new Rng('offset');
    for (let i = 0; i < 40; i++) {
      const q = () => P(rng.next() * 60, rng.next() * 60);
      const c: Curve = { kind: 'cubic', p0: q(), p1: q(), p2: q(), p3: q() };
      const d = 0.5 + rng.next();
      const tol = 0.01;
      const pts = offsetCurve(c, d, tol);
      expect(pts.length).toBeGreaterThanOrEqual(2);
      for (const p of pts) {
        // 頂点は曲線から距離 d（曲率半径が d より十分大きい場所では厳密、内側でカスプの近くは緩める）
        const cp = closestPoint(c, p);
        expect(cp.dist).toBeLessThanOrEqual(d + 1e-6);
      }
      // 端点
      const s = evaluate(c, 0);
      expect(Math.hypot(pts[0]!.x - s.x, pts[0]!.y - s.y)).toBeCloseTo(d, 9);
    }
  });
});
