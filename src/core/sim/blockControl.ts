import { compareIds, sortedValues } from '../model/ids';
import type { SizeClass } from '../model/types';
import type { SimContext } from './context';
import { resolveType } from './aircraftTypes';
import { holdShortOnRoute } from './routes';
import { BLOCK_REQ_M, DIR_FAIRNESS_SEC, FOLLOW_GAP_M, JUNCTION_STOP_M, MIN_GROUND_SEPARATION_M, STALL_SEC } from './rules';
import { admits, blockUsableM, isPassThrough, type EndKind } from './taxiBlocks';
import type { Aircraft, Route, SimState } from './types';

/**
 * 区間ごとに進む地上走行の制御（フェーズ 2、taxiMode 'block'。docs/design/impl_phase2_plan.md §2.3〜§2.4）。
 * 状態は SimState.taxiBlocks（occ・locks）。経路 → 区間の対応は派生データでキャッシュする（保存しない）。
 * 乱数・実時間は使わない。走査は ID 順。
 */

export interface BlockRef {
  blockId: string;
  /** 区間の正規の向きに対する進行方向 */
  dir: 1 | -1;
  /** 回廊の向きに対する進行方向 */
  chainDir: 1 | -1;
  corridorId: string;
  enterDist: number;
  exitDist: number;
  /** 直前が滑走路ノードの入口の小片なら、その経路上のノード番号（なければ -1） */
  afterRunwayNode: number;
}

export interface RouteBlocks {
  refs: BlockRef[];
  byBlock: Map<string, BlockRef>;
}

const cache = new WeakMap<Route, RouteBlocks>();

const isRunwayLike = (ctx: SimContext, node: string): boolean => ctx.network.nodes[node]!.runwayIds.length > 0 || !!ctx.crossingNodeRunways[node];

export function routeBlocks(ctx: SimContext, r: Route): RouteBlocks {
  const hit = cache.get(r);
  if (hit) return hit;
  const g = ctx.blocks!;
  const refs: BlockRef[] = [];
  let lastRunway = -1;
  for (let i = 0; i < r.edges.length; i++) {
    const e = ctx.network.edges[r.edges[i]!]!;
    if (e.kind !== 'taxiway') continue;
    const ids = g.edgeBlocks[e.id];
    if (!ids) continue;
    const fwd = r.nodes[i] === e.from;
    const L = r.cum[i + 1]! - r.cum[i]!;
    for (const id of fwd ? ids : [...ids].reverse()) {
      const b = g.blocks[id]!;
      const sp = b.spans.find((s) => s.edgeId === e.id)!;
      const enter = fwd ? r.cum[i]! + sp.fromM : r.cum[i]! + (L - sp.toM);
      const exit = fwd ? r.cum[i]! + sp.toM : r.cum[i]! + (L - sp.fromM);
      if (b.entry) {
        if (isRunwayLike(ctx, r.nodes[i]!)) lastRunway = i;
        continue;
      }
      const last = refs[refs.length - 1];
      if (last && last.blockId === id) {
        last.exitDist = exit;
        continue;
      }
      const dir: 1 | -1 = sp.forward === fwd ? 1 : -1;
      refs.push({ blockId: id, dir, chainDir: b.corrFwd ? dir : (-dir as 1 | -1), corridorId: b.corridorId, enterDist: enter, exitDist: exit, afterRunwayNode: lastRunway });
      lastRunway = -1;
    }
  }
  const rb: RouteBlocks = { refs, byBlock: new Map(refs.map((x) => [x.blockId, x])) };
  cache.set(r, rb);
  return rb;
}

const endKindOf = (ctx: SimContext, ref: BlockRef): EndKind => {
  const b = ctx.blocks!.blocks[ref.blockId]!;
  return ref.dir === 1 ? b.endKind.end : b.endKind.start;
};
const startKindOf = (ctx: SimContext, ref: BlockRef): EndKind => {
  const b = ctx.blocks!.blocks[ref.blockId]!;
  return ref.dir === 1 ? b.endKind.start : b.endKind.end;
};
const stopOf = (k: EndKind): number => (k === 'junction' || k === 'standEntry' ? JUNCTION_STOP_M : 0);
/** この区間で止まる位置（経路上の距離） */
const stopDist = (ctx: SimContext, ref: BlockRef): number => ref.exitDist - stopOf(endKindOf(ctx, ref));

const lenOf = (ctx: SimContext, ac: Aircraft): number => resolveType(ctx.types, ac.typeId).lengthM;
const sizeOf = (ctx: SimContext, ac: Aircraft): SizeClass => resolveType(ctx.types, ac.typeId).size;
const passed = (ctx: SimContext, ac: Aircraft, ref: BlockRef): boolean => ac.dist - lenOf(ctx, ac) >= ref.exitDist - 1e-6;

export function createTaxiBlockState(): NonNullable<SimState['taxiBlocks']> {
  return { occ: {}, locks: {}, stats: { resolutions: 0, reroutes: 0, overruns: 0, unresolved: 0, nightStranded: 0 } };
}

// ---------------------------------------------------------------- 前進の上限

export interface BlockLimit {
  limit: number;
  /** 上限を決めた要因: 確保の範囲（grant）か、前の機体への追従（follow） */
  cause: 'grant' | 'follow' | null;
  leader?: string;
}

/** 区間の確保・追従から決まる前進の上限（経路上の距離）。区間のない経路・従来方式の機体は Infinity */
export function blockMovementLimit(sim: { ctx: SimContext; state: SimState }, ac: Aircraft): BlockLimit {
  const { ctx, state } = sim;
  const tb = state.taxiBlocks;
  const r = ac.route;
  if (!tb || !r || r.kind === 'takeoff' || !ctx.blocks) return { limit: Infinity, cause: null };
  const rb = routeBlocks(ctx, r);
  let limit = Infinity;
  let cause: BlockLimit['cause'] = null;
  let leader: string | undefined;
  let lastHeld: BlockRef | null = null;
  for (const ref of rb.refs) {
    if (passed(ctx, ac, ref)) continue;
    const occ = tb.occ[ref.blockId];
    const idx = occ ? occ.indexOf(ac.id) : -1;
    if (idx < 0) {
      const g = lastHeld ? stopDist(ctx, lastHeld) : ref.enterDist - stopOf(startKindOf(ctx, ref));
      if (g < limit) {
        limit = g;
        cause = 'grant';
        leader = undefined;
      }
      break;
    }
    lastHeld = ref;
    if (idx > 0) {
      const p = state.aircraft[occ![idx - 1]!];
      const pref = p?.route ? routeBlocks(ctx, p.route).byBlock.get(ref.blockId) : undefined;
      if (p && pref) {
        const lim = ref.enterDist + (p.dist - pref.enterDist) - lenOf(ctx, p) - FOLLOW_GAP_M;
        if (lim < limit) {
          limit = lim;
          cause = 'follow';
          leader = p.id;
        }
      }
    }
  }
  return { limit, cause, ...(leader ? { leader } : {}) };
}

// ---------------------------------------------------------------- 確保

export type AcquireFail = 'blockFull' | 'opposingTraffic';

interface ChainPlan {
  ok: true;
  blocks: BlockRef[];
  nodes: string[];
}

interface ChainFail {
  ok: false;
  reason: AcquireFail;
  /** 待っている相手（確保できない区間の占有機・交差点の予約機・優先中の機体） */
  blockers: string[];
}

/** 最初の未確保の区間の番号（経路の区間の数なら全部確保済み）と、その直前の確保済みの区間 */
function firstUnheld(ctx: SimContext, tb: NonNullable<SimState['taxiBlocks']>, ac: Aircraft, rb: RouteBlocks): number {
  for (let i = 0; i < rb.refs.length; i++) {
    const ref = rb.refs[i]!;
    if (passed(ctx, ac, ref)) continue;
    if (tb.occ[ref.blockId]?.includes(ac.id)) continue;
    return i;
  }
  return rb.refs.length;
}

/**
 * 次のチェーン（次に止まれる区間までの区間の枠と交差点）を作る。状態は変えない。
 * - 後続の区間が滑走路の向こう側（afterRunwayNode が経路の最初の滑走路ノードでない）なら、allowAfterRunway のときだけ。
 * - 入口の小片 + 機体が滑走路の解放位置を越えて止まれる最初の区間までを 1 つにする（滑走路上で止まらない）。
 */
function planChain(sim: { ctx: SimContext; state: SimState }, ac: Aircraft, route: Route, opts: { allowAfterRunway?: boolean; overrun?: boolean } = {}): ChainPlan | ChainFail | { ok: 'skip' } {
  const { ctx, state } = sim;
  const tb = state.taxiBlocks!;
  const g = ctx.blocks!;
  const rb = routeBlocks(ctx, route);
  const k = firstUnheld(ctx, tb, ac, rb);
  const size = sizeOf(ctx, ac);
  const len = lenOf(ctx, ac);
  const startIdx = route.kind === 'landing' ? Math.max(0, route.runwayEnd) : 0;
  const first = rb.refs[k];
  if (first && first.afterRunwayNode > (route.kind === 'landing' ? route.runwayEnd : -1) && !opts.allowAfterRunway) return { ok: 'skip' };
  const mustPass = first && first.afterRunwayNode >= 0 ? route.cum[first.afterRunwayNode]! + Math.max(holdShortOnRoute(ctx, route, first.afterRunwayNode, 1), len) : 0;
  const blocks: BlockRef[] = [];
  let exhausted = true;
  for (let i = k; i < rb.refs.length; i++) {
    const ref = rb.refs[i]!;
    const b = g.blocks[ref.blockId]!;
    const sizes = (tb.occ[ref.blockId] ?? []).filter((id) => id !== ac.id).map((id) => sizeOf(ctx, state.aircraft[id]!));
    if (!opts.overrun && !admits(b, ref.dir, sizes, size)) return { ok: false, reason: 'blockFull', blockers: (tb.occ[ref.blockId] ?? []).filter((id) => id !== ac.id) };
    blocks.push(ref);
    if (i === rb.refs.length - 1) break;
    if (!isPassThrough(b, ref.dir, size) && stopDist(ctx, ref) >= mustPass - 1e-6) {
      exhausted = false;
      break;
    }
  }
  const S = k > 0 ? rb.refs[k - 1]!.exitDist : route.cum[startIdx]!;
  const E = exhausted ? Infinity : blocks[blocks.length - 1]!.exitDist;
  const nodes: string[] = [];
  const lastNode = route.nodes.length - 1;
  for (let i = startIdx; i < route.nodes.length; i++) {
    const c = route.cum[i]!;
    if (c < S - 1e-6 || c >= E - 1e-6) continue;
    const n = route.nodes[i]!;
    if (!g.junctions.has(n)) continue;
    if (i === lastNode && isRunwayLike(ctx, n)) continue; // 離陸の進入ノードは整列の許可で確保する
    if ((state.nodeReservations[n] ?? ac.id) !== ac.id) return { ok: false, reason: 'blockFull', blockers: [state.nodeReservations[n]!] };
    nodes.push(n);
  }
  // 規則 4 の優先中の機体がいるとき、その機体の次のチェーンの区間・交差点は他機が新しく確保しない
  const prio = tb.priority && tb.priority !== ac.id ? state.aircraft[tb.priority] : undefined;
  if (prio?.route && prio.state !== 'scheduled') {
    const pp = planChain(sim, prio, prio.route, { allowAfterRunway: true, overrun: true });
    if (pp.ok === true && (pp.blocks.some((x) => blocks.some((y) => y.blockId === x.blockId)) || pp.nodes.some((n) => nodes.includes(n)))) return { ok: false, reason: 'blockFull', blockers: [prio.id] };
  }
  return { ok: true, blocks, nodes };
}

function commitChain(state: SimState, ac: Aircraft, plan: ChainPlan): void {
  const tb = state.taxiBlocks!;
  for (const ref of plan.blocks) {
    const list = (tb.occ[ref.blockId] ??= []);
    if (!list.includes(ac.id)) list.push(ac.id);
  }
  for (const n of plan.nodes) state.nodeReservations[n] = ac.id;
}

/** 経路の全回廊の向きを確保できるか（できなければ理由）。状態は変えない（record のときは対向待ちの公平性だけ記録する） */
function planLocks(sim: { ctx: SimContext; state: SimState }, ac: Aircraft, route: Route, record = false): Map<string, 1 | -1> | 'opposingTraffic' {
  const tb = sim.state.taxiBlocks!;
  const now = sim.state.now;
  const rb = routeBlocks(sim.ctx, route);
  const want = new Map<string, 1 | -1>();
  for (const ref of rb.refs) {
    if (!ref.corridorId) continue;
    const have = want.get(ref.corridorId);
    if (have !== undefined && have !== ref.chainDir) return 'opposingTraffic';
    want.set(ref.corridorId, ref.chainDir);
  }
  for (const [cid, dir] of want) {
    const lock = tb.locks[cid];
    if (lock && lock.dir !== dir && lock.holders.some((h) => h !== ac.id)) {
      if (record) {
        tb.oppWait ??= {};
        if (!tb.oppWait[cid] || !sim.state.aircraft[tb.oppWait[cid]!.acId]) tb.oppWait[cid] = { acId: ac.id, since: now };
      }
      return 'opposingTraffic';
    }
    // 公平性: 逆向きを DIR_FAIRNESS_SEC 以上待っている機体がいる回廊へは、同じ向きの新しい確保を止める（流れが切れて逆向きが通る）
    const w = tb.oppWait?.[cid];
    if (lock && lock.dir === dir && !lock.holders.includes(ac.id) && w && w.acId !== ac.id && now - w.since >= DIR_FAIRNESS_SEC) return 'opposingTraffic';
  }
  return want;
}

function commitLocks(state: SimState, ac: Aircraft, want: Map<string, 1 | -1>): void {
  const tb = state.taxiBlocks!;
  for (const [cid, dir] of want) {
    const lock = (tb.locks[cid] ??= { dir, holders: [] });
    lock.dir = dir;
    if (!lock.holders.includes(ac.id)) {
      lock.holders.push(ac.id);
      lock.holders.sort(compareIds);
    }
  }
  if (tb.oppWait) {
    for (const [cid, w] of Object.entries(tb.oppWait)) if (w.acId === ac.id) delete tb.oppWait[cid];
    if (Object.keys(tb.oppWait).length === 0) delete tb.oppWait;
  }
}

/** 逆向きの待ちを記録する（経路探索が逆向きの回廊を避けられず、迂回路もないとき）。状態は oppWait だけ変える */
export function noteOpposed(sim: { ctx: SimContext; state: SimState }, ac: Aircraft, route: Route): void {
  if (sim.state.taxiBlocks) planLocks(sim, ac, route, true);
}

export type AcquireResult = { ok: true } | { ok: false; reason: AcquireFail };

/** 経路を使い始める（プッシュバック・進入許可）: 全回廊の向き + 最初のチェーンをまとめて確保する。全部できたときだけ確保する */
export function acquireRoute(sim: { ctx: SimContext; state: SimState }, ac: Aircraft, route: Route): AcquireResult {
  const locks = planLocks(sim, ac, route, true);
  if (locks === 'opposingTraffic') return { ok: false, reason: 'opposingTraffic' };
  const prevRoute = ac.route;
  const prevDist = ac.dist;
  // firstUnheld は機体の位置（dist）を使うので、新しい経路の先頭で評価する
  ac.route = route;
  ac.dist = 0;
  let plan: ReturnType<typeof planChain>;
  try {
    plan = planChain(sim, ac, route, {});
  } finally {
    ac.route = prevRoute;
    ac.dist = prevDist;
  }
  if (plan.ok === false) return { ok: false, reason: plan.reason };
  commitLocks(sim.state, ac, locks);
  if (plan.ok === true) commitChain(sim.state, ac, plan);
  return { ok: true };
}

/** 次のチェーンの確保（走行中の要求・横断の許可）。確保するものがなければ ok */
export function acquireNext(sim: { ctx: SimContext; state: SimState }, ac: Aircraft, opts: { allowAfterRunway?: boolean; overrun?: boolean } = {}): AcquireResult | { ok: 'skip' } {
  const r = ac.route;
  if (!r || !sim.state.taxiBlocks || !sim.ctx.blocks) return { ok: true };
  const plan = planChain(sim, ac, r, opts);
  if (plan.ok === 'skip') return { ok: 'skip' };
  if (plan.ok === false) return { ok: false, reason: plan.reason };
  commitChain(sim.state, ac, plan);
  if (sim.state.taxiBlocks.priority === ac.id) {
    delete sim.state.taxiBlocks.priority;
    delete sim.state.taxiBlocks.priorityAt;
  }
  return { ok: true };
}

/** 確保待ち（次のチェーンがあり、滑走路の向こう側でない）か。停止位置までの距離（m）を返す。なければ null */
export function pendingChainDistance(sim: { ctx: SimContext; state: SimState }, ac: Aircraft): number | null {
  const tb = sim.state.taxiBlocks;
  const r = ac.route;
  if (!tb || !r || r.kind === 'takeoff') return null;
  const rb = routeBlocks(sim.ctx, r);
  const k = firstUnheld(sim.ctx, tb, ac, rb);
  const ref = rb.refs[k];
  if (!ref) return null;
  if (ref.afterRunwayNode > (r.kind === 'landing' ? r.runwayEnd : -1)) return null;
  const prev = k > 0 ? rb.refs[k - 1]! : null;
  const held = prev && tb.occ[prev.blockId]?.includes(ac.id);
  const stop = held ? stopDist(sim.ctx, prev!) : ref.enterDist - stopOf(startKindOf(sim.ctx, ref));
  return stop - ac.dist;
}

// ---------------------------------------------------------------- 解放

/** 尾部が通過した区間の占有と、使い終えた回廊の向きを外す（moveTaxi の releasePassed の隣） */
export function releaseBlocksPassed(sim: { ctx: SimContext; state: SimState }, ac: Aircraft): void {
  const tb = sim.state.taxiBlocks;
  const r = ac.route;
  if (!tb || !r || r.kind === 'takeoff' || !sim.ctx.blocks) return;
  const rb = routeBlocks(sim.ctx, r);
  const remaining = new Set<string>();
  for (const ref of rb.refs) {
    if (passed(sim.ctx, ac, ref)) {
      const list = tb.occ[ref.blockId];
      if (list?.includes(ac.id)) {
        const rest = list.filter((x) => x !== ac.id);
        if (rest.length === 0) delete tb.occ[ref.blockId];
        else tb.occ[ref.blockId] = rest;
      }
    } else if (ref.corridorId) remaining.add(ref.corridorId);
  }
  for (const ref of rb.refs) {
    if (!ref.corridorId || remaining.has(ref.corridorId)) continue;
    const lock = tb.locks[ref.corridorId];
    if (lock?.holders.includes(ac.id)) {
      lock.holders = lock.holders.filter((x) => x !== ac.id);
      if (lock.holders.length === 0) delete tb.locks[ref.corridorId];
    }
  }
}

// ---------------------------------------------------------------- 経路探索の通行止め（逆向きの回廊）

/** 他機が逆向きに確保している回廊へ入る動きか */
export function opposedMove(sim: { ctx: SimContext; state: SimState }, acId: string, edgeId: string, fromNode: string): boolean {
  const tb = sim.state.taxiBlocks;
  const g = sim.ctx.blocks;
  if (!tb || !g) return false;
  const ids = g.edgeBlocks[edgeId];
  if (!ids) return false;
  const e = sim.ctx.network.edges[edgeId]!;
  const fwd = e.from === fromNode;
  for (const id of ids) {
    const b = g.blocks[id]!;
    if (!b.corridorId) continue;
    const lock = tb.locks[b.corridorId];
    if (!lock) continue;
    const sp = b.spans.find((s) => s.edgeId === edgeId)!;
    const dir: 1 | -1 = sp.forward === fwd ? 1 : -1;
    const chainDir = b.corrFwd ? dir : (-dir as 1 | -1);
    if (lock.dir !== chainDir && lock.holders.some((h) => h !== acId)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 規則 4: 停止の検出と解消

const WAIT_REASONS = ['blockFull', 'opposingTraffic', 'runwayQueue'];

/** 規則 4 の 1 回の検査の結果 */
export interface StallReport {
  /** 閉路にいた機体（待ちの輪） */
  cycle: string[];
  action: 'priority' | 'overrun' | 'unresolved' | 'waiting';
  aircraftId: string;
}

/**
 * 規則 4（検出と解消）: 速度 0 で STALL_SEC 以上待っている機体の「待ちの相手」の閉路を探し、あれば最も長く待っている機体 X に
 * (ii) 優先（他機が X の次のチェーンを新しく確保しない）→ (iii) さらに STALL_SEC 進まなければ、機数を超えて X の次のチェーンに入れる、を順に行う。
 * (i)（経路の選び直し）は未実装。どれも効かなければ unresolved を数える。1 回の検査は O(待機機数 + 辺) と各待機機の確保の試行 1 回で、ティック内で繰り返さない。
 */
export function detectTaxiStall(sim: { ctx: SimContext; state: SimState }): StallReport[] {
  const { ctx, state } = sim;
  const tb = state.taxiBlocks;
  const out: StallReport[] = [];
  if (!tb || !ctx.blocks) return out;
  const stalled = sortedValues(state.aircraft).filter(
    (a) => a.route && ['taxiOut', 'taxiIn', 'vacating'].includes(a.state) && a.speed < 0.5 && a.waitSince !== null && state.now - a.waitSince >= STALL_SEC && a.holdReason !== null && WAIT_REASONS.includes(a.holdReason),
  );
  if (stalled.length === 0) {
    // 優先中の機体が動き出していれば解除する
    if (tb.priority && !state.aircraft[tb.priority]) {
      delete tb.priority;
      delete tb.priorityAt;
    }
    return out;
  }
  const edges = new Map<string, string[]>();
  for (const a of stalled) {
    const bl = blockMovementLimit(sim, a);
    let waitFor: string[] = [];
    if (bl.cause === 'follow' && bl.leader) waitFor = [bl.leader];
    else {
      const plan = planChain(sim, a, a.route!, { allowAfterRunway: false });
      if (plan.ok === false) waitFor = plan.blockers;
    }
    edges.set(a.id, [...new Set(waitFor)].sort(compareIds));
  }
  // 閉路の探索（ID 順の深さ優先）
  const color = new Map<string, 0 | 1 | 2>();
  const cycles: string[][] = [];
  const stack: string[] = [];
  const dfs = (u: string): void => {
    color.set(u, 1);
    stack.push(u);
    for (const v of edges.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) cycles.push(stack.slice(stack.indexOf(v)));
      else if (c === 0 && edges.has(v)) dfs(v);
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const a of stalled) if ((color.get(a.id) ?? 0) === 0) dfs(a.id);
  if (cycles.length === 0) return out;
  for (const cyc of cycles) {
    const members = cyc.map((id) => state.aircraft[id]!).sort((p, q) => (p.waitSince ?? 0) - (q.waitSince ?? 0) || compareIds(p.id, q.id));
    const x = members[0]!;
    if (tb.priority === x.id) {
      if (state.now - (tb.priorityAt ?? state.now) >= STALL_SEC) {
        const r = acquireNext(sim, x, { overrun: true });
        if (r.ok === true) {
          tb.stats.overruns++;
          tb.stats.resolutions++;
          out.push({ cycle: cyc, action: 'overrun', aircraftId: x.id });
        } else {
          tb.stats.unresolved++;
          tb.priorityAt = state.now;
          out.push({ cycle: cyc, action: 'unresolved', aircraftId: x.id });
        }
      } else out.push({ cycle: cyc, action: 'waiting', aircraftId: x.id });
    } else if (!tb.priority || !state.aircraft[tb.priority]) {
      tb.priority = x.id;
      tb.priorityAt = state.now;
      tb.stats.resolutions++;
      out.push({ cycle: cyc, action: 'priority', aircraftId: x.id });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 不変条件 B1〜B6

const TAXI_STATES = ['taxiOut', 'taxiIn', 'vacating', 'holdShort', 'docking'];

/** 区間の不変条件（state.taxiBlocks があるときだけ。違反の説明の配列） */
export function checkBlockInvariants(sim: { ctx: SimContext; state: SimState }): string[] {
  const { ctx, state } = sim;
  const tb = state.taxiBlocks;
  const out: string[] = [];
  if (!tb || !ctx.blocks) return out;
  const g = ctx.blocks;
  const active = (a: Aircraft | undefined): a is Aircraft => !!a && a.state !== 'scheduled' && !['departed', 'diverted', 'cannotOperate'].includes(a.state);
  for (const [bid, list] of Object.entries(tb.occ)) {
    const b = g.blocks[bid];
    if (!b) {
      out.push(`B6 occ の区間 ${bid} が存在しない`);
      continue;
    }
    const dups = new Set(list);
    if (dups.size !== list.length) out.push(`B6 区間 ${bid} の占有に重複: ${list.join(',')}`);
    const dirs = new Set<number>();
    let sum = 0;
    let dirOf: 1 | -1 = 1;
    let maxReq = 0;
    for (const id of list) {
      const a = state.aircraft[id];
      if (!active(a) || !a.route) {
        out.push(`B6 区間 ${bid} の占有者 ${id} が無効（経路なし・終端）`);
        continue;
      }
      const ref = routeBlocks(ctx, a.route).byBlock.get(bid);
      if (!ref) {
        out.push(`B6 区間 ${bid} の占有者 ${id} の経路にその区間がない`);
        continue;
      }
      dirs.add(ref.dir);
      dirOf = ref.dir;
      const req = BLOCK_REQ_M[sizeOf(ctx, a)];
      sum += req;
      maxReq = Math.max(maxReq, req);
    }
    if (dirs.size > 1) out.push(`B2 区間 ${bid} に逆向きの機体が同居: ${list.join(',')}`);
    if (tb.stats.overruns === 0 && list.length > 1 && sum > Math.max(blockUsableM(b, dirOf), maxReq) + 1e-6) {
      out.push(`B1 区間 ${bid} の占有 ${list.length} 機（必要長 ${sum} m）が使える長さ ${blockUsableM(b, dirOf).toFixed(0)} m を超える`);
    }
    if (b.maxAircraft !== undefined && list.length > b.maxAircraft && tb.stats.overruns === 0) out.push(`B1 区間 ${bid} の占有 ${list.length} 機が上限 ${b.maxAircraft} を超える`);
    // B4: 区間内の順と間隔（両機とも区間に入っているとき）
    for (let i = 1; i < list.length; i++) {
      const p = state.aircraft[list[i - 1]!];
      const a = state.aircraft[list[i]!];
      if (!active(p) || !active(a) || !p.route || !a.route) continue;
      const pr = routeBlocks(ctx, p.route).byBlock.get(bid);
      const ar = routeBlocks(ctx, a.route).byBlock.get(bid);
      if (!pr || !ar) continue;
      const pp = p.dist - pr.enterDist;
      const ap = a.dist - ar.enterDist;
      if (ap < 0) continue;
      const gap = pp - ap - resolveType(ctx.types, p.typeId).lengthM;
      if (gap < MIN_GROUND_SEPARATION_M - 1e-6) out.push(`B4 区間 ${bid} の ${a.id} が前の ${p.id} に近すぎる（尾部との間隔 ${gap.toFixed(1)} m）`);
    }
  }
  for (const [cid, lock] of Object.entries(tb.locks)) {
    if (!g.corridors[cid]) out.push(`B6 lock の回廊 ${cid} が存在しない`);
    if (lock.holders.length === 0) out.push(`B6 回廊 ${cid} の lock に保持者がいない`);
    for (const h of lock.holders) {
      const a = state.aircraft[h];
      if (!active(a)) {
        out.push(`B6 回廊 ${cid} の保持者 ${h} が無効`);
        continue;
      }
      if (!a.route) continue;
      const ref = routeBlocks(ctx, a.route).refs.find((x) => x.corridorId === cid);
      if (!ref) out.push(`B6 回廊 ${cid} の保持者 ${h} の経路にその回廊がない`);
      else if (ref.chainDir !== lock.dir) out.push(`B2 回廊 ${cid} の向き ${lock.dir} と保持者 ${h} の向き ${ref.chainDir} が逆`);
    }
  }
  for (const a of sortedValues(state.aircraft)) {
    if (!a.route || !TAXI_STATES.includes(a.state) || a.route.kind === 'takeoff') continue;
    const rb = routeBlocks(ctx, a.route);
    const len = resolveType(ctx.types, a.typeId).lengthM;
    for (const ref of rb.refs) {
      // B5: 走行中の機体は、いま機首か尾部がある区間の占有に載っている
      if (a.dist > ref.enterDist + 1e-3 && a.dist - len < ref.exitDist && a.state !== 'docking' && !tb.occ[ref.blockId]?.includes(a.id)) {
        out.push(`B5 ${a.id}(${a.state}) が区間 ${ref.blockId} 内にいるが占有に載っていない`);
      }
    }
    // B3: 交差点の中で止まらない（機首が交差点のノード上で停止していない。経路の端は除く）
    // 動き出した直後（エンジン始動の後の 1 ティック）は除く
    if (a.speed < 0.01 && a.state !== 'holdShort' && state.now - a.stateSince > 2) {
      for (let i = 1; i < a.route.nodes.length - 1; i++) {
        if (g.junctions.has(a.route.nodes[i]!) && Math.abs(a.dist - a.route.cum[i]!) < 1) {
          out.push(`B3 ${a.id}(${a.state}) が交差点 ${a.route.nodes[i]} の上で停止`);
        }
      }
    }
  }
  return out;
}
