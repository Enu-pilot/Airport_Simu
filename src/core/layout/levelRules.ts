import { tileKey, type Tile } from '../geometry/vec';
import type { AirportLayout } from '../model/types';
import { facilityTiles } from './footprint';

/**
 * 建物内の階に関する規則（純粋関数・1-04）。
 * コアの失敗コード（`INVALID_VALUE`）と戻り値の形は変えず、エディタが「なぜ置けないか」を導くために使う。
 */

/** 内部設備の階の範囲: 地下 5 階（-5）から、親の階数 − 1 まで */
export const INTERIOR_MIN_FLOOR = -5;

/** ターミナル内エリアの最下階: 地下 3 階（-3）まで。地上は親（ターミナル）の階数 − 1 まで */
export const TERMINAL_AREA_MIN_LEVEL = -3;

/**
 * 地下（mapLevel < 0）に単独で置ける施設の種類（5-09 / docs/39 W-7 で確定）。
 * 地下駐車場・従業員駐車場・地下駅だけを許し、管制塔・消防・格納庫など地上で機能する施設は地下に置けない。
 * 建物の中の内部設備（parentFacilityId あり）はこの制限の対象外（親の階として扱う）。
 */
export const UNDERGROUND_FACILITY_KINDS: readonly string[] = ['parking', 'staffParking', 'railStation'];

/** 単独施設をその階に置けない理由（地下の種類制限）。置けるなら null */
export function undergroundFacilityProblem(kind: string, mapLevel: number | undefined, hasParent: boolean): 'undergroundKind' | null {
  if (hasParent || mapLevel === undefined || mapLevel >= 0) return null;
  return UNDERGROUND_FACILITY_KINDS.includes(kind) ? null : 'undergroundKind';
}

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

/** ターミナルのエリアを、指定の階に置けない理由。置けるなら null（階は地下 3 階から階数 − 1） */
export function terminalAreaLevelProblem(layout: AirportLayout, terminalId: string, level: number): 'floorOutOfRange' | null {
  if (!layout.facilities[terminalId]) return null;
  return Number.isInteger(level) && level >= TERMINAL_AREA_MIN_LEVEL && level < levelsOf(layout, terminalId) ? null : 'floorOutOfRange';
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
