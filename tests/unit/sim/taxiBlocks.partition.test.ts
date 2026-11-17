import { describe, expect, it } from 'vitest';
import { addTaxiwayPath, placeStand } from '../../../src/core/layout/operations';
import { buildAirsideNetwork } from '../../../src/core/airside/network';
import { createContext } from '../../../src/core/sim/context';
import { buildTaxiBlocks, type TaxiBlockGraph } from '../../../src/core/sim/taxiBlocks';
import { TILE_M } from '../../../src/core/model/catalog';
import { distance } from '../../../src/core/geometry/vec';
import type { AirportLayout } from '../../../src/core/model/types';
import { linearLayout } from '../../audit/d_helpers';
import { createStressLayout } from '../../golden/layouts';
import { emptyLayout, must } from '../helpers';
import { crossingAirport } from './helpers';
import { crossingFreeAirport, parallelFreeAirport } from './crossingLayouts';
import { freeShallowCrossingAirport, legacyTwinAirport } from './chainLayouts';

const withBlock = (l: AirportLayout, tiles?: number): AirportLayout => ({ ...l, taxiMode: 'block', ...(tiles !== undefined ? { taxiBlockTiles: tiles } : {}) });

function graphOf(l: AirportLayout, tiles = 10): { g: TaxiBlockGraph; net: ReturnType<typeof buildAirsideNetwork> } {
  const ctx = createContext(withBlock(l, tiles));
  return { g: ctx.blocks!, net: ctx.network };
}

/** 検査: 区間の和 = 誘導路の長さの和、spans の連続、必ず区切り */
function check(l: AirportLayout, tiles = 10): TaxiBlockGraph {
  const { g, net } = graphOf(l, tiles);
  const taxi = Object.values(net.edges).filter((e) => e.kind === 'taxiway');
  const total = taxi.reduce((s, e) => s + distance(net.nodes[e.from]!.pos, net.nodes[e.to]!.pos) * TILE_M, 0);
  const sum = Object.values(g.blocks).reduce((s, b) => s + b.lengthM, 0);
  expect(Math.abs(sum - total)).toBeLessThan(1e-6);
  // 各エッジは区間の spans で隙間なく覆われる
  for (const e of taxi) {
    const L = distance(net.nodes[e.from]!.pos, net.nodes[e.to]!.pos) * TILE_M;
    const spans = (g.edgeBlocks[e.id] ?? []).flatMap((id) => g.blocks[id]!.spans.filter((s) => s.edgeId === e.id)).sort((a, b) => a.fromM - b.fromM);
    let at = 0;
    for (const s of spans) {
      expect(s.fromM).toBeCloseTo(at, 6);
      at = s.toM;
    }
    expect(at).toBeCloseTo(L, 6);
  }
  // 区間の長さの上限（入口の小片を除く）: tiles × TILE_M 以下
  for (const b of Object.values(g.blocks)) if (!b.entry) expect(b.lengthM).toBeLessThanOrEqual(tiles * TILE_M + 1e-6);
  // 交差点・滑走路・スポット入口は区間の途中に現れない（複数エッジにまたがる区間の内部のノードは交差点でない）
  for (const b of Object.values(g.blocks)) {
    for (let i = 0; i + 1 < b.spans.length; i++) {
      const e1 = net.edges[b.spans[i]!.edgeId]!;
      const e2 = net.edges[b.spans[i + 1]!.edgeId]!;
      const shared = [e1.from, e1.to].filter((n) => n === e2.from || n === e2.to);
      for (const n of shared) expect(g.junctions.has(n), `${b.id} interior node ${n}`).toBe(false);
    }
  }
  return g;
}

describe('2-01 taxiBlocks.partition', () => {
  const layouts: [string, () => AirportLayout][] = [
    ['linear 4 stands', () => linearLayout({ stands: 4 })],
    ['linear dual (loop-ish)', () => linearLayout({ stands: 4, dual: true })],
    ['linear oneWayPair', () => linearLayout({ stands: 4, oneWayPair: true })],
    ['linear multiExit', () => linearLayout({ stands: 4, multiExit: true })],
    ['crossingAirport', () => crossingAirport()],
    ['stress', () => createStressLayout()],
    ['free crossing', () => crossingFreeAirport()],
    ['free parallel', () => parallelFreeAirport()],
    ['free shallow', () => freeShallowCrossingAirport()],
    ['legacy twin', () => legacyTwinAirport()],
  ];
  for (const [name, mk] of layouts) {
    it(`${name}: 区間の長さの和 = 誘導路の長さの和・隙間なし・同じ配置から同じ区間`, () => {
      const l = mk();
      const a = check(l);
      const b = graphOf(l).g;
      expect(JSON.stringify([a.blocks, a.corridors, a.edgeBlocks, [...a.junctions].sort()])).toBe(JSON.stringify([b.blocks, b.corridors, b.edgeBlocks, [...b.junctions].sort()]));
    });
    it(`${name}: tiles 4/10/40 で区間数が単調（小さいほど多い）`, () => {
      const l = mk();
      const n = (t: number) => Object.keys(graphOf(l, t).g.blocks).length;
      expect(n(4)).toBeGreaterThanOrEqual(n(10));
      expect(n(10)).toBeGreaterThanOrEqual(n(40));
      check(l, 4);
      check(l, 40);
    });
  }

  it('直線: 100 タイルの誘導路は tiles=10 で 10 区間に等分される（端数の短い区間なし）', () => {
    let l = emptyLayout(200, 20);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 10 }, { x: 110, y: 10 }])).layout;
    const g = check(l, 10);
    const bs = Object.values(g.blocks);
    expect(bs.length).toBe(10);
    for (const b of bs) expect(b.lengthM).toBeCloseTo(250, 6);
    expect(Object.keys(g.corridors).length).toBe(1);
    expect(Object.keys(check(l, 40).blocks).length).toBe(3); // 2500 m / 1000 m → 3 等分
  });

  it('環状（区切りのない誘導路の環）でも区間ができ、1 つの回廊になる', () => {
    let l = emptyLayout(100, 60);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }, { x: 10, y: 10 }])).layout;
    const g = check(l, 10);
    expect(Object.keys(g.blocks).length).toBeGreaterThan(0);
    expect(Object.keys(g.corridors).length).toBe(1);
  });

  it('分岐（T 字）: 交差点で区切り、回廊は 3 本に分かれる。行き止まりも区切り', () => {
    let l = emptyLayout(100, 60);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 50, y: 30 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 30, y: 30 }, { x: 30, y: 10 }])).layout;
    const g = check(l, 10);
    const net = buildAirsideNetwork(l);
    const center = Object.values(net.nodes).find((n) => n.pos.x === 30 && n.pos.y === 30)!;
    expect(g.junctions.has(center.id)).toBe(true);
    expect(Object.keys(g.corridors).length).toBe(3);
  });

  it('スポット入口は区切りで、交差点（junctions）に入る。入口の小片（滑走路手前）は entry', () => {
    const l = linearLayout({ stands: 4 });
    const ctx = createContext(withBlock(l));
    const g = ctx.blocks!;
    for (const s of Object.values(ctx.stands)) if (s.entry) expect(g.junctions.has(s.entry)).toBe(true);
    const entries = Object.values(g.blocks).filter((b) => b.entry);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.corridorId).toBe('');
    // 滑走路の手前で区切られる: 滑走路ノードに接する区間は入口の小片
    for (const rid of Object.keys(ctx.runways)) {
      for (const n of ctx.network.runwayNodes[rid]!) {
        for (const eid of ctx.network.outgoing[n]!) {
          const e = ctx.network.edges[eid]!;
          if (e.kind !== 'taxiway') continue;
          const ids = g.edgeBlocks[eid]!;
          const first = e.from === n ? g.blocks[ids[0]!]! : g.blocks[ids[ids.length - 1]!]!;
          expect(first.entry, `${eid} next to runway node ${n}`).toBe(true);
        }
      }
    }
  });

  it('一方通行・幅の違い・運用中でない誘導路は区切りになる（条件が区間内で一様）', () => {
    let l = emptyLayout(100, 30);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 10 }, { x: 30, y: 10 }], { widthClass: 'L' })).layout;
    l = must(addTaxiwayPath(l, [{ x: 30, y: 10 }, { x: 50, y: 10 }], { widthClass: 'S' })).layout;
    l = must(addTaxiwayPath(l, [{ x: 50, y: 10 }, { x: 70, y: 10 }], { widthClass: 'S', oneWay: true })).layout;
    l = must(addTaxiwayPath(l, [{ x: 70, y: 10 }, { x: 90, y: 10 }], { widthClass: 'S', oneWay: true, buildState: 'planned' } as never)).layout;
    const g = check(l, 40);
    expect(Object.keys(g.blocks).length).toBe(4);
    // 条件の変わり目でつながる 1 本の回廊
    expect(Object.keys(g.corridors).length).toBe(1);
  });

  it('異常: 孤立した誘導路・誘導路なしの配置でも例外にならない', () => {
    const empty = emptyLayout(40, 40);
    expect(buildTaxiBlocks(empty, buildAirsideNetwork(empty), 10).blocks).toEqual({});
    let l = emptyLayout(100, 60);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 10 }, { x: 12, y: 10 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 60, y: 40 }, { x: 90, y: 40 }])).layout;
    const g = check(l, 10);
    expect(Object.keys(g.corridors).length).toBe(2);
    // スポットだけで誘導路がない
    let m = emptyLayout(60, 60);
    m = must(placeStand(m, { x: 20, y: 20 }, 'M', 180, 'operational', 'S1')).layout;
    expect(Object.keys(buildTaxiBlocks(m, buildAirsideNetwork(m), 10).blocks).length).toBe(0);
  });

  it('従来方式（taxiMode なし）の context は blocks のキー自体を作らない', () => {
    const ctx = createContext(linearLayout());
    expect('blocks' in ctx).toBe(false);
  });
});
