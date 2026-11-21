import { TILE_M } from '../model/catalog';
import { sortedValues } from '../model/ids';
import { facilityLevel } from '../model/levels';
import { isSiteEdge } from '../model/site';
import type { AirportLayout, RoadEdge } from '../model/types';
import { tileKey, type Tile } from '../geometry/vec';
import { facilityTiles, footprintOf } from '../layout/footprint';
import type { LandsideNetwork } from './landside';

/**
 * 道路・線路の区間能力（フェーズ 4 §6.2）。個別の車両・列車は動かさず、
 * 出入口から目的地までの「最も太い経路」（区間の能力の最小を最大にする経路）で上限を決める。
 * 集約モデル（出入口数 × 900 台/時）は比較用に残し、この解析は layout.accessCapacityModel === 'segment' のときだけ使う。
 */

export interface SegmentEdgeInfo {
  /** 台/時（鉄道は本/時） */
  capacity: number;
  /** 基準所要時間（分）= 長さ ÷ 時速 30 km */
  t0Min: number;
}

export interface SegmentPath {
  /** 出入口の辺から目的地の辺までの辺 ID の列 */
  edges: string[];
  bottleneck: number;
  bottleneckEdgeId: string;
  t0Min: number;
}

export interface AccessSegments {
  curbCapacity: number;
  parkingCapacity: number;
  /** 貨物地区（貨物上屋）向けの区間能力と経路（CARGO-05 区間モデル） */
  cargoCapacity: number;
  cargoPaths: Record<string, SegmentPath>;
  /** すべての経路の中で最も細いボトルネックの辺 */
  bottleneckEdgeId: string | null;
  /** 車寄せ向けの経路（出入口の辺 ID ごと） */
  paths: Record<string, SegmentPath>;
  /** 駐車場向けの経路（出入口の辺 ID ごと） */
  parkingPaths: Record<string, SegmentPath>;
  /** 運用中の一般道路の区間情報（運航中の遅れ計算に使う） */
  edges: Record<string, SegmentEdgeInfo>;
  /** 鉄道の実効本数 = min(駅の宣言本数の合計, 出入口のボトルネックの合計, ホームの能力) */
  railTrainsPerHour: number;
  railDeclaredTrainsPerHour: number;
  railPlatformCapacity: number;
}

const ROAD_SPEED_MPS = 30_000 / 3600; // 時速 30 km

/** 道路1車線あたりの既定能力（台/時）。capacityPerHour 未設定の辺に使う */
export const ROAD_LANE_CAPACITY_PER_HOUR = 900;

export const roadEdgeCapacity = (e: RoadEdge): number => e.capacityPerHour ?? (e.lanes ?? 1) * ROAD_LANE_CAPACITY_PER_HOUR;
/** 線路の既定能力（本/時）: 単線 4・複線 12・複々線 24（2026-QT。複々線は複線の線形 2 倍）。capacityPerHour 未設定の辺に使う */
export const railEdgeCapacity = (e: RoadEdge): number => e.capacityPerHour ?? ((e.tracks ?? 1) >= 4 ? 24 : (e.tracks ?? 1) >= 2 ? 12 : 4);

function edgeT0Min(layout: AirportLayout, e: RoadEdge): number {
  const a = layout.roadNodes[e.from];
  const b = layout.roadNodes[e.to];
  if (!a || !b) return 0;
  const lengthM = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y) * TILE_M;
  return lengthM / ROAD_SPEED_MPS / 60;
}

function edgeTiles(layout: AirportLayout, id: string): Tile[] {
  return footprintOf(layout, id).flatMap((p) => p.tiles);
}

/** 最も太い経路（maximin）。出入口の辺から目的地の辺の集合まで。届かなければ null */
function widestPath(
  layout: AirportLayout,
  edges: readonly RoadEdge[],
  capacityOf: (e: RoadEdge) => number,
  source: RoadEdge,
  isTarget: (e: RoadEdge) => boolean,
): SegmentPath | null {
  const byNode = new Map<string, RoadEdge[]>();
  for (const e of edges) {
    (byNode.get(e.from) ?? byNode.set(e.from, []).get(e.from)!).push(e);
    (byNode.get(e.to) ?? byNode.set(e.to, []).get(e.to)!).push(e);
  }
  const dist = new Map<string, number>();
  const prev = new Map<string, { edge: RoadEdge; from: string }>();
  const done = new Set<string>();
  dist.set(source.from, capacityOf(source));
  dist.set(source.to, capacityOf(source));
  prev.set(source.from, { edge: source, from: source.from });
  prev.set(source.to, { edge: source, from: source.from });
  // 目的地の辺で終わる最良の到達
  const bestRef: { current: { value: number; node: string; edge: RoadEdge } | null } = { current: null };
  const consider = (node: string): void => {
    const d = dist.get(node);
    if (d === undefined) return;
    for (const e of byNode.get(node) ?? []) {
      if (!isTarget(e)) continue;
      const v = Math.min(d, capacityOf(e));
      if (!bestRef.current || v > bestRef.current.value) bestRef.current = { value: v, node, edge: e };
    }
  };
  consider(source.from);
  consider(source.to);
  for (;;) {
    // 未確定の頂点から dist 最大を選ぶ（頂点数は小さいので線形走査で足りる）
    let u: string | null = null;
    let du = -1;
    for (const [n, d] of dist) {
      if (done.has(n) || d <= du) continue;
      u = n;
      du = d;
    }
    if (u === null) break;
    done.add(u);
    if (bestRef.current && du < bestRef.current.value) break; // これ以上は良くならない
    for (const e of byNode.get(u) ?? []) {
      if (e.id === source.id) continue;
      const v = e.from === u ? e.to : e.from;
      const nd = Math.min(du, capacityOf(e));
      if (nd > (dist.get(v) ?? -1)) {
        dist.set(v, nd);
        prev.set(v, { edge: e, from: u });
        consider(v);
      }
    }
  }
  if (!bestRef.current) return null;
  const b = bestRef.current;
  // 経路の再構成: 目的地の辺 ← 前任をたどる
  const pathEdges: RoadEdge[] = [b.edge];
  let node = b.node;
  const guard = new Set<string>();
  while (node !== source.from && node !== source.to && !guard.has(node)) {
    guard.add(node);
    const p = prev.get(node);
    if (!p) break;
    if (p.edge.id !== b.edge.id) pathEdges.unshift(p.edge);
    node = p.from;
  }
  if (pathEdges[0]!.id !== source.id) pathEdges.unshift(source);
  const bottleneck = Math.min(...pathEdges.map(capacityOf));
  const bottleneckEdge = pathEdges.reduce((m, e) => (capacityOf(e) < capacityOf(m) ? e : m), pathEdges[0]!);
  return {
    edges: pathEdges.map((e) => e.id),
    bottleneck,
    bottleneckEdgeId: bottleneckEdge.id,
    t0Min: pathEdges.reduce((s, e) => s + edgeT0Min(layout, e), 0),
  };
}

export function analyzeSegments(
  layout: AirportLayout,
  net: LandsideNetwork,
  opts: { railStationIds?: readonly string[]; railDeclaredTrainsPerHour?: number } = {},
): AccessSegments {
  const facilities = sortedValues(layout.facilities).filter((f) => f.buildState === 'operational' && !f.parentFacilityId);
  const terminals = facilities.filter((f) => f.kind === 'terminal');

  // 車寄せのタイル（モデル解析と同じ定義: ターミナルに接する外部接続済みの一般道路タイル）
  const curbTiles = new Set<string>();
  for (const t of terminals) {
    for (const p of facilityTiles(t)) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const k = tileKey(p.x + dx, p.y + dy);
        if ((net.publicTilesByLevel[facilityLevel(t)] ?? new Set<string>()).has(k)) curbTiles.add(k);
      }
    }
  }
  // 駐車場に接するタイル（施設タイル + 周囲 1 タイル）
  const parkingTiles = new Set<string>();
  for (const f of facilities) {
    if (f.kind !== 'parking') continue;
    for (const p of facilityTiles(f)) {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) parkingTiles.add(tileKey(p.x + dx, p.y + dy));
    }
  }

  // 貨物上屋に接するタイル（施設タイル + 周囲 1 タイル。駐車場と同じ定義）
  const cargoTiles = new Set<string>();
  for (const f of facilities) {
    if (f.kind !== 'cargoTerminal') continue;
    for (const p of facilityTiles(f)) {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) cargoTiles.add(tileKey(p.x + dx, p.y + dy));
    }
  }

  const publicEdges = sortedValues(layout.roads).filter((e) => e.roadClass === 'public' && e.buildState === 'operational');
  const tilesOf = new Map(publicEdges.map((e) => [e.id, edgeTiles(layout, e.id)]));
  const isCurb = (e: RoadEdge): boolean => (tilesOf.get(e.id) ?? []).some((t) => curbTiles.has(tileKey(t.x, t.y)));
  const isParking = (e: RoadEdge): boolean => (tilesOf.get(e.id) ?? []).some((t) => parkingTiles.has(tileKey(t.x, t.y)));
  const isCargo = (e: RoadEdge): boolean => (tilesOf.get(e.id) ?? []).some((t) => cargoTiles.has(tileKey(t.x, t.y)));

  const edges: Record<string, SegmentEdgeInfo> = {};
  for (const e of publicEdges) edges[e.id] = { capacity: roadEdgeCapacity(e), t0Min: edgeT0Min(layout, e) };

  const entrances = [...new Set(net.entryRoads)].map((id) => layout.roads[id]).filter((e): e is RoadEdge => !!e && e.buildState === 'operational');
  const build = (isTarget: (e: RoadEdge) => boolean): { paths: Record<string, SegmentPath>; capacity: number } => {
    const paths: Record<string, SegmentPath> = {};
    let bottleneckSum = 0;
    for (const src of entrances) {
      const p = widestPath(layout, publicEdges, roadEdgeCapacity, src, isTarget);
      if (!p) continue;
      paths[src.id] = p;
      bottleneckSum += p.bottleneck;
    }
    const destCap = publicEdges.filter(isTarget).reduce((s, e) => s + roadEdgeCapacity(e), 0);
    return { paths, capacity: Math.min(bottleneckSum, destCap) };
  };
  const curb = build(isCurb);
  const parking = build(isParking);
  const cargo = build(isCargo);
  let bottleneckEdgeId: string | null = null;
  let bottleneckValue = Infinity;
  for (const p of [...Object.values(curb.paths), ...Object.values(parking.paths), ...Object.values(cargo.paths)]) {
    if (p.bottleneck < bottleneckValue) {
      bottleneckValue = p.bottleneck;
      bottleneckEdgeId = p.bottleneckEdgeId;
    }
  }

  // 鉄道: 辺は rail、外周に届く辺が出入口。駅に接する辺が目的地
  const railEdges = sortedValues(layout.roads).filter((e) => e.roadClass === 'rail' && e.buildState === 'operational');
  const stationIds = opts.railStationIds ? new Set(opts.railStationIds) : null;
  const stations = facilities.filter((f) => f.kind === 'railStation' && (!stationIds || stationIds.has(f.id)));
  const stationTiles = new Set<string>();
  for (const f of stations) {
    for (const p of facilityTiles(f)) {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) stationTiles.add(tileKey(p.x + dx, p.y + dy));
    }
  }
  const isStationEdge = (e: RoadEdge): boolean => edgeTiles(layout, e.id).some((t) => stationTiles.has(tileKey(t.x, t.y)));
  const railEntrances = railEdges.filter((e) => edgeTiles(layout, e.id).some((t) => isSiteEdge(layout.site, t.x, t.y)));
  let railBottleneckSum = 0;
  for (const src of railEntrances) {
    const p = widestPath(layout, railEdges, railEdgeCapacity, src, isStationEdge);
    if (p) railBottleneckSum += p.bottleneck;
  }
  const railPlatformCapacity = stations.reduce((s, f) => s + Math.max(1, Math.floor(Number(f.props.platforms ?? 2) || 2)) * 6, 0);
  const railDeclared = opts.railDeclaredTrainsPerHour ?? stations.reduce((s, f) => s + Math.max(0, Number(f.props.trainsPerHour ?? 0) || 0), 0);
  const railTrainsPerHour = stations.length === 0 ? 0 : Math.min(railDeclared, railBottleneckSum, railPlatformCapacity);

  return {
    curbCapacity: curb.capacity,
    parkingCapacity: parking.capacity,
    cargoCapacity: cargo.capacity,
    cargoPaths: cargo.paths,
    bottleneckEdgeId,
    paths: curb.paths,
    parkingPaths: parking.paths,
    edges,
    railTrainsPerHour,
    railDeclaredTrainsPerHour: railDeclared,
    railPlatformCapacity,
  };
}
