import type { AirportLayout, PaxZone, TerminalTransitLink } from '../model/types';
import { sortedValues } from '../model/ids';
import { agtSegmentCapacityPerHour, agtSegmentTravelSec } from '../model/agt';
import { agtSegmentUsability } from './agt';
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
  // 機能I: AGT セグメントを辺として合成する（buildTerminalModel は変更しない）。
  // 端点は両駅が接続するエリア同士で、区域の扱いはリンクと同じ（両端とも q.zone）。
  // セグメントは無向。所要時間 = 待ち headway/2 + 走行 + 停車（model/agt の集約モデル）。
  for (const seg of sortedValues(layout.agtSegments ?? {})) {
    if ((seg.buildState ?? 'operational') !== 'operational' || q.closedLinkIds?.has(seg.id)) continue;
    const system = layout.agtSystems?.[seg.systemId];
    if (!system) continue;
    const usability = agtSegmentUsability(layout, seg);
    if (!usability.usable) continue;
    const travelSec = agtSegmentTravelSec(system, seg);
    const addAgtHop = (from: string, to: string) => {
      (outgoing.get(from) ?? (outgoing.set(from, []), outgoing.get(from)!)).push({
        to,
        travelSec,
        distanceM: seg.distanceM,
        connectionId: seg.id,
      });
    };
    for (const fromId of usability.fromAreas) {
      const from = model.areas[fromId];
      if (!from || from.zone !== q.zone) continue;
      for (const toId of usability.toAreas) {
        const to = model.areas[toId];
        if (!to || to.zone !== q.zone) continue;
        addAgtHop(from.id, to.id);
        addAgtHop(to.id, from.id);
      }
    }
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
    if (capacity === null) return null;
    const link = layout.terminalLinks?.[id];
    if (link) return Math.min(capacity, terminalLinkCapacityPerHour(link));
    // 機能I: AGT セグメントの容量は系統パラメータから決まる（リンクと同じ予約・集計の対象）
    const seg = layout.agtSegments?.[id];
    const system = seg ? layout.agtSystems?.[seg.systemId] : undefined;
    return system ? Math.min(capacity, agtSegmentCapacityPerHour(system)) : null;
  }, Infinity);
  return {
    areas,
    connectionIds,
    travelSec: distance.get(q.toAreaId)!,
    distanceM: hops.reduce((sum, hop) => sum + hop.distanceM, 0),
    capacityPerHour,
  };
}
