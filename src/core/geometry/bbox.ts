/** 軸平行境界ボックス（AABB） */
import type { Vec2 } from './vec';

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 点列の境界ボックス。空なら null */
export function bboxOf(points: readonly Vec2[]): Bbox | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export const bboxUnion = (a: Bbox, b: Bbox): Bbox => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
});

export const bboxExpand = (a: Bbox, d: number): Bbox => ({ minX: a.minX - d, minY: a.minY - d, maxX: a.maxX + d, maxY: a.maxY + d });

/** 接触（辺・角が触れるだけ）も交差とみなす */
export const bboxIntersects = (a: Bbox, b: Bbox): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

export const bboxContainsPoint = (a: Bbox, p: Vec2): boolean => p.x >= a.minX && p.x <= a.maxX && p.y >= a.minY && p.y <= a.maxY;
