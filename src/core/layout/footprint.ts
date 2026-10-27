import { STAND_DIMS, FACILITY_SPECS, type FootprintLayer } from '../model/catalog';
import type { AirportLayout, Facility, NetNode, Rotation, Stand } from '../model/types';
import { rasterizePolygon, rasterizeSegment, type Tile, type Vec2 } from '../geometry/vec';
import { runwayPolygon, runwayStripPolygon } from './runway';

/** 回転後の幅・高さ */
export function rotatedDims(w: number, h: number, rotation: Rotation): { w: number; h: number } {
  return rotation === 90 || rotation === 270 ? { w: h, h: w } : { w, h };
}

export function rectTiles(origin: Tile, w: number, h: number): Tile[] {
  const out: Tile[] = [];
  for (let y = origin.y; y < origin.y + h; y++) {
    for (let x = origin.x; x < origin.x + w; x++) out.push({ x, y });
  }
  return out;
}

export function facilityDims(f: Pick<Facility, 'w' | 'h' | 'rotation'>): { w: number; h: number } {
  return rotatedDims(f.w, f.h, f.rotation);
}

export function facilityTiles(f: Facility): Tile[] {
  const d = facilityDims(f);
  return rectTiles(f.origin, d.w, d.h);
}

export function standDims(s: Pick<Stand, 'size' | 'rotation'>): { w: number; h: number } {
  const { w, d } = STAND_DIMS[s.size];
  return rotatedDims(w, d, s.rotation);
}

export function standTiles(s: Stand): Tile[] {
  const d = standDims(s);
  return rectTiles(s.origin, d.w, d.h);
}

/**
 * スポット入口（機首の反対側、外接矩形のすぐ外側の中央タイル）。
 * 誘導路ノードがこのタイルにあるとき、スポットはネットワークに接続される。
 */
export function standEntry(s: Pick<Stand, 'origin' | 'size' | 'rotation'>): Tile {
  const { w, d } = STAND_DIMS[s.size];
  const half = (w - 1) / 2;
  const o = s.origin;
  switch (s.rotation) {
    case 0: // 機首 北 → 入口は南
      return { x: o.x + half, y: o.y + d };
    case 90: // 機首 東 → 入口は西
      return { x: o.x - 1, y: o.y + half };
    case 180: // 機首 南 → 入口は北
      return { x: o.x + half, y: o.y - 1 };
    case 270: // 機首 西 → 入口は東
      return { x: o.x + d, y: o.y + half };
  }
}

/** 回転後の外接矩形の中心（世界座標） */
export function rectCenter(origin: Tile, w: number, h: number): Vec2 {
  return { x: origin.x + w / 2, y: origin.y + h / 2 };
}

/**
 * 中心を保ったまま回転したときの新しい origin。
 * 幅と高さの偶奇が異なると中心が半タイルずれるため、90/270度へは切り捨て、0/180度へは切り上げで丸め、
 * 4回回転すると元の位置に戻るようにする。
 */
export function originAfterRotation(
  origin: Tile,
  oldDims: { w: number; h: number },
  newDims: { w: number; h: number },
  newRotation: Rotation,
): Tile {
  const c = rectCenter(origin, oldDims.w, oldDims.h);
  const round = newRotation === 90 || newRotation === 270 ? Math.floor : Math.ceil;
  return { x: round(c.x - newDims.w / 2), y: round(c.y - newDims.h / 2) };
}

function edgeTiles(nodes: Record<string, NetNode>, from: string, to: string): Tile[] {
  const a = nodes[from];
  const b = nodes[to];
  if (!a || !b) return [];
  return rasterizeSegment(a.pos, b.pos);
}

export interface FootprintPart {
  ownerId: string;
  layer: FootprintLayer;
  tiles: Tile[];
}

/** エンティティ1つの占有部分（滑走路は本体と保護区域の2つ） */
export function footprintOf(layout: AirportLayout, id: string): FootprintPart[] {
  const r = layout.runways[id];
  if (r) {
    return [
      { ownerId: id, layer: 'runway', tiles: rasterizePolygon(runwayPolygon(r)) },
      { ownerId: id, layer: 'strip', tiles: rasterizePolygon(runwayStripPolygon(r)) },
    ];
  }
  const t = layout.taxiways[id];
  if (t) return [{ ownerId: id, layer: 'taxiway', tiles: edgeTiles(layout.taxiNodes, t.from, t.to) }];
  const rd = layout.roads[id];
  if (rd) {
    return [
      {
        ownerId: id,
        layer: rd.roadClass === 'public' ? 'roadPublic' : rd.roadClass === 'rail' ? 'rail' : 'roadService',
        tiles: edgeTiles(layout.roadNodes, rd.from, rd.to),
      },
    ];
  }
  const s = layout.stands[id];
  if (s) return [{ ownerId: id, layer: 'stand', tiles: standTiles(s) }];
  const f = layout.facilities[id];
  if (f) return [{ ownerId: id, layer: FACILITY_SPECS[f.kind].layer, tiles: facilityTiles(f) }];
  return [];
}

/** 占有を持つエンティティIDの一覧（ノードは占有を持たない） */
export function footprintOwnerIds(layout: AirportLayout): string[] {
  return [
    ...Object.keys(layout.runways),
    ...Object.keys(layout.taxiways),
    ...Object.keys(layout.roads),
    ...Object.keys(layout.stands),
    ...Object.keys(layout.facilities),
  ];
}

/** レイアウト内の全エンティティの占有タイル（重なり・地形判定用） */
export function collectFootprints(layout: AirportLayout): FootprintPart[] {
  return footprintOwnerIds(layout).flatMap((id) => footprintOf(layout, id));
}

/** エンティティ1つの主な占有タイル（保護区域を除く） */
export function entityTiles(layout: AirportLayout, id: string): Tile[] {
  const area = layout.terminalAreas?.[id];
  if (area) return rectTiles(area.origin, area.w, area.h);
  return footprintOf(layout, id)
    .filter((p) => p.layer !== 'strip')
    .flatMap((p) => p.tiles);
}
