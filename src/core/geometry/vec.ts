/**
 * 幾何ユーティリティ。
 *
 * 座標系: タイル (i, j) は世界座標 [i, i+1) × [j, j+1) を占め、中心は (i+0.5, j+0.5)。
 * ネットワークのノード・滑走路端点は「タイル中心」に置くため、ノード同士の幾何計算は
 * タイル番号（整数）のまま行う（平行移動しても交差・距離の判定は変わらない）。
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** 整数タイル座標 */
export type Tile = Vec2;

export const EPS = 1e-9;

export const tileKey = (x: number, y: number): string => `${x},${y}`;

export const sameTile = (a: Tile, b: Tile): boolean => a.x === b.x && a.y === b.y;

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 点と線分の距離と、線分上の射影位置 t (0..1 にクランプ) */
export function distPointSegment(p: Vec2, a: Vec2, b: Vec2): { dist: number; t: number } {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < EPS) return { dist: distance(p, a), t: 0 };
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  return { dist: distance(p, add(a, scale(ab, t))), t };
}

/** 点が線分の内部（端点を除く）にあるか。あれば射影位置 t を返す */
export function pointOnSegmentInterior(p: Vec2, a: Vec2, b: Vec2): number | null {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < EPS) return null;
  if (Math.abs(cross(ab, sub(p, a))) > 1e-7 * Math.sqrt(len2)) return null;
  const t = dot(sub(p, a), ab) / len2;
  return t > EPS && t < 1 - EPS ? t : null;
}

/**
 * 2線分の「両方の内部」で交わる真の交差点。平行・共線・端点接触は null。
 * t: ab 上の位置, u: cd 上の位置
 */
export function segmentIntersection(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): { point: Vec2; t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return null;
  const ca = sub(c, a);
  const t = cross(ca, s) / denom;
  const u = cross(ca, r) / denom;
  if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return null;
  return { point: add(a, scale(r, t)), t, u };
}

export function isIntegerPoint(p: Vec2): boolean {
  return Math.abs(p.x - Math.round(p.x)) < 1e-7 && Math.abs(p.y - Math.round(p.y)) < 1e-7;
}

export function roundPoint(p: Vec2): Tile {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** 偶奇規則による点の多角形内判定 */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }
  return inside;
}

export { rasterizePolygon, rasterizeSegment } from './raster';

/** from から見て to を8方向（水平・垂直・45度）のいずれかにスナップする */
export function snapToOctant(from: Tile, to: Tile): Tile {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return { ...from };
  const angle = Math.atan2(dy, dx);
  const oct = Math.round(angle / (Math.PI / 4));
  const ux = Math.round(Math.cos(oct * (Math.PI / 4)));
  const uy = Math.round(Math.sin(oct * (Math.PI / 4)));
  // 斜めは軸ごとのステップ数、軸方向はその軸の距離
  const steps =
    ux !== 0 && uy !== 0
      ? Math.round((Math.abs(dx) + Math.abs(dy)) / 2)
      : Math.round(Math.abs(ux !== 0 ? dx : dy));
  return { x: from.x + ux * steps, y: from.y + uy * steps };
}

/** 2つのタイル集合の最小チェビシェフ距離（隣接 = 1） */
export function chebyshevDistance(a: readonly Tile[], b: readonly Tile[]): number {
  let best = Infinity;
  for (const p of a) {
    for (const q of b) {
      const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- Phase 11 追加（既存関数は変更しない）

export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** 単位ベクトル。零ベクトルは (0, 0) */
export function normalize(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** 左 90° 回転した直交ベクトル `(-y, x)`（World フレームでは画面上で時計回りに 90°） */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

/** 原点まわりに rad だけ回転（数学角。y 下向きの World では画面上で時計回り） */
export function rotate(a: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** 2 点が許容誤差内で一致するか（既定 1e-6 タイル） */
export const nearlyEqualPoint = (a: Vec2, b: Vec2, eps = 1e-6): boolean => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
