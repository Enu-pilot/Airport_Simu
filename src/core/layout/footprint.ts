import { STAND_DIMS, FACILITY_SPECS, type FootprintLayer } from '../model/catalog';
import type { AirportLayout, Facility, NetNode, Rotation, Stand } from '../model/types';
import { rasterizePolygon, rasterizeSegment, type Tile, type Vec2 } from '../geometry/vec';
import { tilesOverlappingPolygon } from '../geometry/raster';
import { orthogonalPolygonTiles, rectRing } from '../geometry/polygon';
import type { WorldPoint } from '../geometry/frames';
import { isFreeRunway } from '../model/types';
import { runwayPolygon, runwayStripPolygon } from './runway';
import { runwayAreas } from './runwayAreas';
import { facilityLevel, facilityVerticalRange, elevationOf, levelOf } from '../model/levels';

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
  // 5-15: footprint（直交ポリゴン）があればそれを占有形状とする。なければ従来の矩形。
  if (f.footprint && f.footprint.length >= 4) return orthogonalPolygonTiles(f.footprint);
  const d = facilityDims(f);
  return rectTiles(f.origin, d.w, d.h);
}

/** 施設の外形リング（footprint があればそれ、なければ矩形リング）。複合体判定・描画の共通入口 */
export function facilityOutline(f: Facility): Tile[] {
  if (f.footprint && f.footprint.length >= 4) return [...f.footprint];
  const d = facilityDims(f);
  return rectRing(f.origin, d.w, d.h);
}

export function standDims(s: Pick<Stand, 'size' | 'rotation'>): { w: number; h: number } {
  const { w, d } = STAND_DIMS[s.size];
  return rotatedDims(w, d, s.rotation);
}

export function standTiles(s: Stand): Tile[] {
  const d = standDims(s);
  return rectTiles(s.origin, d.w, d.h);
}

function entryFor(s: Pick<Stand, 'origin' | 'size' | 'rotation'>, dims: { w: number; d: number }): Tile {
  const { w, d } = dims;
  // 入口は中央に最も近いタイル。偶数幅では 2 つの中央タイルのうち小さい方（左/上）に寄せる。
  // 横方向の軸長は全回転で w（0/180 は x 方向、90/270 は y 方向が横になる）。
  const half = Math.floor((w - 1) / 2);
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

/**
 * スポット入口（機首の反対側、外接矩形のすぐ外側の中央付近のタイル）。
 * 誘導路ノードがこのタイルにあるとき、スポットはネットワークに接続される。
 */
export function standEntry(s: Pick<Stand, 'origin' | 'size' | 'rotation'>): Tile {
  return entryFor(s, STAND_DIMS[s.size]);
}

/** 寸法改定（S 2×2・M 3×2・L 4×4）前の旧寸法。旧セーブの入口位置の互換判定に使う */
export const LEGACY_STAND_DIMS: Record<Stand['size'], { w: number; d: number }> = {
  S: { w: 3, d: 3 },
  M: { w: 3, d: 4 },
  L: { w: 5, d: 5 },
};

/** 旧寸法でのスポット入口。旧セーブは入口タイルに誘導路ノードを置いてあるため、接続判定の互換に使う */
export function legacyStandEntry(s: Pick<Stand, 'origin' | 'size' | 'rotation'>): Tile {
  return entryFor(s, LEGACY_STAND_DIMS[s.size]);
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
  /** 占有する高度階。地上施設は省略（level 0）。 */
  level?: number;
  /** 階層接続設備は両端の階を占有検証する。 */
  levels?: number[];
  /** Hosted equipment occupies a private floor namespace inside its parent building. */
  spaceId?: string;
  /** Physical vertical extent, used instead of discrete-level equality when checking collisions. */
  vertical?: { minM: number; maxM: number };
  /** Per-tile physical extents for sloped and vertical connectors. */
  occupancy?: { tile: Tile; minM: number; maxM: number }[];
  tiles: Tile[];
  /** 実寸の多角形（自由形の滑走路だけ。World フレーム、凸）。ある部分は重なり判定を多角形で行う（`tiles` は重なるタイル） */
  poly?: WorldPoint[];
}

/** エンティティ1つの占有部分（滑走路は本体と保護区域の2つ） */
export function footprintOf(layout: AirportLayout, id: string): FootprintPart[] {
  const r = layout.runways[id];
  if (r) {
    if (isFreeRunway(r)) {
      const a = runwayAreas(r);
      const part = (layer: FootprintPart['layer'], poly: WorldPoint[]): FootprintPart => ({ ownerId: id, layer, tiles: tilesOverlappingPolygon(poly), poly });
      return [part('runway', a.paved), part('strip', a.strip), ...a.resa.map((p) => part('resa', p))];
    }
    return [
      { ownerId: id, layer: 'runway', tiles: rasterizePolygon(runwayPolygon(r)) },
      { ownerId: id, layer: 'strip', tiles: rasterizePolygon(runwayStripPolygon(r)) },
    ];
  }
  const t = layout.taxiways[id];
  if (t) return [{ ownerId: id, layer: 'taxiway', tiles: edgeTiles(layout.taxiNodes, t.from, t.to) }];
  const rd = layout.roads[id];
  if (rd) {
    const from = layout.roadNodes[rd.from];
    const to = layout.roadNodes[rd.to];
    const fromLevel = levelOf(from);
    const toLevel = levelOf(to);
    const tiles = edgeTiles(layout.roadNodes, rd.from, rd.to);
    const fromElevation = elevationOf(from);
    const toElevation = elevationOf(to);
    const layer: FootprintLayer = rd.roadClass === 'public' ? 'roadPublic' : rd.roadClass === 'service' ? 'roadService' : rd.roadClass === 'rail' ? 'rail' : rd.roadClass === 'walkway' ? 'walkway' : 'fuelPipe';
    const occupancy = from && to && fromLevel !== toLevel
      ? tiles.map((tile, index) => {
          if (from.pos.x === to.pos.x && from.pos.y === to.pos.y) {
            return { tile, minM: Math.min(fromElevation, toElevation) - 0.2, maxM: Math.max(fromElevation, toElevation) + 0.2 };
          }
          const ratio = tiles.length <= 1 ? 0.5 : index / (tiles.length - 1);
          const elevation = fromElevation + (toElevation - fromElevation) * ratio;
          return { tile, minM: elevation - 0.2, maxM: elevation + 0.2 };
        })
      : undefined;
    return [
      {
        ownerId: id,
        layer,
        tiles,
        ...(fromLevel !== 0 ? { level: fromLevel } : {}),
        ...(from && to && fromLevel === toLevel ? { vertical: { minM: Math.min(fromElevation, toElevation) - 0.2, maxM: Math.max(fromElevation, toElevation) + 0.2 } } : {}),
        ...(occupancy ? { occupancy } : {}),
      },
    ];
  }
  const s = layout.stands[id];
  if (s) return [{ ownerId: id, layer: 'stand', tiles: standTiles(s) }];
  const f = layout.facilities[id];
  if (f) return [{
    ownerId: id,
    layer: f.parentFacilityId ? 'interior' : FACILITY_SPECS[f.kind].layer,
    level: facilityLevel(f),
    ...(f.parentFacilityId ? { spaceId: `facility:${f.parentFacilityId}:floor:${f.floorIndex ?? 0}` } : {}),
    vertical: facilityVerticalRange(f),
    tiles: facilityTiles(f),
  }];
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
    .filter((p) => p.layer !== 'strip' && p.layer !== 'resa')
    .flatMap((p) => p.tiles);
}
