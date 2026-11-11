import { TILE_M } from '../model/catalog';
import { FREE_RUNWAY_DEFAULTS, type DefaultDims } from '../model/runwayReference';
import type { RunwayFree } from '../model/types';
import type { WorldPoint } from '../geometry/frames';
import { rectAlongDir } from '../geometry/stroke';
import { runwayAxis } from './runway';

/** 自由形の実寸（欠落はゲーム既定値で補う）。m */
export function resolveRunwayDims(r: RunwayFree): DefaultDims {
  const d = FREE_RUNWAY_DEFAULTS[r.surfaceWidthM];
  const o = r.dims ?? {};
  return {
    shoulderWidthM: o.shoulderWidthM ?? d.shoulderWidthM,
    stripHalfWidthM: o.stripHalfWidthM ?? d.stripHalfWidthM,
    stripEndM: o.stripEndM ?? d.stripEndM,
    resaLengthM: o.resaLengthM ?? d.resaLengthM,
    resaWidthM: o.resaWidthM ?? d.resaWidthM,
    holdingPositionM: o.holdingPositionM ?? d.holdingPositionM,
  };
}

export interface RunwayAreas {
  /** 舗装（滑走路の幅 × 長さ） */
  pavement: WorldPoint[];
  /** 舗装 + 肩 */
  paved: WorldPoint[];
  /** 着陸帯（半幅 stripHalfWidthM、両端に stripEndM 延長） */
  strip: WorldPoint[];
  /** RESA（着陸帯の両端から外側へ resaLengthM、全幅 resaWidthM）。長さ 0 なら空 */
  resa: WorldPoint[][];
}

/**
 * 自由形の領域（World フレーム、タイル単位。すべて凸の 4 角形）。
 * 値はゲーム既定値（`FREE_RUNWAY_DEFAULTS`）または `dims` の上書き。
 */
export function runwayAreas(r: RunwayFree): RunwayAreas {
  const { start, end, dir } = runwayAxis(r);
  const d = resolveRunwayDims(r);
  const t = (m: number): number => m / TILE_M;
  const pavement = rectAlongDir(start, end, dir, t(r.surfaceWidthM / 2), 0);
  const paved = rectAlongDir(start, end, dir, t(r.surfaceWidthM / 2 + d.shoulderWidthM), 0);
  const strip = rectAlongDir(start, end, dir, t(d.stripHalfWidthM), t(d.stripEndM));
  const resa: WorldPoint[][] = [];
  if (d.resaLengthM > 0) {
    const hw = t(d.resaWidthM / 2);
    const s0 = { x: start.x - dir.x * t(d.stripEndM), y: start.y - dir.y * t(d.stripEndM) };
    const s1 = { x: s0.x - dir.x * t(d.resaLengthM), y: s0.y - dir.y * t(d.resaLengthM) };
    const e0 = { x: end.x + dir.x * t(d.stripEndM), y: end.y + dir.y * t(d.stripEndM) };
    const e1 = { x: e0.x + dir.x * t(d.resaLengthM), y: e0.y + dir.y * t(d.resaLengthM) };
    resa.push(rectAlongDir(s1, s0, dir, hw, 0), rectAlongDir(e0, e1, dir, hw, 0));
  }
  return { pavement, paved, strip, resa };
}
