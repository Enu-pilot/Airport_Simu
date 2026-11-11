/**
 * 線分の分類付き交差と最近点（新 API。既存 `segmentIntersection` とは別物で、
 * 端点接触・共線重なり・平行を「分類して返す」。意味づけは呼び出し側が行う）。
 */
import { ANGLE_EPS_RAD, POS_EPS_T } from './tolerance';
import { cross, dot, sub, type Vec2 } from './vec';

export type SegmentIntersection =
  | { kind: 'none' }
  /** 1 点で交わる。t: ab 上、u: cd 上の位置 (0..1)。atEndA/atEndB: その点が ab/cd の端点（許容内）か */
  | { kind: 'point'; p: Vec2; t: number; u: number; atEndA: boolean; atEndB: boolean }
  /** 共線で長さを持って重なる。t0..t1 は ab 上、u0..u1 は同じ点に対応する cd 上の位置（t0 < t1） */
  | { kind: 'overlap'; t0: number; t1: number; u0: number; u1: number };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 点 p の線分 ab 上の位置 t (0..1 にクランプ)・最近点・距離。ab が縮退していれば t = 0 */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; p: Vec2; dist: number } {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 === 0 ? 0 : clamp01(dot(sub(p, a), ab) / len2);
  const q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { t, p: q, dist: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** 縮退（長さ ≤ POS_EPS_T）した線分と、もう一方の線分の交差。`swap` は縮退側が cd のとき */
function pointVsSegment(pt: Vec2, a: Vec2, b: Vec2, swap: boolean): SegmentIntersection {
  const cp = closestPointOnSegment(pt, a, b);
  if (cp.dist > POS_EPS_T) return { kind: 'none' };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const eps = len > 0 ? POS_EPS_T / len : 1;
  const atEnd = cp.t <= eps || cp.t >= 1 - eps || len === 0;
  return swap
    ? { kind: 'point', p: pt, t: cp.t, u: 0, atEndA: atEnd, atEndB: true }
    : { kind: 'point', p: pt, t: 0, u: cp.t, atEndA: true, atEndB: atEnd };
}

/**
 * 線分 ab と cd の交差を分類する。
 * - 長さで正規化した外積が ANGLE_EPS_RAD 以下なら平行（共線かは cd 端点と直線 ab の距離 ≤ POS_EPS_T で判定）
 * - 端点判定はパラメータ許容 POS_EPS_T / 線分長
 * - 長さ ≤ POS_EPS_T の線分は点として扱う
 */
export function classifySegmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): SegmentIntersection {
  const r = sub(b, a);
  const s = sub(d, c);
  const lr = Math.hypot(r.x, r.y);
  const ls = Math.hypot(s.x, s.y);
  const degA = lr <= POS_EPS_T;
  const degB = ls <= POS_EPS_T;
  if (degA && degB) {
    return Math.hypot(c.x - a.x, c.y - a.y) <= POS_EPS_T
      ? { kind: 'point', p: { ...a }, t: 0, u: 0, atEndA: true, atEndB: true }
      : { kind: 'none' };
  }
  if (degA) return pointVsSegment(a, c, d, false);
  if (degB) return pointVsSegment(c, a, b, true);

  const denom = cross(r, s);
  const epsT = POS_EPS_T / lr;
  const epsU = POS_EPS_T / ls;

  if (Math.abs(denom) <= ANGLE_EPS_RAD * lr * ls) {
    // 平行。直線 ab からの cd 端点の距離で共線か判定
    const dist = Math.abs(cross(r, sub(c, a))) / lr;
    if (dist > POS_EPS_T) return { kind: 'none' };
    const tc = dot(sub(c, a), r) / (lr * lr);
    const td = dot(sub(d, a), r) / (lr * lr);
    const lo = Math.max(0, Math.min(tc, td));
    const hi = Math.min(1, Math.max(tc, td));
    if (hi < lo - epsT) return { kind: 'none' };
    // u（cd 上の位置）: t ∈ ab 上の位置に対応する cd 上の位置
    const uAt = (t: number): number => clamp01(dot(sub({ x: a.x + r.x * t, y: a.y + r.y * t }, c), s) / (ls * ls));
    if ((hi - lo) * lr <= POS_EPS_T) {
      const t = clamp01((lo + hi) / 2);
      const u = uAt(t);
      return {
        kind: 'point',
        p: { x: a.x + r.x * t, y: a.y + r.y * t },
        t,
        u,
        atEndA: t <= epsT || t >= 1 - epsT,
        atEndB: u <= epsU || u >= 1 - epsU,
      };
    }
    return { kind: 'overlap', t0: lo, t1: hi, u0: uAt(lo), u1: uAt(hi) };
  }

  const ca = sub(c, a);
  const t = cross(ca, s) / denom;
  const u = cross(ca, r) / denom;
  if (t < -epsT || t > 1 + epsT || u < -epsU || u > 1 + epsU) return { kind: 'none' };
  const tc = clamp01(t);
  const uc = clamp01(u);
  return {
    kind: 'point',
    p: { x: a.x + r.x * tc, y: a.y + r.y * tc },
    t: tc,
    u: uc,
    atEndA: tc <= epsT || tc >= 1 - epsT,
    atEndB: uc <= epsU || uc >= 1 - epsU,
  };
}
