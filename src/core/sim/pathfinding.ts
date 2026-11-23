import type { SizeClass } from '../model/types';
import { canAircraftUse, otherEnd, type AirsideNetwork } from '../airside/network';
import {
  CROSSING_PENALTY_SEC,
  TAXI_CONGESTION_CAP_SEC,
  TAXI_CONGESTION_PER_AIRCRAFT_SEC,
  TAXI_JITTER_MAX_SEC,
  TAXI_JITTER_RATIO,
} from './rules';

/**
 * 誘導路ネットワーク上の経路探索（多始点・多終点ダイクストラ）。
 *
 * - 通れるのはネットワークのエッジのみ（接続していない区間へは進めない）
 * - 機体区分・一方通行・建設状態（運用中のみ）を守る
 * - 地上走行では滑走路の上を走らない（滑走路エッジは使わない）。滑走路の横断はノード経由で可能だがコストを加える
 * - スポット接続エッジは、始点・終点のスポットのものだけ使う
 * - 同コストの場合はノードIDの辞書順で決まる（決定的）
 * - 分散化（2026-TAXI）: 混雑コスト（edgeLoad）と、機体 ID ハッシュによる決定的ジッタ（jitterKey、最短 + δ 以内）で、
 *   並行誘導路や近似最短路へ経路を分散させる。どちらも乱数を使わず、同一入力では決定的に同じ結果になる
 */

export interface PathQuery {
  /** 始点ノードと初期コスト（秒） */
  sources: { node: string; cost: number }[];
  /** 終点ノードと到着時に加えるコスト（秒） */
  goals: Map<string, number>;
  size: SizeClass;
  /** コード F 対応のエッジのみ通る */
  codeF?: boolean;
  speed: number;
  /** 使ってよいスポット接続エッジのスポットID */
  allowStands?: readonly string[];
  /** 通れない（他機が予約中の）エッジ・ノード */
  blockedEdge?: (edgeId: string) => boolean;
  blockedNode?: (nodeId: string) => boolean;
  /** fromNode から edgeId へ進む動きが通れないか（区間ごとの走行: 逆向きの回廊など。なければ従来どおり） */
  blockedMove?: (edgeId: string, fromNode: string) => boolean;
  /** 決定的分散ジッタの種（機体 ID）。指定すると最短コスト + δ 以内の経路間で ID ハッシュにより決定的に分散する */
  jitterKey?: string;
  /** 混雑コストの負荷（エッジ ID → そのエッジを確定経路に含む走行中機体数） */
  edgeLoad?: ReadonlyMap<string, number>;
}

export interface PathResult {
  nodes: string[];
  edges: string[];
  cost: number;
}

/** (cost, id) の最小ヒープ */
class Heap {
  private items: { cost: number; node: string }[] = [];
  get size(): number {
    return this.items.length;
  }
  private less(a: { cost: number; node: string }, b: { cost: number; node: string }): boolean {
    return a.cost < b.cost || (a.cost === b.cost && a.node < b.node);
  }
  push(item: { cost: number; node: string }): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): { cost: number; node: string } {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * 決定的なハッシュを [0, 1) に写した値。sim の RNG は使わない（Z1 のジッタ用）。
 * FNV-1a だけでは末尾だけが違う ID（ac_12 と twy_3 等）で値が近接してしまうため、
 * splitmix32 のフィナライザでビットを十分に拡散させる。
 */
export function deterministicHash01(a: string, b: string): number {
  let h = 0x811c9dc5;
  const s = `${a}\n${b}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** 混雑コスト（秒）: 負荷 1 機あたり TAXI_CONGESTION_PER_AIRCRAFT_SEC、1 エッジあたり上限 TAXI_CONGESTION_CAP_SEC */
function congestionSec(q: PathQuery, edgeId: string): number {
  const load = q.edgeLoad?.get(edgeId) ?? 0;
  return load > 0 ? Math.min(load * TAXI_CONGESTION_PER_AIRCRAFT_SEC, TAXI_CONGESTION_CAP_SEC) : 0;
}

export function findPath(net: AirsideNetwork, q: PathQuery): PathResult | null {
  const base = searchPath(net, q, (eid) => congestionSec(q, eid));
  if (!base || !q.jitterKey) return base;
  // Z1: 最短（混雑込み）コスト + δ の内側で、機体 ID ハッシュのジッタにより決定的に分散する。
  // ジッタは各エッジの走行時間に比例させる（経路全体のジッタ合計は α × 走行時間以下）ため、
  // 選ばれた経路の実コストは base.cost + δ を超えない
  const delta = Math.min(base.cost * TAXI_JITTER_RATIO, TAXI_JITTER_MAX_SEC);
  if (delta <= 0 || base.cost <= 0) return base;
  const alpha = delta / base.cost;
  const key = q.jitterKey;
  const jittered = searchPath(net, q, (eid, travel) => congestionSec(q, eid) + deterministicHash01(key, eid) * alpha * travel);
  if (!jittered) return base;
  // 返却コストはジッタ抜きの実コスト（呼び出し側の比較は従来どおりの意味になる）
  return { nodes: jittered.nodes, edges: jittered.edges, cost: trueCostSec(net, q, jittered) };
}

/** ジッタ抜きの実コスト（走行時間＋横断ペナルティ＋混雑コスト＋始点・目標コスト）を経路から再計算する */
function trueCostSec(net: AirsideNetwork, q: PathQuery, path: PathResult): number {
  let cost = Infinity;
  for (const s of q.sources) if (s.node === path.nodes[0]) cost = Math.min(cost, s.cost);
  if (!Number.isFinite(cost)) cost = 0;
  for (let i = 0; i < path.edges.length; i++) {
    const e = net.edges[path.edges[i]!]!;
    const speed = e.kind === 'standLink' ? 2 : q.speed;
    cost += e.lengthM / speed + congestionSec(q, e.id);
    const next = path.nodes[i + 1]!;
    if (net.nodes[next]!.runwayIds.length > 0 && !q.goals.has(next)) cost += CROSSING_PENALTY_SEC;
  }
  return cost + (q.goals.get(path.nodes[path.nodes.length - 1]!) ?? 0);
}

function searchPath(
  net: AirsideNetwork,
  q: PathQuery,
  extra: (edgeId: string, travelSec: number) => number,
): PathResult | null {
  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string; edge: string }>();
  const done = new Set<string>();
  const heap = new Heap();
  const allow = new Set(q.allowStands ?? []);

  for (const s of q.sources) {
    if (!net.nodes[s.node] || q.blockedNode?.(s.node)) continue;
    if (s.cost < (dist.get(s.node) ?? Infinity)) {
      dist.set(s.node, s.cost);
      heap.push({ cost: s.cost, node: s.node });
    }
  }

  let best: { node: string; cost: number } | null = null;
  while (heap.size > 0) {
    const { cost, node } = heap.pop();
    if (done.has(node) || cost > (dist.get(node) ?? Infinity)) continue;
    done.add(node);
    if (best && cost >= best.cost) break;
    const goalCost = q.goals.get(node);
    if (goalCost !== undefined) {
      const total = cost + goalCost;
      if (!best || total < best.cost || (total === best.cost && node < best.node)) best = { node, cost: total };
    }
    for (const eid of net.outgoing[node] ?? []) {
      const e = net.edges[eid]!;
      if (e.kind === 'runway') continue;
      if (e.kind === 'standLink' && !allow.has(e.sourceId)) continue;
      if (!canAircraftUse(e, q.size, { operationalOnly: true, codeF: !!q.codeF })) continue;
      if (q.blockedEdge?.(eid)) continue;
      if (q.blockedMove?.(eid, node)) continue;
      const next = otherEnd(e, node);
      if (q.blockedNode?.(next)) continue;
      const nextNode = net.nodes[next]!;
      const speed = e.kind === 'standLink' ? 2 : q.speed;
      // 終点以外で滑走路上のノードを通る = 滑走路の横断
      const crossing = nextNode.runwayIds.length > 0 && !q.goals.has(next) ? CROSSING_PENALTY_SEC : 0;
      const travel = e.lengthM / speed;
      const nc = cost + travel + crossing + extra(eid, travel);
      if (nc < (dist.get(next) ?? Infinity)) {
        dist.set(next, nc);
        prev.set(next, { node, edge: eid });
        heap.push({ cost: nc, node: next });
      }
    }
  }
  if (!best) return null;

  const nodes = [best.node];
  const edges: string[] = [];
  let cur = best.node;
  while (prev.has(cur)) {
    const p = prev.get(cur)!;
    edges.unshift(p.edge);
    nodes.unshift(p.node);
    cur = p.node;
  }
  return { nodes, edges, cost: best.cost };
}
