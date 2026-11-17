import { TILE_M } from '../model/catalog';
import { distance } from '../geometry/vec';
import { dirToBearing, turnAngleDeg } from '../geometry/angle';
import type { SimContext } from './context';
import { holdWalkLimitM, walkToClear, type HoldRunway } from '../layout/holdShort';
import { HOLD_SHORT_M, HOLD_SHORT_MAX_RATIO, SIN_MIN_HOLD } from './rules';
import type { Aircraft, Route, SimState } from './types';
import { releaseTaxiBlocks } from './blockState';

/**
 * 経路（ノード列）と、経路上の位置・予約の扱い。
 */

export function makeRoute(ctx: SimContext, kind: Route['kind'], nodes: string[], edges: string[], runwayEnd = -1): Route {
  const cum = [0];
  for (let i = 1; i < nodes.length; i++) {
    const a = ctx.network.nodes[nodes[i - 1]!]!.pos;
    const b = ctx.network.nodes[nodes[i]!]!.pos;
    cum.push(cum[i - 1]! + distance(a, b) * TILE_M);
  }
  return { kind, nodes, edges, cum, released: 0, runwayEnd };
}

export function routeLength(r: Route): number {
  return r.cum[r.cum.length - 1]!;
}

/** 位置 dist を含むエッジの番号（nodes[i] → nodes[i+1]） */
export function edgeIndexAt(r: Route, dist: number): number {
  for (let i = 0; i + 1 < r.cum.length; i++) if (dist < r.cum[i + 1]!) return i;
  return Math.max(0, r.cum.length - 2);
}

/** 経路上の位置（タイル番号空間）と進行方向（度、0 = 北） */
export function pointAt(ctx: SimContext, r: Route, dist: number): { x: number; y: number; heading: number } {
  const i = edgeIndexAt(r, dist);
  const a = ctx.network.nodes[r.nodes[i]!]!.pos;
  const b = ctx.network.nodes[r.nodes[Math.min(i + 1, r.nodes.length - 1)]!]!.pos;
  const len = r.cum[i + 1]! - r.cum[i]!;
  const t = len > 0 ? Math.min(1, Math.max(0, (dist - r.cum[i]!) / len)) : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, heading: headingOf(b.x - a.x, b.y - a.y) };
}

export function headingOf(dx: number, dy: number): number {
  return dirToBearing(dx, dy);
}

/** 滑走路手前の停止位置: 滑走路ノードから手前へ戻る距離 */
export function holdShortDistance(edgeLengthM: number): number {
  return Math.min(HOLD_SHORT_M, edgeLengthM * HOLD_SHORT_MAX_RATIO);
}

/**
 * 滑走路ノードに接続する誘導路エッジ（nodeId — otherId、長さ edgeLengthM）の停止位置（nodeId から手前へ戻る距離、m）。
 * ノードの滑走路がすべて従来形なら既存の式（holdShortDistance）をそのまま返す。
 * 自由形が含まれるときは、中心線からの垂直距離 H（dims.holdingPositionM）を、エッジに沿った距離 H / max(sinθ, sin15°) に直す
 * （θ = エッジと中心線のなす角。複数ならそのうち最大）。上限は従来どおりエッジ長の 0.6 倍。
 */
export function holdShortDistanceAt(ctx: SimContext, nodeId: string, otherId: string, edgeLengthM: number): number {
  const free = Object.keys(ctx.freeRunways).length === 0 ? [] : ctx.network.nodes[nodeId]!.runwayIds.filter((id) => ctx.freeRunways[id]);
  if (free.length === 0) return holdShortDistance(edgeLengthM);
  const a = ctx.network.nodes[nodeId]!.pos;
  const b = ctx.network.nodes[otherId]!.pos;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let d = 0;
  for (const id of free) {
    const f = ctx.freeRunways[id]!;
    const sin = len > 0 ? Math.abs((b.x - a.x) * f.dir.y - (b.y - a.y) * f.dir.x) / len : 1;
    d = Math.max(d, f.holdingM / Math.max(sin, SIN_MIN_HOLD));
  }
  return Math.min(d, edgeLengthM * HOLD_SHORT_MAX_RATIO);
}

const holdCache = new WeakMap<Route, Map<number, number>>();

/**
 * 経路 r の滑走路ノード i の停止位置（dir = -1: 手前、ノードから経路に沿って戻る距離 m）または通過後の解放位置（dir = +1: 先、m）。
 * - ノードの滑走路がすべて従来形: 従来の式（`holdShortDistance(エッジ長)`）をそのまま返す。
 * - 自由形が含まれ、`holdShortDistanceAt` の換算が頭打ちにならない場合は、その値（従来どおり）。
 * - 頭打ちになる場合（浅い角度・短いエッジ）: 経路を dir の向きにたどり、各滑走路（ノードの滑走路と、交差点のグループ）の中心線（線分）からの
 *   距離が H 以上になる最初の点までの距離。他の滑走路ノード・滑走路区間・スポット接続・探索の上限（max(3H, 300 m)）で止め、届かなければ換算の値。
 * 混在ノード（従来形と自由形）は max(自由形の結果, 従来の式)。
 */
export function holdShortOnRoute(ctx: SimContext, r: Route, i: number, dir: -1 | 1): number {
  const j = i + dir;
  const edgeLen = Math.abs(r.cum[j]! - r.cum[i]!);
  const nodeId = r.nodes[i]!;
  const d0 = holdShortDistanceAt(ctx, nodeId, r.nodes[j]!, edgeLen);
  if (Object.keys(ctx.freeRunways).length === 0) return d0;
  const node = ctx.network.nodes[nodeId]!;
  const ids = new Set([...node.runwayIds, ...(ctx.crossingNodeRunways[nodeId] ?? [])]);
  const free = [...ids].filter((id) => ctx.freeRunways[id]).sort();
  if (free.length === 0) return d0;
  const legacyToo = node.runwayIds.some((id) => !ctx.freeRunways[id]);
  const wrap = (v: number): number => (legacyToo ? Math.max(v, holdShortDistance(edgeLen)) : v);
  // 頭打ちかどうか（頭打ちでなければ従来の値のまま）
  const a = node.pos;
  const b = ctx.network.nodes[r.nodes[j]!]!.pos;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let clamped = false;
  let want = 0;
  for (const id of free) {
    const f = ctx.freeRunways[id]!;
    const sin = len > 0 ? Math.abs((b.x - a.x) * f.dir.y - (b.y - a.y) * f.dir.x) / len : 1;
    if (sin < SIN_MIN_HOLD) clamped = true;
    want = Math.max(want, f.holdingM / Math.max(sin, SIN_MIN_HOLD));
  }
  if (want > edgeLen * HOLD_SHORT_MAX_RATIO) clamped = true;
  if (!clamped) return wrap(d0);

  let memo = holdCache.get(r);
  if (!memo) holdCache.set(r, (memo = new Map()));
  const key = i * 2 + (dir > 0 ? 1 : 0);
  let v = memo.get(key);
  if (v === undefined) {
    v = walkRoute(ctx, r, i, dir, free) ?? -1;
    memo.set(key, v);
  }
  return wrap(v < 0 ? d0 : v);
}

/** 経路に沿って、余裕 ≥ 0 になる最初の点までの距離（m）。届かなければ null */
function walkRoute(ctx: SimContext, r: Route, i: number, dir: -1 | 1, free: string[]): number | null {
  const runways: HoldRunway[] = free.map((id) => {
    const f = ctx.freeRunways[id]!;
    return { a: f.a, b: f.b, holdM: f.holdingM };
  });
  const limit0 = holdWalkLimitM(Math.max(...runways.map((x) => x.holdM)));
  const points = [ctx.network.nodes[r.nodes[i]!]!.pos];
  let cap = limit0;
  for (let k = i + dir; k >= 0 && k < r.nodes.length; k += dir) {
    const dist = Math.abs(r.cum[k]! - r.cum[i]!);
    const edge = ctx.network.edges[r.edges[Math.min(k, k - dir)]!];
    if (edge && edge.kind === 'standLink') {
      cap = Math.min(cap, Math.abs(r.cum[k - dir]! - r.cum[i]!));
      break;
    }
    if (dir < 0 && r.runwayEnd >= 0 && k <= r.runwayEnd) {
      cap = Math.min(cap, dist);
      points.push(ctx.network.nodes[r.nodes[k]!]!.pos);
      break;
    }
    points.push(ctx.network.nodes[r.nodes[k]!]!.pos);
    if (ctx.network.nodes[r.nodes[k]!]!.runwayIds.length > 0) {
      cap = Math.min(cap, dist);
      break;
    }
    if (dist >= cap) break;
  }
  return walkToClear(points, runways, cap).clearM;
}

/** ノード i で曲がる角度（度）。端点は 0 */
export function turnAngleAt(ctx: SimContext, r: Route, i: number): number {
  if (i <= 0 || i >= r.nodes.length - 1) return 0;
  const p = ctx.network.nodes[r.nodes[i - 1]!]!.pos;
  const q = ctx.network.nodes[r.nodes[i]!]!.pos;
  const s = ctx.network.nodes[r.nodes[i + 1]!]!.pos;
  const h1 = headingOf(q.x - p.x, q.y - p.y);
  const h2 = headingOf(s.x - q.x, s.y - q.y);
  return turnAngleDeg(h1, h2);
}

// ---------------------------------------------------------------- 予約

/** 経路のうち予約対象となるノード・エッジ（スポット・滑走路区間を除く from 番目以降） */
export function reservableParts(ctx: SimContext, r: Route, from: number): { nodes: string[]; edges: string[] } {
  const nodes: string[] = [];
  const edges: string[] = [];
  for (let i = from; i < r.nodes.length; i++) {
    const n = ctx.network.nodes[r.nodes[i]!]!;
    if (n.kind !== 'stand') nodes.push(n.id);
    if (i < r.edges.length && i >= from) {
      const e = ctx.network.edges[r.edges[i]!]!;
      if (e.kind === 'taxiway') edges.push(e.id);
    }
  }
  return { nodes, edges };
}

export function isFree(state: SimState, acId: string, parts: { nodes: string[]; edges: string[] }): boolean {
  return (
    parts.nodes.every((n) => (state.nodeReservations[n] ?? acId) === acId) &&
    parts.edges.every((e) => (state.edgeReservations[e] ?? acId) === acId)
  );
}

export function reserve(state: SimState, acId: string, parts: { nodes: string[]; edges: string[] }): void {
  for (const n of parts.nodes) state.nodeReservations[n] = acId;
  for (const e of parts.edges) state.edgeReservations[e] = acId;
}

export function releaseAll(state: SimState, acId: string): void {
  for (const [k, v] of Object.entries(state.nodeReservations)) if (v === acId) delete state.nodeReservations[k];
  for (const [k, v] of Object.entries(state.edgeReservations)) if (v === acId) delete state.edgeReservations[k];
  if (state.taxiBlocks) releaseTaxiBlocks(state, acId);
}

/**
 * 通過済みの区間を解放する。ノード i は機体の尾部が通過した（位置 > ノード + 機体長）時点で、
 * その手前のエッジと一緒に解放する。経路の終点ノードは解放しない（停止位置として保持）。
 */
export function releasePassed(state: SimState, ac: Aircraft, lengthM: number): void {
  const r = ac.route;
  if (!r) return;
  while (r.released < r.nodes.length - 1) {
    const i = r.released;
    if (ac.dist < r.cum[i]! + lengthM) break;
    const n = r.nodes[i]!;
    if (state.nodeReservations[n] === ac.id) delete state.nodeReservations[n];
    if (i > 0) {
      const e = r.edges[i - 1]!;
      if (state.edgeReservations[e] === ac.id) delete state.edgeReservations[e];
    }
    r.released++;
  }
}
