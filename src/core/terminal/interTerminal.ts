import type { AirportLayout, PaxZone, TerminalTransitLink } from '../model/types';
import { sortedValues } from '../model/ids';
import { buildTerminalModel, canMove, terminalLinkCapacityPerHour, WALK_SPEED_MPS } from './model';

export interface TerminalTransferQuery {
  fromAreaId: string;
  toAreaId: string;
  zone: PaxZone;
  uncleared?: boolean;
  stepFree?: boolean;
  closedAreaIds?: ReadonlySet<string>;
  closedLinkIds?: ReadonlySet<string>;
}

export interface TerminalTransferRoute {
  /** Full sequence of existing terminal-area IDs. No passenger groups are created or modified. */
  areas: string[];
  /** Inter-terminal walkway/moving-walkway IDs traversed. */
  connectionIds: string[];
  travelSec: number;
  distanceM: number;
  /** Bottleneck among explicit capacities or finite width-derived legacy capacities. */
  capacityPerHour: number | null;
}

interface Hop { to: string; travelSec: number; distanceM: number; connectionId?: string; }

/**
 * Plan a route over existing per-terminal AreaLinks plus explicit inter-terminal connections.
 * This is deliberately a planner only: existing flight passenger generation and PaxGroup state are untouched.
 */
export function findTerminalTransferRoute(layout: AirportLayout, q: TerminalTransferQuery): TerminalTransferRoute | null {
  const model = buildTerminalModel(layout);
  if (!model.areas[q.fromAreaId] || !model.areas[q.toAreaId]) return null;
  const outgoing = new Map<string, Hop[]>();
  for (const [from, links] of Object.entries(model.links)) {
    for (const link of links) {
      if (link.transferLinkId) continue;
      (outgoing.get(from) ?? (outgoing.set(from, []), outgoing.get(from)!)).push({
        to: link.to,
        travelSec: link.lengthM / WALK_SPEED_MPS + link.travelSec,
        distanceM: link.lengthM,
      });
    }
  }
  const addConnection = (link: TerminalTransitLink, from: string, to: string) => {
    (outgoing.get(from) ?? (outgoing.set(from, []), outgoing.get(from)!)).push({
      to,
      travelSec: link.travelSec,
      distanceM: link.distanceM,
      connectionId: link.id,
    });
  };
  for (const link of sortedValues(layout.terminalLinks ?? {})) {
    if (link.buildState !== 'operational' || q.closedLinkIds?.has(link.id) || !link.allowedZones.includes(q.zone)) continue;
    const from = model.areas[link.fromAreaId];
    const to = model.areas[link.toAreaId];
    if (!from || !to || from.zone !== q.zone || to.zone !== q.zone) continue;
    addConnection(link, from.id, to.id);
    if (link.bidirectional) addConnection(link, to.id, from.id);
  }

  const distance = new Map<string, number>([[q.fromAreaId, 0]]);
  const previous = new Map<string, { from: string; hop: Hop }>();
  const pending = new Set<string>([q.fromAreaId]);
  const settled = new Set<string>();
  while (pending.size) {
    const current = [...pending].sort((a, b) => (distance.get(a)! - distance.get(b)!) || a.localeCompare(b))[0]!;
    pending.delete(current);
    if (settled.has(current)) continue;
    settled.add(current);
    if (current === q.toAreaId) break;
    const node = model.areas[current]!;
    for (const hop of outgoing.get(current) ?? []) {
      const next = model.areas[hop.to];
      if (!next || q.closedAreaIds?.has(next.id)) continue;
      if (q.stepFree && (node.kind === 'stairs' || next.kind === 'stairs')) continue;
      if (hop.connectionId) {
        // An uncleared departing passenger must complete security in the current terminal first.
        if (q.uncleared) continue;
      } else {
        if (q.uncleared && next.zone === 'departure' && !(next.kind === 'security' && next.id === q.toAreaId)) continue;
        if (q.uncleared && !(node.kind === 'security' && next.zone === 'landside') && !canMove(node, next)) continue;
        if (!q.uncleared && !canMove(node, next)) continue;
      }
      const nextCost = distance.get(current)! + hop.travelSec;
      if (nextCost < (distance.get(next.id) ?? Infinity)) {
        distance.set(next.id, nextCost);
        previous.set(next.id, { from: current, hop });
        pending.add(next.id);
      }
    }
  }
  if (!distance.has(q.toAreaId)) return null;
  const areas = [q.toAreaId];
  const hops: Hop[] = [];
  while (previous.has(areas[0]!)) {
    const p = previous.get(areas[0]!)!;
    hops.unshift(p.hop);
    areas.unshift(p.from);
  }
  const connectionIds = hops.flatMap((hop) => hop.connectionId ? [hop.connectionId] : []);
  const capacityPerHour = connectionIds.length === 0 ? null : connectionIds.reduce<number | null>((capacity, id) => {
    const link = layout.terminalLinks?.[id];
    return capacity === null || !link ? null : Math.min(capacity, terminalLinkCapacityPerHour(link));
  }, Infinity);
  return {
    areas,
    connectionIds,
    travelSec: distance.get(q.toAreaId)!,
    distanceM: hops.reduce((sum, hop) => sum + hop.distanceM, 0),
    capacityPerHour,
  };
}
