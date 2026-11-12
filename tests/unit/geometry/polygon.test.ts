import { describe, expect, it } from 'vitest';
import {
  isConvex,
  onPolygonBoundary,
  orientation,
  polygonContains,
  polygonMinDistance,
  polygonsOverlap,
  satOverlapConvex,
  satPenetration,
  signedArea,
} from '../../../src/core/geometry/polygon';
import { Rng } from '../../../src/core/rng';
import { pointInPolygon } from '../../../src/core/geometry/vec';

const P = (x: number, y: number) => ({ x, y });
const sq = (x: number, y: number, w: number, h = w) => [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
const regular = (cx: number, cy: number, r: number, n: number, rot: number) =>
  Array.from({ length: n }, (_, i) => P(cx + r * Math.cos(rot + (i * 2 * Math.PI) / n), cy + r * Math.sin(rot + (i * 2 * Math.PI) / n)));

describe('面積・向き・凸性', () => {
  it('signedArea / orientation', () => {
    expect(signedArea(sq(0, 0, 4, 3))).toBe(12);
    expect(signedArea([...sq(0, 0, 4, 3)].reverse())).toBe(-12);
    expect(orientation(sq(0, 0, 2))).toBe('cw');
    expect(orientation([...sq(0, 0, 2)].reverse())).toBe('ccw');
    expect(orientation([P(0, 0), P(1, 1), P(2, 2)])).toBe('degenerate');
  });
  it('isConvex', () => {
    expect(isConvex(sq(0, 0, 3))).toBe(true);
    expect(isConvex(regular(0, 0, 5, 7, 0.3))).toBe(true);
    expect(isConvex([P(0, 0), P(4, 0), P(4, 4), P(2, 1), P(0, 4)])).toBe(false);
    expect(isConvex([P(0, 0), P(1, 0)])).toBe(false);
    expect(isConvex([P(0, 0), P(2, 0), P(4, 0), P(4, 4), P(0, 4)])).toBe(true);
  });
});

describe('SAT（凸）', () => {
  it('重なり・接触・離れ・包含・同一', () => {
    expect(satOverlapConvex(sq(0, 0, 4), sq(2, 2, 4))).toBe(true);
    expect(satOverlapConvex(sq(0, 0, 4), sq(4, 0, 4))).toBe(false); // 辺で接する
    expect(satOverlapConvex(sq(0, 0, 4), sq(4, 4, 4))).toBe(false); // 角で接する
    expect(satOverlapConvex(sq(0, 0, 4), sq(5, 0, 4))).toBe(false);
    expect(satOverlapConvex(sq(0, 0, 10), sq(2, 2, 2))).toBe(true);
    expect(satOverlapConvex(sq(0, 0, 4), sq(0, 0, 4))).toBe(true);
    expect(satPenetration(sq(0, 0, 4), sq(3, 0, 4))).toBeCloseTo(1, 12);
    expect(satPenetration(sq(0, 0, 4), sq(6, 0, 4))).toBeCloseTo(-2, 12);
  });

  it('総当たり（点サンプリング）との一致: 回転した凸多角形 1,000 組', () => {
    const rng = new Rng('sat');
    let overlaps = 0;
    let checked = 0;
    for (let i = 0; i < 1000; i++) {
      const A = regular(rng.next() * 10, rng.next() * 10, 1 + rng.next() * 4, rng.int(3, 8), rng.next() * 6.28);
      const B = regular(rng.next() * 10, rng.next() * 10, 1 + rng.next() * 4, rng.int(3, 8), rng.next() * 6.28);
      const depth = satPenetration(A, B);
      const sat = satOverlapConvex(A, B);
      expect(polygonsOverlap(A, B) === sat || Math.abs(depth) < 1e-4).toBe(true);
      let both = false;
      for (let y = 0; y <= 15 && !both; y += 0.05) {
        for (let x = 0; x <= 15; x += 0.05) {
          const p = P(x, y);
          if (pointInPolygon(p, A) && pointInPolygon(p, B)) {
            both = true;
            break;
          }
        }
      }
      if (depth > 0.3) {
        expect(both).toBe(true);
        checked++;
      }
      if (depth < -1e-6) {
        expect(both).toBe(false);
        checked++;
      }
      if (sat) overlaps++;
    }
    expect(overlaps).toBeGreaterThan(100);
    expect(checked).toBeGreaterThan(400);
  });
});

describe('一般多角形', () => {
  const L = [P(0, 0), P(6, 0), P(6, 2), P(2, 2), P(2, 6), P(0, 6)]; // L 字（非凸）
  it('包含・境界', () => {
    expect(polygonContains(sq(0, 0, 4), P(2, 2))).toBe(true);
    expect(polygonContains(sq(0, 0, 4), P(4, 2))).toBe(false);
    expect(polygonContains(sq(0, 0, 4), P(4, 2), true)).toBe(true);
    expect(polygonContains(sq(0, 0, 4), P(5, 2), true)).toBe(false);
    expect(onPolygonBoundary(sq(0, 0, 4), P(0, 3))).toBe(true);
    expect(polygonContains(L, P(4, 4))).toBe(false); // L の凹部
    expect(polygonContains(L, P(1, 4))).toBe(true);
  });

  it('非凸: 凹部に入る小さな矩形は重ならず、腕にかかる矩形は重なる', () => {
    expect(polygonsOverlap(L, sq(3, 3, 2))).toBe(false);
    expect(polygonsOverlap(L, sq(1, 3, 2))).toBe(true);
    expect(polygonsOverlap(L, sq(2, 2, 3))).toBe(false); // 凹角に角を接して外側
    expect(polygonsOverlap(L, sq(1, 1, 3))).toBe(true);
  });

  it('接触は false、同一・包含・辺共有同側は true', () => {
    expect(polygonsOverlap(sq(0, 0, 4), sq(4, 0, 4))).toBe(false);
    expect(polygonsOverlap(sq(0, 0, 4), sq(4, 4, 4))).toBe(false);
    expect(polygonsOverlap(sq(0, 0, 4), sq(1, 4, 2))).toBe(false); // T 字接触
    expect(polygonsOverlap(sq(0, 0, 4), sq(0, 0, 4))).toBe(true);
    expect(polygonsOverlap(sq(0, 0, 10), sq(3, 3, 2))).toBe(true);
    expect(polygonsOverlap(sq(3, 3, 2), sq(0, 0, 10))).toBe(true);
    expect(polygonsOverlap(sq(0, 0, 4), sq(0, 0, 2))).toBe(true); // 角と辺を共有して含まれる
    expect(polygonsOverlap(sq(0, 0, 4), sq(2, 2, 4))).toBe(true);
    expect(polygonsOverlap(sq(0, 0, 4), sq(10, 10, 4))).toBe(false);
    // 十字（どの頂点も相手の内部にない）
    expect(polygonsOverlap(sq(0, 4, 10, 2), sq(4, 0, 2, 10))).toBe(true);
  });

  it('頂点を通って侵入する形でも検出する（辺が相手の頂点を通過）', () => {
    const diamond = [P(5, 0), P(10, 5), P(5, 10), P(0, 5)];
    expect(polygonsOverlap(diamond, [P(0, 5), P(5, 5), P(5, 6), P(0, 6)])).toBe(true);
    expect(polygonsOverlap(diamond, [P(10, 5), P(15, 0), P(15, 10)])).toBe(false); // 頂点接触のみ
  });

  it('凸の組では SAT と一致、向き（cw/ccw）に依存しない', () => {
    const rng = new Rng('poly');
    for (let i = 0; i < 300; i++) {
      const A = regular(rng.next() * 8, rng.next() * 8, 1 + rng.next() * 3, rng.int(3, 7), rng.next() * 6.28);
      const B = regular(rng.next() * 8, rng.next() * 8, 1 + rng.next() * 3, rng.int(3, 7), rng.next() * 6.28);
      if (Math.abs(satPenetration(A, B)) < 1e-4) continue;
      const exp = satOverlapConvex(A, B);
      expect(polygonsOverlap(A, B)).toBe(exp);
      expect(polygonsOverlap([...A].reverse(), B)).toBe(exp);
      expect(polygonsOverlap(A, [...B].reverse())).toBe(exp);
    }
  });

  it('polygonMinDistance', () => {
    expect(polygonMinDistance(sq(0, 0, 4), sq(7, 0, 4))).toBe(3);
    expect(polygonMinDistance(sq(0, 0, 4), sq(7, 7, 4))).toBeCloseTo(Math.hypot(3, 3), 12);
    expect(polygonMinDistance(sq(0, 0, 4), sq(4, 0, 4))).toBe(0);
    expect(polygonMinDistance(sq(0, 0, 4), sq(2, 2, 4))).toBe(0);
    expect(polygonMinDistance(sq(0, 0, 10), sq(3, 3, 1))).toBe(0);
    expect(polygonMinDistance(sq(0, 0, 4), [P(2, 6), P(6, 6), P(6, 10)])).toBe(2);
    expect(polygonMinDistance([], sq(0, 0, 1))).toBe(Infinity);
  });
});
