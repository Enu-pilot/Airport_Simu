import { describe, expect, it } from 'vitest';
import { arcFromTangent } from '../../../src/core/geometry/arc';
import { evaluate, type ArcCurve, type Curve, type LineCurve } from '../../../src/core/geometry/curve';
import { intersectCurves, type CurveIntersection } from '../../../src/core/geometry/intersect';
import { Rng } from '../../../src/core/rng';

const P = (x: number, y: number) => ({ x, y });
const line = (x0: number, y0: number, x1: number, y1: number): LineCurve => ({ kind: 'line', p0: P(x0, y0), p1: P(x1, y1) });
const circle = (cx: number, cy: number, r: number, th0 = 0, sweep = 6): ArcCurve => ({ kind: 'arc', c: P(cx, cy), r, theta0: th0, sweep });
const pts = (r: CurveIntersection[]) => r.filter((x): x is Extract<CurveIntersection, { kind: 'point' }> => x.kind === 'point');
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** 結果の各点が両曲線上にあることを確認 */
function expectOnBoth(c1: Curve, c2: Curve, res: CurveIntersection[], tol = 1e-5): void {
  for (const r of pts(res)) {
    expect(dist(evaluate(c1, r.t1), r.p)).toBeLessThan(tol);
    expect(dist(evaluate(c2, r.t2), r.p)).toBeLessThan(tol);
  }
}

describe('line–line', () => {
  it('交差・端点接触・共線重なり・平行', () => {
    const a = line(0, 0, 10, 10);
    const r = intersectCurves(a, line(0, 10, 10, 0));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'point', t1: 0.5, t2: 0.5 });
    expect(intersectCurves(line(0, 0, 10, 0), line(10, 0, 10, 5))[0]).toMatchObject({ kind: 'point', t1: 1, t2: 0 });
    expect(intersectCurves(line(0, 0, 10, 0), line(4, 0, 20, 0))[0]).toMatchObject({ kind: 'overlap', t1a: 0.4, t1b: 1 });
    expect(intersectCurves(line(0, 0, 10, 0), line(0, 1, 10, 1))).toEqual([]);
  });
});

describe('line–arc（解析）', () => {
  const c = circle(0, 0, 10, 0, Math.PI * 1.5); // 3/4 円（θ 0 → 270°）
  it('2 点で交わる（t1 昇順）', () => {
    const l = line(-20, 0, 20, 0);
    const r = intersectCurves(l, c);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ kind: 'point', t1: 0.25 });
    expect(r[1]).toMatchObject({ kind: 'point', t1: 0.75 });
    const a0 = pts(r)[0]!;
    expect(a0.p.x).toBeCloseTo(-10, 12);
    expect(a0.t2).toBeCloseTo(2 / 3, 12); // θ = π → 180°/270°
    expect(pts(r)[1]!.t2).toBe(0);
    expectOnBoth(l, c, r, 1e-12);
  });
  it('引数を入れ替えると t1 と t2 も入れ替わる', () => {
    const l = line(-20, 3, 20, 3);
    const a = pts(intersectCurves(l, c));
    const b = pts(intersectCurves(c, l));
    expect(a).toHaveLength(b.length);
    for (const p of a) {
      const q = b.find((x) => dist(x.p, p.p) < 1e-9)!;
      expect(q.t1).toBeCloseTo(p.t2, 12);
      expect(q.t2).toBeCloseTo(p.t1, 12);
    }
  });
  it('円弧の範囲外の交点は除外される', () => {
    const l = line(-20, 5, 20, 5); // 円との交点は x = ±8.66, y = 5 → θ = 30°, 150°。弧は 0..270° なので両方内、y=-5 の側は 330°, 210°
    expect(intersectCurves(l, c)).toHaveLength(2);
    expect(intersectCurves(line(-20, -5, 20, -5), c)).toHaveLength(1); // 210° のみ（330° は範囲外）
  });
  it('接線: tangent: true で 1 点', () => {
    const r = intersectCurves(line(-20, 10, 20, 10), circle(0, 0, 10, 0, 6));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'point', t1: 0.5, tangent: true });
  });
  it('離れている・線分の端で止まる', () => {
    expect(intersectCurves(line(-20, 11, 20, 11), c)).toEqual([]);
    expect(intersectCurves(line(-5, 0, 5, 0), c)).toEqual([]); // 円の内側に収まる
    expect(intersectCurves(line(0, 0, 10, 0), c)).toHaveLength(1); // 端点が円周上
  });
});

describe('arc–arc（解析）', () => {
  it('2 点・外接・内接・離れている・内包', () => {
    const a = circle(0, 0, 10);
    const r = intersectCurves(a, circle(10, 0, 10));
    expect(r).toHaveLength(2);
    expectOnBoth(a, circle(10, 0, 10), r, 1e-9);
    const ext = intersectCurves(a, circle(20, 0, 10));
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ kind: 'point', tangent: true });
    expect(pts(ext)[0]!.p.x).toBeCloseTo(10, 9);
    const int = intersectCurves(a, circle(5, 0, 5));
    expect(int).toHaveLength(1);
    expect(int[0]).toMatchObject({ tangent: true });
    expect(pts(int)[0]!.p.x).toBeCloseTo(10, 9);
    expect(intersectCurves(a, circle(30, 0, 10))).toEqual([]);
    expect(intersectCurves(a, circle(1, 0, 3))).toEqual([]);
    expect(intersectCurves(a, circle(0, 0, 5))).toEqual([]);
  });
  it('同一円上の重なり・端点接触・離れた弧', () => {
    const a: ArcCurve = circle(0, 0, 10, 0, 2); // θ 0..2
    const b: ArcCurve = circle(0, 0, 10, 1, 2); // θ 1..3
    const r = intersectCurves(a, b);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'overlap' });
    const o = r[0]!;
    if (o.kind === 'overlap') {
      expect(o.t1a).toBeCloseTo(0.5, 12);
      expect(o.t1b).toBeCloseTo(1, 12);
      expect(o.t2a).toBeCloseTo(0, 9);
      expect(o.t2b).toBeCloseTo(0.5, 9);
    }
    const touch = intersectCurves(a, circle(0, 0, 10, 2, 1));
    expect(touch).toHaveLength(1);
    expect(touch[0]).toMatchObject({ kind: 'point', t1: 1, t2: 0 });
    expect(intersectCurves(a, circle(0, 0, 10, 3, 1))).toEqual([]);
    // 逆向きの弧
    const rev: ArcCurve = circle(0, 0, 10, 3, -2); // θ 3..1
    const rr = intersectCurves(a, rev);
    expect(rr[0]).toMatchObject({ kind: 'overlap' });
    const o2 = rr[0]!;
    if (o2.kind === 'overlap') {
      expect(o2.t2a).toBeCloseTo(1, 9);
      expect(o2.t2b).toBeCloseTo(0.5, 9);
    }
    // 2π をまたぐ重なり
    const w1: ArcCurve = circle(0, 0, 10, 5.5, 2);
    const w2: ArcCurve = circle(0, 0, 10, 0, 1);
    const wr = intersectCurves(w1, w2);
    expect(wr).toHaveLength(1);
    expect(wr[0]).toMatchObject({ kind: 'overlap' });
  });
  it('始点接線から作った 2 本の円弧が接する（S 字の接続点）', () => {
    const a = arcFromTangent(P(0, 0), 90, 10, Math.PI / 2)!;
    const end = evaluate(a, 1);
    const b = arcFromTangent(end, 180, 10, -Math.PI / 2)!;
    const r = intersectCurves(a, b);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'point', t1: 1, t2: 0 });
  });
});

describe('一般（Bezier を含む）', () => {
  const cubic = (a: number[]): Curve => ({ kind: 'cubic', p0: P(a[0]!, a[1]!), p1: P(a[2]!, a[3]!), p2: P(a[4]!, a[5]!), p3: P(a[6]!, a[7]!) });

  it('S 字 3 次と水平線: 点が両曲線上にある、t1 昇順', () => {
    const c = cubic([0, 0, 30, 40, -10, -40, 20, 0]);
    const l = line(-5, 0, 25, 0);
    const r = intersectCurves(c, l);
    expect(pts(r).length).toBeGreaterThanOrEqual(2);
    expectOnBoth(c, l, r);
    for (let i = 1; i < r.length; i++) expect(pts(r)[i]!.t1).toBeGreaterThanOrEqual(pts(r)[i - 1]!.t1);
  });

  it('直線と 2 次 Bezier の 1 点交差は解析的に検証できる', () => {
    // y = t²·... p(t) = (2t, t²)（p0=(0,0), p1=(1,0), p2=(2,1)）と垂直線 x = 1 → t = 0.5, y = 0.25
    const q: Curve = { kind: 'quad', p0: P(0, 0), p1: P(1, 0), p2: P(2, 1) };
    const r = intersectCurves(q, line(1, -5, 1, 5));
    expect(r).toHaveLength(1);
    const p = pts(r)[0]!;
    expect(p.t1).toBeCloseTo(0.5, 9);
    expect(p.p.x).toBeCloseTo(1, 9);
    expect(p.p.y).toBeCloseTo(0.25, 9);
    expect(p.tangent).toBeUndefined();
  });

  it('Bezier と円弧（4 分円近似と円）', () => {
    const k = (4 / 3) * Math.tan(Math.PI / 8);
    const c = cubic([10, 0, 10, 10 * k, 10 * k, 10, 0, 10]);
    const l = line(0, 0, 20, 20);
    const r = intersectCurves(c, l);
    expect(r).toHaveLength(1);
    expect(pts(r)[0]!.p.x).toBeCloseTo(7.07, 1);
    expectOnBoth(c, l, r);
    const circ = circle(0, 0, 10, 0, 6);
    const r2 = intersectCurves(c, circ);
    expect(r2.length).toBeGreaterThanOrEqual(1); // 端点 2 つで円周上（ほぼ接触）
    expectOnBoth(c, circ, r2, 1e-5);
  });

  it('接触（重根）: tangent: true', () => {
    // 放物線 (2t, t²)  と 直線 y = 0 は t = 0 の端点で接する → 端点接触
    const q: Curve = { kind: 'quad', p0: P(0, 0), p1: P(1, 0), p2: P(2, 1) };
    const r = intersectCurves(q, line(-5, 0, 5, 0));
    expect(r).toHaveLength(1);
    expect(pts(r)[0]!.tangent).toBe(true);
    expect(pts(r)[0]!.t1).toBeCloseTo(0, 6);
    // 内部で接する: 頂点 y=-5 の山型 2 次 Bezier と直線 y=-5
    const hill: Curve = { kind: 'quad', p0: P(-10, 0), p1: P(0, -10), p2: P(10, 0) };
    const t = intersectCurves(hill, line(-20, -5, 20, -5));
    expect(t).toHaveLength(1);
    expect(pts(t)[0]!.tangent).toBe(true);
    expect(pts(t)[0]!.t1).toBeCloseTo(0.5, 4);
    expect(pts(t)[0]!.p.x).toBeCloseTo(0, 4);
  });

  it('交わらない', () => {
    const c = cubic([0, 0, 10, 10, 20, 10, 30, 0]);
    expect(intersectCurves(c, line(0, 20, 30, 20))).toEqual([]);
  });

  it('同一の制御点列は overlap、逆順は t2 が逆', () => {
    const c = cubic([0, 0, 10, 10, 20, 10, 30, 0]);
    expect(intersectCurves(c, c)).toEqual([{ kind: 'overlap', t1a: 0, t1b: 1, t2a: 0, t2b: 1 }]);
    const rev = cubic([30, 0, 20, 10, 10, 10, 0, 0]);
    expect(intersectCurves(c, rev)).toEqual([{ kind: 'overlap', t1a: 0, t1b: 1, t2a: 1, t2b: 0 }]);
  });

  it('決定性: 同じ入力で同じ順・同じビットの結果', () => {
    const c = cubic([0, 0, 30, 40, -10, -40, 20, 0]);
    const d = cubic([-5, -10, 10, 30, 15, -30, 30, 10]);
    const a = intersectCurves(c, d);
    const b = intersectCurves(c, d);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it('性質: 乱数曲線対で、結果点は両曲線上、t1 昇順、重複なし', () => {
    const rng = new Rng('isect');
    const rc = (): Curve => {
      const q = () => P(rng.next() * 40, rng.next() * 40);
      const k = rng.int(0, 3);
      if (k === 0) return { kind: 'line', p0: q(), p1: q() };
      if (k === 1) return { kind: 'quad', p0: q(), p1: q(), p2: q() };
      if (k === 2) return { kind: 'cubic', p0: q(), p1: q(), p2: q(), p3: q() };
      return { kind: 'arc', c: q(), r: 3 + rng.next() * 15, theta0: rng.next() * 6, sweep: (rng.next() * 2 - 1) * 5 || 1 };
    };
    let total = 0;
    for (let i = 0; i < 150; i++) {
      const a = rc();
      const b = rc();
      const r = intersectCurves(a, b);
      expectOnBoth(a, b, r, 1e-5);
      const p = pts(r);
      total += p.length;
      for (let j = 1; j < p.length; j++) expect(p[j]!.t1).toBeGreaterThanOrEqual(p[j - 1]!.t1);
      for (let j = 0; j < p.length; j++) for (let k = j + 1; k < p.length; k++) expect(dist(p[j]!.p, p[k]!.p)).toBeGreaterThan(1e-6);
      expect(JSON.stringify(intersectCurves(a, b))).toBe(JSON.stringify(r));
    }
    expect(total).toBeGreaterThan(30);
  });

  it('性質: 密サンプリングの符号変化から数えた横断数が、線分–Bezier の結果数と一致する', () => {
    const rng = new Rng('cross');
    for (let i = 0; i < 80; i++) {
      const q = () => P(rng.next() * 40, rng.next() * 40);
      const c: Curve = { kind: 'cubic', p0: q(), p1: q(), p2: q(), p3: q() };
      const a = q();
      const b = q();
      const l = line(a.x, a.y, b.x, b.y);
      // 直線の左右を符号付き距離で判定し、曲線との交点のうち線分範囲内のものを数える
      const side = (p: { x: number; y: number }) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      let n = 0;
      let prev = side(evaluate(c, 0));
      for (let j = 1; j <= 4000; j++) {
        const p = evaluate(c, j / 4000);
        const s = side(p);
        if (prev < 0 !== s < 0) {
          // 符号が変わった区間の直線上の位置
          const u = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2;
          if (u >= 0 && u <= 1) n++;
        }
        prev = s;
      }
      const r = pts(intersectCurves(c, l));
      // 端付近の境界ケースを除き一致する（許容 ±0 を要求し、不一致は端で起きるものだけ）
      const margin = r.some((x) => x.t2 < 1e-2 || x.t2 > 1 - 1e-2 || x.tangent);
      if (!margin) expect(r.length).toBe(n);
    }
  });
});
