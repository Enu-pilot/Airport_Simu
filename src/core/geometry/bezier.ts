/** 2 次・3 次 Bezier（制御点配列 3 点 / 4 点）。純関数 */
import { dirToBearing } from './angle';
import { bboxOf, type Bbox } from './bbox';
import type { Vec2 } from './vec';

export type BezierPts = readonly Vec2[];

const lerpP = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** de Casteljau。点列が 3（2 次）でも 4（3 次）でも動く */
export function bezierPoint(pts: BezierPts, t: number): Vec2 {
  let cur = pts;
  while (cur.length > 1) {
    const next: Vec2[] = [];
    for (let i = 0; i < cur.length - 1; i++) next.push(lerpP(cur[i]!, cur[i + 1]!, t));
    cur = next;
  }
  return cur[0]!;
}

/** 1 階微分（制御点の差分の Bezier × 次数） */
export function bezierDerivative(pts: BezierPts, t: number): Vec2 {
  const n = pts.length - 1;
  const d: Vec2[] = [];
  for (let i = 0; i < n; i++) d.push({ x: (pts[i + 1]!.x - pts[i]!.x) * n, y: (pts[i + 1]!.y - pts[i]!.y) * n });
  return bezierPoint(d, t);
}

/** 2 階微分 */
export function bezierSecondDerivative(pts: BezierPts, t: number): Vec2 {
  const n = pts.length - 1;
  if (n < 2) return { x: 0, y: 0 };
  const d: Vec2[] = [];
  for (let i = 0; i < n; i++) d.push({ x: (pts[i + 1]!.x - pts[i]!.x) * n, y: (pts[i + 1]!.y - pts[i]!.y) * n });
  const e: Vec2[] = [];
  for (let i = 0; i < n - 1; i++) e.push({ x: (d[i + 1]!.x - d[i]!.x) * (n - 1), y: (d[i + 1]!.y - d[i]!.y) * (n - 1) });
  return bezierPoint(e, t);
}

/** 符号付き曲率（正 = 画面時計回り）。速度 0 では 0 */
export function bezierCurvature(pts: BezierPts, t: number): number {
  const d1 = bezierDerivative(pts, t);
  const d2 = bezierSecondDerivative(pts, t);
  const sp2 = d1.x * d1.x + d1.y * d1.y;
  if (sp2 === 0) return 0;
  return (d1.x * d2.y - d1.y * d2.x) / (sp2 * Math.sqrt(sp2));
}

/** 接線方位（度）。端点で速度が 0（制御点が重なる）ときは次の異なる制御点への方向を使う */
export function bezierTangentBearing(pts: BezierPts, t: number): number {
  const d = bezierDerivative(pts, t);
  if (d.x !== 0 || d.y !== 0) return dirToBearing(d.x, d.y);
  const n = pts.length;
  if (t <= 0) {
    for (let i = 1; i < n; i++) {
      const dx = pts[i]!.x - pts[0]!.x;
      const dy = pts[i]!.y - pts[0]!.y;
      if (dx !== 0 || dy !== 0) return dirToBearing(dx, dy);
    }
  } else if (t >= 1) {
    for (let i = n - 2; i >= 0; i--) {
      const dx = pts[n - 1]!.x - pts[i]!.x;
      const dy = pts[n - 1]!.y - pts[i]!.y;
      if (dx !== 0 || dy !== 0) return dirToBearing(dx, dy);
    }
  }
  return dirToBearing(0, 0);
}

/** t で 2 分割（de Casteljau） */
export function bezierSplit(pts: BezierPts, t: number): [Vec2[], Vec2[]] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  let cur: readonly Vec2[] = pts;
  while (cur.length > 0) {
    left.push(cur[0]!);
    right.unshift(cur[cur.length - 1]!);
    const next: Vec2[] = [];
    for (let i = 0; i < cur.length - 1; i++) next.push(lerpP(cur[i]!, cur[i + 1]!, t));
    cur = next;
  }
  return [left, right];
}

/** 1 軸の導関数の根（(0,1) 内）。2 次・3 次 */
function axisExtremaT(v: readonly number[]): number[] {
  const out: number[] = [];
  if (v.length === 3) {
    const den = v[0]! - 2 * v[1]! + v[2]!;
    if (den !== 0) {
      const t = (v[0]! - v[1]!) / den;
      if (t > 0 && t < 1) out.push(t);
    }
  } else {
    // 3 次: B'(t)/3 = a t² + b t + c
    const a = -v[0]! + 3 * v[1]! - 3 * v[2]! + v[3]!;
    const b = 2 * (v[0]! - 2 * v[1]! + v[2]!);
    const c = v[1]! - v[0]!;
    if (Math.abs(a) < 1e-14) {
      if (b !== 0) {
        const t = -c / b;
        if (t > 0 && t < 1) out.push(t);
      }
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) if (t > 0 && t < 1) out.push(t);
      }
    }
  }
  return out;
}

/** 厳密な境界ボックス（端点 + 導関数の根での点） */
export function bezierBbox(pts: BezierPts): Bbox {
  const cand: Vec2[] = [pts[0]!, pts[pts.length - 1]!];
  for (const t of axisExtremaT(pts.map((p) => p.x))) cand.push(bezierPoint(pts, t));
  for (const t of axisExtremaT(pts.map((p) => p.y))) cand.push(bezierPoint(pts, t));
  return bboxOf(cand)!;
}
