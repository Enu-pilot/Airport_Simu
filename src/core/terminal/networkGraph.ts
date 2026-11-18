import type { AirportLayout } from '../model/types';
import { sortedValues } from '../model/ids';
import { facilityLevel } from '../model/levels';
import { buildTerminalModel, WALK_SPEED_MPS, type TerminalModel } from './model';

/**
 * 5-16 T3/T4: 対外交通施設とターミナル内エリアを横断する複合グラフ（派生データ）。
 *
 * ノードは `area:<エリアID>` / `portal:<ポータルID>` / `facility:<施設ID>` の 3 種。
 * エリア間は TerminalModel のリンクをそのまま使い、交通施設とはポータル経由でのみ接続する
 * （座標や階が近いだけでは接続しない）。車両用の道路・鉄道グラフは歩行グラフへ入れない。
 * ポータルと交通施設は、運用中のものだけが現行グラフに入り、建設中は
 * includeUnderConstruction の将来グラフにだけ入る（planned はどちらにも入らない）。
 * 旅客の現在経路に将来グラフの経路を使ってはならない（5-13 と同じ原則）。
 */

export type CompositeNodeKind = 'area' | 'portal' | 'facility';

export interface CompositeNode {
  id: string;
  kind: CompositeNodeKind;
  /** 元のエンティティ ID */
  refId: string;
}

export interface CompositeEdge {
  to: string;
  /** 歩行所要時間（秒）。エリア間は TerminalModel と同じ費用（距離/歩行速度＋上下移動時間） */
  costSec: number;
  /** この辺がポータル境界の場合、そのポータル ID */
  portalId?: string;
  /** ターミナル間連絡設備を通る場合、その設備 ID */
  transferLinkId?: string;
}

export interface CompositeGraph {
  nodes: Record<string, CompositeNode>;
  links: Record<string, CompositeEdge[]>;
}

export const areaNodeId = (areaId: string): string => `area:${areaId}`;
export const portalNodeId = (portalId: string): string => `portal:${portalId}`;
export const facilityNodeId = (facilityId: string): string => `facility:${facilityId}`;

function buildStateIncluded(state: string, includeUnderConstruction: boolean): boolean {
  return state === 'operational' || (includeUnderConstruction && state === 'underConstruction');
}

export function buildCompositeGraph(
  layout: AirportLayout,
  opts: { includeUnderConstruction?: boolean } = {},
): CompositeGraph {
  const model: TerminalModel = buildTerminalModel(layout, opts);
  const nodes: Record<string, CompositeNode> = {};
  const links: Record<string, CompositeEdge[]> = {};
  const addNode = (id: string, kind: CompositeNodeKind, refId: string): void => {
    if (!nodes[id]) {
      nodes[id] = { id, kind, refId };
      links[id] = [];
    }
  };
  for (const area of Object.values(model.areas)) addNode(areaNodeId(area.id), 'area', area.id);
  for (const [from, edges] of Object.entries(model.links)) {
    for (const e of edges) {
      links[areaNodeId(from)]!.push({
        to: areaNodeId(e.to),
        costSec: e.lengthM / WALK_SPEED_MPS + e.travelSec,
        ...(e.transferLinkId ? { transferLinkId: e.transferLinkId } : {}),
      });
    }
  }
  const future = opts.includeUnderConstruction ?? false;
  for (const portal of sortedValues(layout.portals ?? {})) {
    if (!buildStateIncluded(portal.buildState, future)) continue;
    const facility = layout.facilities[portal.facilityId];
    if (!facility || !buildStateIncluded(facility.buildState ?? 'operational', future)) continue;
    if (!model.areas[portal.areaId]) continue;
    // 階・階層が作成時と食い違ったポータルは接続として扱わない（検証側で報告する）
    if (portal.floorIndex !== layout.terminalAreas[portal.areaId]!.level) continue;
    if (portal.mapLevel !== facilityLevel(facility)) continue;
    addNode(facilityNodeId(facility.id), 'facility', facility.id);
    addNode(portalNodeId(portal.id), 'portal', portal.id);
    const f = facilityNodeId(facility.id);
    const p = portalNodeId(portal.id);
    const a = areaNodeId(portal.areaId);
    links[f]!.push({ to: p, costSec: 0, portalId: portal.id });
    links[p]!.push({ to: f, costSec: 0, portalId: portal.id });
    links[p]!.push({ to: a, costSec: 0, portalId: portal.id });
    links[a]!.push({ to: p, costSec: 0, portalId: portal.id });
  }
  return { nodes, links };
}

export interface CompositeRoute {
  /** 始点を含むノード列 */
  nodes: string[];
  costSec: number;
}

/** 複合グラフ上の最短経路（Dijkstra。ノード数は小さいので線形探索で十分） */
export function findCompositeRoute(graph: CompositeGraph, from: string, to: string): CompositeRoute | null {
  if (!graph.nodes[from] || !graph.nodes[to]) return null;
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  const open: string[] = [from];
  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if ((dist.get(open[i]!) ?? Infinity) < (dist.get(open[bi]!) ?? Infinity)) bi = i;
    const cur = open.splice(bi, 1)[0]!;
    if (done.has(cur)) continue;
    done.add(cur);
    if (cur === to) break;
    for (const e of graph.links[cur] ?? []) {
      const nc = (dist.get(cur) ?? 0) + e.costSec;
      if (nc < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nc);
        prev.set(e.to, cur);
        open.push(e.to);
      }
    }
  }
  if (!dist.has(to)) return null;
  const nodes: string[] = [to];
  let cur = to;
  while (cur !== from) {
    cur = prev.get(cur)!;
    nodes.unshift(cur);
  }
  return { nodes, costSec: dist.get(to)! };
}

export type FacilityConnectionStatus = 'operational' | 'underConstruction' | 'unreachable';

export interface FacilityConnection {
  status: FacilityConnectionStatus;
  /** 現在通行できる経路（operational のときだけ） */
  route: CompositeRoute | null;
  /** 建設完了後に通行できる経路（診断専用。旅客へ割り当ててはならない） */
  futureRoute: CompositeRoute | null;
}

/**
 * 交通施設からターミナル内エリアへの接続を 3 状態で分類する（5-16 T4、5-13 と同じ原則）。
 * 運用中の迂回路があれば、建設中の近道より運用中を優先する。
 */
export function classifyFacilityConnection(layout: AirportLayout, facilityId: string, areaId: string): FacilityConnection {
  const from = facilityNodeId(facilityId);
  const to = areaNodeId(areaId);
  const route = findCompositeRoute(buildCompositeGraph(layout), from, to);
  if (route) return { status: 'operational', route, futureRoute: null };
  const futureRoute = findCompositeRoute(buildCompositeGraph(layout, { includeUnderConstruction: true }), from, to);
  if (futureRoute) return { status: 'underConstruction', route: null, futureRoute };
  return { status: 'unreachable', route: null, futureRoute: null };
}

export interface PortalAccessStatus {
  facilityId: string;
  /** 出発側: 交通施設 → いずれかの入口エリアへの接続状態（最良のもの） */
  toEntrance: FacilityConnectionStatus;
  /** 到着側: いずれかの出口エリア → 交通施設への接続状態（最良のもの） */
  fromExit: FacilityConnectionStatus;
}

const STATUS_RANK: Record<FacilityConnectionStatus, number> = { operational: 0, underConstruction: 1, unreachable: 2 };

function bestStatus(statuses: FacilityConnectionStatus[]): FacilityConnectionStatus {
  let best: FacilityConnectionStatus = 'unreachable';
  for (const s of statuses) if (STATUS_RANK[s] < STATUS_RANK[best]) best = s;
  return best;
}

/**
 * ポータルを持つ全交通施設について、出発側（入口まで）と到着側（出口から）の
 * 接続状態を検査する（5-16 T7 の核）。ポータルのない施設は対象外で、
 * 未設置の手段はここでは扱わない（notConfigured はアクセス分析側の責務）。
 */
export function verifyPortalAccess(layout: AirportLayout): PortalAccessStatus[] {
  const entrances = sortedValues(layout.terminalAreas).filter((a) => a.kind === 'entrance');
  const exits = sortedValues(layout.terminalAreas).filter((a) => a.kind === 'exit');
  const current = buildCompositeGraph(layout);
  const future = buildCompositeGraph(layout, { includeUnderConstruction: true });
  const facilityIds = [...new Set(sortedValues(layout.portals ?? {}).map((p) => p.facilityId))].sort();
  const classifyOn = (graph: CompositeGraph, from: string, to: string): boolean => findCompositeRoute(graph, from, to) !== null;
  const statusBetween = (fromNode: (id: string) => string, fromId: string, targets: { id: string }[], toNode: (id: string) => string): FacilityConnectionStatus => {
    const from = fromNode(fromId);
    const statuses = targets.map((t) => {
      if (classifyOn(current, from, toNode(t.id))) return 'operational' as const;
      if (classifyOn(future, from, toNode(t.id))) return 'underConstruction' as const;
      return 'unreachable' as const;
    });
    return bestStatus(statuses);
  };
  return facilityIds.map((facilityId) => ({
    facilityId,
    toEntrance: statusBetween(facilityNodeId, facilityId, entrances, areaNodeId),
    fromExit: bestStatus(exits.map((e) => {
      if (classifyOn(current, areaNodeId(e.id), facilityNodeId(facilityId))) return 'operational' as const;
      if (classifyOn(future, areaNodeId(e.id), facilityNodeId(facilityId))) return 'underConstruction' as const;
      return 'unreachable' as const;
    })),
  }));
}
