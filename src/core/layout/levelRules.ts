import { tileKey, type Tile } from '../geometry/vec';
import type { AirportLayout, Facility, PropValue } from '../model/types';
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
 * 地下（mapLevel < 0）に単独で置ける施設の種類（5-09 / docs/39 W-7 で確定、機能G で変更）。
 * 地下駐車場・従業員駐車場・地下駅に加え、機能G（CDG 型の地下コンコース再現）でターミナルを解禁した。
 * 管制塔・消防・格納庫など地上で機能する施設は引き続き地下に置けない。
 * 地下ターミナルの孤立（到達不能）は配置禁止ではなく検証警告 TERMINAL_UNDERGROUND_ISOLATED で知らせる。
 * 建物の中の内部設備（parentFacilityId あり）はこの制限の対象外（親の階として扱う）。
 */
export const UNDERGROUND_FACILITY_KINDS: readonly string[] = ['parking', 'staffParking', 'railStation', 'terminal', 'agtStation'];

/** 単独施設をその階に置けない理由（地下の種類制限）。置けるなら null */
export function undergroundFacilityProblem(kind: string, mapLevel: number | undefined, hasParent: boolean): 'undergroundKind' | null {
  if (hasParent || mapLevel === undefined || mapLevel >= 0) return null;
  return UNDERGROUND_FACILITY_KINDS.includes(kind) ? null : 'undergroundKind';
}

export type PlacementProblem = 'floorOutOfRange' | 'outsideParent';

const levelsOf = (layout: AirportLayout, facilityId: string): number => Number(layout.facilities[facilityId]?.props.levels ?? 1);

/**
 * ターミナルのエリアを置ける相対階の範囲（機能G）。props の floorRangeMin / floorRangeMax で
 * 建物ごとに上書きでき、欠落 = 従来どおり [TERMINAL_AREA_MIN_LEVEL, levels − 1]。
 * 読み取りは必ずここを通す（欠落 = 従来どおりの家風）。不正な値（非整数・範囲外・min > max）は
 * 従来範囲へ寄せて解釈し、読み込みで落とさない。
 */
export function terminalFloorRangeOf(props: Record<string, PropValue>, levels: number): { min: number; max: number } {
  const lv = Math.max(1, Number.isInteger(levels) ? levels : 1);
  const rawMin = props.floorRangeMin;
  const rawMax = props.floorRangeMax;
  let min = typeof rawMin === 'number' && Number.isInteger(rawMin) ? rawMin : TERMINAL_AREA_MIN_LEVEL;
  let max = typeof rawMax === 'number' && Number.isInteger(rawMax) ? rawMax : lv - 1;
  min = Math.min(Math.max(min, TERMINAL_AREA_MIN_LEVEL), lv - 1);
  max = Math.min(Math.max(max, min), lv - 1);
  return { min, max };
}

/** レイアウト内のターミナルのエリア階範囲（terminalFloorRangeOf のレイアウト版） */
export function terminalFloorRange(layout: AirportLayout, terminalId: string): { min: number; max: number } {
  const t = layout.facilities[terminalId];
  if (!t) return { min: TERMINAL_AREA_MIN_LEVEL, max: 0 };
  return terminalFloorRangeOf(t.props, levelsOf(layout, terminalId));
}

/** 施設オブジェクトから直接読む版（検証など、レイアウトを引かずに済む場面用） */
export function terminalFloorRangeForFacility(facility: Facility): { min: number; max: number } {
  return terminalFloorRangeOf(facility.props, Number(facility.props.levels ?? 1));
}

/** 親（建物）の中に、指定の階・タイルで内部設備を置けない理由。置けるなら null（親が無いときも null＝コアの判定に任せる） */
export function interiorPlacementProblem(layout: AirportLayout, parentId: string, floorIndex: number, tiles: readonly Tile[]): PlacementProblem | null {
  const parent = layout.facilities[parentId];
  if (!parent) return null;
  if (!Number.isInteger(floorIndex) || floorIndex < INTERIOR_MIN_FLOOR || floorIndex >= levelsOf(layout, parentId)) return 'floorOutOfRange';
  const inside = new Set(facilityTiles(parent).map((t) => tileKey(t.x, t.y)));
  return tiles.every((t) => inside.has(tileKey(t.x, t.y))) ? null : 'outsideParent';
}

/** ターミナルのエリアを、指定の階に置けない理由。置けるなら null（範囲は terminalFloorRange、欠落時は地下 3 階から階数 − 1） */
export function terminalAreaLevelProblem(layout: AirportLayout, terminalId: string, level: number): 'floorOutOfRange' | null {
  if (!layout.facilities[terminalId]) return null;
  const range = terminalFloorRange(layout, terminalId);
  return Number.isInteger(level) && level >= range.min && level <= range.max ? null : 'floorOutOfRange';
}

/** 階数を newLevels に減らすと、範囲外になる階に、エリア（terminalAreas）または建物内の設備があるか */
export function levelsInUse(layout: AirportLayout, facilityId: string, newLevels: number): boolean {
  // 範囲の上限は floorRangeMax と newLevels − 1 の小さい方（floorRange 欠落時は従来どおり newLevels − 1）
  const t = layout.facilities[facilityId];
  const max = t ? terminalFloorRangeOf(t.props, newLevels).max : newLevels - 1;
  if (Object.values(layout.terminalAreas).some((a) => a.terminalId === facilityId && a.level > max)) return true;
  return Object.values(layout.facilities).some((f) => f.parentFacilityId === facilityId && (f.floorIndex ?? 0) >= newLevels);
}

/** エリアの置ける階範囲を [min, max] に変えると、範囲外になるエリアがそのターミナルにあるか（機能G） */
export function floorRangeInUse(layout: AirportLayout, terminalId: string, min: number, max: number): boolean {
  return Object.values(layout.terminalAreas).some((a) => a.terminalId === terminalId && (a.level < min || a.level > max));
}

/** 建物の階範囲の総階数の上限（検証上限。配置時の変換規則 §G.2-3 と同じ） */
export const TERMINAL_MAX_LEVELS = 4;

/**
 * ターミナルの建物の階範囲を絶対階 [absMin, absMax] に変えるための patch（階範囲のプルダウン一本化）。
 * 配置時の変換規則（機能G §G.2-3）と同じ導出で、基底階（mapLevel）= absMin、階数（levels）=
 * absMax − absMin + 1 とし、levels はこの patch からの従属値になる。エリア範囲は
 * 上限を新しい最上階（levels − 1）に一致させ、下限は従来の相対下限を保持する
 * （基底より下のエリア許可 = 旧データの地下エリアの意味を変えない。新しい階数 − 1 を
 * 超える場合だけそこまで切り詰める）。
 * 次の場合は null（変更不可）: 対象がターミナルでない／絶対範囲が不正（非整数・min > max・
 * 総階数が 1〜4 の外・基底階が地図階層の範囲外）／範囲外になるエリアがある／
 * 新しい階数以上に内包施設がある。呼び出し側は null のときに理由を出して止める。
 */
export function terminalSpanPatch(
  layout: AirportLayout,
  terminalId: string,
  absMin: number,
  absMax: number,
): { mapLevel: number; levels: number; floorRangeMin: number; floorRangeMax: number } | null {
  const t = layout.facilities[terminalId];
  if (!t || t.kind !== 'terminal') return null;
  if (!Number.isInteger(absMin) || !Number.isInteger(absMax) || absMin > absMax) return null;
  const levels = absMax - absMin + 1;
  if (levels < 1 || levels > TERMINAL_MAX_LEVELS) return null;
  if (absMin < -5 || absMin > 10) return null;
  const current = terminalFloorRange(layout, terminalId);
  const floorRangeMin = Math.min(current.min, levels - 1);
  const floorRangeMax = levels - 1;
  if (floorRangeInUse(layout, terminalId, floorRangeMin, floorRangeMax)) return null;
  if (Object.values(layout.facilities).some((f) => f.parentFacilityId === terminalId && (f.floorIndex ?? 0) >= levels)) return null;
  return { mapLevel: absMin, levels, floorRangeMin, floorRangeMax };
}

/** 親の階数に対して、その階が存在するか（階の選択肢の注記用） */
export function floorExistsInParent(layout: AirportLayout, parentId: string, floorIndex: number): boolean {
  return interiorPlacementProblem(layout, parentId, floorIndex, []) === null;
}
