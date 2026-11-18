import { TILE_M } from '../model/catalog';
import { sortedValues } from '../model/ids';
import { isSiteEdge } from '../model/site';
import type { AirportLayout, Facility, RoadClass } from '../model/types';
import { chebyshevDistance, tileKey, type Tile } from '../geometry/vec';
import { facilityTiles, footprintOf } from '../layout/footprint';
import { levelOf, roadEdgeLevelValid } from '../model/levels';

/**
 * ランドサイド（空港の外から施設まで）の接続（docs/15_access_rules.md §2）。
 *
 * - 一般車の出入口 = 取得済み敷地の外周に届いている一般道路。そこから一般道路でつながる道路が「外部に接続」。
 * - 業務用（職員・車両）は一般道路とサービス道路のどちらでもよい。
 * - 鉄道は、敷地の外周に届いている鉄道線（道路種別 rail）につながる駅だけが使える。
 * 道路ノードを共有していても、種別ごとに別のネットワークとして扱う。
 * - 敷地外への到達は道路・鉄道とも階層を問わない（地下の道路・線路が外周に届けば外部接続。
 *   トンネル状の出入口を認める。検証側の ROAD_NO_ENTRANCE 判定・鉄道の扱いと一致させる）。
 *   階層の規律は別の場所で担保する: 階層が変わる区間は接続設備（道路=ランプ、鉄道=鉄道ランプ等）が
 *   あるものだけを通す（roadEdgeLevelValid）し、施設は自分の階層の道路タイルに接していないと使えない
 *   （touchesTilesAtLevel）。つまり地下道路だけに接する地上の駐車場は従来どおり未接続で、
 *   地下で外に出てランプで地上に上がる道路網は、地上区間に接する施設から正しく使える。
 */

/** 徒歩の速さ（m/s）と、交通施設からターミナルまで歩ける最大距離（タイル、チェビシェフ距離） */
export const ACCESS_WALK_SPEED = 1.2;
export const ACCESS_MAX_WALK_TILES = 16;
/** 駐車場は少し遠くても使う */
export const PARKING_MAX_WALK_TILES = 24;

export interface LandsideNetwork {
  /** 外部につながった一般道路のタイル */
  publicTiles: Set<string>;
  /** 外部につながった道路（一般・サービス）のタイル */
  anyRoadTiles: Set<string>;
  /** 外部につながった鉄道のタイル */
  railTiles: Set<string>;
  publicTilesByLevel: Record<number, Set<string>>;
  anyRoadTilesByLevel: Record<number, Set<string>>;
  railTilesByLevel: Record<number, Set<string>>;
  walkwayTilesByLevel: Record<number, Set<string>>;
  /** 一般車の出入口（敷地外周で一般道路が出入りするタイル）と、出入口になっている道路区間 */
  entrances: Tile[];
  entryRoads: string[];
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** 指定の種別の道路のうち、外周に届く連結成分のタイル */
interface ConnectedTiles { all: Set<string>; byLevel: Record<number, Set<string>> }
function connected(layout: AirportLayout, classes: readonly RoadClass[], entrances?: Tile[], entryRoads?: string[], boundary: 'any' | 'none' = 'any'): ConnectedTiles {
  const edges = sortedValues(layout.roads).filter((e) => classes.includes(e.roadClass) && e.buildState === 'operational' && roadEdgeLevelValid(e, layout.roadNodes[e.from], layout.roadNodes[e.to]));
  const uf = new UnionFind();
  for (const e of edges) uf.union(e.from, e.to);
  const tiles = new Map<string, Tile[]>();
  const roots = new Set<string>();
  for (const e of edges) {
    const t = footprintOf(layout, e.id).flatMap((p) => p.tiles);
    tiles.set(e.id, t);
    // 敷地外周への到達は階層を問わない（道路・鉄道共通。地下トンネル状の出入口も外部接続）
    const edge = t.filter((p) => isSiteEdge(layout.site, p.x, p.y));
    if (edge.length > 0) {
      roots.add(uf.find(e.from));
      entrances?.push(...edge);
      entryRoads?.push(e.id);
    }
    if (boundary === 'none') roots.add(uf.find(e.from));
  }
  const all = new Set<string>();
  const byLevel: Record<number, Set<string>> = {};
  for (const e of edges) if (roots.has(uf.find(e.from))) {
    const a = levelOf(layout.roadNodes[e.from]);
    const b = levelOf(layout.roadNodes[e.to]);
    const levels = a === b ? [a] : [a, b];
    for (const level of levels) {
      const set = (byLevel[level] ??= new Set<string>());
      for (const t of tiles.get(e.id)!) {
        const k = tileKey(t.x, t.y);
        set.add(k);
        all.add(k);
      }
    }
  }
  return { all, byLevel };
}

export function buildLandsideNetwork(layout: AirportLayout): LandsideNetwork {
  const entrances: Tile[] = [];
  const entryRoads: string[] = [];
  const publicNet = connected(layout, ['public'], entrances, entryRoads, 'any');
  const anyRoadNet = connected(layout, ['public', 'service'], undefined, undefined, 'any');
  const railNet = connected(layout, ['rail'], undefined, undefined, 'any');
  const walkwayNet = connected(layout, ['walkway'], undefined, undefined, 'none');
  const seen = new Set<string>();
  return {
    entryRoads,
    publicTiles: publicNet.all,
    anyRoadTiles: anyRoadNet.all,
    railTiles: railNet.all,
    publicTilesByLevel: publicNet.byLevel,
    anyRoadTilesByLevel: anyRoadNet.byLevel,
    railTilesByLevel: railNet.byLevel,
    walkwayTilesByLevel: walkwayNet.byLevel,
    entrances: entrances.filter((t) => {
      const k = tileKey(t.x, t.y);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
}

/** 施設（本体または周囲1タイル）が指定のタイル集合に接しているか */
export function touchesTiles(f: Facility, set: Set<string>): boolean {
  for (const t of facilityTiles(f)) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (set.has(tileKey(t.x + dx, t.y + dy))) return true;
    }
  }
  return false;
}

export function touchesTilesAtLevel(f: Facility, byLevel: Record<number, Set<string>>, level = 0): boolean {
  return touchesTiles(f, byLevel[level] ?? new Set<string>());
}

/** 施設からいちばん近い運用中ターミナルまでの距離（タイル）。ターミナルが無ければ Infinity */
export function distanceToTerminal(layout: AirportLayout, f: Facility): number {
  const tiles = facilityTiles(f);
  let best = Infinity;
  for (const t of sortedValues(layout.facilities)) {
    if (t.kind !== 'terminal' || t.buildState !== 'operational') continue;
    best = Math.min(best, chebyshevDistance(tiles, facilityTiles(t)));
  }
  return best;
}

/** 徒歩の所要時間（分） */
export const walkMinutes = (tiles: number): number => (Math.max(0, tiles) * TILE_M) / ACCESS_WALK_SPEED / 60;
