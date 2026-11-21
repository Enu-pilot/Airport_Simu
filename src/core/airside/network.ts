import { TILE_M } from '../model/catalog';
import { isFreeRunway, sizeAtLeast, type AirportLayout, type SizeClass } from '../model/types';
import { distance, type Tile, type Vec2 } from '../geometry/vec';
import { POS_EPS_T } from '../geometry/tolerance';
import { classifySegmentIntersection } from '../geometry/segment';
import { mapToWorld } from '../geometry/frames';
import { legacyStandEntry, rectCenter, standDims, standEntry } from '../layout/footprint';
import { edgesOfNode, findNodeAt } from '../layout/network';
import { compareIds, sortedValues } from '../model/ids';
import { positionOnRunway, runwayAxis, runwayEnd, runwayMaxSize } from '../layout/runway';

/**
 * 論理エアサイドネットワーク（派生データ）。
 *
 * 建設レイヤー（滑走路・誘導路・スポット）から決定的に生成する。航空機の経路探索は
 * このグラフのみを使う。グラフに無いエッジは通行できないため、未接続の誘導路へ進入する
 * 経路は構造的に存在しない。
 *
 * ID 規則:
 * - 誘導路ノード: レイアウトのノードIDそのまま（tn_*）
 * - 滑走路端: `${runwayId}:T0`（始点側）/ `${runwayId}:T1`（終点側）。端に誘導路ノードがあればそれを使う
 * - 滑走路の交差点（自由形が関与する組だけ）: `${a}:X:${b}`（a < b）。その位置に誘導路ノードがあればそれを使う
 * - スポット: `${standId}:P`、スポット接続エッジ: `${standId}:L`
 * - 滑走路区間: `${runwayId}:${nodeA}~${nodeB}`
 * - 誘導路エッジ: レイアウトのエッジIDそのまま（twy_*）
 */

export type AirsideNodeKind =
  | 'taxiway'
  | 'intersection'
  | 'endpoint'
  | 'runwayEntry'
  | 'runwayThreshold'
  | 'runwayIntersection'
  | 'stand';

export interface AirsideNode {
  id: string;
  pos: Tile;
  kind: AirsideNodeKind;
  /** 滑走路上のノードの場合の滑走路ID */
  runwayIds: string[];
  /** このノードを入口とするスポット */
  standIds: string[];
  /** 滑走路入口での停止義務 */
  holdShort: boolean;
  operational: boolean;
}

export type AirsideEdgeKind = 'taxiway' | 'runway' | 'standLink';

export interface AirsideEdge {
  id: string;
  kind: AirsideEdgeKind;
  /** 元になったレイアウト上のエンティティID */
  sourceId: string;
  from: string;
  to: string;
  /** false の場合 from → to の一方通行 */
  bidirectional: boolean;
  lengthM: number;
  /** 通行可能な最大機体区分。null は通行不可（短すぎる滑走路など） */
  maxSize: SizeClass | null;
  /** コード F（翼幅 65〜80 m）の機体が通行できるか（ゲームの適合ルール: 誘導路・スポットは指定、滑走路は幅 60 m） */
  codeF: boolean;
  operational: boolean;
  runwayId?: string;
  /**
   * 滑走路入口ノードに接続する誘導路エッジの場合、そのノードで停止義務があるか。
   * 航空機はこのエッジから滑走路ノードへ進む前に滑走路の使用許可が必要になる。
   */
  holdShortAt?: { nodeId: string; runwayId: string };
}

/** 滑走路どうしの交差点（自由形が関与する組だけ） */
export interface RunwayCrossingPoint {
  /** `${a}:X:${b}`（a < b）。組の ID */
  id: string;
  a: string;
  b: string;
  /** 交差点のネットワークノード（新規の runwayIntersection、または同じ位置の誘導路ノード） */
  nodeId: string;
  /** 各滑走路の始点から交差点までの位置（0..1） */
  tA: number;
  tB: number;
}

export interface AirsideNetwork {
  nodes: Record<string, AirsideNode>;
  edges: Record<string, AirsideEdge>;
  /** ノードから出発できるエッジ（向きを考慮） */
  outgoing: Record<string, string[]>;
  /** ノードへ到着するエッジ（向きを考慮） */
  incoming: Record<string, string[]>;
  /** 滑走路ID → 滑走路上のノードID（始点側から順） */
  runwayNodes: Record<string, string[]>;
  /** スポットID → 接続先の誘導路ノード（未接続なら無し） */
  standLinks: Record<string, string>;
  /** 滑走路どうしの交差点。自由形が関与する交差があるときだけ存在する（従来形だけなら欠落） */
  crossings?: RunwayCrossingPoint[];
}

/** nodes の中で p から POS_EPS_T 以内の最も近いノード（同距離は ID 順） */
function nodeNear(nodes: Record<string, AirsideNode>, p: Tile): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const n of Object.values(nodes)) {
    const dist = Math.hypot(n.pos.x - p.x, n.pos.y - p.y);
    if (dist > POS_EPS_T) continue;
    if (dist < bestD || (dist === bestD && best !== undefined && compareIds(n.id, best) < 0)) {
      best = n.id;
      bestD = dist;
    }
  }
  return best;
}

/**
 * 滑走路どうしの交差点ノードを作る（少なくとも一方が自由形の組だけ。従来形どうしは対象外）。
 * 中心線が 1 点で交わる（端点での T 字を含む）組に、`${a}:X:${b}` のノードを作る。
 * 共線で重なる組（overlap）は作らない（検証でエラー）。
 */
function addRunwayIntersections(
  layout: AirportLayout,
  nodes: Record<string, AirsideNode>,
): { extra: Record<string, { t: number; id: string }[]>; crossings: RunwayCrossingPoint[] } {
  const extra: Record<string, { t: number; id: string }[]> = {};
  const crossings: RunwayCrossingPoint[] = [];
  const rs = sortedValues(layout.runways);
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const ra = rs[i]!;
      const rb = rs[j]!;
      if (!isFreeRunway(ra) && !isFreeRunway(rb)) continue;
      const [a, b] = compareIds(ra.id, rb.id) < 0 ? [ra, rb] : [rb, ra];
      const xa = runwayAxis(a);
      const xb = runwayAxis(b);
      const c = classifySegmentIntersection(xa.start, xa.end, xb.start, xb.end);
      if (c.kind !== 'point') continue;
      const tA = c.atEndA ? (c.t < 0.5 ? 0 : 1) : c.t;
      const tB = c.atEndB ? (c.u < 0.5 ? 0 : 1) : c.u;
      const id = `${a.id}:X:${b.id}`;
      let nodeId = nodeNear(nodes, c.p);
      if (nodeId === undefined) {
        nodeId = id;
        nodes[id] = { id, pos: { x: c.p.x, y: c.p.y }, kind: 'runwayIntersection', runwayIds: [a.id, b.id], standIds: [], holdShort: false, operational: false };
      } else {
        // 誘導路ノードの runwayIds は下の滑走路のループが付ける。既に作った交差点ノードの再利用だけここで足す
        const n = nodes[nodeId]!;
        if (n.kind === 'runwayIntersection') for (const rid of [a.id, b.id]) if (!n.runwayIds.includes(rid)) n.runwayIds.push(rid);
      }
      (extra[a.id] ??= []).push({ t: tA, id: nodeId });
      (extra[b.id] ??= []).push({ t: tB, id: nodeId });
      crossings.push({ id, a: a.id, b: b.id, nodeId, tA, tB });
    }
  }
  return { extra, crossings };
}

export function buildAirsideNetwork(layout: AirportLayout): AirsideNetwork {
  const nodes: Record<string, AirsideNode> = {};
  const edges: Record<string, AirsideEdge> = {};
  const runwayNodes: Record<string, string[]> = {};
  const standLinks: Record<string, string> = {};

  // 誘導路ノード
  for (const n of sortedValues(layout.taxiNodes)) {
    const degree = edgesOfNode(layout.taxiways, n.id).length;
    nodes[n.id] = {
      id: n.id,
      pos: n.pos,
      kind: degree >= 3 ? 'intersection' : degree <= 1 ? 'endpoint' : 'taxiway',
      runwayIds: [],
      standIds: [],
      holdShort: false,
      operational: false,
    };
  }

  // 誘導路エッジ
  for (const e of sortedValues(layout.taxiways)) {
    const a = layout.taxiNodes[e.from];
    const b = layout.taxiNodes[e.to];
    if (!a || !b) continue;
    edges[e.id] = {
      id: e.id,
      kind: 'taxiway',
      sourceId: e.id,
      from: e.from,
      to: e.to,
      bidirectional: !e.oneWay,
      lengthM: Math.round(distance(a.pos, b.pos) * TILE_M),
      // 2026-CF: 幅区分 'F' は (maxSize 'L', codeF true) と等価。旧表現 (L ＋ codeF) の移行後も導出は同一
      maxSize: e.widthClass === 'F' ? 'L' : e.widthClass,
      codeF: e.widthClass === 'F',
      operational: e.buildState === 'operational',
    };
  }

  // 滑走路どうしの交差点（自由形が関与する組だけ。従来形だけなら何もしない）
  const hasFree = Object.values(layout.runways).some(isFreeRunway);
  const { extra, crossings } = hasFree ? addRunwayIntersections(layout, nodes) : { extra: {}, crossings: [] };

  // 滑走路: 中心線上のノード（端 + 入口）を順に結ぶ
  for (const r of sortedValues(layout.runways)) {
    const maxSize = runwayMaxSize(r);
    const operational = r.buildState === 'operational';
    const onLine: { t: number; id: string }[] = [];
    for (const n of sortedValues(layout.taxiNodes)) {
      const t = positionOnRunway(r, n.pos);
      if (t === null) continue;
      onLine.push({ t, id: n.id });
      const node = nodes[n.id]!;
      node.kind = 'runwayEntry';
      node.runwayIds.push(r.id);
      node.holdShort = n.holdShort;
    }
    // 交差点ノード（同じノードが既に中心線上にあれば重複させない）
    const crossHere = extra[r.id] ?? [];
    for (const x of crossHere) {
      if (onLine.some((o) => o.id === x.id)) continue;
      onLine.push(x);
      const node = nodes[x.id]!;
      if (node.kind !== 'runwayIntersection' && !node.runwayIds.includes(r.id)) node.runwayIds.push(r.id);
    }
    const ends: [number, Tile, string][] = [
      [0, r.start, `${r.id}:T0`],
      [1, runwayEnd(r), `${r.id}:T1`],
    ];
    for (const [t, pos, id] of ends) {
      // 自由形（と交差点を持つ滑走路）は中心線上の位置 t で判定する（終点が実数のため。従来形は従来の厳密一致）
      const covered = isFreeRunway(r) || crossHere.length > 0 ? onLine.some((o) => o.t === t) : !!findNodeAt(layout.taxiNodes, pos);
      if (covered) continue;
      nodes[id] = { id, pos, kind: 'runwayThreshold', runwayIds: [r.id], standIds: [], holdShort: false, operational: false };
      onLine.push({ t, id });
    }
    onLine.sort((x, y) => x.t - y.t || compareIds(x.id, y.id));
    runwayNodes[r.id] = onLine.map((o) => o.id);
    for (let i = 0; i + 1 < onLine.length; i++) {
      const from = onLine[i]!.id;
      const to = onLine[i + 1]!.id;
      const id = `${r.id}:${from}~${to}`;
      edges[id] = {
        id,
        kind: 'runway',
        sourceId: r.id,
        from,
        to,
        bidirectional: true,
        lengthM: Math.round(distance(nodes[from]!.pos, nodes[to]!.pos) * TILE_M),
        maxSize,
        codeF: maxSize === 'L' && r.surfaceWidthM >= 60,
        operational,
        runwayId: r.id,
      };
    }
  }

  // 滑走路入口に接続する誘導路エッジに停止義務を付ける
  for (const e of Object.values(edges)) {
    if (e.kind !== 'taxiway') continue;
    const fromRwy = nodes[e.from]!.runwayIds;
    const toRwy = nodes[e.to]!.runwayIds;
    // 両端が同じ滑走路上 = 滑走路上を走る誘導路（検証でエラーにする）
    if (fromRwy.some((r) => toRwy.includes(r))) continue;
    const [nodeId, rwys] = toRwy.length > 0 ? [e.to, toRwy] : fromRwy.length > 0 ? [e.from, fromRwy] : [null, []];
    if (nodeId && nodes[nodeId]!.holdShort) e.holdShortAt = { nodeId, runwayId: rwys[0]! };
  }

  // スポット
  for (const s of sortedValues(layout.stands)) {
    const entry = standEntry(s);
    // 旧寸法で作られたセーブは入口タイルが旧位置にある。新入口にノードが無ければ旧入口でも探す（互換）
    const entryNode = findNodeAt(layout.taxiNodes, entry) ?? findNodeAt(layout.taxiNodes, legacyStandEntry(s));
    const dims = standDims(s);
    const c: Vec2 = rectCenter(s.origin, dims.w, dims.h);
    const pid = `${s.id}:P`;
    nodes[pid] = {
      id: pid,
      pos: mapToWorld(c),
      kind: 'stand',
      runwayIds: [],
      standIds: [s.id],
      holdShort: false,
      operational: s.buildState === 'operational',
    };
    if (!entryNode) continue;
    standLinks[s.id] = entryNode;
    nodes[entryNode]!.standIds.push(s.id);
    const lid = `${s.id}:L`;
    edges[lid] = {
      id: lid,
      kind: 'standLink',
      sourceId: s.id,
      from: entryNode,
      to: pid,
      bidirectional: true,
      lengthM: Math.round(distance(nodes[entryNode]!.pos, nodes[pid]!.pos) * TILE_M),
      maxSize: s.size,
      codeF: s.size === 'L' && !!s.codeF,
      operational: s.buildState === 'operational',
    };
  }

  const outgoing: Record<string, string[]> = {};
  const incoming: Record<string, string[]> = {};
  for (const id of Object.keys(nodes)) {
    outgoing[id] = [];
    incoming[id] = [];
  }
  for (const e of Object.values(edges)) {
    outgoing[e.from]!.push(e.id);
    incoming[e.to]!.push(e.id);
    if (e.bidirectional) {
      outgoing[e.to]!.push(e.id);
      incoming[e.from]!.push(e.id);
    }
    if (e.operational) {
      nodes[e.from]!.operational = true;
      nodes[e.to]!.operational = true;
    }
  }
  const net: AirsideNetwork = { nodes, edges, outgoing, incoming, runwayNodes, standLinks };
  if (crossings.length > 0) net.crossings = crossings;
  return net;
}

export interface UseOptions {
  /** 運用中（完成済み）のエッジのみを使う */
  operationalOnly?: boolean;
  /** コード F 対応のエッジのみを使う（翼幅 65 m 以上の機体） */
  codeF?: boolean;
}

/** 指定区分の航空機がこのエッジを通行できるか */
export function canAircraftUse(edge: AirsideEdge, size: SizeClass, opts: UseOptions = {}): boolean {
  if (edge.maxSize === null || !sizeAtLeast(edge.maxSize, size)) return false;
  if (opts.codeF && !edge.codeF) return false;
  if (opts.operationalOnly && !edge.operational) return false;
  return true;
}

/** エッジを from 側から辿ったときの反対側ノード */
export function otherEnd(edge: AirsideEdge, nodeId: string): string {
  return edge.from === nodeId ? edge.to : edge.from;
}

/**
 * 到達可能なノード集合（幅優先探索）。
 * direction = 'forward': start から出発して行ける場所 / 'reverse': start に到着できる場所
 */
export function reachableNodes(
  net: AirsideNetwork,
  start: string,
  size: SizeClass | null,
  direction: 'forward' | 'reverse',
  opts: UseOptions = {},
): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  const adj = direction === 'forward' ? net.outgoing : net.incoming;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const eid of adj[cur] ?? []) {
      const e = net.edges[eid]!;
      if (size !== null && !canAircraftUse(e, size, opts)) continue;
      if (size === null && opts.operationalOnly && !e.operational) continue;
      const next = otherEnd(e, cur);
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
