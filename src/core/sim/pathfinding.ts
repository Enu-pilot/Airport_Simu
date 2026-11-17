import type { SizeClass } from '../model/types';
import { canAircraftUse, otherEnd, type AirsideNetwork } from '../airside/network';
import { CROSSING_PENALTY_SEC } from './rules';

/**
 * 誘導路ネットワーク上の経路探索（多始点・多終点ダイクストラ）。
 *
 * - 通れるのはネットワークのエッジのみ（接続していない区間へは進めない）
 * - 機体区分・一方通行・建設状態（運用中のみ）を守る
 * - 地上走行では滑走路の上を走らない（滑走路エッジは使わない）。滑走路の横断はノード経由で可能だがコストを加える
 * - スポット接続エッジは、始点・終点のスポットのものだけ使う
 * - 同コストの場合はノードIDの辞書順で決まる（決定的）
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

export function findPath(net: AirsideNetwork, q: PathQuery): PathResult | null {
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
      const nc = cost + e.lengthM / speed + crossing;
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
