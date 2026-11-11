import {
  RUNWAY_HALF_WIDTH,
  RUNWAY_MIN_LENGTH_M,
  RUNWAY_WIDTH_CLASS,
  STRIP_END_EXTENSION,
  STRIP_HALF_WIDTH,
  TILE_M,
} from '../model/catalog';
import type { Heading, Runway, SizeClass } from '../model/types';
import { minSize } from '../model/types';
import { GRID8_STEP } from '../geometry/angle';
import type { WorldPoint } from '../geometry/frames';
import { rectAlongDir } from '../geometry/stroke';
import { length, pointOnSegmentInterior, sameTile, type Tile, type Vec2 } from '../geometry/vec';

/** 方位 → 1ステップのタイル差分（0 = 北 = -y）。整数表 `GRID8_STEP` の引き当て */
export function headingVector(h: Heading): Tile {
  return GRID8_STEP[h];
}

export function runwayEnd(r: Pick<Runway, 'start' | 'heading' | 'length'>): Tile {
  const v = headingVector(r.heading);
  return { x: r.start.x + v.x * r.length, y: r.start.y + v.y * r.length };
}

export function runwayMidpoint(r: Runway): Vec2 {
  const e = runwayEnd(r);
  return { x: (r.start.x + e.x) / 2, y: (r.start.y + e.y) / 2 };
}

/** 実長（m） */
export function runwayLengthM(r: Pick<Runway, 'heading' | 'length'>): number {
  return Math.round(r.length * length(headingVector(r.heading)) * TILE_M);
}

/** 長さのみで決まる対応区分（短すぎる場合 null） */
export function runwayLengthClass(r: Pick<Runway, 'heading' | 'length'>): SizeClass | null {
  const m = runwayLengthM(r);
  if (m >= RUNWAY_MIN_LENGTH_M.L) return 'L';
  if (m >= RUNWAY_MIN_LENGTH_M.M) return 'M';
  if (m >= RUNWAY_MIN_LENGTH_M.S) return 'S';
  return null;
}

/** 長さ・幅の両方から決まる、使用可能な最大機体区分（使用不可なら null） */
export function runwayMaxSize(r: Pick<Runway, 'heading' | 'length' | 'surfaceWidthM'>): SizeClass | null {
  const byLength = runwayLengthClass(r);
  if (!byLength) return null;
  return minSize(byLength, RUNWAY_WIDTH_CLASS[r.surfaceWidthM]);
}

/** 滑走路番号（例: "09/27"）。始点側の番号が先 */
export function runwayDesignators(heading: Heading): [string, string] {
  const fmt = (deg: number) => {
    const n = Math.round(deg / 10) % 36;
    return String(n === 0 ? 36 : n).padStart(2, '0');
  };
  return [fmt(heading), fmt((heading + 180) % 360)];
}

/** 中心線方向に extend、直交方向に halfWidth だけ広げた矩形（タイル番号空間）。演算順は従来と同一 */
function runwayRect(r: Runway, halfWidth: number, extend: number): Vec2[] {
  const { start, end, dir } = runwayAxis(r);
  return rectAlongDir(start, end, dir, halfWidth, extend);
}

/** 滑走路中心線の幾何（World フレーム）。従来形（8 方位）のみ対応 */
export interface RunwayAxis {
  start: WorldPoint;
  end: WorldPoint;
  /** 始点 → 終点の単位方向 */
  dir: Vec2;
  /** 真方位（度、[0, 360)） */
  trueHeadingDeg: number;
  /** 長さ（タイル）。丸めなし（端点間の距離。斜めは √2 倍） */
  lengthT: number;
  /** 実長（m、四捨五入）。`runwayLengthM` と同じ */
  lengthM: number;
}

export function runwayAxis(r: Runway): RunwayAxis {
  const v = headingVector(r.heading);
  const len = length(v);
  const end = runwayEnd(r);
  return {
    start: { x: r.start.x, y: r.start.y },
    end,
    dir: { x: v.x / len, y: v.y / len },
    trueHeadingDeg: r.heading,
    lengthT: r.length * len,
    lengthM: runwayLengthM(r),
  };
}

export function runwayPolygon(r: Runway): Vec2[] {
  return runwayRect(r, RUNWAY_HALF_WIDTH, 0.5);
}

/** 滑走路保護区域（着陸帯）。誘導路以外の施設は置けない */
export function runwayStripPolygon(r: Runway): Vec2[] {
  return runwayRect(r, STRIP_HALF_WIDTH, STRIP_END_EXTENSION);
}

/**
 * 点が滑走路中心線上（端点を含む）にあれば、始点からの位置 t (0..1) を返す。
 */
export function positionOnRunway(r: Runway, p: Tile): number | null {
  const e = runwayEnd(r);
  if (sameTile(p, r.start)) return 0;
  if (sameTile(p, e)) return 1;
  return pointOnSegmentInterior(p, r.start, e);
}
