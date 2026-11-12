import type { AirportLayout, NetNode, RoadEdge, TaxiwayEdge } from '../model/types';
import {
  isIntegerPoint,
  pointOnSegmentInterior,
  roundPoint,
  sameTile,
  segmentIntersection,
  type Tile,
} from '../geometry/vec';
import { isFreeRunway } from '../model/types';
import { POS_EPS_T } from '../geometry/tolerance';
import { classifySegmentIntersection, closestPointOnSegment } from '../geometry/segment';
import { runwayAxis, runwayEnd } from './runway';

/**
 * 誘導路・道路ネットワークの編集操作（ドラフトを直接変更する）。
 *
 * ネットワークは「ノード（交差点・端点）」と「エッジ（ノード間の直線区間）」で表す。
 * 経路を追加すると、既存ノードを通過する位置・既存エッジとの交差位置・滑走路中心線との交差位置で
 * 自動的に分割し、交差点ノードを作る。これにより接続関係が常にデータとして明示される。
 */

export type NetKind = 'taxi' | 'road';
export type AnyEdge = TaxiwayEdge | RoadEdge;
export type EdgeTemplate = Omit<TaxiwayEdge, 'id' | 'from' | 'to'> | Omit<RoadEdge, 'id' | 'from' | 'to'>;

const NODE_PREFIX: Record<NetKind, string> = { taxi: 'tn', road: 'rn' };
const EDGE_PREFIX: Record<NetKind, string> = { taxi: 'twy', road: 'rd' };

export function netNodes(d: AirportLayout, net: NetKind): Record<string, NetNode> {
  return net === 'taxi' ? d.taxiNodes : d.roadNodes;
}

export function netEdges(d: AirportLayout, net: NetKind): Record<string, AnyEdge> {
  return net === 'taxi' ? d.taxiways : d.roads;
}

/** 接頭辞ごとのカウンタからIDを発行する（再利用しない） */
export function allocId(d: AirportLayout, prefix: string): string {
  const n = (d.counters[prefix] ?? 0) + 1;
  d.counters[prefix] = n;
  return `${prefix}_${n}`;
}

export function findNodeAt(nodes: Record<string, NetNode>, tile: Tile): string | undefined {
  for (const n of Object.values(nodes)) if (sameTile(n.pos, tile)) return n.id;
  return undefined;
}

/** 位置が POS_EPS_T 以内のノード（実数の位置用。距離の最小、同距離なら ID 順）。従来の整数タイルは findNodeAt を使う */
export function findNodeNear(nodes: Record<string, NetNode>, p: Tile, eps: number = POS_EPS_T): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const n of Object.values(nodes)) {
    const dist = Math.hypot(n.pos.x - p.x, n.pos.y - p.y);
    if (dist > eps) continue;
    if (dist < bestD || (dist === bestD && best !== undefined && n.id < best)) {
      best = n.id;
      bestD = dist;
    }
  }
  return best;
}

export function edgesOfNode<E extends { from: string; to: string }>(edges: Record<string, E>, nodeId: string): E[] {
  return Object.values(edges).filter((e) => e.from === nodeId || e.to === nodeId);
}

export function edgeBetween<E extends { from: string; to: string }>(
  edges: Record<string, E>,
  a: string,
  b: string,
): E | undefined {
  return Object.values(edges).find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
}

export function createNode(d: AirportLayout, net: NetKind, tile: Tile): string {
  const id = allocId(d, NODE_PREFIX[net]);
  netNodes(d, net)[id] = { id, pos: { x: tile.x, y: tile.y }, name: '', holdShort: true };
  return id;
}

/**
 * エッジを nodeId の位置で2本に分割する。前半は元のIDを引き継ぎ、後半に新IDを発行する。
 */
export function splitEdge(d: AirportLayout, net: NetKind, edgeId: string, nodeId: string): string {
  const edges = netEdges(d, net);
  const e = edges[edgeId];
  if (!e) throw new Error(`edge not found: ${edgeId}`);
  const newId = allocId(d, EDGE_PREFIX[net]);
  edges[edgeId] = { ...e, to: nodeId };
  edges[newId] = { ...e, id: newId, from: nodeId };
  return newId;
}

/**
 * tile にノードを保証する。既存ノードがあればそれを返し、エッジ内部にあればそのエッジを分割する。
 * どちらでもなければ create=true の場合のみ新規作成する。
 */
export function ensureNodeAt(d: AirportLayout, net: NetKind, tile: Tile, create: boolean): string | undefined {
  const nodes = netNodes(d, net);
  const existing = findNodeAt(nodes, tile);
  if (existing) return existing;
  const edges = netEdges(d, net);
  for (const e of Object.values(edges)) {
    const a = nodes[e.from];
    const b = nodes[e.to];
    if (!a || !b) continue;
    if (pointOnSegmentInterior(tile, a.pos, b.pos) !== null) {
      const id = createNode(d, net, tile);
      splitEdge(d, net, e.id, id);
      return id;
    }
  }
  return create ? createNode(d, net, tile) : undefined;
}

/**
 * 実数の位置 p にノードを保証する（自由形の滑走路との交点用）。
 * POS_EPS_T 以内の既存ノードがあればそれを返し、エッジの内部にあればそのエッジを分割し、なければ作成する。
 */
export function ensureNodeNear(d: AirportLayout, net: NetKind, p: Tile): string {
  const nodes = netNodes(d, net);
  const existing = findNodeNear(nodes, p);
  if (existing) return existing;
  for (const e of Object.values(netEdges(d, net))) {
    const a = nodes[e.from];
    const b = nodes[e.to];
    if (!a || !b) continue;
    const cp = closestPointOnSegment(p, a.pos, b.pos);
    if (cp.dist <= POS_EPS_T) {
      const id = createNode(d, net, p);
      splitEdge(d, net, e.id, id);
      return id;
    }
  }
  return createNode(d, net, p);
}

/**
 * 折れ線経路を追加する。戻り値は経路上のノードIDと、新規作成したエッジID。
 */
export function addPath(
  d: AirportLayout,
  net: NetKind,
  points: readonly Tile[],
  template: EdgeTemplate,
): { nodeIds: string[]; edgeIds: string[] } {
  const nodes = netNodes(d, net);
  const edges = netEdges(d, net);
  const pathNodes: string[] = [];
  const created: string[] = [];

  // 1. 各頂点にノードを保証（既存エッジの途中なら分割 = T字交差点）
  // （整数でない頂点 = 自由形の中心線上の実数の位置は、POS_EPS_T 以内の既存ノードに併合する）
  const vertexIds = points.map((p) => (isIntegerPoint(p) ? ensureNodeAt(d, net, p, true)! : ensureNodeNear(d, net, p)));

  for (let i = 0; i + 1 < vertexIds.length; i++) {
    const na = vertexIds[i]!;
    const nb = vertexIds[i + 1]!;
    if (na === nb) continue;
    const pa = nodes[na]!.pos;
    const pb = nodes[nb]!.pos;
    const splits: { t: number; id: string }[] = [];

    // 2a. 区間内部を通過する既存ノード
    for (const n of Object.values(nodes)) {
      if (n.id === na || n.id === nb) continue;
      const t = pointOnSegmentInterior(n.pos, pa, pb);
      if (t !== null) splits.push({ t, id: n.id });
    }
    // 2b. 既存エッジとの交差（交点がタイル中心にある場合のみ交差点を作る）
    for (const e of Object.values(edges)) {
      const c = nodes[e.from];
      const dd = nodes[e.to];
      if (!c || !dd) continue;
      const hit = segmentIntersection(pa, pb, c.pos, dd.pos);
      if (!hit || !isIntegerPoint(hit.point)) continue;
      const id = createNode(d, net, roundPoint(hit.point));
      splitEdge(d, net, e.id, id);
      splits.push({ t: hit.t, id });
    }
    // 2c. 誘導路は滑走路中心線との交差点に滑走路入口ノードを作る
    if (net === 'taxi') {
      for (const r of Object.values(d.runways)) {
        if (isFreeRunway(r)) {
          // 自由形: 交点は実数のまま採用する。中心線に沿って走る（overlap）誘導路は検証に任せる
          const axis = runwayAxis(r);
          const c = classifySegmentIntersection(pa, pb, axis.start, axis.end);
          if (c.kind !== 'point' || c.atEndA) continue; // 区間の端は頂点のノードが既にある
          const near =
            findNodeNear(nodes, c.p) ?? splits.find((s) => Math.hypot(nodes[s.id]!.pos.x - c.p.x, nodes[s.id]!.pos.y - c.p.y) <= POS_EPS_T)?.id;
          if (near !== undefined && (near === na || near === nb || splits.some((s) => s.id === near))) continue;
          splits.push({ t: c.t, id: near ?? ensureNodeNear(d, net, c.p) });
          continue;
        }
        const hit = segmentIntersection(pa, pb, r.start, runwayEnd(r));
        if (!hit || !isIntegerPoint(hit.point)) continue;
        const tile = roundPoint(hit.point);
        if (splits.some((s) => sameTile(nodes[s.id]!.pos, tile))) continue;
        splits.push({ t: hit.t, id: ensureNodeAt(d, net, tile, true)! });
      }
    }

    splits.sort((x, y) => x.t - y.t);
    const chain = [na, ...splits.map((s) => s.id), nb].filter((id, k, arr) => k === 0 || arr[k - 1] !== id);
    for (let k = 0; k + 1 < chain.length; k++) {
      const from = chain[k]!;
      const to = chain[k + 1]!;
      if (!edgeBetween(edges, from, to)) {
        const id = allocId(d, EDGE_PREFIX[net]);
        edges[id] = { ...template, id, from, to } as AnyEdge;
        created.push(id);
      }
    }
    pathNodes.push(...chain.slice(pathNodes.length > 0 ? 1 : 0));
  }
  if (vertexIds.length === 1) pathNodes.push(vertexIds[0]!);
  return { nodeIds: pathNodes, edgeIds: created };
}

/** 接続エッジのないノードを削除する */
export function pruneOrphanNodes(d: AirportLayout, net: NetKind, candidates: readonly string[]): void {
  const nodes = netNodes(d, net);
  const edges = netEdges(d, net);
  for (const id of candidates) {
    if (nodes[id] && edgesOfNode(edges, id).length === 0) delete nodes[id];
  }
}

export function removeEdge(d: AirportLayout, net: NetKind, edgeId: string): void {
  const edges = netEdges(d, net);
  const e = edges[edgeId];
  if (!e) return;
  delete edges[edgeId];
  pruneOrphanNodes(d, net, [e.from, e.to]);
}

export function removeNode(d: AirportLayout, net: NetKind, nodeId: string): void {
  const edges = netEdges(d, net);
  const neighbors: string[] = [];
  for (const e of edgesOfNode(edges, nodeId)) {
    neighbors.push(e.from === nodeId ? e.to : e.from);
    delete edges[e.id];
  }
  delete netNodes(d, net)[nodeId];
  pruneOrphanNodes(d, net, neighbors);
}
