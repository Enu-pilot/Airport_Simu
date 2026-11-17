import { TILE_M } from '../model/catalog';
import { compareIds, sortedValues } from '../model/ids';
import type { AirportLayout, SizeClass } from '../model/types';
import type { AirsideNetwork } from '../airside/network';
import { distance } from '../geometry/vec';
import { BLOCK_REQ_M, JUNCTION_STOP_M } from './rules';

/**
 * 誘導路の区間（フェーズ 2、taxiMode 'block'。docs/design/impl_phase2_plan.md §1.3・§2.1・§2.2）。
 * 配置の解析時に 1 回だけ作る純粋関数。実運航の状態は持たない（占有は SimState.taxiBlocks）。
 */

export type EndKind = 'junction' | 'runway' | 'standEntry' | 'endpoint' | 'split' | 'attr';

/** 区間がエッジ上で占める範囲（エッジの from からの距離。m） */
export interface TaxiBlockSpan {
  edgeId: string;
  fromM: number;
  toM: number;
  /** 区間の正規の向きが、このエッジの from → to の向きか */
  forward: boolean;
}

export interface TaxiBlock {
  /** `${segmentId}#${k}`（segmentId = 区切りの間の最初のエッジ ID） */
  id: string;
  /** 回廊 ID。入口の小片は '' */
  corridorId: string;
  /** 回廊の向きと正規の向きが同じか（回廊の向き = 正規の向きなら true） */
  corrFwd: boolean;
  spans: TaxiBlockSpan[];
  lengthM: number;
  /** 正規の向きの両端のノード。分割点は null */
  startNode: string | null;
  endNode: string | null;
  endKind: { start: EndKind; end: EndKind };
  /** 向きごとの使える長さ（長さ − 出口側の停止距離）。fwd = 正規の向き */
  usableM: { fwd: number; rev: number };
  /** 誘導路の上書き（進入可能機数の上限。最小値） */
  maxAircraft?: number;
  /** 滑走路手前の入口の小片（区間の枠を持たない。離陸・横断の許可を得た機体だけが入る） */
  entry?: boolean;
}

export interface TaxiCorridor {
  id: string;
  blocks: string[];
}

export interface TaxiBlockGraph {
  tiles: number;
  blocks: Record<string, TaxiBlock>;
  corridors: Record<string, TaxiCorridor>;
  /** 誘導路エッジ ID → 区間 ID（エッジの from からの順） */
  edgeBlocks: Record<string, string[]>;
  /** 同時に 1 機のノード（交差点・スポット入口・滑走路ノード） */
  junctions: Set<string>;
}

export interface BuildBlockOptions {
  /** 滑走路ノード nodeId に接続するエッジ（反対側 otherId、長さ m）の停止位置（nodeId から手前へ戻る距離、m） */
  holdShortM?: (nodeId: string, otherId: string, edgeLengthM: number) => number;
  /** 滑走路の保護範囲などで、滑走路ノードとして扱う追加のノード */
  runwayLikeNodes?: Iterable<string>;
}

const stopM = (k: EndKind): number => (k === 'junction' || k === 'standEntry' ? JUNCTION_STOP_M : 0);

interface SegEdge {
  edgeId: string;
  fwd: boolean;
  len: number;
}

export function buildTaxiBlocks(layout: AirportLayout, net: AirsideNetwork, tiles: number, opts: BuildBlockOptions = {}): TaxiBlockGraph {
  const graph: TaxiBlockGraph = { tiles, blocks: {}, corridors: {}, edgeBlocks: {}, junctions: new Set() };
  const extraRunway = new Set<string>(opts.runwayLikeNodes ?? []);
  const taxi = Object.values(net.edges)
    .filter((e) => e.kind === 'taxiway' && e.from !== e.to && net.nodes[e.from] && net.nodes[e.to])
    .sort((a, b) => compareIds(a.id, b.id));
  const len = (id: string): number => {
    const e = net.edges[id]!;
    return distance(net.nodes[e.from]!.pos, net.nodes[e.to]!.pos) * TILE_M;
  };
  const incident = new Map<string, string[]>();
  for (const e of taxi) {
    for (const n of [e.from, e.to]) {
      const l = incident.get(n) ?? [];
      l.push(e.id);
      incident.set(n, l);
    }
  }
  const isRunwayNode = (n: string): boolean => net.nodes[n]!.runwayIds.length > 0 || extraRunway.has(n);
  const maxOf = (id: string): number | undefined => layout.taxiways[net.edges[id]!.sourceId]?.blockMaxAircraft;
  const attr = (id: string): string => {
    const e = net.edges[id]!;
    return `${e.maxSize}|${e.bidirectional}|${e.codeF}|${maxOf(id) ?? ''}|${e.operational}`;
  };
  const forcedBreak = new Set<string>();
  const deg = (n: string): number => incident.get(n)?.length ?? 0;
  const attrBreak = (n: string): boolean => {
    const [a, b] = incident.get(n)!;
    if (attr(a!) !== attr(b!)) return true;
    const ea = net.edges[a!]!;
    const eb = net.edges[b!]!;
    if (!ea.bidirectional && !eb.bidirectional) {
      // 一方通行の向きが食い違う（両方がこのノードへ入る・両方が出る）ノードは区切る
      return (ea.to === n) !== (eb.from === n);
    }
    return false;
  };
  const isBreak = (n: string): boolean => deg(n) !== 2 || isRunwayNode(n) || net.nodes[n]!.standIds.length > 0 || forcedBreak.has(n) || attrBreak(n);
  const breakKind = (n: string): EndKind => {
    if (isRunwayNode(n)) return 'runway';
    if (deg(n) >= 3) return 'junction';
    if (net.nodes[n]!.standIds.length > 0) return 'standEntry';
    if (deg(n) <= 1) return 'endpoint';
    return 'attr';
  };

  // ---- 交差点
  for (const [n] of incident) {
    if (deg(n) >= 3 || net.nodes[n]!.standIds.length > 0 || isRunwayNode(n)) graph.junctions.add(n);
  }
  for (const id of Object.keys(net.nodes)) if (isRunwayNode(id)) graph.junctions.add(id);

  // ---- セグメント（区切りの間）
  const used = new Set<string>();
  const segments: { id: string; edges: SegEdge[]; a: string; b: string }[] = [];
  const trace = (start: string, first: string): void => {
    const list: SegEdge[] = [];
    let cur = start;
    let eid = first;
    for (;;) {
      used.add(eid);
      const e = net.edges[eid]!;
      list.push({ edgeId: eid, fwd: e.from === cur, len: len(eid) });
      const next = e.from === cur ? e.to : e.from;
      if (isBreak(next) || next === start) {
        cur = next;
        break;
      }
      const nextEdge = incident.get(next)!.find((x) => x !== eid && !used.has(x));
      if (!nextEdge) {
        cur = next;
        break;
      }
      cur = next;
      eid = nextEdge;
    }
    let a = start;
    let b = cur;
    let edges = list;
    if (compareIds(b, a) < 0) {
      edges = [...list].reverse().map((x) => ({ ...x, fwd: !x.fwd }));
      [a, b] = [b, a];
    }
    segments.push({ id: edges[0]!.edgeId, edges, a, b });
  };
  const sweep = (): void => {
    for (const n of [...incident.keys()].sort(compareIds)) {
      if (!isBreak(n)) continue;
      for (const eid of incident.get(n)!) if (!used.has(eid)) trace(n, eid);
    }
  };
  sweep();
  for (;;) {
    // 区切りのない環状の誘導路: 最小のノードを区切りにして作り直す
    const rest = taxi.filter((e) => !used.has(e.id));
    if (rest.length === 0) break;
    const n = [...new Set(rest.flatMap((e) => [e.from, e.to]))].sort(compareIds)[0]!;
    forcedBreak.add(n);
    sweep();
  }
  segments.sort((x, y) => compareIds(x.id, y.id));

  // ---- 区間
  const joins = new Map<string, string[]>(); // 区間をつなぐノード（次数 2）→ 区間 ID
  const cutJoin = new Map<string, string[]>(); // 分割点
  const sideKey = new Map<string, { start: string; end: string }>();
  const tilesM = tiles * TILE_M;
  const rawBlocks: TaxiBlock[] = [];
  const spansOf = (edges: SegEdge[], lo: number, hi: number): TaxiBlockSpan[] => {
    const out: TaxiBlockSpan[] = [];
    let c0 = 0;
    for (const se of edges) {
      const c1 = c0 + se.len;
      const a = Math.max(lo, c0);
      const b = Math.min(hi, c1);
      if (b - a > 1e-9 || (hi - lo <= 1e-9 && a <= b)) {
        const m1 = se.fwd ? a - c0 : c1 - a;
        const m2 = se.fwd ? b - c0 : c1 - b;
        out.push({ edgeId: se.edgeId, fromM: Math.min(m1, m2), toM: Math.max(m1, m2), forward: se.fwd });
      }
      c0 = c1;
    }
    return out;
  };
  for (const seg of segments) {
    const Ls = seg.edges.reduce((s, e) => s + e.len, 0);
    const lastEdge = (atStart: boolean): { other: string; len: number } => {
      const se = atStart ? seg.edges[0]! : seg.edges[seg.edges.length - 1]!;
      const e = net.edges[se.edgeId]!;
      const node = atStart ? seg.a : seg.b;
      return { other: e.from === node ? e.to : e.from, len: se.len };
    };
    const holdAt = (atStart: boolean): number => {
      const node = atStart ? seg.a : seg.b;
      if (!isRunwayNode(node)) return 0;
      const le = lastEdge(atStart);
      return opts.holdShortM ? opts.holdShortM(node, le.other, le.len) : Math.min(87.5, le.len * 0.6);
    };
    const hs = holdAt(true);
    const he = holdAt(false);
    const kStart = isBreak(seg.a) ? breakKind(seg.a) : 'attr';
    const kEnd = isBreak(seg.b) ? breakKind(seg.b) : 'attr';
    type Piece = { lo: number; hi: number; entry: boolean };
    const pieces: Piece[] = [];
    if (hs + he >= Ls - 1e-9 && (hs > 0 || he > 0)) {
      // 浅い角度などで停止位置がセグメント全体に及ぶ: 全体を入口の小片にする
      pieces.push({ lo: 0, hi: Ls, entry: true });
    } else {
      if (hs > 0) pieces.push({ lo: 0, hi: hs, entry: true });
      const lm = Ls - hs - he;
      const n = Math.max(1, Math.ceil(lm / tilesM - 1e-9));
      for (let k = 0; k < n; k++) pieces.push({ lo: hs + (lm * k) / n, hi: k === n - 1 ? Ls - he : hs + (lm * (k + 1)) / n, entry: false });
      if (he > 0) pieces.push({ lo: Ls - he, hi: Ls, entry: true });
    }
    const m = pieces.length;
    pieces.forEach((p, k) => {
      const id = `${seg.id}#${k}`;
      const prevEntry = k > 0 && pieces[k - 1]!.entry;
      const nextEntry = k < m - 1 && pieces[k + 1]!.entry;
      const startKind: EndKind = k === 0 ? kStart : p.entry ? 'runway' : prevEntry ? 'split' : 'split';
      const endKind: EndKind = k === m - 1 ? kEnd : nextEntry ? 'runway' : 'split';
      const sKey = k === 0 ? `n:${seg.a}` : `c:${seg.id}@${k}`;
      const eKey = k === m - 1 ? `n:${seg.b}` : `c:${seg.id}@${k + 1}`;
      sideKey.set(id, { start: sKey, end: eKey });
      const lengthM = p.hi - p.lo;
      const b: TaxiBlock = {
        id,
        corridorId: '',
        corrFwd: true,
        spans: spansOf(seg.edges, p.lo, p.hi),
        lengthM,
        startNode: k === 0 ? seg.a : null,
        endNode: k === m - 1 ? seg.b : null,
        endKind: { start: p.entry && k === 0 ? 'runway' : startKind, end: p.entry && k === m - 1 ? 'runway' : endKind },
        usableM: { fwd: Math.max(0, lengthM - stopM(endKind)), rev: Math.max(0, lengthM - stopM(startKind)) },
      };
      let mx: number | undefined;
      for (const sp of b.spans) {
        const v = maxOf(sp.edgeId);
        if (v !== undefined) mx = mx === undefined ? v : Math.min(mx, v);
      }
      if (mx !== undefined) b.maxAircraft = mx;
      if (p.entry) {
        b.entry = true;
        b.usableM = { fwd: 0, rev: 0 };
      }
      rawBlocks.push(b);
      graph.blocks[id] = b;
    });
    // 回廊の接続: 次数 2 の区切りのノード（スポット入口・条件の変わり目）と分割点
    for (let k = 0; k + 1 < m; k++) {
      if (pieces[k]!.entry || pieces[k + 1]!.entry) continue;
      (cutJoin.get(`c:${seg.id}@${k + 1}`) ?? cutJoin.set(`c:${seg.id}@${k + 1}`, []).get(`c:${seg.id}@${k + 1}`)!).push(`${seg.id}#${k}`, `${seg.id}#${k + 1}`);
    }
    for (const [node, k] of [[seg.a, 0], [seg.b, m - 1]] as const) {
      if (pieces[k]!.entry) continue;
      if (deg(node) === 2 && !isRunwayNode(node)) {
        const l = joins.get(node) ?? [];
        l.push(`${seg.id}#${k}`);
        joins.set(node, l);
      }
    }
  }

  // ---- 回廊（次数 2 でつながる区間の最大の列）
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (x: string, y: string): void => {
    const a = find(x);
    const b = find(y);
    if (a !== b) parent.set(compareIds(a, b) < 0 ? b : a, compareIds(a, b) < 0 ? a : b);
  };
  const real = rawBlocks.filter((b) => !b.entry);
  for (const b of real) parent.set(b.id, b.id);
  for (const l of [...joins.values(), ...cutJoin.values()]) for (let i = 1; i < l.length; i++) union(l[0]!, l[i]!);
  const groups = new Map<string, TaxiBlock[]>();
  for (const b of real) (groups.get(find(b.id)) ?? groups.set(find(b.id), []).get(find(b.id))!).push(b);
  // 隣接（側のキー → 区間）
  const byKey = new Map<string, TaxiBlock[]>();
  for (const b of real) {
    const k = sideKey.get(b.id)!;
    for (const key of [k.start, k.end]) (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(b);
  }
  // 隣接は次数 2 のノード（ちょうど 2 区間が接する）か分割点だけ
  for (const [root, list] of [...groups.entries()].sort((x, y) => compareIds(x[0], y[0]))) {
    list.sort((x, y) => compareIds(x.id, y.id));
    const cid = `C:${list[0]!.id}`;
    graph.corridors[cid] = { id: cid, blocks: list.map((b) => b.id) };
    for (const b of list) b.corridorId = cid;
    void root;
    // 向きの定義: 最初の区間の正規の向きを回廊の向きとし、隣へ伝える
    const seen = new Set<string>([list[0]!.id]);
    const stack = [list[0]!];
    list[0]!.corrFwd = true;
    while (stack.length > 0) {
      const b = stack.pop()!;
      const k = sideKey.get(b.id)!;
      for (const side of ['start', 'end'] as const) {
        const key = k[side];
        const nbs = (byKey.get(key) ?? []).filter((x) => x.id !== b.id && x.corridorId === cid);
        const leavingChain = (b.corrFwd && side === 'end') || (!b.corrFwd && side === 'start');
        for (const nb of nbs) {
          if (seen.has(nb.id)) continue;
          const nk = sideKey.get(nb.id)!;
          nb.corrFwd = leavingChain ? nk.start === key : nk.end === key;
          seen.add(nb.id);
          stack.push(nb);
        }
      }
    }
    // 回廊の並び順は正規の向きの連鎖に沿う（表示・検査用）。未到達の区間（環など）は ID 順のまま
  }

  // ---- エッジ → 区間
  for (const b of rawBlocks) for (const sp of b.spans) (graph.edgeBlocks[sp.edgeId] ??= []).push(b.id);
  for (const [eid, ids] of Object.entries(graph.edgeBlocks)) {
    const minFrom = (id: string): number => Math.min(...graph.blocks[id]!.spans.filter((s) => s.edgeId === eid).map((s) => s.fromM));
    ids.sort((x, y) => minFrom(x) - minFrom(y) || compareIds(x, y));
    graph.edgeBlocks[eid] = [...new Set(ids)];
  }
  void sortedValues;
  return graph;
}

// ---------------------------------------------------------------- 進入可能機数（2-02）

/** 向き dir（正規の向き = +1）の使える長さ */
export const blockUsableM = (b: TaxiBlock, dir: 1 | -1): number => (dir === 1 ? b.usableM.fwd : b.usableM.rev);

/**
 * 区間 b に向き dir で、すでに sizes の機体がいるときに大きさ s の機体が入れるか。
 * 空の区間には常に 1 機入れる。入れる条件: 必要長の合計 ≤ max(使える長さ, 必要長) かつ機数 < maxAircraft。
 */
export function admits(b: TaxiBlock, dir: 1 | -1, sizes: readonly SizeClass[], s: SizeClass): boolean {
  if (b.entry) return true;
  if (sizes.length === 0) return true;
  if (b.maxAircraft !== undefined && sizes.length >= b.maxAircraft) return false;
  let sum = BLOCK_REQ_M[s];
  for (const x of sizes) sum += BLOCK_REQ_M[x];
  return sum <= Math.max(blockUsableM(b, dir), BLOCK_REQ_M[s]) + 1e-9;
}

/** 同じ大きさの機体だけのときの進入可能機数（最小 1。maxAircraft で頭打ち） */
export function blockCapacity(b: TaxiBlock, dir: 1 | -1, s: SizeClass): number {
  if (b.entry) return 0;
  const cap = Math.max(1, Math.floor((blockUsableM(b, dir) + 1e-9) / BLOCK_REQ_M[s]));
  return b.maxAircraft !== undefined ? Math.min(cap, b.maxAircraft) : cap;
}

/** その大きさの機体が止まれない（通過専用）区間か */
export const isPassThrough = (b: TaxiBlock, dir: 1 | -1, s: SizeClass): boolean => !b.entry && blockUsableM(b, dir) + 1e-9 < BLOCK_REQ_M[s];

/**
 * 区間の通行能力（回/時）= min(cap × 3600 / 通過時間, 3600 × taxiSpeed / 必要長)。
 * cap は大きさ s の進入可能機数、通過時間 = 長さ / taxiSpeed。入口の小片は null（能力を持たない）。
 */
export function blockCapacityPerHour(b: TaxiBlock, s: SizeClass, taxiSpeed: number): number | null {
  if (b.entry || taxiSpeed <= 0) return null;
  const dir: 1 | -1 = 1;
  const cap = blockCapacity(b, dir, s);
  const transit = Math.max(1, b.lengthM / taxiSpeed);
  return Math.min((cap * 3600) / transit, (3600 * taxiSpeed) / BLOCK_REQ_M[s]);
}

/** 誘導路（エッジの集合）の通行能力（回/時）= 含む区間の最小。区間がなければ null */
export function taxiwayCapacityPerHour(graph: TaxiBlockGraph, edgeIds: readonly string[], s: SizeClass, taxiSpeed: number): number | null {
  let best: number | null = null;
  for (const eid of edgeIds) {
    for (const bid of graph.edgeBlocks[eid] ?? []) {
      const v = blockCapacityPerHour(graph.blocks[bid]!, s, taxiSpeed);
      if (v !== null && (best === null || v < best)) best = v;
    }
  }
  return best;
}
