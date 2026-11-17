import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { addTaxiwayPath, placeFacility, placeRunway, placeStand, type OpResult } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { createSimulation, addTurnaround } from '../../../src/core/sim/simulation';
import { detectTaxiStall, routeBlocks } from '../../../src/core/sim/blockControl';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { makeRoute } from '../../../src/core/sim/routes';
import { HOLD_DIVERT_SEC } from '../../../src/core/sim/rules';
import { allDone, linearLayout, manual, traceRun } from '../../audit/d_helpers';
import { createStressLayout } from '../../golden/layouts';
import { emptyLayout, must } from '../helpers';
import { crossingAirport } from './helpers';
import { crossingFreeAirport, parallelFreeAirport } from './crossingLayouts';
import { freeShallowCrossingAirport } from './chainLayouts';
import { asBlock, leftovers, phase2 } from './blockHelpers';

const SEEDS = ['d1-s1', 'd1-s2', 'd1-s3'];

/**
 * ランダムな格子状の誘導路の配置（シードから決定的）。滑走路 1 本（y=20, x=10..110）、誘導路の格子（行 y=30,45,60 / 列 x=10,30,50,70,90）、
 * 最下段の行 y=60 に沿ってスポット 8。行・列は一部を確率で省く（行 y=30・y=60 と列 x=10,90 は必ず残して連結を保つ）。
 */
export function randomGridLayout(seed: string): AirportLayout {
  const rng = new Rng(`grid:${seed}`);
  let l = emptyLayout(130, 90);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeRunway(l, { x: 10, y: 20 }, 90, 100, { surfaceWidthM: 45 }));
  const cols = [10, 30, 50, 70, 90];
  const rows = [30, 45, 60];
  for (const y of rows) {
    for (let i = 0; i + 1 < cols.length; i++) {
      const must4 = y === 30 || y === 60;
      if (must4 || rng.next() < 0.75) step(addTaxiwayPath(l, [{ x: cols[i]!, y }, { x: cols[i + 1]!, y }], { name: `R${y}-${i}` }));
    }
  }
  for (const x of cols) {
    const full = x === 10 || x === 90;
    for (let j = 0; j + 1 < rows.length; j++) {
      if (full || rng.next() < 0.75) step(addTaxiwayPath(l, [{ x, y: rows[j]! }, { x, y: rows[j + 1]! }], { name: `C${x}-${j}`, oneWay: !full && rng.next() < 0.15 }));
    }
  }
  step(addTaxiwayPath(l, [{ x: 10, y: 20 }, { x: 10, y: 30 }], { name: 'RW10' }));
  step(addTaxiwayPath(l, [{ x: 90, y: 20 }, { x: 90, y: 30 }], { name: 'RW90' }));
  if (rng.next() < 0.5) step(addTaxiwayPath(l, [{ x: 50, y: 20 }, { x: 50, y: 30 }], { name: 'RW50' }));
  step(placeFacility(l, 'apron', { x: 18, y: 61 }, { w: 48, h: 8 }));
  for (let i = 0; i < 8; i++) step(placeStand(l, { x: 20 + i * 5, y: 61 }, 'M', 180, 'operational', `S${i + 1}`));
  step(placeFacility(l, 'gseBase', { x: 70, y: 65 }));
  step(placeFacility(l, 'fuelFarm', { x: 76, y: 65 }));
  step(placeFacility(l, 'maintenance', { x: 8, y: 65 }));
  return l;
}

function flow(layout: AirportLayout, seed: string, n: number, spanMin = 30) {
  const sim = createSimulation(layout, { seed, settings: manual });
  const rng = new Rng(`${seed}:flow`);
  const t0 = sim.state.now + 20 * 60;
  for (let i = 0; i < n; i++) {
    const arr = t0 + Math.round(rng.next() * spanMin * 60);
    addTurnaround(sim, (['regional70', 'narrow180', 'narrow180'] as const)[rng.int(0, 2)]!, arr, { departureAt: arr + (40 + rng.int(0, 20)) * 60 });
  }
  return sim;
}

describe('2-04 taxiBlocks.deadlock: デッドロックを避ける規則 1〜4', () => {
  for (const seed of SEEDS) {
    it(`対向 25 通り seed=${seed}（単一誘導路・スポット 2 の行き止まり）: 競合 0・未完了 0・ダイバート 0・unresolved 0。待ちの最大を記録`, { timeout: 300_000 }, () => {
      const rng = new Rng(`${seed}:off`);
      let maxAirborneHold = 0;
      let maxStandWait = 0;
      let resolutions = 0;
      for (let k = -12; k <= 12; k++) {
        const off = k * 60 + rng.int(0, 59);
        const sim = createSimulation(asBlock(linearLayout({ stands: 2 })), { seed, settings: manual });
        const t0 = sim.state.now + 20 * 60;
        const dep = addTurnaround(sim, 'narrow180', t0, { departureAt: t0 + 3000 });
        const arr = addTurnaround(sim, 'narrow180', t0 + 3000 + off, { departureAt: t0 + 3000 + off + 3600 });
        const tr = traceRun(sim, 4 * 3600, { every: 20 });
        expect(tr.violations, `${seed} off=${off}`).toEqual([]);
        expect(sim.state.stats.conflicts, `${seed} off=${off}`).toBe(0);
        expect(allDone(sim), `${seed} off=${off}: ${[dep, arr].map((a) => `${a.id}:${a.state}`)}`).toBe(true);
        expect(sim.state.stats.diverted, `${seed} off=${off}`).toBe(0);
        const st = sim.state.taxiBlocks!.stats;
        expect(st.unresolved).toBe(0);
        resolutions += st.resolutions;
        const hold = (id: string, pre: string) => Object.entries(tr.holdSec[id] ?? {}).filter(([k2]) => k2.startsWith(pre)).reduce((a, [, v]) => a + v, 0);
        maxAirborneHold = Math.max(maxAirborneHold, hold(arr.id, 'holding/'));
        maxStandWait = Math.max(maxStandWait, hold(dep.id, 'readyForPushback/blockFull') + hold(dep.id, 'readyForPushback/opposingTraffic'), hold(arr.id, 'readyForPushback/blockFull') + hold(arr.id, 'readyForPushback/opposingTraffic'));
        expect(leftovers(sim)).toEqual([]);
      }
      expect(maxAirborneHold).toBeLessThan(HOLD_DIVERT_SEC);
      phase2('2-04-headon', { seed, cases: 25, maxAirborneHoldSec: maxAirborneHold, maxStandWaitSec: maxStandWait, resolutions });
    });
  }

  for (const seed of SEEDS) {
    it(`ストレス 30 機 seed=${seed} × 6 時間: 競合 0・未完了 0・unresolved 0`, { timeout: 300_000 }, () => {
      const sim = createSimulation(asBlock(createStressLayout()), { seed, settings: manual });
      const rng = new Rng(`${seed}:arr`);
      const t0 = sim.state.now + 600;
      for (let i = 0; i < 30; i++) addTurnaround(sim, i % 3 === 0 ? 'regional70' : 'narrow180', t0 + i * 120 + rng.int(0, 60), { departureAt: t0 + 3000 + i * 60 });
      const tr = traceRun(sim, 6 * 3600, { every: 10 });
      expect(tr.violations, seed).toEqual([]);
      expect(sim.state.stats.conflicts, seed).toBe(0);
      expect(allDone(sim), seed).toBe(true);
      const st = sim.state.taxiBlocks!.stats;
      expect(st.unresolved).toBe(0);
      expect(leftovers(sim)).toEqual([]);
      phase2('2-04-stress', { seed, stats: st, departures: sim.state.stats.departures, diverted: sim.state.stats.diverted });
    });
  }

  for (const [name, mk] of [['crossingAirport', crossingAirport], ['crossingFree（自由角度）', crossingFreeAirport], ['parallelFree', parallelFreeAirport], ['freeShallow', freeShallowCrossingAirport]] as const) {
    it(`${name}: 12 機の連続流入で競合 0・未完了 0・unresolved 0`, { timeout: 300_000 }, () => {
      for (const seed of SEEDS) {
        const sim = flow(asBlock(mk()), seed, 12);
        const tr = traceRun(sim, 12 * 3600, { every: 30 });
        expect(tr.violations, `${name} ${seed}`).toEqual([]);
        expect(sim.state.stats.conflicts, `${name} ${seed}`).toBe(0);
        expect(allDone(sim), `${name} ${seed}`).toBe(true);
        expect(sim.state.taxiBlocks!.stats.unresolved).toBe(0);
        expect(leftovers(sim)).toEqual([]);
        phase2('2-04-free', { layout: name, seed, stats: sim.state.taxiBlocks!.stats, departures: sim.state.stats.departures, diverted: sim.state.stats.diverted });
      }
    });
  }

  it('ランダムな格子状の配置（シード 5 個。シードは記録する）: 競合 0・未完了 0・unresolved 0', { timeout: 300_000 }, () => {
    const seeds = ['g1', 'g2', 'g3', 'g4', 'g5'];
    for (const g of seeds) {
      const layout = randomGridLayout(g);
      for (const seed of ['d1-s1', 'd1-s2']) {
        const sim = flow(asBlock(layout), `${g}:${seed}`, 14, 40);
        const tr = traceRun(sim, 8 * 3600, { every: 30 });
        const tag = `grid=${g} seed=${g}:${seed}`;
        expect(tr.violations, tag).toEqual([]);
        expect(sim.state.stats.conflicts, tag).toBe(0);
        expect(allDone(sim), tag).toBe(true);
        expect(sim.state.taxiBlocks!.stats.unresolved, tag).toBe(0);
        expect(leftovers(sim), tag).toEqual([]);
        phase2('2-04-random', { grid: g, seed, stats: sim.state.taxiBlocks!.stats, departures: sim.state.stats.departures, diverted: sim.state.stats.diverted, cancelled: sim.state.stats.cancelled });
      }
    }
  });

  it('通常の配置（サンプル空港・linear）の運航で規則 4 が働いた回数 resolutions = 0', { timeout: 300_000 }, () => {
    for (const seed of SEEDS) {
      const sim = flow(asBlock(linearLayout({ stands: 8 })), seed, 12);
      traceRun(sim, 8 * 3600, { every: 60 });
      expect(sim.state.taxiBlocks!.stats.resolutions).toBe(0);
    }
  });

  it('規則 4 の単体: わざと満杯の環（17 区間の環状誘導路に 17 機）を作ると、検出 → 優先 → 機数超過の順に解消が記録される（黙って止まらない）', () => {
    let l = emptyLayout(100, 60);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 10 }])).layout;
    const sim = createSimulation(asBlock(l, 6), { seed: 'ring', settings: manual });
    const { ctx, state } = sim;
    // 環の角のノードを走査順に並べる（隣のノードへ進む）
    const edges = Object.values(ctx.network.edges).filter((e) => e.kind === 'taxiway');
    const next = new Map<string, { to: string; edge: string }[]>();
    for (const e of edges) {
      next.set(e.from, [...(next.get(e.from) ?? []), { to: e.to, edge: e.id }]);
      next.set(e.to, [...(next.get(e.to) ?? []), { to: e.from, edge: e.id }]);
    }
    const start = [...next.keys()].sort()[0]!;
    const nodes = [start];
    const eids: string[] = [];
    let prev = '';
    let cur = start;
    for (let lap = 0; lap < 2; lap++) {
      for (let i = 0; i < 4; i++) {
        const step = next.get(cur)!.filter((x) => x.to !== prev).sort((a, b) => a.edge.localeCompare(b.edge))[0]!;
        nodes.push(step.to);
        eids.push(step.edge);
        prev = cur;
        cur = step.to;
      }
    }
    const route = makeRoute(ctx, 'taxiOut', nodes, eids);
    const refs = routeBlocks(ctx, route).refs;
    const lap1 = Math.floor(refs.length / 2);
    expect(lap1).toBe(Object.keys(ctx.blocks!.blocks).length);
    expect(lap1).toBeGreaterThanOrEqual(10);
    const tb = state.taxiBlocks!;
    const ids: string[] = [];
    for (let k = 0; k < lap1; k++) {
      const a = addTurnaround(sim, 'narrow180', state.now + 3600, { departureAt: state.now + 9000 });
      ids.push(a.id);
      a.state = 'taxiOut';
      a.route = { ...route, released: 0 };
      a.dist = refs[k]!.exitDist - 1;
      a.speed = 0;
      a.holdReason = 'blockFull';
      a.waitSince = state.now - 400 - k;
      tb.occ[refs[k]!.blockId] = [a.id];
    }
    // 同じ経路オブジェクトを使う（routeBlocks のキャッシュが効く）
    for (const id of ids) state.aircraft[id]!.route = route;
    tb.locks[refs[0]!.corridorId] = { dir: refs[0]!.chainDir, holders: [...ids].sort() };
    expect(checkInvariants(sim).filter((m) => m.startsWith('B1') || m.startsWith('B2'))).toEqual([]);
    // 1 回目: 閉路を検出し、最も長く待っている機体に優先を付ける
    const r1 = detectTaxiStall(sim);
    expect(r1.length).toBeGreaterThanOrEqual(1);
    expect(r1[0]!.action).toBe('priority');
    expect(r1[0]!.cycle.length).toBe(lap1);
    expect(tb.priority).toBe(r1[0]!.aircraftId);
    expect(tb.stats.resolutions).toBe(1);
    // 優先だけでは環は解けない: 180 秒後も同じなら機数を超えて入れる
    state.now += 100;
    expect(detectTaxiStall(sim)[0]!.action).toBe('waiting');
    state.now += 100;
    const r3 = detectTaxiStall(sim);
    expect(r3[0]!.action).toBe('overrun');
    expect(tb.stats.overruns).toBe(1);
    expect(tb.stats.resolutions).toBe(2);
    expect(tb.stats.unresolved).toBe(0);
    expect(tb.priority).toBeUndefined();
    phase2('2-04-ring-unit', { blocks: lap1, aircraft: ids.length, first: r1[0]!.action, third: r3[0]!.action, stats: tb.stats });
  });
});
