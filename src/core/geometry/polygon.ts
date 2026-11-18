/**
 * 多角形の述語（新 API）。頂点は World フレーム（タイル単位）。
 * 接触（辺・点が触れるだけ）は「重ならない」。単純多角形（自己交差なし）を前提とする。
 */
import { bboxIntersects, bboxOf } from './bbox';
import { classifySegmentIntersection, closestPointOnSegment } from './segment';
import { POS_EPS_T } from './tolerance';
import { pointInPolygon, type Vec2 } from './vec';

/** 符号付き面積（靴ひも公式）。正 = 反時計回り（数学座標）= y 下向きの画面では時計回り */
export function signedArea(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += poly[j]!.x * poly[i]!.y - poly[i]!.x * poly[j]!.y;
  }
  return s / 2;
}

/** 巻き方向（画面 = y 下向きでの見え方）。面積 0 は 'degenerate' */
export function orientation(poly: readonly Vec2[]): 'cw' | 'ccw' | 'degenerate' {
  const a = signedArea(poly);
  return a > 0 ? 'cw' : a < 0 ? 'ccw' : 'degenerate';
}

/** 凸多角形か（共線の頂点は許容）。3 頂点未満は false */
export function isConvex(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const c = poly[(i + 2) % n]!;
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) <= 1e-12) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

function project(poly: readonly Vec2[], ax: number, ay: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    const v = p.x * ax + p.y * ay;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/**
 * 凸多角形 A, B の分離軸定理による最小貫入量（軸ごとの射影の重なりの最小値）。
 * 正 = 重なっている（その量だけ貫入）、0 以下 = 離れている／接触。
 */
export function satPenetration(A: readonly Vec2[], B: readonly Vec2[]): number {
  let best = Infinity;
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      const l = Math.hypot(ex, ey);
      if (l === 0) continue;
      const ax = -ey / l;
      const ay = ex / l;
      const [a0, a1] = project(A, ax, ay);
      const [b0, b1] = project(B, ax, ay);
      const o = Math.min(a1, b1) - Math.max(a0, b0);
      if (o < best) best = o;
    }
  }
  return best;
}

/** 凸多角形どうしの重なり。接触（貫入 ≤ POS_EPS_T）は false */
export function satOverlapConvex(A: readonly Vec2[], B: readonly Vec2[]): boolean {
  return satPenetration(A, B) > POS_EPS_T;
}

/** 点が境界上（許容 POS_EPS_T）にあるか */
export function onPolygonBoundary(poly: readonly Vec2[], p: Vec2): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (closestPointOnSegment(p, poly[j]!, poly[i]!).dist <= POS_EPS_T) return true;
  }
  return false;
}

/** 点の包含（既定: 境界上は含まない） */
export function polygonContains(poly: readonly Vec2[], p: Vec2, includeBoundary = false): boolean {
  if (onPolygonBoundary(poly, p)) return includeBoundary;
  return pointInPolygon(p, poly);
}

/** A の境界を B の境界との交点で分割した小区間の（中点, 内側へ少しずらした点）を、内側にずらした点が B の内部かで判定 */
function boundaryInsideOther(A: readonly Vec2[], B: readonly Vec2[], inwardSign: number): boolean {
  const delta = POS_EPS_T * 10;
  const nA = A.length;
  const nB = B.length;
  for (let i = 0; i < nA; i++) {
    const a = A[i]!;
    const b = A[(i + 1) % nA]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= POS_EPS_T) continue;
    const ts: number[] = [0, 1];
    for (let j = 0; j < nB; j++) {
      const r = classifySegmentIntersection(a, b, B[j]!, B[(j + 1) % nB]!);
      if (r.kind === 'point') ts.push(r.t);
      else if (r.kind === 'overlap') ts.push(r.t0, r.t1);
    }
    ts.sort((x, y) => x - y);
    // 内向き法線（面積符号に依存）
    const nx = (-dy / len) * inwardSign;
    const ny = (dx / len) * inwardSign;
    for (let k = 0; k + 1 < ts.length; k++) {
      if ((ts[k + 1]! - ts[k]!) * len <= POS_EPS_T) continue;
      const tm = (ts[k]! + ts[k + 1]!) / 2;
      const q = { x: a.x + dx * tm + nx * delta, y: a.y + dy * tm + ny * delta };
      if (pointInPolygon(q, B) && !onPolygonBoundary(B, q)) return true;
    }
  }
  return false;
}

/**
 * 一般の（非凸でもよい）単純多角形どうしの重なり。境界の接触は false。
 * bbox → 境界を交点で分割した小区間の内側点が相手の内部にあるか（双方向）で判定する。
 * 境界を共有して同じ側に広がる（同一・片方が他方に含まれ辺を共有）場合も true。
 */
export function polygonsOverlap(A: readonly Vec2[], B: readonly Vec2[]): boolean {
  if (A.length < 3 || B.length < 3) return false;
  const ba = bboxOf(A);
  const bb = bboxOf(B);
  if (!ba || !bb || !bboxIntersects(ba, bb)) return false;
  const sa = signedArea(A) >= 0 ? 1 : -1;
  const sb = signedArea(B) >= 0 ? 1 : -1;
  // 左法線 (-dy, dx) が内側になるのは面積が正のとき
  return boundaryInsideOther(A, B, sa) || boundaryInsideOther(B, A, sb);
}

const isFinitePoint = (p: Vec2): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

function segSegDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const r = classifySegmentIntersection(a, b, c, d);
  if (r.kind !== 'none') return 0;
  return Math.min(
    closestPointOnSegment(a, c, d).dist,
    closestPointOnSegment(b, c, d).dist,
    closestPointOnSegment(c, a, b).dist,
    closestPointOnSegment(d, a, b).dist,
  );
}

/** 2 多角形の最小距離（重なる・接する・包含は 0）。クリアランス用。非有限の頂点を含むなら NaN */
export function polygonMinDistance(A: readonly Vec2[], B: readonly Vec2[]): number {
  if (A.length === 0 || B.length === 0) return Infinity;
  if (!A.every(isFinitePoint) || !B.every(isFinitePoint)) return NaN;
  if (polygonContains(B, A[0]!, true) || polygonContains(A, B[0]!, true)) return 0;
  let best = Infinity;
  for (let i = 0; i < A.length; i++) {
    const a = A[i]!;
    const b = A[(i + 1) % A.length]!;
    for (let j = 0; j < B.length; j++) {
      const d = segSegDist(a, b, B[j]!, B[(j + 1) % B.length]!);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 直交ポリゴン（5-15: ターミナル建物の複雑形状）                        */
/* ------------------------------------------------------------------ */

export type OrthogonalPolygonIssue =
  | 'tooFewPoints'
  | 'nonInteger'
  | 'nonOrthogonal'
  | 'zeroLengthEdge'
  | 'duplicatePoint'
  | 'selfIntersecting'
  | 'zeroArea';

/** 2 区間（軸平行）の交差判定（端点共有を含む） */
function segmentsTouchOrCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abH = a.y === b.y;
  const cdH = c.y === d.y;
  if (abH && cdH) {
    if (a.y !== c.y) return false;
    return Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
  }
  if (!abH && !cdH) {
    if (a.x !== c.x) return false;
    return Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
  }
  const h = abH ? [a, b] : [c, d];
  const v = abH ? [c, d] : [a, b];
  const x = v[0]!.x;
  const y = h[0]!.y;
  return x >= Math.min(h[0]!.x, h[1]!.x) && x <= Math.max(h[0]!.x, h[1]!.x)
    && y >= Math.min(v[0]!.y, v[1]!.y) && y <= Math.max(v[0]!.y, v[1]!.y);
}

/**
 * 直交ポリゴンの検証。頂点はタイル境界の整数座標、辺は軸平行、単純（自己交差なし）、
 * 面積 > 0 を要求する。凹形は許可する。曲線・穴・複数島は対象外。
 */
export function validateOrthogonalPolygon(points: readonly Vec2[]): OrthogonalPolygonIssue[] {
  const issues: OrthogonalPolygonIssue[] = [];
  if (points.length < 4) return ['tooFewPoints'];
  if (points.some((p) => !Number.isInteger(p.x) || !Number.isInteger(p.y))) issues.push('nonInteger');
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    if (a.x === b.x && a.y === b.y) issues.push('duplicatePoint');
    else if (a.x !== b.x && a.y !== b.y) issues.push('nonOrthogonal');
  }
  if (issues.length > 0) return [...new Set(issues)];
  // 自己交差: 隣接しない辺同士が触れたり交わったりしてはならない
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // 始点と終点の辺は隣接
      if (segmentsTouchOrCross(points[i]!, points[(i + 1) % n]!, points[j]!, points[(j + 1) % n]!)) {
        issues.push('selfIntersecting');
      }
    }
  }
  if (Math.abs(signedArea(points)) <= 0) issues.push('zeroArea');
  return [...new Set(issues)];
}

/** 矩形の外周リング（CCW） */
export function rectRing(origin: Vec2, w: number, h: number): Vec2[] {
  return [
    { x: origin.x, y: origin.y },
    { x: origin.x + w, y: origin.y },
    { x: origin.x + w, y: origin.y + h },
    { x: origin.x, y: origin.y + h },
  ];
}

/**
 * 直交ポリゴンが占有するタイル。規則: タイル中心がポリゴン内部にあるタイルを占有する。
 * 頂点が整数座標のため、タイル中心（.5 座標）が境界上に来ることはない。
 */
export function orthogonalPolygonTiles(points: readonly Vec2[]): { x: number; y: number }[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const out: { x: number; y: number }[] = [];
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      if (polygonContains(points, { x: x + 0.5, y: y + 0.5 })) out.push({ x, y });
    }
  }
  return out;
}
