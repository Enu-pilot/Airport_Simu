import { describe, expect, it } from 'vitest';
import { arcFromBulge, arcFromTangent, arcFromThreePoints, fillet } from '../../../src/core/geometry/arc';
import { gauss5, integrateAdaptive } from '../../../src/core/geometry/integrate';
import {
  arcLengthTable,
  bbox,
  closestPoint,
  curvature,
  derivative,
  evaluate,
  flatten,
  length,
  pointAtLength,
  reverse,
  split,
  tAtLength,
  tangentBearingDeg,
  type ArcCurve,
  type Curve,
} from '../../../src/core/geometry/curve';
import { distPointSegment } from '../../../src/core/geometry/vec';
import { Rng } from '../../../src/core/rng';

const P = (x: number, y: number) => ({ x, y });
const KAPPA = (4 / 3) * Math.tan(Math.PI / 8);

/** 半径 r・中心 0 の第 1 象限（右 → 下: θ 0 → π/2）の 3 次近似 */
const quarterCubic = (r: number): Curve => ({
  kind: 'cubic',
  p0: P(r, 0),
  p1: P(r, r * KAPPA),
  p2: P(r * KAPPA, r),
  p3: P(0, r),
});

const randCurve = (rng: Rng, kind: 'line' | 'arc' | 'quad' | 'cubic'): Curve => {
  const q = () => P(rng.next() * 40 - 20, rng.next() * 40 - 20);
  if (kind === 'line') return { kind, p0: q(), p1: q() };
  if (kind === 'quad') return { kind, p0: q(), p1: q(), p2: q() };
  if (kind === 'cubic') return { kind, p0: q(), p1: q(), p2: q(), p3: q() };
  return { kind, c: q(), r: 1 + rng.next() * 15, theta0: rng.next() * 6.28 - 3.14, sweep: (rng.next() * 2 - 1) * 5.5 || 1 };
};
const KINDS = ['line', 'arc', 'quad', 'cubic'] as const;

describe('integrate', () => {
  it('gauss5 は 9 次以下の多項式を厳密に積分する', () => {
    expect(gauss5((t) => t ** 9 + 3 * t ** 2, 0, 1)).toBeCloseTo(0.1 + 1, 14);
  });
  it('適応積分: sin と深い特徴', () => {
    expect(integrateAdaptive(Math.sin, 0, Math.PI)).toBeCloseTo(2, 12);
    expect(integrateAdaptive((t) => 1 / (1e-3 + (t - 0.3) ** 2), 0, 1)).toBeCloseTo((Math.atan((1 - 0.3) / Math.sqrt(1e-3)) + Math.atan(0.3 / Math.sqrt(1e-3))) / Math.sqrt(1e-3), 6);
    expect(integrateAdaptive(() => 5, 2, 2)).toBe(0);
  });
});

describe('円弧', () => {
  it('弧長 = r·|sweep|（厳密）、曲率 = ±1/r（厳密）', () => {
    const a: ArcCurve = { kind: 'arc', c: P(3, 4), r: 7, theta0: 0.3, sweep: 2.1 };
    expect(length(a)).toBe(7 * 2.1);
    expect(curvature(a, 0.4)).toBe(1 / 7);
    expect(curvature({ ...a, sweep: -2.1 }, 0.4)).toBe(-1 / 7);
  });

  it('端点・接線・進行方向', () => {
    // 北向きに出発して右旋回 90° → 東向きに終わる（半径 10）
    const a = arcFromTangent(P(0, 0), 0, 10, Math.PI / 2)!;
    expect(a.c.x).toBeCloseTo(10, 12);
    expect(a.c.y).toBeCloseTo(0, 12);
    const e = evaluate(a, 1);
    expect(e.x).toBeCloseTo(10, 12);
    expect(e.y).toBeCloseTo(-10, 12);
    expect(tangentBearingDeg(a, 0)).toBeCloseTo(0, 9);
    expect(tangentBearingDeg(a, 1)).toBeCloseTo(90, 9);
    expect(tangentBearingDeg(a, 0.5)).toBeCloseTo(45, 9);
    // 左旋回
    const l = arcFromTangent(P(0, 0), 0, 10, -Math.PI / 2)!;
    expect(evaluate(l, 1).x).toBeCloseTo(-10, 12);
    expect(tangentBearingDeg(l, 1)).toBeCloseTo(270, 9);
    expect(curvature(l, 0.5)).toBe(-0.1);
    expect(arcFromTangent(P(0, 0), 0, 0, 1)).toBeNull();
    expect(arcFromTangent(P(0, 0), 0, 5, 0)).toBeNull();
  });

  it('fromBulge: 端点を通り、bulge = tan(sweep/4)、符号は向き', () => {
    const a = arcFromBulge(P(0, 0), P(10, 0), 1)!; // 半円、時計回り
    expect(a.sweep).toBeCloseTo(Math.PI, 12);
    expect(a.r).toBeCloseTo(5, 12);
    expect(evaluate(a, 0).x).toBeCloseTo(0, 12);
    expect(evaluate(a, 1).x).toBeCloseTo(10, 12);
    expect(evaluate(a, 1).y).toBeCloseTo(0, 12);
    expect(evaluate(a, 0.5).y).toBeCloseTo(-5, 12); // 画面上方へ膨らむ
    const b = arcFromBulge(P(0, 0), P(10, 0), -1)!;
    expect(evaluate(b, 0.5).y).toBeCloseTo(5, 12);
    expect(arcFromBulge(P(0, 0), P(10, 0), 0)).toBeNull();
    expect(arcFromBulge(P(1, 1), P(1, 1), 0.5)).toBeNull();
    const rng = new Rng('bulge');
    for (let i = 0; i < 500; i++) {
      const p0 = P(rng.next() * 30, rng.next() * 30);
      const p1 = P(rng.next() * 30, rng.next() * 30);
      const bu = (rng.next() * 2 - 1) * 3;
      const arc = arcFromBulge(p0, p1, bu)!;
      const s = evaluate(arc, 0);
      const e = evaluate(arc, 1);
      expect(Math.hypot(s.x - p0.x, s.y - p0.y)).toBeLessThan(1e-9);
      expect(Math.hypot(e.x - p1.x, e.y - p1.y)).toBeLessThan(1e-9);
      expect(Math.tan(arc.sweep / 4)).toBeCloseTo(bu, 9);
    }
  });

  it('fromThreePoints', () => {
    const a = arcFromThreePoints(P(10, 0), P(0, 10), P(-10, 0))!;
    expect(a.r).toBeCloseTo(10, 12);
    expect(a.c.x).toBeCloseTo(0, 12);
    expect(Math.abs(a.sweep)).toBeCloseTo(Math.PI, 12);
    const m = evaluate(a, 0.5);
    expect(m.x).toBeCloseTo(0, 9);
    expect(m.y).toBeCloseTo(10, 9);
    expect(arcFromThreePoints(P(0, 0), P(1, 1), P(2, 2))).toBeNull();
    // 逆回りでも中間点を通る
    const b = arcFromThreePoints(P(10, 0), P(0, -10), P(-10, 0))!;
    expect(evaluate(b, 0.5).y).toBeCloseTo(-10, 9);
    expect(b.sweep).toBeLessThan(0);
  });

  it('fillet: 直角コーナーを半径 r で丸める（接線連続）', () => {
    const f = fillet({ kind: 'line', p0: P(0, 0), p1: P(20, 0) }, { kind: 'line', p0: P(20, 0), p1: P(20, 20) }, 5)!;
    expect(f.a.p1).toEqual(P(15, 0));
    expect(f.b.p0.x).toBe(20);
    expect(f.b.p0.y).toBeCloseTo(5, 12);
    expect(f.arc.r).toBe(5);
    expect(f.arc.c.x).toBeCloseTo(15, 12);
    expect(f.arc.c.y).toBeCloseTo(5, 12);
    expect(f.arc.sweep).toBeCloseTo(Math.PI / 2, 12);
    const s = evaluate(f.arc, 0);
    const e = evaluate(f.arc, 1);
    expect(s.x).toBeCloseTo(15, 12);
    expect(s.y).toBeCloseTo(0, 12);
    expect(e.x).toBeCloseTo(20, 12);
    expect(e.y).toBeCloseTo(5, 12);
    expect(tangentBearingDeg(f.arc, 0)).toBeCloseTo(90, 9);
    expect(tangentBearingDeg(f.arc, 1)).toBeCloseTo(180, 9);
    // 長さが足りない・一直線・折り返し・離れている
    const L = (a: [number, number], b: [number, number]) => ({ kind: 'line' as const, p0: P(...a), p1: P(...b) });
    expect(fillet(L([0, 0], [20, 0]), L([20, 0], [20, 20]), 25)).toBeNull();
    expect(fillet(L([0, 0], [20, 0]), L([20, 0], [40, 0]), 5)).toBeNull();
    expect(fillet(L([0, 0], [20, 0]), L([20, 0], [0, 0]), 5)).toBeNull();
    expect(fillet(L([0, 0], [20, 0]), L([21, 0], [21, 20]), 5)).toBeNull();
    // 45° の振れ・左折
    const g = fillet(L([0, 0], [20, 0]), L([20, 0], [30, -10]), 6)!;
    expect(g.arc.sweep).toBeCloseTo(-Math.PI / 4, 9);
    const gs = evaluate(g.arc, 0);
    expect(gs.x).toBeCloseTo(g.a.p1.x, 9);
    expect(gs.y).toBeCloseTo(g.a.p1.y, 9);
    const ge = evaluate(g.arc, 1);
    expect(ge.x).toBeCloseTo(g.b.p0.x, 9);
    expect(ge.y).toBeCloseTo(g.b.p0.y, 9);
    expect(tangentBearingDeg(g.arc, 1)).toBeCloseTo(45, 7);
  });
});

describe('Bezier', () => {
  it('直線に退化した Bezier の長さは弦長', () => {
    const q: Curve = { kind: 'quad', p0: P(0, 0), p1: P(5, 5), p2: P(10, 10) };
    expect(length(q)).toBeCloseTo(Math.hypot(10, 10), 12);
    const c: Curve = { kind: 'cubic', p0: P(0, 0), p1: P(3, 0), p2: P(7, 0), p3: P(10, 0) };
    expect(length(c)).toBeCloseTo(10, 12);
    // 折り返さない不等間隔でも同じ
    const c2: Curve = { kind: 'cubic', p0: P(0, 0), p1: P(1, 1), p2: P(9, 9), p3: P(10, 10) };
    expect(length(c2)).toBeCloseTo(Math.hypot(10, 10), 11);
  });

  it('4 分円の 3 次近似: 半径誤差 ≈ 2.7e-4、長さ ≈ πr/2', () => {
    const r = 100;
    const c = quarterCubic(r);
    let maxErr = 0;
    for (let i = 0; i <= 200; i++) {
      const p = evaluate(c, i / 200);
      maxErr = Math.max(maxErr, Math.abs(Math.hypot(p.x, p.y) / r - 1));
    }
    expect(maxErr).toBeGreaterThan(2.0e-4);
    expect(maxErr).toBeLessThan(3.0e-4);
    expect(length(c) / r).toBeCloseTo(Math.PI / 2, 3);
  });

  it('全制御点が一致する退化 Bezier: 長さ 0、評価は点、接線は 0 方位', () => {
    const c: Curve = { kind: 'cubic', p0: P(2, 3), p1: P(2, 3), p2: P(2, 3), p3: P(2, 3) };
    expect(length(c)).toBe(0);
    expect(evaluate(c, 0.37)).toEqual(P(2, 3));
    expect(curvature(c, 0.5)).toBe(0);
    expect(tangentBearingDeg(c, 0.5)).toBe(0);
    const f = flatten(c, 0.01);
    expect(f[0]!.p).toEqual(P(2, 3));
    expect(f[f.length - 1]!.p).toEqual(P(2, 3));
    expect(bbox(c)).toEqual({ minX: 2, minY: 3, maxX: 2, maxY: 3 });
  });

  it('始点の制御点が重なる 3 次の端点接線は次の制御点への方向', () => {
    const c: Curve = { kind: 'cubic', p0: P(0, 0), p1: P(0, 0), p2: P(10, 0), p3: P(10, 10) };
    expect(tangentBearingDeg(c, 0)).toBeCloseTo(90, 9);
  });

  it('Bezier の曲率は円弧近似で ≈ 1/r（中点）', () => {
    const c = quarterCubic(50);
    expect(curvature(c, 0.5)).toBeCloseTo(1 / 50, 3);
  });

  it('2 次 Bezier の曲率を解析式と比較（放物線）', () => {
    // p(t) = (2t, t²) 相当: p0=(0,0), p1=(1,0), p2=(2,1) → x=2t, y=t²。κ = 2/(4+4t²)^{3/2}·... 符号付き
    const q: Curve = { kind: 'quad', p0: P(0, 0), p1: P(1, 0), p2: P(2, 1) };
    for (const t of [0, 0.3, 0.5, 1]) {
      const exp = (2 * 2) / Math.pow(4 + 4 * t * t, 1.5); // x'y'' − y'x'' = 2·2 − 2t·0
      expect(curvature(q, t)).toBeCloseTo(exp, 12);
    }
  });

  it('導関数が有限差分と一致する（全種別）', () => {
    const rng = new Rng('deriv');
    for (const k of KINDS) {
      for (let i = 0; i < 50; i++) {
        const c = randCurve(rng, k);
        const t = 0.1 + rng.next() * 0.8;
        const h = 1e-6;
        const a = evaluate(c, t - h);
        const b = evaluate(c, t + h);
        const d = derivative(c, t);
        expect(d.x).toBeCloseTo((b.x - a.x) / (2 * h), 4);
        expect(d.y).toBeCloseTo((b.y - a.y) / (2 * h), 4);
      }
    }
  });
});

describe('長さ・分割・反転（性質テスト、シード付き乱数）', () => {
  it('split 後の長さの和 = 元の長さ、接合点が一致する', () => {
    const rng = new Rng('split');
    for (const k of KINDS) {
      for (let i = 0; i < 250; i++) {
        const c = randCurve(rng, k);
        const t = 0.05 + rng.next() * 0.9;
        const [a, b] = split(c, t);
        expect(length(a) + length(b)).toBeCloseTo(length(c), 8);
        const j1 = evaluate(a, 1);
        const j2 = evaluate(b, 0);
        const m = evaluate(c, t);
        expect(Math.hypot(j1.x - m.x, j1.y - m.y)).toBeLessThan(1e-9);
        expect(Math.hypot(j2.x - m.x, j2.y - m.y)).toBeLessThan(1e-9);
        const e0 = evaluate(a, 0);
        const e1 = evaluate(b, 1);
        const s0 = evaluate(c, 0);
        const s1 = evaluate(c, 1);
        expect(Math.hypot(e0.x - s0.x, e0.y - s0.y)).toBeLessThan(1e-9);
        expect(Math.hypot(e1.x - s1.x, e1.y - s1.y)).toBeLessThan(1e-9);
      }
    }
  });

  it('split は接線方位を保つ（接線連続）', () => {
    const rng = new Rng('tan');
    for (const k of KINDS) {
      for (let i = 0; i < 100; i++) {
        const c = randCurve(rng, k);
        const t = 0.1 + rng.next() * 0.8;
        const [a, b] = split(c, t);
        const h0 = tangentBearingDeg(c, t);
        const h1 = tangentBearingDeg(a, 1);
        const h2 = tangentBearingDeg(b, 0);
        const d = (x: number, y: number) => Math.abs(((x - y + 540) % 360) - 180);
        expect(d(h0, h1)).toBeLessThan(1e-6);
        expect(d(h0, h2)).toBeLessThan(1e-6);
      }
    }
  });

  it('reverse の対称性: evaluate(reverse(c), 1 − t) ≈ evaluate(c, t)、長さ不変、接線は逆向き', () => {
    const rng = new Rng('rev');
    for (const k of KINDS) {
      for (let i = 0; i < 150; i++) {
        const c = randCurve(rng, k);
        const r = reverse(c);
        const t = rng.next();
        const p = evaluate(c, t);
        const q = evaluate(r, 1 - t);
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1e-9);
        expect(length(r)).toBeCloseTo(length(c), 9);
        expect(curvature(r, 1 - t)).toBeCloseTo(-curvature(c, t), 9);
        const d = Math.abs(((tangentBearingDeg(r, 1 - t) - tangentBearingDeg(c, t) + 540) % 360) - 180);
        expect(Math.abs(d - 180)).toBeLessThan(1e-6);
      }
    }
  });

  it('bbox は密サンプリングの点を含み、サンプリング誤差の理論上限内でほぼ一致する', () => {
    const rng = new Rng('bbox');
    const N = 64;
    // |B''| の上限（極値のサンプリング誤差 ≤ A · (1/N)² / 8）
    const accel = (c: Curve): number => {
      const dd = (a: ReturnType<typeof P>, b: ReturnType<typeof P>, d: ReturnType<typeof P>) => Math.hypot(a.x - 2 * b.x + d.x, a.y - 2 * b.y + d.y);
      if (c.kind === 'line') return 0;
      if (c.kind === 'arc') return c.r * c.sweep * c.sweep;
      if (c.kind === 'quad') return 2 * dd(c.p0, c.p1, c.p2);
      return 6 * Math.max(dd(c.p0, c.p1, c.p2), dd(c.p1, c.p2, c.p3));
    };
    for (const k of KINDS) {
      for (let i = 0; i < 300; i++) {
        const c = randCurve(rng, k);
        const b = bbox(c);
        let mnx = Infinity;
        let mxx = -Infinity;
        let mny = Infinity;
        let mxy = -Infinity;
        for (let j = 0; j <= N; j++) {
          const p = evaluate(c, j / N);
          mnx = Math.min(mnx, p.x);
          mxx = Math.max(mxx, p.x);
          mny = Math.min(mny, p.y);
          mxy = Math.max(mxy, p.y);
        }
        const slack = (accel(c) / (N * N)) / 8 + 1e-6;
        expect(b.minX).toBeLessThanOrEqual(mnx + 1e-9);
        expect(b.minY).toBeLessThanOrEqual(mny + 1e-9);
        expect(b.maxX).toBeGreaterThanOrEqual(mxx - 1e-9);
        expect(b.maxY).toBeGreaterThanOrEqual(mxy - 1e-9);
        expect(mnx - b.minX).toBeLessThan(slack);
        expect(b.maxX - mxx).toBeLessThan(slack);
        expect(mny - b.minY).toBeLessThan(slack);
        expect(b.maxY - mxy).toBeLessThan(slack);
      }
    }
    // 半円の bbox は軸方向の極値を含む
    const half: ArcCurve = { kind: 'arc', c: P(0, 0), r: 10, theta0: -Math.PI / 2, sweep: Math.PI };
    const hb = bbox(half);
    expect(hb.maxX).toBeCloseTo(10, 12);
    expect(hb.minY).toBeCloseTo(-10, 12);
    expect(hb.maxY).toBeCloseTo(10, 12);
    expect(hb.minX).toBeCloseTo(0, 9);
  });
});

describe('flatten', () => {
  it('弦高誤差 ≤ tol（密サンプリングで検証）、端点を含み t は単調', () => {
    const rng = new Rng('flat');
    for (const k of ['arc', 'quad', 'cubic'] as const) {
      for (const tol of [0.01, 0.002, 0.2]) {
        for (let i = 0; i < 40; i++) {
          const c = randCurve(rng, k);
          const f = flatten(c, tol);
          expect(f[0]!.t).toBe(0);
          expect(f[f.length - 1]!.t).toBe(1);
          for (let j = 1; j < f.length; j++) expect(f[j]!.t).toBeGreaterThan(f[j - 1]!.t);
          for (let j = 0; j <= 300; j++) {
            const p = evaluate(c, j / 300);
            let d = Infinity;
            for (let m = 0; m + 1 < f.length; m++) d = Math.min(d, distPointSegment(p, f[m]!.p, f[m + 1]!.p).dist);
            expect(d).toBeLessThanOrEqual(tol + 1e-9);
          }
        }
      }
    }
  });

  it('線分は 2 点、折れ線の点は曲線上にある', () => {
    expect(flatten({ kind: 'line', p0: P(0, 0), p1: P(3, 4) }, 0.01)).toHaveLength(2);
    const c = quarterCubic(30);
    for (const cp of flatten(c, 0.01)) {
      const q = evaluate(c, cp.t);
      expect(Math.hypot(q.x - cp.p.x, q.y - cp.p.y)).toBeLessThan(1e-9);
    }
  });

  it('円弧の分割数は解析的で、許容を小さくすると増える', () => {
    const a: ArcCurve = { kind: 'arc', c: P(0, 0), r: 100, theta0: 0, sweep: Math.PI };
    expect(flatten(a, 0.002).length).toBeGreaterThan(flatten(a, 0.01).length);
    expect(flatten(a, 1000)).toHaveLength(2);
  });
});

describe('closestPoint', () => {
  it('線分・円弧（範囲内・範囲外・中心）', () => {
    expect(closestPoint({ kind: 'line', p0: P(0, 0), p1: P(10, 0) }, P(4, 3))).toEqual({ t: 0.4, p: P(4, 0), dist: 3 });
    const a: ArcCurve = { kind: 'arc', c: P(0, 0), r: 10, theta0: 0, sweep: Math.PI / 2 };
    const inside = closestPoint(a, P(20, 20));
    expect(inside.t).toBeCloseTo(0.5, 12);
    expect(inside.dist).toBeCloseTo(Math.hypot(20, 20) - 10, 12);
    const out = closestPoint(a, P(10, -5));
    expect(out.t).toBe(0);
    expect(out.dist).toBeCloseTo(5, 12);
    expect(closestPoint(a, P(0, 0)).t).toBe(0);
    const cw: ArcCurve = { kind: 'arc', c: P(0, 0), r: 10, theta0: 0, sweep: -Math.PI / 2 };
    expect(closestPoint(cw, P(20, -20)).t).toBeCloseTo(0.5, 12);
  });

  it('曲線上の点は距離 0、乱数点は密サンプリングの最小値と一致する', () => {
    const rng = new Rng('closest');
    for (const k of KINDS) {
      for (let i = 0; i < 60; i++) {
        const c = randCurve(rng, k);
        const t = rng.next();
        const on = evaluate(c, t);
        expect(closestPoint(c, on).dist).toBeLessThan(1e-6);
        const q = P(rng.next() * 50 - 25, rng.next() * 50 - 25);
        let best = Infinity;
        for (let j = 0; j <= 4000; j++) {
          const p = evaluate(c, j / 4000);
          best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
        }
        const r = closestPoint(c, q);
        expect(r.dist).toBeLessThanOrEqual(best + 1e-9);
        expect(r.dist).toBeGreaterThan(best - 0.05);
        const rp = evaluate(c, r.t);
        expect(Math.hypot(rp.x - r.p.x, rp.y - r.p.y)).toBeLessThan(1e-9);
      }
    }
  });

  it('同距離は小さい t（円弧の中心対称）', () => {
    const q: Curve = { kind: 'quad', p0: P(-10, 0), p1: P(0, -10), p2: P(10, 0) };
    // 軸上の点 (0, -100) の最近点は頂点（t = 0.5）
    expect(closestPoint(q, P(0, -100)).t).toBeCloseTo(0.5, 6);
    // (0, 100) は両端点が同距離: 小さい t（始点）を返す
    expect(closestPoint(q, P(0, 100)).t).toBe(0);
  });
});

describe('弧長テーブルと pointAtLength', () => {
  it('単調かつ s 一致: 長さ s の点までの弧長が s、全長でクランプ', () => {
    const rng = new Rng('pal');
    for (const k of KINDS) {
      for (let i = 0; i < 25; i++) {
        const c = randCurve(rng, k);
        const L = length(c);
        const tbl = arcLengthTable(c);
        expect(tbl.total).toBeCloseTo(L, 9);
        let prevT = -1;
        for (let j = 0; j <= 20; j++) {
          const s = (L * j) / 20;
          const r = pointAtLength(c, s, tbl);
          expect(r.t).toBeGreaterThanOrEqual(prevT);
          prevT = r.t;
          const [head] = split(c, r.t);
          expect(length(head)).toBeCloseTo(s, 7);
        }
        expect(pointAtLength(c, -5, tbl).t).toBe(0);
        expect(pointAtLength(c, L + 5, tbl).t).toBe(1);
        expect(pointAtLength(c, L + 5, tbl).s).toBe(tbl.total);
        expect(tAtLength(tbl, 0)).toBe(0);
      }
    }
  });

  it('円弧・線分では s と t が比例する', () => {
    const a: ArcCurve = { kind: 'arc', c: P(0, 0), r: 10, theta0: 0, sweep: 2 };
    expect(pointAtLength(a, 10).t).toBe(0.5);
    const l: Curve = { kind: 'line', p0: P(0, 0), p1: P(30, 40) };
    const r = pointAtLength(l, 10);
    expect(r.p.x).toBeCloseTo(6, 12);
    expect(r.p.y).toBeCloseTo(8, 12);
  });

  it('決定的: 同じ入力で同じビット', () => {
    const c = quarterCubic(40);
    const a = pointAtLength(c, 33.3);
    const b = pointAtLength(c, 33.3);
    expect(a).toEqual(b);
    expect(length(c)).toBe(length(c));
  });
});
