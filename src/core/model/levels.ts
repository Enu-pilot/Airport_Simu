import { distance } from '../geometry/vec';
import type { Facility, NetNode, RoadClass, RoadConnectorKind, RoadEdge } from './types';
import { TILE_M } from './catalog';

/** Height used for rendering and routing when a node has only a discrete level. */
export const DEFAULT_LEVEL_HEIGHT_M = 6;
export const MIN_MAP_LEVEL = -5;
export const MAX_MAP_LEVEL = 10;

export const levelOf = (node: NetNode | undefined): number => node?.level ?? 0;
export const elevationOf = (node: NetNode | undefined): number => node?.elevationM ?? levelOf(node) * DEFAULT_LEVEL_HEIGHT_M;
export const facilityLevel = (facility: Facility): number => Number.isInteger(facility.props.level) ? Number(facility.props.level) : 0;

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
