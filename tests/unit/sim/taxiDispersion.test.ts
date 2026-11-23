import { describe, expect, it } from 'vitest';
import { buildAirsideNetwork, type AirsideNetwork } from '../../../src/core/airside/network';
import { deterministicHash01, findPath, type PathResult } from '../../../src/core/sim/pathfinding';
import { TAXI_JITTER_MAX_SEC, TAXI_JITTER_RATIO } from '../../../src/core/sim/rules';
import { createSimulation, departurePath } from '../../../src/core/sim/simulation';
import { addTaxiwayPath, placeRunway, placeStand, type OpResult } from '../../../src/core/layout/operations';
import { findNodeAt } from '../../../src/core/layout/network';
import type { AirportLayout } from '../../../src/core/model/types';
import type { Aircraft } from '../../../src/core/sim/types';
import { emptyLayout, must } from '../helpers';

/**
 * 経路探索の分散化（2026-TAXI）の単体テスト。
 * Z1: 決定的タイブレーク分散（最短 + δ 以内で機体 ID ハッシュにより並行路が分かれる）
 * Y: 混雑コスト（混んでいる側を避ける。1 エッジの上限が横断ペナルティ未満）
 * X2: 入口コストの区分別重み（大型機ほど滑走路端の入口を強く優先）
 */

const node = (l: AirportLayout, x: number, y: number) => findNodeAt(l.taxiNodes, { x, y })!;

/** 4 本の並行誘導路（y=32/38/40/46）を持つレイアウト。始点 (10,42) → 終点 (90,42) の経路長は y=40 が最短（84タイル）、y=38/46 が +4タイル、y=32 が +16タイル */
function parallelLayout(): AirportLayout {
  let l = emptyLayout(120, 80);
  const step = (r: OpResult) => (l = must(r).layout);
  for (const y of [32, 38, 40, 46]) step(addTaxiwayPath(l, [{ x: 10, y }, { x: 90, y }]));
  step(addTaxiwayPath(l, [{ x: 10, y: 32 }, { x: 10, y: 46 }]));
  step(addTaxiwayPath(l, [{ x: 90, y: 32 }, { x: 90, y: 46 }]));
  step(addTaxiwayPath(l, [{ x: 4, y: 42 }, { x: 16, y: 42 }]));
  step(addTaxiwayPath(l, [{ x: 84, y: 42 }, { x: 96, y: 42 }]));
  return l;
}

/** 経路が使う長い水平エッジの y 座標（＝どの並行路を通ったか） */
function routeY(net: AirsideNetwork, p: PathResult): number {
  let best = '';
  let bestLen = -1;
  for (const eid of p.edges) {
    const e = net.edges[eid]!;
    if (e.lengthM > bestLen) {
      bestLen = e.lengthM;
      best = e.from;
    }
  }
  return net.nodes[best]!.pos.y;
}

describe('Z1: 決定的タイブレーク分散', () => {
  const l = parallelLayout();
  const net = buildAirsideNetwork(l);
  const src = node(l, 10, 42);
  const goal = node(l, 90, 42);
  const query = (jitterKey?: string) => ({
    sources: [{ node: src, cost: 0 }],
    goals: new Map([[goal, 0]]),
    size: 'M' as const,
    speed: 8,
    ...(jitterKey ? { jitterKey } : {}),
  });

  it('ハッシュは決定的で [0, 1) の範囲', () => {
    for (const k of ['ac_1', 'ac_2', 'flight:123']) {
      const v = deterministicHash01(k, 'edge_1');
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(deterministicHash01(k, 'edge_1')).toBe(v);
    }
    expect(deterministicHash01('ac_1', 'edge_1')).not.toBe(deterministicHash01('ac_1', 'edge_2'));
  });

  it('ジッタなしでは常に最短路（y=40）で決定的', () => {
    const a = findPath(net, query());
    const b = findPath(net, query());
    expect(a).not.toBeNull();
    expect(routeY(net, a!)).toBe(40);
    expect(b!.nodes).toEqual(a!.nodes);
  });

  it('機体 ID により δ 以内の並行路へ分かれ、δ を超える迂回は選ばれない', () => {
    const plain = findPath(net, query())!;
    const delta = Math.min(plain.cost * TAXI_JITTER_RATIO, TAXI_JITTER_MAX_SEC);
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const key = `ac_${i}`;
      const p = findPath(net, query(key))!;
      expect(p).not.toBeNull();
      const y = routeY(net, p);
      // y=32 の経路は最短 +50 秒相当で δ（26.25 秒）を超えるため選ばれない
      expect(y).not.toBe(32);
      expect([38, 40, 46]).toContain(y);
      // 返却コストはジッタ抜きの実コストで、最短 + δ 以内
      expect(p.cost).toBeLessThanOrEqual(plain.cost + delta + 1e-9);
      expect(p.cost).toBeGreaterThanOrEqual(plain.cost - 1e-9);
      // 同じ ID では何度探索しても同じ経路（決定的）
      expect(findPath(net, query(key))!.nodes).toEqual(p.nodes);
      seen.add(y);
    }
    // 60 機で少なくとも 2 本の並行路に分かれる
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});

describe('Y: 混雑コスト', () => {
  it('混んでいる側の並行路を避けて空いている側を選ぶ（ジッタ併用でも）', () => {
    let l = emptyLayout(120, 80);
    const step = (r: OpResult) => (l = must(r).layout);
    for (const y of [38, 46]) step(addTaxiwayPath(l, [{ x: 10, y }, { x: 90, y }]));
    step(addTaxiwayPath(l, [{ x: 10, y: 38 }, { x: 10, y: 46 }]));
    step(addTaxiwayPath(l, [{ x: 90, y: 38 }, { x: 90, y: 46 }]));
    step(addTaxiwayPath(l, [{ x: 4, y: 42 }, { x: 16, y: 42 }]));
    step(addTaxiwayPath(l, [{ x: 84, y: 42 }, { x: 96, y: 42 }]));
    const net = buildAirsideNetwork(l);
    const q = (extra: object) => ({
      sources: [{ node: node(l, 10, 42), cost: 0 }],
      goals: new Map([[node(l, 90, 42), 0]]),
      size: 'M' as const,
      speed: 8,
      ...extra,
    });
    const plain = findPath(net, q({}))!;
    const load = new Map(plain.edges.map((e) => [e, 1]));
    const avoided = findPath(net, q({ edgeLoad: load }))!;
    expect(avoided.edges.some((e) => plain.edges.includes(e))).toBe(false);
    // ジッタを併用しても、混雑側（+15 秒 × 3 エッジ）は選ばれない
    const avoidedJitter = findPath(net, q({ edgeLoad: load, jitterKey: 'ac_0' }))!;
    expect(avoidedJitter.edges.some((e) => plain.edges.includes(e))).toBe(false);
  });

  it('1 エッジの混雑コストは上限（60 秒）で頭打ちになる', () => {
    let l = emptyLayout(120, 80);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 40 }, { x: 90, y: 40 }])).layout;
    const net = buildAirsideNetwork(l);
    const q = (edgeLoad?: Map<string, number>) => ({
      sources: [{ node: node(l, 10, 40), cost: 0 }],
      goals: new Map([[node(l, 90, 40), 0]]),
      size: 'M' as const,
      speed: 8,
      ...(edgeLoad ? { edgeLoad } : {}),
    });
    const base = findPath(net, q())!;
    const n = base.edges.length;
    const withLoad = (v: number) => findPath(net, q(new Map(base.edges.map((e) => [e, v]))))!;
    expect(withLoad(1).cost).toBeCloseTo(base.cost + 15 * n, 6);
    expect(withLoad(4).cost).toBeCloseTo(base.cost + 60 * n, 6);
    expect(withLoad(100).cost).toBeCloseTo(withLoad(4).cost, 6);
  });

  it('混雑回避のためだけに滑走路を横断する経路は選ばれない', () => {
    let l = emptyLayout(130, 80);
    const step = (r: OpResult) => (l = must(r).layout);
    step(placeRunway(l, { x: 10, y: 44 }, 90, 100, { surfaceWidthM: 45 }));
    step(addTaxiwayPath(l, [{ x: 20, y: 48 }, { x: 100, y: 48 }]));
    step(addTaxiwayPath(l, [{ x: 20, y: 40 }, { x: 100, y: 40 }]));
    step(addTaxiwayPath(l, [{ x: 20, y: 40 }, { x: 20, y: 48 }]));
    step(addTaxiwayPath(l, [{ x: 100, y: 40 }, { x: 100, y: 48 }]));
    const net = buildAirsideNetwork(l);
    const q = (edgeLoad?: Map<string, number>) => ({
      sources: [{ node: node(l, 20, 48), cost: 0 }],
      goals: new Map([[node(l, 100, 48), 0]]),
      size: 'M' as const,
      speed: 8,
      ...(edgeLoad ? { edgeLoad } : {}),
    });
    const direct = findPath(net, q())!;
    expect(direct.nodes.some((n) => net.nodes[n]!.runwayIds.length > 0)).toBe(false);
    // 直通エッジに最大の混雑（上限 60 秒までしか効かない）を与えても、横断 2 回（+240 秒）の迂回は選ばれない
    const loaded = findPath(net, q(new Map(direct.edges.map((e) => [e, 100]))))!;
    expect(loaded.nodes).toEqual(direct.nodes);
    expect(loaded.nodes.some((n) => net.nodes[n]!.runwayIds.length > 0)).toBe(false);
  });
});

describe('X2: 入口コストの区分別重み', () => {
  it('大型機ほど滑走路端（残りの長い）入口を強く優先する', () => {
    let l = emptyLayout(200, 70);
    const step = (r: OpResult) => (l = must(r).layout);
    step(placeRunway(l, { x: 10, y: 30 }, 90, 160, { surfaceWidthM: 60 }));
    // 誘導路は全区分が通れる F 幅で敷く（入口コストの差だけを効かせるため）
    const twy = { widthClass: 'F' as const };
    // 入口は西端（dist 0）と dist 1200 m（x=58）の 2 箇所だけに接続する
    step(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 10, y: 39 }], twy));
    step(addTaxiwayPath(l, [{ x: 58, y: 30 }, { x: 58, y: 39 }], twy));
    step(addTaxiwayPath(l, [{ x: 10, y: 39 }, { x: 90, y: 39 }], twy));
    // スポットの接続は両入口の中間（x=44）から。タキシー時間差は M で約 62 秒・L で約 71 秒
    step(addTaxiwayPath(l, [{ x: 44, y: 39 }, { x: 44, y: 48 }], twy));
    step(addTaxiwayPath(l, [{ x: 36, y: 48 }, { x: 52, y: 48 }], twy));
    step(placeStand(l, { x: 43, y: 49 }, 'L', 180));
    const standId = Object.keys(l.stands)[0]!;
    l.stands[standId] = { ...l.stands[standId]!, codeF: true };
    const sim = createSimulation(l);
    const ac = (id: string, typeId: string) => ({ id, typeId, standId }) as unknown as Aircraft;
    const west = node(l, 10, 30);
    const east = node(l, 58, 30);
    // M（A320）: 入口コスト差 1200/30 = 40 秒 < タキシー時間差 → 中間入口（dist 1200）を選ぶ
    expect(departurePath(sim, ac('m1', 'A320-200'), false)!.path.nodes.at(-1)).toBe(east);
    // L（B767）: 入口コスト差 1200/12 = 100 秒 > タキシー時間差 → 端の入口（dist 0）を選ぶ
    expect(departurePath(sim, ac('l1', 'B767-300ER'), false)!.path.nodes.at(-1)).toBe(west);
    // F（A380）: 入口コスト差 1200/8 = 150 秒 → 端の入口を選ぶ
    expect(departurePath(sim, ac('f1', 'A380-800'), false)!.path.nodes.at(-1)).toBe(west);
  });
});
