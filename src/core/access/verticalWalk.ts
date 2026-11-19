import type { AirportLayout, Facility } from '../model/types';
import { facilityLevel, levelOf, roadEdgeLevelValid } from '../model/levels';
import { TILE_M } from '../model/catalog';
import { facilityTiles } from '../layout/footprint';
import { ACCESS_MAX_WALK_TILES, distanceToTerminal, walkMinutes } from './landside';
import { adjacentTerminalAreas } from '../terminal/adjacency';

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

export type StationAccessKind = 'walkway' | 'adjacent' | 'legacy';

export interface StationAccess {
  kind: StationAccessKind;
  /** 駅からターミナルまでの徒歩（分） */
  minutes: number;
  /** kind === 'walkway' のときの歩行経路（連絡通路の能力計算に使う） */
  route?: WalkRoute;
  /** kind === 'adjacent' のとき、接しているエリア（連絡の根拠） */
  areaId?: string;
}

/**
 * 鉄道駅からターミナルへ旅客が歩いて届くかを判定する（analyzeAccess と検証で共有）。
 *
 * 届く条件は次のいずれかで、所要が最短のものを採用する（同点は walkway → adjacent → legacy の順）:
 * - walkway: 旅客連絡通路の歩行経路があり、徒歩上限（ACCESS_MAX_WALK_TILES 相当）以内
 * - adjacent: 同一階層でターミナルエリアに辺接触している（隣接連絡。徒歩は 1 タイル分）
 * - legacy: 地上の駅で、ターミナルから ACCESS_MAX_WALK_TILES 以内（従来ルール）
 * 線路への接続（敷地外へ届く鉄道に接しているか）は呼び出し側の責務。
 */
export function findStationTerminalAccess(layout: AirportLayout, station: Facility, terminals: readonly Facility[]): StationAccess | null {
  let best: StationAccess | null = null;
  const consider = (a: StationAccess): void => {
    if (!best || a.minutes < best.minutes) best = a;
  };
  const route = terminals
    .map((t) => findPedestrianRoute(layout, station, t))
    .filter((r): r is WalkRoute => r !== null)
    .sort((a, b) => a.minutes - b.minutes)[0];
  if (route && route.minutes <= walkMinutes(ACCESS_MAX_WALK_TILES)) consider({ kind: 'walkway', minutes: route.minutes, route });
  const terminalIds = new Set(terminals.map((t) => t.id));
  const adj = adjacentTerminalAreas(layout, station).filter((a) => terminalIds.has(a.terminalId));
  if (adj.length > 0) consider({ kind: 'adjacent', minutes: walkMinutes(1), areaId: adj[0]!.areaId });
  if (facilityLevel(station) === 0) {
    const d = distanceToTerminal(layout, station);
    if (d <= ACCESS_MAX_WALK_TILES) consider({ kind: 'legacy', minutes: walkMinutes(Math.min(d, ACCESS_MAX_WALK_TILES)) });
  }
  return best;
}
