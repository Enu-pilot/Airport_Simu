import { DEFAULT_LEVEL_HEIGHT_M } from '../model/levels';
import type { TerminalArea, TerminalAreaKind, TerminalTransitLink } from '../model/types';
import { deckElevationForCode } from '../sim/aircraftTypes';
import { DEFAULT_TERMINAL_LINK_ELEVATION_M } from './model';

/**
 * 複合連絡施設（J-2）の純粋ヘルパー。
 * 垂直ノードの階カバー・通路段の階・段差なし判定は、生成（operations）と
 * 検証（validate）の両方が同じ定義を使うため、ここに集約する。
 */

/** 垂直移動エリアの種別（ターミナル内グラフで隣接階をつなぐリフト種別と一致） */
export const VERTICAL_AREA_KINDS: readonly TerminalAreaKind[] = ['stairs', 'escalator', 'elevator'];

export function isVerticalAreaKind(kind: TerminalAreaKind): boolean {
  return kind === 'stairs' || kind === 'escalator' || kind === 'elevator';
}

/**
 * 高層通路のデッキ床の階（建物内階の数え方。0 = 1F）。
 * 標高は J-1 の導出（宣言があれば宣言のデッキ床高、無ければ従来の既定 36m）に従い、
 * 1層 = DEFAULT_LEVEL_HEIGHT_M m で階に換算する。
 */
export function connectionDeckLevel(link: Pick<TerminalTransitLink, 'elevationM' | 'crossingMaxCode'>): number {
  const elevation =
    link.elevationM ??
    (link.crossingMaxCode !== undefined ? deckElevationForCode(link.crossingMaxCode) : DEFAULT_TERMINAL_LINK_ELEVATION_M);
  return Math.round(elevation / DEFAULT_LEVEL_HEIGHT_M);
}

/**
 * 通路段がその端点側で通る階（端点エリアと同じ数え方 = 端点ターミナルの基点からの建物内階）。
 * - 高層通路: デッキ床の導出階。デッキ階は絶対の地図階層で導出されるため、
 *   端点ターミナルの基点階（facilityLevel）を引いて建物内階に換算する
 * - それ以外（歩行通路・地下トンネル・動く歩道・エスカレーター・エレベーター）:
 *   通路段は端点エリアの階を通るものとする（設計書 J.3 の「地下=端点階」）
 */
export function connectionSegmentLevel(
  link: Pick<TerminalTransitLink, 'kind' | 'elevationM' | 'crossingMaxCode'>,
  endpointLevel: number,
  endpointBaseLevel = 0,
): number {
  return link.kind === 'elevatedWalkway' ? connectionDeckLevel(link) - endpointBaseLevel : endpointLevel;
}

/**
 * 垂直エリア群が fromLevel から toLevel までの階の段差をすべてカバーするか。
 * 階 k と k+1 の間の段差は、そのどちらかの階にある垂直エリアが担う
 * （ターミナル内グラフの隣接階接続が対称であることに対応）。
 * fromLevel === toLevel なら段差は無く、常にカバーされる。
 */
export function verticalStepsCovered(areas: readonly TerminalArea[], fromLevel: number, toLevel: number): boolean {
  const levels = new Set(areas.filter((a) => isVerticalAreaKind(a.kind)).map((a) => a.level));
  const lo = Math.min(fromLevel, toLevel);
  const hi = Math.max(fromLevel, toLevel);
  for (let k = lo; k < hi; k++) {
    if (!levels.has(k) && !levels.has(k + 1)) return false;
  }
  return true;
}

/** 垂直エリア群が「階段のみ」か（1つ以上あり、すべて階段） */
export function verticalGroupStairsOnly(areas: readonly TerminalArea[]): boolean {
  return areas.length > 0 && areas.every((a) => a.kind === 'stairs');
}

/**
 * 段差なし（stepFree）の派生値。片側でも階段のみ、または階移動が必要なのに
 * 垂直エリアが無い側があれば段差なしにはならない。
 */
export function deriveConnectionStepFree(
  aAreas: readonly TerminalArea[],
  bAreas: readonly TerminalArea[],
  aNeedsTravel: boolean,
  bNeedsTravel: boolean,
): boolean {
  const sideOk = (areas: readonly TerminalArea[], needsTravel: boolean): boolean => {
    if (verticalGroupStairsOnly(areas)) return false;
    if (needsTravel && areas.length === 0) return false;
    return true;
  };
  return sideOk(aAreas, aNeedsTravel) && sideOk(bAreas, bNeedsTravel);
}
