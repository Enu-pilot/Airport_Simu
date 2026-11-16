import { tileKey, type Tile } from '../geometry/vec';
import type { AirportLayout } from '../model/types';
import { facilityTiles } from './footprint';

/**
 * 建物内の階に関する規則（純粋関数・1-04）。
 * コアの失敗コード（`INVALID_VALUE`）と戻り値の形は変えず、エディタが「なぜ置けないか」を導くために使う。
 */

/** 内部設備の階の範囲: 地下 5 階（-5）から、親の階数 − 1 まで */
export const INTERIOR_MIN_FLOOR = -5;

export type PlacementProblem = 'floorOutOfRange' | 'outsideParent';

const levelsOf = (layout: AirportLayout, facilityId: string): number => Number(layout.facilities[facilityId]?.props.levels ?? 1);

/** 親（建物）の中に、指定の階・タイルで内部設備を置けない理由。置けるなら null（親が無いときも null＝コアの判定に任せる） */
export function interiorPlacementProblem(layout: AirportLayout, parentId: string, floorIndex: number, tiles: readonly Tile[]): PlacementProblem | null {
  const parent = layout.facilities[parentId];
  if (!parent) return null;
  if (!Number.isInteger(floorIndex) || floorIndex < INTERIOR_MIN_FLOOR || floorIndex >= levelsOf(layout, parentId)) return 'floorOutOfRange';
  const inside = new Set(facilityTiles(parent).map((t) => tileKey(t.x, t.y)));
  return tiles.every((t) => inside.has(tileKey(t.x, t.y))) ? null : 'outsideParent';
}

/** ターミナルのエリアを、指定の階に置けない理由。置けるなら null（階は 0 から階数 − 1） */
export function terminalAreaLevelProblem(layout: AirportLayout, terminalId: string, level: number): 'floorOutOfRange' | null {
  if (!layout.facilities[terminalId]) return null;
  return Number.isInteger(level) && level >= 0 && level < levelsOf(layout, terminalId) ? null : 'floorOutOfRange';
}

/** 階数を newLevels に減らすと、範囲外になる階に、エリア（terminalAreas）または建物内の設備があるか */
export function levelsInUse(layout: AirportLayout, facilityId: string, newLevels: number): boolean {
  if (Object.values(layout.terminalAreas).some((a) => a.terminalId === facilityId && a.level >= newLevels)) return true;
  return Object.values(layout.facilities).some((f) => f.parentFacilityId === facilityId && (f.floorIndex ?? 0) >= newLevels);
}

/** 親の階数に対して、その階が存在するか（階の選択肢の注記用） */
export function floorExistsInParent(layout: AirportLayout, parentId: string, floorIndex: number): boolean {
  return interiorPlacementProblem(layout, parentId, floorIndex, []) === null;
}
