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
import { length, pointOnSegmentInterior, sameTile, type Tile, type Vec2 } from '../geometry/vec';

/** 方位 → 1ステップのタイル差分（0 = 北 = -y） */
export function headingVector(h: Heading): Tile {
  const rad = (h * Math.PI) / 180;
  return { x: Math.round(Math.sin(rad)), y: Math.round(-Math.cos(rad)) };
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

/** 中心線方向に extend、直交方向に halfWidth だけ広げた矩形（タイル番号空間） */
function runwayRect(r: Runway, halfWidth: number, extend: number): Vec2[] {
  const v = headingVector(r.heading);
  const len = length(v);
  const u = { x: v.x / len, y: v.y / len };
  const n = { x: -u.y, y: u.x };
  const s = r.start;
  const e = runwayEnd(r);
  const a = { x: s.x - u.x * extend, y: s.y - u.y * extend };
  const b = { x: e.x + u.x * extend, y: e.y + u.y * extend };
  return [
    { x: a.x + n.x * halfWidth, y: a.y + n.y * halfWidth },
    { x: b.x + n.x * halfWidth, y: b.y + n.y * halfWidth },
    { x: b.x - n.x * halfWidth, y: b.y - n.y * halfWidth },
    { x: a.x - n.x * halfWidth, y: a.y - n.y * halfWidth },
  ];
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
