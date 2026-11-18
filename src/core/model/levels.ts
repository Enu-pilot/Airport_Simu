import { distance } from '../geometry/vec';
import type { Facility, NetNode, RoadClass, RoadConnectorKind, RoadEdge } from './types';
import { FACILITY_HEIGHT_M, TILE_M } from './catalog';

/** Height used for rendering and routing when a node has only a discrete level. */
export const DEFAULT_LEVEL_HEIGHT_M = 6;
export const MIN_MAP_LEVEL = -5;
export const MAX_MAP_LEVEL = 10;

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
  const floorOffset = facility.parentFacilityId ? (facility.floorIndex ?? 0) * DEFAULT_LEVEL_HEIGHT_M : 0;
  const minM = facilityLevel(facility) * DEFAULT_LEVEL_HEIGHT_M + floorOffset;
  const heightM = facility.parentFacilityId
    ? Math.min(FACILITY_HEIGHT_M[facility.kind] ?? 5, DEFAULT_LEVEL_HEIGHT_M * 0.6)
    : facility.kind === 'terminal'
    ? (FACILITY_HEIGHT_M.terminal ?? 18) * Math.max(1, Number(facility.props.levels ?? 1) * 0.6)
    : FACILITY_HEIGHT_M[facility.kind] ?? 5;
  const maxM = facility.parentFacilityId || facilityLevel(facility) >= 0
    ? minM + heightM
    : Math.min(minM + heightM, (facilityLevel(facility) + 1) * DEFAULT_LEVEL_HEIGHT_M - 0.2);
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
