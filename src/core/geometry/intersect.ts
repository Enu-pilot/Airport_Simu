/**
 * 曲線同士の交差。線分–線分・線分–円弧・円弧–円弧は解析解、Bezier を含む組は
 * bbox 細分 + 最小二乗 Newton（Levenberg 風の微小減衰）で仕上げる。
 *
 * 契約:
 * - 結果は t1 昇順（overlap は t1a）で、距離 `dedupe` 以内の点は 1 点にまとめる。
 * - 接触（重根）は 1 点で `tangent: true`。端点での接触も `point` として返す（呼び出し側が意味を決める）。
 * - 共線の線分・同一円上の円弧の重なりは `overlap`。一般の Bezier の部分的な重なりは検出せず、
 *   制御点が完全に一致（または逆順一致）する場合のみ overlap [0, 1] を返す。
 * - 決定的: ループ順・再帰順は固定で、乱数・時刻を使わない。
 */
import { type Curve, type ArcCurve, bbox, derivative, evaluate, split, closestPoint } from './curve';
import { bboxExpand, bboxIntersects } from './bbox';
import { classifySegmentIntersection } from './segment';
import { MAX_SUBDIV_DEPTH, POS_EPS_T } from './tolerance';
import type { Vec2 } from './vec';

export type CurveIntersection =
  | { kind: 'point'; p: Vec2; t1: number; t2: number; tangent?: true }
  | { kind: 'overlap'; t1a: number; t1b: number; t2a: number; t2b: number };

const TWO_PI = 2 * Math.PI;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const norm2pi = (a: number): number => {
  const m = ((a % TWO_PI) + TWO_PI) % TWO_PI;
  return m === 0 ? 0 : m;
};

/** 円周上の角度 ang が円弧のどの t に当たるか（弧の外なら null、許容は POS_EPS_T/r） */
function arcParamOfAngle(a: ArcCurve, ang: number): number | null {
  const span = Math.abs(a.sweep);
  const epsA = POS_EPS_T / a.r;
  const rel = norm2pi(a.sweep >= 0 ? ang - a.theta0 : a.theta0 - ang);
  if (rel <= span + epsA) return span === 0 ? 0 : Math.min(1, rel / span);
  if (rel >= TWO_PI - epsA) return 0;
  return null;
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

function pointResult(p: Vec2, t1: number, t2: number, tangent: boolean): CurveIntersection {
  return tangent ? { kind: 'point', p, t1: clamp01(t1), t2: clamp01(t2), tangent: true } : { kind: 'point', p, t1: clamp01(t1), t2: clamp01(t2) };
}

// ---------------------------------------------------------------- 解析解

function lineLine(c1: Curve & { kind: 'line' }, c2: Curve & { kind: 'line' }): CurveIntersection[] {
  const r = classifySegmentIntersection(c1.p0, c1.p1, c2.p0, c2.p1);
  if (r.kind === 'none') return [];
  if (r.kind === 'overlap') return [{ kind: 'overlap', t1a: r.t0, t1b: r.t1, t2a: r.u0, t2b: r.u1 }];
  return [pointResult(r.p, r.t, r.u, false)];
}

/** 線分 l と円弧 a。lineIsFirst: 結果の t1 が線分側か */
function lineArc(l: Curve & { kind: 'line' }, a: ArcCurve, lineIsFirst: boolean): CurveIntersection[] {
  const dx = l.p1.x - l.p0.x;
  const dy = l.p1.y - l.p0.y;
  const len = Math.hypot(dx, dy);
  const out: CurveIntersection[] = [];
  const emit = (u: number, tangent: boolean): void => {
    const p = { x: l.p0.x + dx * u, y: l.p0.y + dy * u };
    const t = arcParamOfAngle(a, Math.atan2(p.y - a.c.y, p.x - a.c.x));
    if (t === null) return;
    const pe = lineIsFirst ? pointResult(p, u, t, tangent) : pointResult(p, t, u, tangent);
    out.push(pe);
  };
  if (len <= POS_EPS_T) {
    if (Math.abs(dist(l.p0, a.c) - a.r) <= POS_EPS_T) emit(0, false);
    return out;
  }
  const epsU = POS_EPS_T / len;
  const ex = a.c.x - l.p0.x;
  const ey = a.c.y - l.p0.y;
  const h = Math.abs(dx * ey - dy * ex) / len; // 中心から直線までの距離
  if (h > a.r + POS_EPS_T) return [];
  const u0 = (ex * dx + ey * dy) / (len * len);
  if (Math.abs(h - a.r) <= POS_EPS_T) {
    if (u0 >= -epsU && u0 <= 1 + epsU) emit(clamp01(u0), true);
  } else {
    const du = Math.sqrt(a.r * a.r - h * h) / len;
    for (const u of [u0 - du, u0 + du]) if (u >= -epsU && u <= 1 + epsU) emit(clamp01(u), false);
  }
  return out;
}

function arcArc(a: ArcCurve, b: ArcCurve): CurveIntersection[] {
  const dx = b.c.x - a.c.x;
  const dy = b.c.y - a.c.y;
  const d = Math.hypot(dx, dy);
  if (d <= POS_EPS_T) {
    if (Math.abs(a.r - b.r) > POS_EPS_T) return [];
    return sameCircleOverlap(a, b);
  }
  const sumR = a.r + b.r;
  const difR = Math.abs(a.r - b.r);
  if (d > sumR + POS_EPS_T || d < difR - POS_EPS_T) return [];
  const out: CurveIntersection[] = [];
  const emit = (p: Vec2, tangent: boolean): void => {
    const t1 = arcParamOfAngle(a, Math.atan2(p.y - a.c.y, p.x - a.c.x));
    const t2 = arcParamOfAngle(b, Math.atan2(p.y - b.c.y, p.x - b.c.x));
    if (t1 === null || t2 === null) return;
    out.push(pointResult(p, t1, t2, tangent));
  };
  const ux = dx / d;
  const uy = dy / d;
  if (Math.abs(d - sumR) <= POS_EPS_T || Math.abs(d - difR) <= POS_EPS_T) {
    // 外接・内接: 1 点
    const sgn = d >= sumR - POS_EPS_T ? 1 : a.r >= b.r ? 1 : -1;
    emit({ x: a.c.x + ux * a.r * sgn, y: a.c.y + uy * a.r * sgn }, true);
  } else {
    const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
    const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
    const mx = a.c.x + ux * x;
    const my = a.c.y + uy * x;
    emit({ x: mx - uy * h, y: my + ux * h }, false);
    emit({ x: mx + uy * h, y: my - ux * h }, false);
  }
  return out.sort((p, q) => (p.kind === 'point' && q.kind === 'point' ? p.t1 - q.t1 : 0));
}

/** 同一円上の 2 円弧: 角度区間の共通部分（長さ 0 は端点接触の point） */
function sameCircleOverlap(a: ArcCurve, b: ArcCurve): CurveIntersection[] {
  const span1 = Math.abs(a.sweep);
  const dir1 = a.sweep >= 0 ? 1 : -1;
  const s2 = norm2pi(dir1 * (b.theta0 - a.theta0));
  const span2 = Math.abs(b.sweep);
  // b の区間を a の進行方向の角度座標で表す
  const [lo2, hi2] = b.sweep >= 0 === a.sweep >= 0 ? [s2, s2 + span2] : [s2 - span2, s2];
  const pieces: [number, number][] = [];
  for (const k of [-1, 0, 1]) {
    const lo = Math.max(0, lo2 + k * TWO_PI);
    const hi = Math.min(span1, hi2 + k * TWO_PI);
    if (hi >= lo - POS_EPS_T / a.r) pieces.push([lo, Math.max(lo, hi)]);
  }
  pieces.sort((p, q) => p[0] - q[0]);
  const out: CurveIntersection[] = [];
  const at = (ang: number): number => (span1 === 0 ? 0 : clamp01(ang / span1));
  for (const [lo, hi] of pieces) {
    const t1a = at(lo);
    const t1b = at(hi);
    const pa = evaluate(a, t1a);
    if ((hi - lo) * a.r <= POS_EPS_T) {
      out.push(pointResult(pa, t1a, closestPoint(b, pa).t, false));
    } else {
      const pb = evaluate(a, t1b);
      out.push({ kind: 'overlap', t1a, t1b, t2a: closestPoint(b, pa).t, t2b: closestPoint(b, pb).t });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 一般（細分 + Newton）

const SPLIT_SIZE_T = 0.01;
const MAX_CANDIDATES = 256;

function sameControlPoints(c1: Curve, c2: Curve): 'same' | 'reversed' | null {
  const pts = (c: Curve): Vec2[] | null => (c.kind === 'quad' ? [c.p0, c.p1, c.p2] : c.kind === 'cubic' ? [c.p0, c.p1, c.p2, c.p3] : c.kind === 'line' ? [c.p0, c.p1] : null);
  const a = pts(c1);
  const b = pts(c2);
  if (!a || !b || a.length !== b.length) return null;
  const eq = (p: Vec2[], q: Vec2[]) => p.every((v, i) => dist(v, q[i]!) <= POS_EPS_T);
  if (eq(a, b)) return 'same';
  if (eq(a, [...b].reverse())) return 'reversed';
  return null;
}

function intersectGeneral(c1: Curve, c2: Curve, tol: number): CurveIntersection[] {
  const same = sameControlPoints(c1, c2);
  if (same === 'same') return [{ kind: 'overlap', t1a: 0, t1b: 1, t2a: 0, t2b: 1 }];
  if (same === 'reversed') return [{ kind: 'overlap', t1a: 0, t1b: 1, t2a: 1, t2b: 0 }];

  const cands: [number, number][] = [];
  const sizeOf = (c: Curve): number => {
    const b = bbox(c);
    return Math.max(b.maxX - b.minX, b.maxY - b.minY);
  };
  const rec = (a: Curve, ta0: number, ta1: number, b: Curve, tb0: number, tb1: number, depth: number): void => {
    if (cands.length >= MAX_CANDIDATES) return;
    const ba = bboxExpand(bbox(a), tol);
    const bb = bboxExpand(bbox(b), tol);
    if (!bboxIntersects(ba, bb)) return;
    const sa = sizeOf(a);
    const sb = sizeOf(b);
    if ((sa <= SPLIT_SIZE_T && sb <= SPLIT_SIZE_T) || depth >= MAX_SUBDIV_DEPTH) {
      cands.push([(ta0 + ta1) / 2, (tb0 + tb1) / 2]);
      return;
    }
    const splitA = sa >= sb;
    if (splitA) {
      const [l, r] = split(a, 0.5);
      const tm = (ta0 + ta1) / 2;
      rec(l, ta0, tm, b, tb0, tb1, depth + 1);
      rec(r, tm, ta1, b, tb0, tb1, depth + 1);
    } else {
      const [l, r] = split(b, 0.5);
      const tm = (tb0 + tb1) / 2;
      rec(a, ta0, ta1, l, tb0, tm, depth + 1);
      rec(a, ta0, ta1, r, tm, tb1, depth + 1);
    }
  };
  rec(c1, 0, 1, c2, 0, 1, 0);

  const found: { p: Vec2; t1: number; t2: number; tangent: boolean }[] = [];
  for (const [s1, s2] of cands) {
    let t1 = s1;
    let t2 = s2;
    for (let it = 0; it < 80; it++) {
      const p = evaluate(c1, t1);
      const q = evaluate(c2, t2);
      const fx = p.x - q.x;
      const fy = p.y - q.y;
      const d1 = derivative(c1, t1);
      const d2 = derivative(c2, t2);
      // J = [d1, -d2]、最小二乗ステップ −(JᵀJ + λI)⁻¹ JᵀF
      const a11 = d1.x * d1.x + d1.y * d1.y + 1e-14;
      const a12 = -(d1.x * d2.x + d1.y * d2.y);
      const a22 = d2.x * d2.x + d2.y * d2.y + 1e-14;
      const g1 = d1.x * fx + d1.y * fy;
      const g2 = -(d2.x * fx + d2.y * fy);
      const det = a11 * a22 - a12 * a12;
      if (!(Math.abs(det) > 1e-300)) break;
      const dt1 = -(a22 * g1 - a12 * g2) / det;
      const dt2 = -(-a12 * g1 + a11 * g2) / det;
      const n1 = clamp01(t1 + dt1);
      const n2 = clamp01(t2 + dt2);
      const moved = Math.abs(n1 - t1) + Math.abs(n2 - t2);
      t1 = n1;
      t2 = n2;
      if (moved < 1e-15) break;
    }
    const p = evaluate(c1, t1);
    const q = evaluate(c2, t2);
    if (dist(p, q) > tol) continue;
    const d1 = derivative(c1, t1);
    const d2 = derivative(c2, t2);
    const l1 = Math.hypot(d1.x, d1.y);
    const l2 = Math.hypot(d2.x, d2.y);
    const sinAng = l1 > 0 && l2 > 0 ? Math.abs(d1.x * d2.y - d1.y * d2.x) / (l1 * l2) : 0;
    found.push({ p: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, t1, t2, tangent: sinAng < 1e-3 });
  }
  found.sort((x, y) => x.t1 - y.t1 || x.t2 - y.t2);
  const out: CurveIntersection[] = [];
  const merge = Math.max(tol * 10, 1e-5);
  const kept: typeof found = [];
  for (const f of found) {
    const prev = kept.find((k) => dist(k.p, f.p) <= merge);
    if (prev) {
      prev.tangent = prev.tangent || f.tangent;
    } else kept.push({ ...f });
  }
  for (const k of kept) out.push(pointResult(k.p, k.t1, k.t2, k.tangent));
  return out;
}

/** 2 曲線の交差。tol は点の一致・収束判定（タイル、既定 POS_EPS_T） */
export function intersectCurves(c1: Curve, c2: Curve, tol: number = POS_EPS_T): CurveIntersection[] {
  let res: CurveIntersection[];
  if (c1.kind === 'line' && c2.kind === 'line') res = lineLine(c1, c2);
  else if (c1.kind === 'line' && c2.kind === 'arc') res = lineArc(c1, c2, true);
  else if (c1.kind === 'arc' && c2.kind === 'line') res = lineArc(c2, c1, false);
  else if (c1.kind === 'arc' && c2.kind === 'arc') res = arcArc(c1, c2);
  else res = intersectGeneral(c1, c2, tol);
  return dedupeSorted(res, tol);
}

const keyT1 = (r: CurveIntersection): number => (r.kind === 'point' ? r.t1 : r.t1a);

/** t1 昇順に整列し、同じ点（距離 ≤ tol）を 1 つにまとめる（tangent は論理和） */
function dedupeSorted(list: CurveIntersection[], tol: number): CurveIntersection[] {
  const sorted = [...list].sort((a, b) => keyT1(a) - keyT1(b) || (a.kind === 'point' ? 0 : 1) - (b.kind === 'point' ? 0 : 1));
  const out: CurveIntersection[] = [];
  for (const r of sorted) {
    const dup = r.kind === 'point' ? out.find((o) => o.kind === 'point' && dist(o.p, r.p) <= tol) : undefined;
    if (dup && dup.kind === 'point' && r.kind === 'point') {
      if (r.tangent && !dup.tangent) (dup as { tangent?: true }).tangent = true;
      continue;
    }
    out.push(r);
  }
  return out;
}
