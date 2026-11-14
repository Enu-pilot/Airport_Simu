import type { AirportLayout } from '../model/types';
import { facilityLevel, levelOf, roadEdgeLevelValid } from '../model/levels';
import { facilityTiles, standEntry, standTiles } from './footprint';

const touchesAtGround = (layout: AirportLayout, nodeId: string, tiles: { x: number; y: number }[]): boolean => {
  const n = layout.roadNodes[nodeId];
  if (!n || levelOf(n) !== 0) return false;
  return tiles.some((t) => Math.abs(n.pos.x - t.x) <= 1 && Math.abs(n.pos.y - t.y) <= 1);
};

/** Stands whose ground-level connection reaches an operational fuel farm through fuel pipes. */
export function hydrantConnectedStands(layout: AirportLayout): Set<string> {
  const farms = Object.values(layout.facilities).filter((f) => f.kind === 'fuelFarm' && f.buildState === 'operational');
  const edges = Object.values(layout.roads).filter((e) => e.roadClass === 'fuel' && e.buildState === 'operational' && roadEdgeLevelValid(e, layout.roadNodes[e.from], layout.roadNodes[e.to]));
  if (!farms.length || !edges.length) return new Set();
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    (outgoing.get(e.from) ?? (outgoing.set(e.from, []), outgoing.get(e.from)!)).push(e.to);
    if (!e.oneWay) (outgoing.get(e.to) ?? (outgoing.set(e.to, []), outgoing.get(e.to)!)).push(e.from);
  }
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const farm of farms) {
    const tiles = facilityTiles(farm);
    for (const id of outgoing.keys()) {
      if (facilityLevel(farm) === 0 && touchesAtGround(layout, id, tiles) && !reached.has(id)) { reached.add(id); queue.push(id); }
    }
  }
  for (let i = 0; i < queue.length; i++) {
    for (const next of outgoing.get(queue[i]!) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  }
  const result = new Set<string>();
  for (const stand of Object.values(layout.stands)) {
    if (stand.buildState !== 'operational') continue;
    const tiles = [...standTiles(stand), standEntry(stand)];
    if ([...reached].some((id) => touchesAtGround(layout, id, tiles))) result.add(stand.id);
  }
  return result;
}
