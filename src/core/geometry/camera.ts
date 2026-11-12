import { worldToMap } from './frames';
import type { Tile, Vec2 } from './vec';

/**
 * カメラ: 画面左上に対応する世界座標 (x, y) と、1タイルあたりのピクセル数 zoom。
 * 世界座標の単位はタイル。
 */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 3;
export const MAX_ZOOM = 64;

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function worldToScreen(cam: Camera, p: Vec2): Vec2 {
  return { x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom };
}

export function screenToWorld(cam: Camera, s: Vec2): Vec2 {
  return { x: s.x / cam.zoom + cam.x, y: s.y / cam.zoom + cam.y };
}

/** 画面座標が指すタイル */
export function screenToTile(cam: Camera, s: Vec2): Tile {
  const w = screenToWorld(cam, s);
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
}

/** タイル中心の世界座標 */
export function tileCenter(t: Tile): Vec2 {
  return worldToMap(t);
}

/** 画面上の点 anchor を固定したままズームする */
export function zoomAt(cam: Camera, anchor: Vec2, newZoom: number): Camera {
  const zoom = clampZoom(newZoom);
  const w = screenToWorld(cam, anchor);
  return { zoom, x: w.x - anchor.x / zoom, y: w.y - anchor.y / zoom };
}

/** 画面上でのドラッグ量（ピクセル）だけパンする */
export function panBy(cam: Camera, dxPx: number, dyPx: number): Camera {
  return { ...cam, x: cam.x - dxPx / cam.zoom, y: cam.y - dyPx / cam.zoom };
}

/** 世界座標の点を画面中央に表示する */
export function centerOn(cam: Camera, p: Vec2, viewW: number, viewH: number): Camera {
  return { ...cam, x: p.x - viewW / 2 / cam.zoom, y: p.y - viewH / 2 / cam.zoom };
}
