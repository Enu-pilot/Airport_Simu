/**
 * 描画用の面の形状。World フレーム・タイル単位で生成し、2D（worldToMap）と 3D（worldToScene）は
 * 変換して描くだけにする（形状を 2D と 3D で別々に作らない）。
 *
 * - 滑走路の舗装・着陸帯は、現行の占有フットプリント（runwayPolygon / runwayStripPolygon）と同じ形。
 *   実寸の舗装（Phase 12）はここに追加する。
 * - 誘導路・道路の帯は、ノード間の中心線を幅 widthM（m）で太らせ、両端を半幅だけ延ばした矩形。
 */
import { ROAD_DRAW_WIDTH_M, TAXIWAY_DRAW_WIDTH_M } from '../model/catalog';
import type { Runway, SizeClass } from '../model/types';
import { mToTiles, type WorldPoint } from '../geometry/frames';
import { rectAlong } from '../geometry/stroke';
import { runwayPolygon, runwayStripPolygon } from './runway';

/** 誘導路の描画幅（m）。codeF は幅区分より優先 */
export function taxiwayDrawWidthM(e: { widthClass: SizeClass; codeF?: boolean }): number {
  return e.codeF ? TAXIWAY_DRAW_WIDTH_M.codeF : TAXIWAY_DRAW_WIDTH_M[e.widthClass];
}

/** 道路・鉄道の描画幅（m） */
export function roadDrawWidthM(e: { roadClass: string }): number {
  return e.roadClass === 'rail' ? ROAD_DRAW_WIDTH_M.rail : ROAD_DRAW_WIDTH_M.road;
}

/** 滑走路の舗装面（World フレーム、4 頂点） */
export function runwayPavementSurface(r: Runway): WorldPoint[] {
  return runwayPolygon(r);
}

/** 滑走路の着陸帯（World フレーム、4 頂点） */
export function runwayStripSurface(r: Runway): WorldPoint[] {
  return runwayStripPolygon(r);
}

/** a → b の帯（幅 widthM、両端を半幅だけ延ばす）。a = b なら空配列 */
export function bandSurface(a: WorldPoint, b: WorldPoint, widthM: number): WorldPoint[] {
  const half = mToTiles(widthM) / 2;
  return rectAlong(a, b, half, half);
}

export function taxiwayBandSurface(a: WorldPoint, b: WorldPoint, e: { widthClass: SizeClass; codeF?: boolean }): WorldPoint[] {
  return bandSurface(a, b, taxiwayDrawWidthM(e));
}

export function roadBandSurface(a: WorldPoint, b: WorldPoint, e: { roadClass: string }): WorldPoint[] {
  return bandSurface(a, b, roadDrawWidthM(e));
}
