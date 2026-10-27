import { describe, expect, it } from 'vitest';
import { buildAirsideNetwork } from '../../../src/core/airside/network';
import { findPath } from '../../../src/core/sim/pathfinding';
import { addTaxiwayPath, updateEntity } from '../../../src/core/layout/operations';
import { findNodeAt } from '../../../src/core/layout/network';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import type { AirportLayout } from '../../../src/core/model/types';
import { must } from '../helpers';
import { crossingAirport } from './helpers';

const node = (l: AirportLayout, x: number, y: number) => findNodeAt(l.taxiNodes, { x, y })!;

function connected(l: AirportLayout, nodes: string[], edges: string[]): boolean {
  const net = buildAirsideNetwork(l);
  return edges.every((eid, i) => {
    const e = net.edges[eid]!;
    return (e.from === nodes[i] && e.to === nodes[i + 1]) || (e.bidirectional && e.to === nodes[i] && e.from === nodes[i + 1]);
  });
}

describe('誘導路の経路探索', () => {
  const l = createSampleAirport();
  const net = buildAirsideNetwork(l);

  it('接続されたエッジだけを辿ってスポットから滑走路入口へ行ける', () => {
    const p = findPath(net, {
      sources: [{ node: 'std_1:P', cost: 0 }],
      goals: new Map([[node(l, 20, 30), 0]]),
      size: 'M',
      speed: 8,
      allowStands: ['std_1'],
    });
    expect(p).not.toBeNull();
    expect(p!.nodes[0]).toBe('std_1:P');
    expect(p!.nodes.at(-1)).toBe(node(l, 20, 30));
    expect(connected(l, p!.nodes, p!.edges)).toBe(true);
    // 地上走行では滑走路の上を走らない
    expect(p!.edges.every((e) => net.edges[e]!.kind !== 'runway')).toBe(true);
  });

  it('到達できない場合は null（瞬間移動しない）', () => {
    const l2 = must(addTaxiwayPath(l, [{ x: 60, y: 75 }, { x: 80, y: 75 }])).layout;
    const net2 = buildAirsideNetwork(l2);
    const p = findPath(net2, {
      sources: [{ node: node(l2, 60, 75), cost: 0 }],
      goals: new Map([[node(l2, 20, 30), 0]]),
      size: 'S',
      speed: 8,
    });
    expect(p).toBeNull();
  });

  it('機体区分が通れない誘導路は使わない', () => {
    let l2 = l;
    for (const e of Object.values(l2.taxiways).filter((t) => t.name === 'B1' || t.name === 'B2')) {
      l2 = must(updateEntity(l2, e.id, { widthClass: 'M' })).layout;
    }
    const q = (size: 'M' | 'L') =>
      findPath(buildAirsideNetwork(l2), {
        sources: [{ node: 'std_9:P', cost: 0 }],
        goals: new Map([[node(l2, 20, 30), 0]]),
        size,
        speed: 8,
        allowStands: ['std_9'],
      });
    expect(q('M')).not.toBeNull();
    expect(q('L')).toBeNull();
  });

  it('予約中の区間を避けて迂回する / 迂回路がなければ null', () => {
    const blockedEdge = Object.values(l.taxiways).find((t) => t.name === 'B1')!.id;
    const p = findPath(net, {
      sources: [{ node: 'std_1:P', cost: 0 }],
      goals: new Map([[node(l, 20, 30), 0]]),
      size: 'M',
      speed: 8,
      allowStands: ['std_1'],
      blockedEdge: (e) => e === blockedEdge,
    });
    expect(p).not.toBeNull();
    expect(p!.edges).not.toContain(blockedEdge);
    const b2 = Object.values(l.taxiways).find((t) => t.name === 'B2')!.id;
    const none = findPath(net, {
      sources: [{ node: 'std_1:P', cost: 0 }],
      goals: new Map([[node(l, 20, 30), 0]]),
      size: 'M',
      speed: 8,
      allowStands: ['std_1'],
      blockedEdge: (e) => e === blockedEdge || e === b2,
    });
    expect(none).toBeNull();
  });

  it('一方通行を逆走しない', () => {
    let l2 = crossingAirport();
    const lane = Object.values(l2.taxiways).find((t) => {
      const a = l2.taxiNodes[t.from]!.pos;
      const b = l2.taxiNodes[t.to]!.pos;
      return a.y === 23 && b.y === 23 && Math.min(a.x, b.x) === 45;
    })!;
    l2 = must(updateEntity(l2, lane.id, { oneWay: true })).layout;
    const net2 = buildAirsideNetwork(l2);
    const from = l2.taxiNodes[lane.from]!.id;
    const to = l2.taxiNodes[lane.to]!.id;
    const fwd = findPath(net2, { sources: [{ node: from, cost: 0 }], goals: new Map([[to, 0]]), size: 'M', speed: 8 });
    const back = findPath(net2, { sources: [{ node: to, cost: 0 }], goals: new Map([[from, 0]]), size: 'M', speed: 8 });
    expect(fwd!.edges).toEqual([lane.id]);
    expect(back === null || !back.edges.includes(lane.id)).toBe(true);
  });
});
