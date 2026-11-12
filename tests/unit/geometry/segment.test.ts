import { describe, expect, it } from 'vitest';
import { bboxContainsPoint, bboxExpand, bboxIntersects, bboxOf, bboxUnion } from '../../../src/core/geometry/bbox';
import { classifySegmentIntersection, closestPointOnSegment } from '../../../src/core/geometry/segment';
import { distPointSegment, lerp, nearlyEqualPoint, normalize, perp, rotate, segmentIntersection } from '../../../src/core/geometry/vec';
import { Rng } from '../../../src/core/rng';

const P = (x: number, y: number) => ({ x, y });

describe('vec 追加関数', () => {
  it('lerp / normalize / perp / rotate / nearlyEqualPoint', () => {
    expect(lerp(P(0, 0), P(10, 20), 0.25)).toEqual(P(2.5, 5));
    expect(lerp(P(1, 1), P(5, 9), 0)).toEqual(P(1, 1));
    expect(lerp(P(1, 1), P(5, 9), 1)).toEqual(P(5, 9));
    expect(normalize(P(3, 4))).toEqual(P(0.6, 0.8));
    expect(normalize(P(0, 0))).toEqual(P(0, 0));
    expect(perp(P(1, 0))).toEqual(P(-0, 1));
    const r = rotate(P(1, 0), Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(1, 12);
    expect(nearlyEqualPoint(P(1, 1), P(1 + 5e-7, 1))).toBe(true);
    expect(nearlyEqualPoint(P(1, 1), P(1 + 5e-6, 1))).toBe(false);
  });
});

describe('bbox', () => {
  it('of / union / expand / intersects / containsPoint', () => {
    expect(bboxOf([])).toBeNull();
    const a = bboxOf([P(1, 5), P(-2, 3), P(4, 0)])!;
    expect(a).toEqual({ minX: -2, minY: 0, maxX: 4, maxY: 5 });
    const b = bboxOf([P(10, 10), P(12, 11)])!;
    expect(bboxIntersects(a, b)).toBe(false);
    expect(bboxUnion(a, b)).toEqual({ minX: -2, minY: 0, maxX: 12, maxY: 11 });
    expect(bboxIntersects(a, bboxExpand(b, 6))).toBe(true);
    // 接触は交差
    expect(bboxIntersects(a, { minX: 4, minY: 5, maxX: 6, maxY: 6 })).toBe(true);
    expect(bboxContainsPoint(a, P(4, 5))).toBe(true);
    expect(bboxContainsPoint(a, P(4.01, 5))).toBe(false);
  });
});

describe('closestPointOnSegment', () => {
  it('内部・端点クランプ・縮退', () => {
    expect(closestPointOnSegment(P(5, 3), P(0, 0), P(10, 0))).toEqual({ t: 0.5, p: P(5, 0), dist: 3 });
    expect(closestPointOnSegment(P(-4, 3), P(0, 0), P(10, 0))).toEqual({ t: 0, p: P(0, 0), dist: 5 });
    expect(closestPointOnSegment(P(14, 3), P(0, 0), P(10, 0)).t).toBe(1);
    expect(closestPointOnSegment(P(3, 4), P(0, 0), P(0, 0))).toEqual({ t: 0, p: P(0, 0), dist: 5 });
  });
  it('既存 distPointSegment と距離・t が一致する', () => {
    const rng = new Rng('cps');
    for (let i = 0; i < 1000; i++) {
      const a = P(rng.next() * 50, rng.next() * 50);
      const b = P(rng.next() * 50, rng.next() * 50);
      const p = P(rng.next() * 50, rng.next() * 50);
      const o = distPointSegment(p, a, b);
      const n = closestPointOnSegment(p, a, b);
      expect(n.dist).toBeCloseTo(o.dist, 12);
      expect(n.t).toBeCloseTo(o.t, 12);
    }
  });
});

describe('classifySegmentIntersection', () => {
  it('内部での交差', () => {
    const r = classifySegmentIntersection(P(0, 0), P(10, 10), P(0, 10), P(10, 0));
    expect(r).toMatchObject({ kind: 'point', t: 0.5, u: 0.5, atEndA: false, atEndB: false });
    if (r.kind === 'point') expect(r.p).toEqual(P(5, 5));
  });

  it('T 字（端点が相手の内部に接触）', () => {
    const r = classifySegmentIntersection(P(0, 0), P(10, 0), P(5, 0), P(5, 7));
    expect(r).toMatchObject({ kind: 'point', t: 0.5, u: 0, atEndA: false, atEndB: true });
    const r2 = classifySegmentIntersection(P(5, 7), P(5, 0), P(0, 0), P(10, 0));
    expect(r2).toMatchObject({ kind: 'point', t: 1, u: 0.5, atEndA: true, atEndB: false });
  });

  it('端点同士の接触（L 字）', () => {
    const r = classifySegmentIntersection(P(0, 0), P(10, 0), P(10, 0), P(10, 10));
    expect(r).toMatchObject({ kind: 'point', t: 1, u: 0, atEndA: true, atEndB: true });
  });

  it('交わらない（延長上では交わる）', () => {
    expect(classifySegmentIntersection(P(0, 0), P(10, 0), P(15, -5), P(15, 5)).kind).toBe('none');
    expect(classifySegmentIntersection(P(0, 0), P(10, 0), P(5, 1), P(5, 5)).kind).toBe('none');
  });

  it('平行（共線でない）', () => {
    expect(classifySegmentIntersection(P(0, 0), P(10, 0), P(0, 1), P(10, 1)).kind).toBe('none');
    expect(classifySegmentIntersection(P(0, 0), P(10, 10), P(0, 1), P(10, 11)).kind).toBe('none');
  });

  it('共線: 重なり・端点だけ接触・離れている・包含・逆向き', () => {
    const ov = classifySegmentIntersection(P(0, 0), P(10, 0), P(4, 0), P(14, 0));
    expect(ov).toMatchObject({ kind: 'overlap', t0: 0.4, t1: 1, u0: 0, u1: 0.6 });
    const touch = classifySegmentIntersection(P(0, 0), P(10, 0), P(10, 0), P(20, 0));
    expect(touch).toMatchObject({ kind: 'point', t: 1, u: 0, atEndA: true, atEndB: true });
    expect(classifySegmentIntersection(P(0, 0), P(10, 0), P(11, 0), P(20, 0)).kind).toBe('none');
    const inside = classifySegmentIntersection(P(0, 0), P(10, 0), P(2, 0), P(4, 0));
    expect(inside).toMatchObject({ kind: 'overlap', t0: 0.2, t1: 0.4, u0: 0, u1: 1 });
    const rev = classifySegmentIntersection(P(0, 0), P(10, 0), P(8, 0), P(2, 0));
    expect(rev).toMatchObject({ kind: 'overlap', t0: 0.2, t1: 0.8, u0: 1, u1: 0 });
    const diag = classifySegmentIntersection(P(0, 0), P(10, 10), P(5, 5), P(20, 20));
    expect(diag.kind).toBe('overlap');
  });

  it('縮退（長さ 0）', () => {
    expect(classifySegmentIntersection(P(1, 1), P(1, 1), P(1, 1), P(1, 1))).toMatchObject({ kind: 'point' });
    expect(classifySegmentIntersection(P(1, 1), P(1, 1), P(2, 2), P(2, 2)).kind).toBe('none');
    expect(classifySegmentIntersection(P(5, 0), P(5, 0), P(0, 0), P(10, 0))).toMatchObject({ kind: 'point', t: 0, u: 0.5, atEndA: true, atEndB: false });
    expect(classifySegmentIntersection(P(0, 0), P(10, 0), P(5, 0), P(5, 0))).toMatchObject({ kind: 'point', t: 0.5, u: 0, atEndA: false, atEndB: true });
    expect(classifySegmentIntersection(P(0, 0), P(10, 0), P(5, 3), P(5, 3)).kind).toBe('none');
  });

  it('対称性: 引数を入れ替えると t と u が入れ替わる', () => {
    const rng = new Rng('sym');
    for (let i = 0; i < 1000; i++) {
      const [a, b, c, d] = [0, 1, 2, 3].map(() => P(rng.int(0, 20), rng.int(0, 20)));
      const x = classifySegmentIntersection(a!, b!, c!, d!);
      const y = classifySegmentIntersection(c!, d!, a!, b!);
      expect(x.kind).toBe(y.kind);
      if (x.kind === 'point' && y.kind === 'point') {
        expect(x.t).toBeCloseTo(y.u, 9);
        expect(x.u).toBeCloseTo(y.t, 9);
        expect(x.atEndA).toBe(y.atEndB);
      }
    }
  });

  it('既存 segmentIntersection（内部のみ）との整合: 旧が非 null ⇔ 新が両端点でない point', () => {
    const rng = new Rng('old');
    let crossings = 0;
    for (let i = 0; i < 5000; i++) {
      const [a, b, c, d] = [0, 1, 2, 3].map(() => P(rng.int(0, 12), rng.int(0, 12)));
      const old = segmentIntersection(a!, b!, c!, d!);
      const n = classifySegmentIntersection(a!, b!, c!, d!);
      const interior = n.kind === 'point' && !n.atEndA && !n.atEndB;
      expect(interior).toBe(old !== null);
      if (old && n.kind === 'point') {
        crossings++;
        expect(n.t).toBeCloseTo(old.t, 12);
        expect(n.u).toBeCloseTo(old.u, 12);
        expect(n.p.x).toBeCloseTo(old.point.x, 12);
        expect(n.p.y).toBeCloseTo(old.point.y, 12);
      }
    }
    expect(crossings).toBeGreaterThan(200);
  });
});
