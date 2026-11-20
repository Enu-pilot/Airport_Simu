import { distance } from '../geometry/vec';
import type { Facility, NetNode, RoadClass, RoadConnectorKind, RoadEdge } from './types';
import { FACILITY_HEIGHT_M, TILE_M } from './catalog';

/** Height used for rendering and routing when a node has only a discrete level. */
export const DEFAULT_LEVEL_HEIGHT_M = 6;
export const MIN_MAP_LEVEL = -5;
export const MAX_MAP_LEVEL = 10;

export interface FloorDisplay {
  /** 建物内階の表記（実効地図階層 + 1。0層 = 1F、−1層 = B1F） */
  building: string;
  /** 地図階層の符号つき表記（+3 / −1 / +0） */
  map: string;
  /** 床高（m）= 実効地図階層 × 1層の高さ */
  floorM: number;
}

/**
 * 階の統一表記（J-1）: 実効地図階層から建物内階・床高・地図階層を導く唯一の変換。
 * 建物内階 = 実効地図階層 + 1（0層が 1F）の換算はここに閉じ、UI は
 * floorDisplayLabel の「4F（床 +18m／地図階層 +3）」形式で併記する。
 */
export function floorDisplay(effectiveMapLevel: number): FloorDisplay {
  return {
    building: effectiveMapLevel < 0 ? `B${-effectiveMapLevel}F` : `${effectiveMapLevel + 1}F`,
    map: effectiveMapLevel >= 0 ? `+${effectiveMapLevel}` : `${effectiveMapLevel}`,
    floorM: effectiveMapLevel * DEFAULT_LEVEL_HEIGHT_M,
  };
}

/** 併記ラベル: 「4F（床 +18m／地図階層 +3）」「B1F（床 -6m／地図階層 -1）」 */
export function floorDisplayLabel(effectiveMapLevel: number): string {
  const d = floorDisplay(effectiveMapLevel);
  const m = d.floorM > 0 ? `+${d.floorM}` : `${d.floorM}`;
  return `${d.building}（床 ${m}m／地図階層 ${d.map}）`;
}

export const levelOf = (node: NetNode | undefined): number => node?.level ?? 0;
export const elevationOf = (node: NetNode | undefined): number => node?.elevationM ?? levelOf(node) * DEFAULT_LEVEL_HEIGHT_M;
/**
 * 施設の地図階層の優先順位（5-14 T4 で明文化）:
 *   1. facility.mapLevel（配置時に確定する明示値）
 *   2. railStation の props.level（駅が属する鉄道ネットワークの階層。独立駅の互換表現）
 *   3. 0（地上）
 * 親施設に内包された施設（parentFacilityId あり）では、内部の階は floorIndex が表し、
 * 地図階層は原則として親の階層に従う。内包された駅の props.level は「接続先の鉄道の
 * 階層」を保持するが、歩行ポータルによる明示接続（5-16）まではアクセス能力に加算されない。
 */
export const facilityLevel = (facility: Facility): number =>
  Number.isInteger(facility.mapLevel)
    ? Number(facility.mapLevel)
    : facility.kind === 'railStation' && Number.isInteger(facility.props.level)
      ? Number(facility.props.level)
      : 0;

export function facilityVerticalRange(facility: Facility): { minM: number; maxM: number } {
  const level = facilityLevel(facility);
  // 機能H: 搭乗橋（PBB）はトンネルが通る地上 3〜6m の帯を占有する。サービス道路・
  // 誘導路（地上 0〜0.4m）やエプロン（0.2m）とは垂直に重ならないため、その上を
  // またいで置ける。ターミナル建物・ゲートとは重なる（design-GHIJ-detail.md §H.3）
  if (!facility.parentFacilityId && facility.kind === 'boardingBridge') {
    return { minM: level * DEFAULT_LEVEL_HEIGHT_M + 3, maxM: level * DEFAULT_LEVEL_HEIGHT_M + 6 };
  }
  // 機能G: 地下ターミナル（単独施設）は基底階から levels 層ぶんの高さ区間を持つ。
  // 旧分岐は「自階層帯の天井」で丸めていたため、複数階の地下棟や地上へ跨ぐ棟で
  // 実際の占有とずれ、真上の配置判定が誤っていた。地上ターミナルと地下の単独施設
  // （駐車場等）は従来の計算のまま変えない。
  if (!facility.parentFacilityId && facility.kind === 'terminal' && level < 0) {
    const levels = Math.max(1, Number(facility.props.levels ?? 1) || 1);
    return { minM: level * DEFAULT_LEVEL_HEIGHT_M, maxM: (level + levels) * DEFAULT_LEVEL_HEIGHT_M - 0.2 };
  }
  const floorOffset = facility.parentFacilityId ? (facility.floorIndex ?? 0) * DEFAULT_LEVEL_HEIGHT_M : 0;
  const minM = level * DEFAULT_LEVEL_HEIGHT_M + floorOffset;
  const heightM = facility.parentFacilityId
    ? Math.min(FACILITY_HEIGHT_M[facility.kind] ?? 5, DEFAULT_LEVEL_HEIGHT_M * 0.6)
    : facility.kind === 'terminal'
    ? (FACILITY_HEIGHT_M.terminal ?? 18) * Math.max(1, Number(facility.props.levels ?? 1) * 0.6)
    : FACILITY_HEIGHT_M[facility.kind] ?? 5;
  const maxM = facility.parentFacilityId || level >= 0
    ? minM + heightM
    : Math.min(minM + heightM, (level + 1) * DEFAULT_LEVEL_HEIGHT_M - 0.2);
  return { minM, maxM };
}

export function connectorFits(roadClass: RoadClass, kind: RoadConnectorKind | undefined): boolean {
  return (roadClass === 'walkway' && (kind === 'stairs' || kind === 'escalator' || kind === 'elevator')) ||
    ((roadClass === 'public' || roadClass === 'service') && kind === 'ramp') ||
    (roadClass === 'rail' && kind === 'railRamp') ||
    (roadClass === 'fuel' && kind === 'pipeRiser');
}

/** True only for a same-level segment or an explicit, mode-compatible level connector. */
export function roadEdgeLevelValid(edge: RoadEdge, from: NetNode | undefined, to: NetNode | undefined): boolean {
  if (!from || !to) return false;
  const a = levelOf(from);
  const b = levelOf(to);
  if (a === b) return edge.connectorKind === undefined && Math.abs(elevationOf(from) - elevationOf(to)) < 1e-6;
  if (!connectorFits(edge.roadClass, edge.connectorKind)) return false;
  const runM = distance(from.pos, to.pos) * TILE_M;
  const riseM = Math.abs(elevationOf(from) - elevationOf(to));
  if (edge.connectorKind === 'ramp' && runM < riseM * 12) return false;
  if (edge.connectorKind === 'railRamp' && runM < riseM * 20) return false;
  if ((edge.connectorKind === 'stairs' || edge.connectorKind === 'escalator' || edge.connectorKind === 'elevator' || edge.connectorKind === 'pipeRiser') && runM > TILE_M) return false;
  return true;
}
