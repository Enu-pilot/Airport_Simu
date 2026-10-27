import { FACILITY_SPECS } from '../model/catalog';
import { compareIds } from '../model/ids';
import type { AirportLayout } from '../model/types';
import { distPointSegment, distance, pointInPolygon, type Vec2 } from '../geometry/vec';
import { facilityDims, standDims } from './footprint';
import { runwayPolygon } from './runway';

/**
 * 世界座標の点にあるエンティティを選ぶ。重なっている場合は小さく上にあるものを優先する:
 * ノード > ゲート > スポット > 建物 > 誘導路 > 道路 > 滑走路 > エリア（エプロン等）
 */
export function pickAt(layout: AirportLayout, world: Vec2): string | null {
  // ノード・エッジはタイル中心が基準なので、タイル番号空間に直す
  const p = { x: world.x - 0.5, y: world.y - 0.5 };
  const inRect = (o: Vec2, w: number, h: number) => world.x >= o.x && world.x < o.x + w && world.y >= o.y && world.y < o.y + h;
  const first = (ids: string[]) => (ids.length > 0 ? ids.sort(compareIds)[ids.length - 1]! : null);

  const nodeHit = [...Object.values(layout.taxiNodes), ...Object.values(layout.roadNodes)]
    .filter((n) => distance(n.pos, p) <= 0.45)
    .map((n) => n.id);
  if (nodeHit.length > 0) return first(nodeHit);

  const facilities = Object.values(layout.facilities);
  const gate = facilities.filter((f) => f.kind === 'gate' && inRect(f.origin, 1, 1)).map((f) => f.id);
  if (gate.length > 0) return first(gate);

  const stand = Object.values(layout.stands)
    .filter((s) => {
      const d = standDims(s);
      return inRect(s.origin, d.w, d.h);
    })
    .map((s) => s.id);
  if (stand.length > 0) return first(stand);

  const inFacility = (layer: 'building' | 'area' | 'apron') =>
    facilities
      .filter((f) => FACILITY_SPECS[f.kind].layer === layer)
      .filter((f) => {
        const d = facilityDims(f);
        return inRect(f.origin, d.w, d.h);
      })
      .map((f) => f.id);
  const building = inFacility('building');
  if (building.length > 0) return first(building);

  const edgeHit = (nodes: AirportLayout['taxiNodes'], edges: Record<string, { id: string; from: string; to: string }>) =>
    Object.values(edges)
      .filter((e) => {
        const a = nodes[e.from];
        const b = nodes[e.to];
        return !!a && !!b && distPointSegment(p, a.pos, b.pos).dist <= 0.5;
      })
      .map((e) => e.id);
  const taxi = edgeHit(layout.taxiNodes, layout.taxiways);
  if (taxi.length > 0) return first(taxi);
  const road = edgeHit(layout.roadNodes, layout.roads);
  if (road.length > 0) return first(road);

  const rwy = Object.values(layout.runways)
    .filter((r) => pointInPolygon(p, runwayPolygon(r)))
    .map((r) => r.id);
  if (rwy.length > 0) return first(rwy);

  const area = [...inFacility('area'), ...inFacility('apron')];
  return first(area);
}
