import type { AirportLayout, Facility } from '../model/types';
import { facilityLevel, levelOf, roadEdgeLevelValid } from '../model/levels';
import { TILE_M } from '../model/catalog';
import { facilityTiles } from '../layout/footprint';

export const WALK_SPEED_MPS = 1.2;
export interface WalkRoute { minutes: number; capacityPerHour: number | null; edges: string[] }

function attachmentCost(layout: AirportLayout, facility: Facility, nodeId: string): number | null {
  const n = layout.roadNodes[nodeId];
  if (!n || levelOf(n) !== facilityLevel(facility)) return null;
  let tiles = Infinity;
  for (const t of facilityTiles(facility)) tiles = Math.min(tiles, Math.hypot(n.pos.x - t.x, n.pos.y - t.y));
  if (tiles > Math.SQRT2) return null;
  return tiles * TILE_M / WALK_SPEED_MPS;
}

/** Route over operational pedestrian links, including explicit stairs/lifts/escalators between levels. */
export function findPedestrianRoute(layout: AirportLayout, from: Facility, to: Facility): WalkRoute | null {
  const nodes = layout.roadNodes;
  const edges = Object.values(layout.roads).filter((e) => e.roadClass === 'walkway' && e.buildState === 'operational' && roadEdgeLevelValid(e, nodes[e.from], nodes[e.to]));
  if (!edges.length) return null;
  const outgoing = new Map<string, typeof edges>();
  for (const e of edges) {
    (outgoing.get(e.from) ?? (outgoing.set(e.from, []), outgoing.get(e.from)!)).push(e);
    if (!e.oneWay) (outgoing.get(e.to) ?? (outgoing.set(e.to, []), outgoing.get(e.to)!)).push(e);
  }
  const sources = Object.keys(nodes).map((id) => ({ id, cost: attachmentCost(layout, from, id) })).filter((x): x is { id: string; cost: number } => x.cost !== null);
  const goals = new Map(Object.keys(nodes).flatMap((id) => {
    const cost = attachmentCost(layout, to, id);
    return cost === null ? [] : [[id, cost] as const];
  }));
  if (!sources.length || !goals.size) return null;

  const dist = new Map<string, number>();
  const capacity = new Map<string, number | null>();
  const prev = new Map<string, { node: string; edge: string }>();
  const pending = new Set<string>();
  for (const source of sources) {
    dist.set(source.id, source.cost);
    capacity.set(source.id, Infinity);
    pending.add(source.id);
  }
  let best: { id: string; cost: number } | null = null;
  while (pending.size) {
    let id: string | null = null;
    let cost = Infinity;
    for (const candidate of pending) if ((dist.get(candidate) ?? Infinity) < cost) { id = candidate; cost = dist.get(candidate)!; }
    if (id === null) break;
    pending.delete(id);
    const end = goals.get(id);
    if (end !== undefined && (!best || cost + end < best.cost)) best = { id, cost: cost + end };
    for (const e of outgoing.get(id) ?? []) {
      const next = e.from === id ? e.to : e.from;
      const a = nodes[e.from]!;
      const b = nodes[e.to]!;
      const verticalM = Math.abs((b.elevationM ?? levelOf(b) * 6) - (a.elevationM ?? levelOf(a) * 6));
      const horizontalM = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y) * TILE_M;
      const defaultTravel = e.connectorKind === 'elevator' ? 60 : e.connectorKind === 'escalator' ? 30 : Math.hypot(horizontalM, verticalM) / WALK_SPEED_MPS;
      const edgeSec = e.travelSec ?? defaultTravel;
      const nextCost = cost + edgeSec;
      if (nextCost >= (dist.get(next) ?? Infinity)) continue;
      dist.set(next, nextCost);
      const priorCapacity = capacity.get(id) ?? null;
      capacity.set(next, priorCapacity === null || e.capacityPerHour === undefined ? null : Math.min(priorCapacity, e.capacityPerHour));
      prev.set(next, { node: id, edge: e.id });
      pending.add(next);
    }
  }
  if (!best) return null;
  let id = best.id;
  const routeEdges: string[] = [];
  while (prev.has(id)) { const p = prev.get(id)!; routeEdges.unshift(p.edge); id = p.node; }
  const cap = routeEdges.length ? routeEdges.reduce<number | null>((min, edgeId) => {
    const v = layout.roads[edgeId]?.capacityPerHour;
    return min === null || v === undefined ? null : Math.min(min, v);
  }, Infinity) : null;
  return { minutes: best.cost / 60, capacityPerHour: cap, edges: routeEdges };
}
