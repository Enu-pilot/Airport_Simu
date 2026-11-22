/**
 * 監査 docs/38 ID 03（接続ネットワーク）— 分岐・交差・閉路・一方通行・切断・再接続と経路探索の正しさ。
 * 既存: tests/unit/network.test.ts, network.free.test.ts, sim/pathfinding.test.ts（固定形状）。
 * 追加: シード付きランダム誘導路グラフに対する差分テスト（独立実装の BFS を oracle に reachableNodes / findPath を照合）、
 *       双方向グラフでの到達対称性、一方通行・幅区分・建設状態・コードF・閉路切断/再接続・交差（接続ノードなし）の扱い。
 */
import { describe, expect, it } from 'vitest';
import { buildAirsideNetwork, canAircraftUse, reachableNodes } from '../../src/core/airside/network';
import { deleteEntity, addTaxiwayPath, moveEntity, reverseEdge, updateEntity } from '../../src/core/layout/operations';
import { findNodeAt } from '../../src/core/layout/network';
import { taxiwayWidthCap, type AirportLayout, type BuildState, type SizeClass } from '../../src/core/model/types';
import { Rng } from '../../src/core/rng';
import { findPath } from '../../src/core/sim/pathfinding';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { analyzeLayout } from '../../src/core/validation/validate';
import { emptyLayout, must } from '../unit/helpers';

const RANK: Record<SizeClass, number> = { S: 1, M: 2, L: 3 };

/** oracle: レイアウトの誘導路グラフだけから（airside/network.ts を使わずに）有向隣接を作る */
function oracleAdj(l: AirportLayout, size: SizeClass, codeF = false): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const id of Object.keys(l.taxiNodes)) adj.set(id, []);
  for (const e of Object.values(l.taxiways)) {
    if (e.buildState !== 'operational') continue;
    if (RANK[taxiwayWidthCap(e.widthClass)] < RANK[size]) continue;
    if (codeF && e.widthClass !== 'F') continue;
    adj.get(e.from)!.push(e.to);
    if (!e.oneWay) adj.get(e.to)!.push(e.from);
  }
  return adj;
}
function bfs(adj: Map<string, string[]>, s: string): Set<string> {
  const seen = new Set([s]);
  const q = [s];
  while (q.length) {
    const c = q.shift()!;
    for (const n of adj.get(c) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      q.push(n);
    }
  }
  return seen;
}

/** ランダムな誘導路グラフ（格子上の折れ線を重ねる）。属性（幅・一方通行・建設状態）もランダム */
function randomTaxiGraph(seed: string, paths: number, attrs: boolean): AirportLayout {
  const rng = new Rng(seed);
  let l = emptyLayout(60, 60);
  for (let i = 0; i < paths; i++) {
    const pts = [{ x: rng.int(2, 28) * 2, y: rng.int(2, 28) * 2 }];
    const n = rng.int(1, 3);
    for (let k = 0; k < n; k++) {
      const last = pts[pts.length - 1]!;
      // 水平/垂直/斜め 45° のどれか
      const d = rng.int(2, 10);
      const dir = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]][rng.int(0, 7)]!;
      pts.push({ x: Math.min(58, Math.max(1, last.x + dir[0]! * d)), y: Math.min(58, Math.max(1, last.y + dir[1]! * d)) });
    }
    const opt = attrs
      ? {
          widthClass: (['S', 'M', 'L'] as const)[rng.int(0, 2)]!,
          oneWay: rng.int(0, 5) === 0,
          buildState: (['operational', 'operational', 'operational', 'operational', 'underConstruction', 'planned'] as BuildState[])[rng.int(0, 5)]!,
        }
      : { widthClass: 'L' as const };
    const r = addTaxiwayPath(l, pts, opt);
    if (r.ok) l = r.layout;
  }
  return l;
}

describe('ID03 ランダム誘導路グラフ: reachableNodes / findPath が oracle と一致する（差分テスト）', () => {
  for (const seed of ['a3-s1', 'a3-s2', 'a3-s3', 'a3-s4', 'a3-s5']) {
    for (const attrs of [false, true]) {
      it(`seed=${seed} 属性${attrs ? 'あり(幅/一方通行/建設状態)' : 'なし(双方向・全て運用中)'}: 全ノード × 3 区分の到達集合が一致`, { timeout: 120_000 }, () => {
        const l = randomTaxiGraph(seed, 14, attrs);
        const ids = Object.keys(l.taxiNodes).sort();
        expect(ids.length, 'graph too small').toBeGreaterThan(10);
        const net = buildAirsideNetwork(l);
        for (const size of ['S', 'M', 'L'] as const) {
          const adj = oracleAdj(l, size);
          const radj = new Map<string, string[]>(ids.map((i) => [i, []]));
          for (const [a, bs] of adj) for (const b of bs) radj.get(b)!.push(a);
          for (const s of ids) {
            const f = reachableNodes(net, s, size, 'forward', { operationalOnly: true });
            const o = bfs(adj, s);
            // 滑走路・スポットの無い純粋な誘導路グラフなので、ネットワークのノード = レイアウトのノード
            expect([...f].sort(), `${seed} fwd ${s} ${size}`).toEqual([...o].sort());
            const rv = reachableNodes(net, s, size, 'reverse', { operationalOnly: true });
            expect([...rv].sort(), `${seed} rev ${s} ${size}`).toEqual([...bfs(radj, s)].sort());
          }
        }
        // findPath: 到達可能なときだけ経路があり、経路は連続・使用可能・コスト非負。非対称ペアでも壊れない
        const rng = new Rng(`${seed}:pairs`);
        for (let i = 0; i < 60; i++) {
          const a = ids[rng.int(0, ids.length - 1)]!;
          const b = ids[rng.int(0, ids.length - 1)]!;
          const size = (['S', 'M', 'L'] as const)[rng.int(0, 2)]!;
          const p = findPath(net, { sources: [{ node: a, cost: 0 }], goals: new Map([[b, 0]]), size, speed: 8 });
          const reachable = bfs(oracleAdj(l, size), a).has(b);
          expect(p !== null, `${seed} ${a}->${b} ${size}`).toBe(reachable);
          if (p) {
            expect(p.nodes[0]).toBe(a);
            expect(p.nodes.at(-1)).toBe(b);
            expect(p.edges.length).toBe(p.nodes.length - 1);
            p.edges.forEach((eid, k) => {
              const e = net.edges[eid]!;
              expect(canAircraftUse(e, size, { operationalOnly: true })).toBe(true);
              const fwd = e.from === p.nodes[k] && e.to === p.nodes[k + 1];
              const back = e.bidirectional && e.to === p.nodes[k] && e.from === p.nodes[k + 1];
              expect(fwd || back, `${seed} edge ${eid} not traversable in path direction`).toBe(true);
            });
            expect(p.cost).toBeGreaterThanOrEqual(0);
          }
        }
        if (!attrs) {
          // 双方向・全運用中: 到達は対称で、最短コストも往復で一致する
          for (let i = 0; i < 40; i++) {
            const a = ids[rng.int(0, ids.length - 1)]!;
            const b = ids[rng.int(0, ids.length - 1)]!;
            const ab = findPath(net, { sources: [{ node: a, cost: 0 }], goals: new Map([[b, 0]]), size: 'L', speed: 8 });
            const ba = findPath(net, { sources: [{ node: b, cost: 0 }], goals: new Map([[a, 0]]), size: 'L', speed: 8 });
            expect(ab === null, `${seed} symmetric ${a}<->${b}`).toBe(ba === null);
            if (ab && ba) expect(ab.cost).toBeCloseTo(ba.cost, 9);
          }
        }
      });
    }
  }
});

describe('ID03 閉路・分岐・切断と再接続', () => {
  /** 一辺 20 タイルの正方形の閉路 + 1 本の枝 */
  function ringWithSpur(): { l: AirportLayout; node: (x: number, y: number) => string } {
    let l = emptyLayout(80, 80);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 10 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 30, y: 20 }, { x: 50, y: 20 }])).layout;
    const lay = l;
    return { l, node: (x, y) => findNodeAt(lay.taxiNodes, { x, y })! };
  }
  const reach = (l: AirportLayout, from: string, size: SizeClass = 'M') => reachableNodes(buildAirsideNetwork(l), from, size, 'forward', { operationalOnly: true });

  it('閉路は 1 辺の切断では全体が連結のまま、2 辺の切断で分断され、再接続で戻る', () => {
    const { l, node } = ringWithSpur();
    const all = Object.keys(l.taxiNodes).length;
    expect(reach(l, node(10, 10)).size).toBe(all);
    const edgeBetween = (layout: AirportLayout, a: string, b: string) =>
      Object.values(layout.taxiways).find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))!.id;
    const top = edgeBetween(l, node(10, 10), node(30, 10));
    const bottom = edgeBetween(l, node(10, 30), node(30, 30));
    const cut1 = must(deleteEntity(l, top)).layout;
    expect(reach(cut1, node(10, 10)).size, '1 辺切断でも閉路の反対側経由で連結').toBe(Object.keys(cut1.taxiNodes).length);
    const cut2 = must(deleteEntity(cut1, bottom)).layout;
    const comps = reach(cut2, node(10, 10));
    expect(comps.has(node(30, 10)), '2 辺切断で分断').toBe(false);
    expect(comps.has(node(10, 30))).toBe(true);
    // 再接続
    const re = must(addTaxiwayPath(cut2, [{ x: 10, y: 10 }, { x: 30, y: 10 }])).layout;
    const re2 = must(addTaxiwayPath(re, [{ x: 10, y: 30 }, { x: 30, y: 30 }])).layout;
    const back = reach(re2, node(10, 10));
    expect(back.size).toBe(Object.keys(re2.taxiNodes).length);
    // 枝（スパー）の端点は閉路全体から到達でき、逆も然り
    expect(reach(re2, node(50, 20)).has(node(10, 10))).toBe(true);
  });

  it('分岐の T 字: 既存エッジの途中に端点を置くとエッジが分割されてノードが作られ接続される', () => {
    let l = emptyLayout(60, 60);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 20 }, { x: 40, y: 20 }])).layout;
    const before = Object.keys(l.taxiways).length;
    l = must(addTaxiwayPath(l, [{ x: 25, y: 20 }, { x: 25, y: 40 }])).layout;
    expect(Object.keys(l.taxiways).length).toBe(before + 2); // 元の 1 本が 2 本に分割 + 枝 1 本
    const t = findNodeAt(l.taxiNodes, { x: 25, y: 20 })!;
    expect(t).toBeDefined();
    const net = buildAirsideNetwork(l);
    expect(net.nodes[t]!.kind).toBe('intersection');
    expect(reachableNodes(net, findNodeAt(l.taxiNodes, { x: 10, y: 20 })!, 'M', 'forward', { operationalOnly: true }).has(findNodeAt(l.taxiNodes, { x: 25, y: 40 })!)).toBe(true);
  });

  it('十字交差は作図時に交点ノード(次数 4)が自動生成されて接続される。ノードを動かして交点なしの交差にすると非接続になり TAXIWAY_CROSSING_NO_JUNCTION が出る', () => {
    let l = emptyLayout(60, 60);
    l = must(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 40, y: 30 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 25, y: 10 }, { x: 25, y: 50 }])).layout;
    const a = findNodeAt(l.taxiNodes, { x: 10, y: 30 })!;
    const b = findNodeAt(l.taxiNodes, { x: 25, y: 10 })!;
    const x = findNodeAt(l.taxiNodes, { x: 25, y: 30 })!;
    expect(x).toBeDefined();
    expect(buildAirsideNetwork(l).nodes[x]!.kind).toBe('intersection');
    expect(reach(l, a).has(b)).toBe(true);
    expect(analyzeLayout(l).issues.filter((i) => i.code === 'TAXIWAY_CROSSING_NO_JUNCTION')).toHaveLength(0);

    // 交点なしの交差: 先に交わらない 2 本を作り、片方の端点を動かして交差させる
    let m = emptyLayout(60, 60);
    m = must(addTaxiwayPath(m, [{ x: 10, y: 30 }, { x: 40, y: 30 }])).layout;
    m = must(addTaxiwayPath(m, [{ x: 25, y: 10 }, { x: 25, y: 25 }])).layout;
    const tip = findNodeAt(m.taxiNodes, { x: 25, y: 25 })!;
    const moved = must(moveEntity(m, tip, { x: 0, y: 25 })).layout; // (25,25) → (25,50): 横の誘導路を交点ノードなしで横切る
    const crossIssues = analyzeLayout(moved).issues.filter((i) => i.code === 'TAXIWAY_CROSSING_NO_JUNCTION');
    expect(crossIssues.length).toBeGreaterThanOrEqual(1);
    expect(reach(moved, findNodeAt(moved.taxiNodes, { x: 10, y: 30 })!).has(findNodeAt(moved.taxiNodes, { x: 25, y: 10 })!), '交点ノードなしでは接続されない').toBe(false);
  });

  it('一方通行: 向きの反転で到達の向きが入れ替わり、閉路を一方通行にすると逆回りは不可だが全ノードに到達できる', () => {
    const { l, node } = ringWithSpur();
    let cur = l;
    // 閉路の 4 辺を時計回りの一方通行にする
    const ringNodes = [node(10, 10), node(30, 10), node(30, 20), node(30, 30), node(10, 30)]; // (30,20) は枝の分岐点でエッジが分割されている
    for (let i = 0; i < 5; i++) {
      const a = ringNodes[i]!;
      const b = ringNodes[(i + 1) % 5]!;
      const e = Object.values(cur.taxiways).find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a))!;
      cur = must(updateEntity(cur, e.id, { oneWay: true })).layout;
      if (cur.taxiways[e.id]!.from !== a) cur = must(reverseEdge(cur, e.id)).layout;
      expect(cur.taxiways[e.id]!.from).toBe(a);
    }
    const net = buildAirsideNetwork(cur);
    const fwd = findPath(net, { sources: [{ node: ringNodes[0]!, cost: 0 }], goals: new Map([[ringNodes[4]!, 0]]), size: 'M', speed: 8 });
    expect(fwd).not.toBeNull();
    expect(fwd!.nodes).toEqual(ringNodes); // 逆回り(1 辺)は不可なので 4 辺を回る
    expect(reach(cur, ringNodes[0]!).size).toBe(Object.keys(cur.taxiNodes).length);
    // 全辺を反転すると逆回りになり、(10,10)->(10,30) は 1 辺
    let rev = cur;
    for (const e of Object.values(cur.taxiways)) if (e.oneWay) rev = must(reverseEdge(rev, e.id)).layout;
    const p2 = findPath(buildAirsideNetwork(rev), { sources: [{ node: ringNodes[0]!, cost: 0 }], goals: new Map([[ringNodes[4]!, 0]]), size: 'M', speed: 8 });
    expect(p2!.nodes).toEqual([ringNodes[0], ringNodes[4]]);
  });
});

describe('ID03 幅区分・コード F・建設状態・スポット/滑走路接続（サンプル空港）', () => {
  const l0 = createSampleAirport();
  const standNode = (s: string) => `${s}:P`;
  const rwyEnd = (l: AirportLayout) => {
    const net = buildAirsideNetwork(l);
    return net.runwayNodes[Object.keys(l.runways)[0]!]![0]!;
  };

  it('全スポット(9)から滑走路端へ、サイズが適合する範囲で経路がある。スポット→端→スポットは対称（コスト同一）', () => {
    const net = buildAirsideNetwork(l0);
    const end = rwyEnd(l0);
    let found = 0;
    for (const s of Object.values(l0.stands)) {
      const out = findPath(net, { sources: [{ node: standNode(s.id), cost: 0 }], goals: new Map([[end, 0]]), size: s.size, speed: 8, allowStands: [s.id] });
      const back = findPath(net, { sources: [{ node: end, cost: 0 }], goals: new Map([[standNode(s.id), 0]]), size: s.size, speed: 8, allowStands: [s.id] });
      expect(out, s.id).not.toBeNull();
      expect(back, s.id).not.toBeNull();
      expect(back!.cost).toBeCloseTo(out!.cost, 9);
      // 経路は滑走路エッジを使わず、他のスポットのリンクを通らない
      for (const eid of out!.edges) {
        expect(net.edges[eid]!.kind).not.toBe('runway');
        if (net.edges[eid]!.kind === 'standLink') expect(net.edges[eid]!.sourceId).toBe(s.id);
      }
      found++;
    }
    expect(found).toBe(9);
  });

  it('スポットの建設状態が operational でない(underConstruction)と、そのスポットへ向かう経路は operationalOnly で拒否される', () => {
    const l = must(updateEntity(l0, 'std_2', { buildState: 'underConstruction' })).layout;
    const net = buildAirsideNetwork(l);
    const e = net.edges['std_2:L']!;
    expect(e.operational).toBe(false);
    expect(canAircraftUse(e, 'M', { operationalOnly: true })).toBe(false);
    expect(canAircraftUse(e, 'M')).toBe(true);
    const p = findPath(net, { sources: [{ node: rwyEnd(l), cost: 0 }], goals: new Map([[standNode('std_2'), 0]]), size: 'M', speed: 8, allowStands: ['std_2'] });
    expect(p).toBeNull();
  });

  it('コード F: L 級の誘導路・スポットに codeF 指定がなければ経路なし。全経路に指定するとスポット→滑走路が成立（滑走路幅 60 m は別途必要）', () => {
    const net = buildAirsideNetwork(l0);
    const q = (n: ReturnType<typeof buildAirsideNetwork>, codeF: boolean) =>
      findPath(n, { sources: [{ node: standNode('std_9'), cost: 0 }], goals: new Map([[rwyEnd(l0), 0]]), size: 'L', speed: 8, allowStands: ['std_9'], codeF });
    expect(q(net, false)).not.toBeNull();
    expect(q(net, true), 'codeF 指定なしの網でコード F は通れない').toBeNull();
    let l = l0;
    for (const t of Object.values(l.taxiways)) l = must(updateEntity(l, t.id, { widthClass: 'F' })).layout;
    l = must(updateEntity(l, 'std_9', { codeF: true })).layout;
    expect(q(buildAirsideNetwork(l), true)).not.toBeNull();
    // 1 本でも codeF でない L 級誘導路で経路が塞がる(経路上の1本を外す)
    const p = q(buildAirsideNetwork(l), true)!;
    const victim = buildAirsideNetwork(l).edges[p.edges.find((e) => buildAirsideNetwork(l).edges[e]!.kind === 'taxiway')!]!;
    const l2 = must(updateEntity(l, victim.sourceId, { widthClass: 'L' })).layout;
    const alt = q(buildAirsideNetwork(l2), true);
    expect(alt === null || !alt.edges.includes(victim.id)).toBe(true);
  });

  it('滑走路上は走行しない: 全経路は滑走路エッジを含まない / 滑走路の横断はノード経由のみ（crossingAirport）', async () => {
    const { crossingAirport } = await import('../unit/sim/helpers');
    const l = crossingAirport();
    const net = buildAirsideNetwork(l);
    const s = standNode(Object.keys(l.stands)[0]!);
    const goal = net.runwayNodes[Object.keys(l.runways)[0]!]![0]!;
    const p = findPath(net, { sources: [{ node: s, cost: 0 }], goals: new Map([[goal, 0]]), size: 'M', speed: 8, allowStands: Object.keys(l.stands) });
    expect(p).not.toBeNull();
    expect(p!.edges.every((e) => net.edges[e]!.kind !== 'runway')).toBe(true);
  });
});
