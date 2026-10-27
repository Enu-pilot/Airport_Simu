import { describe, expect, it } from 'vitest';
import {
  addRoadPath,
  addTaxiwayPath,
  deleteEntity,
  moveEntity,
  placeRunway,
  placeStand,
  reverseEdge,
  updateEntity,
} from '../../src/core/layout/operations';
import { buildAirsideNetwork, canAircraftUse, reachableNodes } from '../../src/core/airside/network';
import { findNodeAt } from '../../src/core/layout/network';
import type { AirportLayout } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

const nodeAt = (l: AirportLayout, x: number, y: number) => findNodeAt(l.taxiNodes, { x, y });
const degree = (l: AirportLayout, id: string) =>
  Object.values(l.taxiways).filter((e) => e.from === id || e.to === id).length;

describe('誘導路の描画と接続', () => {
  it('直線を引くとノード2つ・エッジ1本', () => {
    const l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 5 }, { x: 10, y: 5 }])).layout;
    expect(Object.keys(l.taxiNodes)).toHaveLength(2);
    expect(Object.keys(l.taxiways)).toHaveLength(1);
  });

  it('既存誘導路の途中に接続すると分割されT字交差点ができる', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 5 }, { x: 10, y: 5 }])).layout;
    const originalId = Object.keys(l.taxiways)[0]!;
    l = must(addTaxiwayPath(l, [{ x: 4, y: 5 }, { x: 4, y: 12 }])).layout;
    expect(Object.keys(l.taxiways)).toHaveLength(3);
    const junction = nodeAt(l, 4, 5)!;
    expect(degree(l, junction)).toBe(3);
    // 分割前のIDは前半の区間に引き継がれる
    expect(l.taxiways[originalId]).toMatchObject({ to: junction });
    const net = buildAirsideNetwork(l);
    expect(net.nodes[junction]!.kind).toBe('intersection');
  });

  it('交差させると両方が分割され十字交差点ができる', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 5 }, { x: 10, y: 5 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 5, y: 0 }, { x: 5, y: 10 }])).layout;
    const x = nodeAt(l, 5, 5)!;
    expect(degree(l, x)).toBe(4);
    expect(Object.keys(l.taxiways)).toHaveLength(4);
  });

  it('既存ノードの上を通過すると、そのノードで接続される', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 5, y: 0 }, { x: 5, y: 5 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 0, y: 5 }, { x: 10, y: 5 }])).layout;
    expect(degree(l, nodeAt(l, 5, 5)!)).toBe(3);
  });

  it('重なる区間を引いても重複エッジは作らない', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 0 }, { x: 10, y: 0 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 5, y: 0 }, { x: 15, y: 0 }])).layout;
    expect(Object.keys(l.taxiways)).toHaveLength(3); // 0-5, 5-10, 10-15
    expect(addTaxiwayPath(l, [{ x: 0, y: 0 }, { x: 15, y: 0 }])).toEqual({ ok: false, reason: 'NO_CHANGE' });
  });

  it('滑走路を横切る誘導路は中心線上に滑走路入口ノードを作る', () => {
    let l = must(placeRunway(emptyLayout(), { x: 5, y: 20 }, 90, 60)).layout;
    l = must(addTaxiwayPath(l, [{ x: 30, y: 10 }, { x: 30, y: 30 }])).layout;
    const entry = nodeAt(l, 30, 20)!;
    expect(entry).toBeDefined();
    const net = buildAirsideNetwork(l);
    expect(net.nodes[entry]!.kind).toBe('runwayEntry');
    expect(net.runwayNodes.rwy_1).toEqual(['rwy_1:T0', entry, 'rwy_1:T1']);
    // 入口へ接続する誘導路エッジは停止義務（ホールディングポイント）を持つ
    const holds = Object.values(net.edges).filter((e) => e.holdShortAt?.nodeId === entry);
    expect(holds).toHaveLength(2);
    // 停止義務を外せる
    const l2 = must(updateEntity(l, entry, { holdShort: false })).layout;
    expect(Object.values(buildAirsideNetwork(l2).edges).some((e) => e.holdShortAt)).toBe(false);
  });

  it('ノードを削除すると接続エッジと孤立ノードも消える', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 5 }, { x: 10, y: 5 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 5, y: 5 }, { x: 5, y: 10 }])).layout;
    l = must(deleteEntity(l, nodeAt(l, 5, 5)!)).layout;
    expect(Object.keys(l.taxiways)).toHaveLength(0);
    expect(Object.keys(l.taxiNodes)).toHaveLength(0);
  });

  it('エッジを移動すると両端ノードが動き、接続エッジも追従する', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 10 }])).layout;
    const first = Object.values(l.taxiways).find((e) => l.taxiNodes[e.from]!.pos.x === 0)!;
    l = must(moveEntity(l, first.id, { x: 0, y: -2 })).layout;
    expect(l.taxiNodes[first.from]!.pos).toEqual({ x: 0, y: 3 });
    expect(l.taxiNodes[first.to]!.pos).toEqual({ x: 10, y: 3 });
    // 他のノードの位置へは移動できない
    const other = nodeAt(l, 10, 10)!;
    expect(moveEntity(l, other, { x: 0, y: -7 })).toEqual({ ok: false, reason: 'NODE_EXISTS' });
  });

  it('道路ネットワークは誘導路と独立', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 5 }, { x: 10, y: 5 }])).layout;
    l = must(addRoadPath(l, [{ x: 5, y: 0 }, { x: 5, y: 10 }], { roadClass: 'service' })).layout;
    expect(Object.keys(l.taxiways)).toHaveLength(1);
    expect(Object.keys(l.roads)).toHaveLength(1);
  });
});

describe('スポットの接続', () => {
  it('スポット入口が誘導路上にあれば自動的にノードが作られ接続される', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 14 }, { x: 20, y: 14 }])).layout;
    l = must(placeStand(l, { x: 10, y: 10 }, 'M', 0)).layout; // 入口 (11, 14)
    const net = buildAirsideNetwork(l);
    expect(net.standLinks.std_1).toBe(nodeAt(l, 11, 14));
    expect(net.edges['std_1:L']).toMatchObject({ kind: 'standLink', maxSize: 'M' });
  });

  it('後から誘導路を引いても接続される / 移動で外れる', () => {
    let l = must(placeStand(emptyLayout(), { x: 10, y: 10 }, 'S', 0)).layout; // 入口 (11, 13)
    expect(buildAirsideNetwork(l).standLinks.std_1).toBeUndefined();
    l = must(addTaxiwayPath(l, [{ x: 0, y: 13 }, { x: 20, y: 13 }])).layout;
    expect(buildAirsideNetwork(l).standLinks.std_1).toBeDefined();
    l = must(moveEntity(l, 'std_1', { x: 0, y: -5 })).layout;
    expect(buildAirsideNetwork(l).standLinks.std_1).toBeUndefined();
  });
});

describe('論理ネットワークの通行条件', () => {
  it('誘導路幅・一方通行・建設状態で通行可否が決まる', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 0 }, { x: 10, y: 0 }], { widthClass: 'M', oneWay: true })).layout;
    l = must(addTaxiwayPath(l, [{ x: 10, y: 0 }, { x: 20, y: 0 }], { widthClass: 'L', buildState: 'underConstruction' })).layout;
    const net = buildAirsideNetwork(l);
    const [m, lEdge] = Object.values(net.edges);
    expect(canAircraftUse(m!, 'M')).toBe(true);
    expect(canAircraftUse(m!, 'L')).toBe(false);
    expect(canAircraftUse(lEdge!, 'L')).toBe(true);
    expect(canAircraftUse(lEdge!, 'L', { operationalOnly: true })).toBe(false);

    const a = nodeAt(l, 0, 0)!;
    const b = nodeAt(l, 10, 0)!;
    expect(reachableNodes(net, a, 'S', 'forward').has(b)).toBe(true);
    expect(reachableNodes(net, b, 'S', 'forward').has(a)).toBe(false); // 一方通行
    const reversed = buildAirsideNetwork(must(reverseEdge(l, m!.id)).layout);
    expect(reachableNodes(reversed, b, 'S', 'forward').has(a)).toBe(true);
  });
});
