import { describe, expect, it } from 'vitest';
import { addTaxiwayPath, convertRunwayToFree, placeFreeRunway, placeRunway } from '../../src/core/layout/operations';
import { buildAirsideNetwork } from '../../src/core/airside/network';
import { positionOnRunway, runwayAxis } from '../../src/core/layout/runway';
import { findNodeNear } from '../../src/core/layout/network';
import { POS_EPS_T } from '../../src/core/geometry/tolerance';
import { GRID8_STEP } from '../../src/core/geometry/angle';
import { classifySegmentIntersection } from '../../src/core/geometry/segment';
import type { AirportLayout, Heading } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

const HEADINGS: Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];
const free = (l: AirportLayout, g: { start: { x: number; y: number }; headingDeg: number; lengthM: number }) => {
  const r = must(placeFreeRunway(l, g));
  return { layout: r.layout, id: r.created[0]! };
};

describe('自由形の滑走路 × 誘導路（S5）', () => {
  it('斜めの自由形を 8 方向の誘導路で横切ると、実数の位置に入口ノードと停止義務ができる', () => {
    for (const h of HEADINGS) {
      const v = GRID8_STEP[h];
      const { layout: l0, id } = free(emptyLayout(), { start: { x: 30, y: 40 }, headingDeg: 20, lengthM: 1500 });
      const l = must(addTaxiwayPath(l0, [{ x: 35 - 6 * v.x, y: 25 - 6 * v.y }, { x: 35 + 6 * v.x, y: 25 + 6 * v.y }])).layout;
      const r = l.runways[id]!;
      const ax = runwayAxis(r);
      const nodes = Object.values(l.taxiNodes);
      // 端点 2 つ + 交点 1 つ
      expect(nodes).toHaveLength(3);
      const entry = nodes.find((n) => !Number.isInteger(n.pos.x) || !Number.isInteger(n.pos.y))!;
      expect(entry).toBeDefined();
      expect(positionOnRunway(r, entry.pos)).not.toBeNull();
      expect(entry.holdShort).toBe(true);
      expect(Object.keys(l.taxiways)).toHaveLength(2);
      const c = classifySegmentIntersection({ x: 35 - 6 * v.x, y: 25 - 6 * v.y }, { x: 35 + 6 * v.x, y: 25 + 6 * v.y }, ax.start, ax.end);
      expect(c.kind).toBe('point');
      if (c.kind === 'point') expect(Math.hypot(c.p.x - entry.pos.x, c.p.y - entry.pos.y)).toBeLessThanOrEqual(POS_EPS_T);
      const net = buildAirsideNetwork(l);
      expect(net.nodes[entry.id]!.kind).toBe('runwayEntry');
      expect(net.nodes[entry.id]!.runwayIds).toEqual([id]);
      expect(net.nodes[entry.id]!.holdShort).toBe(true);
      expect(net.runwayNodes[id]).toContain(entry.id);
      // 停止義務は入口に接続する誘導路エッジに付く
      expect(Object.values(net.edges).filter((e) => e.holdShortAt?.nodeId === entry.id)).toHaveLength(2);
    }
  });

  it('同じ交点を再度引いても・交点から引いても、ノードは重複しない', () => {
    const { layout: l0 } = free(emptyLayout(), { start: { x: 30, y: 40 }, headingDeg: 20, lengthM: 1500 });
    const p = [{ x: 29, y: 25 }, { x: 41, y: 25 }];
    const l1 = must(addTaxiwayPath(l0, p)).layout;
    expect(addTaxiwayPath(l1, p)).toEqual({ ok: false, reason: 'NO_CHANGE' });
    const n1 = Object.keys(l1.taxiNodes).length;
    const entry = Object.values(l1.taxiNodes).find((n) => !Number.isInteger(n.pos.x))!;
    // 交点（実数）から別の誘導路を出す
    const l2 = must(addTaxiwayPath(l1, [{ ...entry.pos }, { x: 35, y: 12 }])).layout;
    expect(Object.keys(l2.taxiNodes)).toHaveLength(n1 + 1);
    expect(findNodeNear(l2.taxiNodes, entry.pos)).toBe(entry.id);
    // 別の角度の誘導路が同じ交点を通っても同じノードに併合される
    const l3 = must(addTaxiwayPath(l2, [{ x: 35, y: 10 }, { x: 35, y: 30 }])).layout;
    const near = Object.values(l3.taxiNodes).filter((n) => Math.hypot(n.pos.x - entry.pos.x, n.pos.y - entry.pos.y) <= 1e-3);
    expect(near.length).toBeLessThanOrEqual(2);
  });

  it('従来形の滑走路 × 誘導路は従来どおり（交点がタイル中心のときだけ入口）', () => {
    const l0 = must(placeRunway(emptyLayout(), { x: 10, y: 20 }, 90, 20)).layout;
    const l = must(addTaxiwayPath(l0, [{ x: 15, y: 15 }, { x: 15, y: 25 }])).layout;
    expect(Object.values(l.taxiNodes).map((n) => `${n.pos.x},${n.pos.y}`).sort()).toEqual(['15,15', '15,20', '15,25']);
    expect(buildAirsideNetwork(l).crossings).toBeUndefined();
  });
});

describe('従来形から変換した自由形の端ノード（S4 の既知の隙間）', () => {
  it('端に誘導路ノードがあれば、8 方位 × 長さで端ノード（T0/T1）が重複しない', () => {
    for (const h of HEADINGS) {
      for (const len of [3, 10]) {
        const v = GRID8_STEP[h];
        const p = { x: -v.y, y: v.x };
        const start = { x: 40, y: 30 };
        const end = { x: start.x + v.x * len, y: start.y + v.y * len };
        let l = must(placeRunway(emptyLayout(), start, h, len)).layout;
        l = must(addTaxiwayPath(l, [{ x: start.x + 3 * p.x, y: start.y + 3 * p.y }, start])).layout;
        l = must(addTaxiwayPath(l, [{ x: end.x + 3 * p.x, y: end.y + 3 * p.y }, end])).layout;
        const before = buildAirsideNetwork(l);
        const after = buildAirsideNetwork(must(convertRunwayToFree(l, 'rwy_1')).layout);
        expect(Object.keys(after.nodes).sort()).toEqual(Object.keys(before.nodes).sort());
        expect(Object.keys(after.edges).sort()).toEqual(Object.keys(before.edges).sort());
        expect(after.runwayNodes).toEqual(before.runwayNodes);
        expect(Object.keys(after.nodes).some((id) => id.includes(':T'))).toBe(false);
      }
    }
  });

  it('端に誘導路が無ければ、端ノードは 1 つずつ作られる', () => {
    const l = must(convertRunwayToFree(must(placeRunway(emptyLayout(), { x: 10, y: 10 }, 135, 6)).layout, 'rwy_1')).layout;
    const net = buildAirsideNetwork(l);
    expect(net.runwayNodes['rwy_1']).toEqual(['rwy_1:T0', 'rwy_1:T1']);
  });
});

describe('滑走路どうしの交差点ノード（S5）', () => {
  const cross = (deg: number) => {
    // 東向き 40 タイルの滑走路（y=30、x=10..50）と、中点（30,30）で交わる別の自由形
    let l = free(emptyLayout(), { start: { x: 10, y: 30 }, headingDeg: 90, lengthM: 1000 }).layout;
    const mid = { x: 30, y: 30 };
    const dir = { x: Math.sin((deg * Math.PI) / 180), y: -Math.cos((deg * Math.PI) / 180) };
    const half = 12;
    l = free(l, { start: { x: mid.x - dir.x * half, y: mid.y - dir.y * half }, headingDeg: deg, lengthM: 2 * half * 25 }).layout;
    return l;
  };

  it.each([30, 60, 0])('方位 %i° の滑走路と（東西の滑走路が）交わる 2 本に交差点ノードができ、両方の滑走路が分割される', (deg) => {
    const l = cross(deg);
    const net = buildAirsideNetwork(l);
    expect(net.crossings).toHaveLength(1);
    const c = net.crossings![0]!;
    expect(c).toMatchObject({ id: 'rwy_1:X:rwy_2', a: 'rwy_1', b: 'rwy_2', nodeId: 'rwy_1:X:rwy_2' });
    expect(c.tA).toBeCloseTo(0.5, 9);
    expect(c.tB).toBeCloseTo(0.5, 9);
    const n = net.nodes[c.nodeId]!;
    expect(n.kind).toBe('runwayIntersection');
    expect(n.runwayIds).toEqual(['rwy_1', 'rwy_2']);
    expect(n.holdShort).toBe(false);
    expect(n.pos.x).toBeCloseTo(30, 9);
    expect(n.pos.y).toBeCloseTo(30, 9);
    for (const rid of ['rwy_1', 'rwy_2']) {
      expect(net.runwayNodes[rid]).toEqual([`${rid}:T0`, c.nodeId, `${rid}:T1`]);
    }
    // 交差点に誘導路は接続しない
    expect(net.outgoing[c.nodeId]).toHaveLength(4);
    expect(Object.values(net.edges).every((e) => e.kind === 'runway')).toBe(true);
  });

  it('T 字（一方の端が他方の内部）: 端のノードが交差点ノードになり、端ノードは重複しない', () => {
    let l = free(emptyLayout(), { start: { x: 10, y: 30 }, headingDeg: 90, lengthM: 1000 }).layout;
    l = free(l, { start: { x: 30, y: 30 }, headingDeg: 180, lengthM: 500 }).layout;
    const net = buildAirsideNetwork(l);
    expect(net.crossings).toHaveLength(1);
    expect(net.crossings![0]).toMatchObject({ tB: 0 });
    expect(Object.keys(net.nodes).filter((id) => id === 'rwy_2:T0')).toHaveLength(0);
    expect(net.runwayNodes['rwy_2']![0]).toBe('rwy_1:X:rwy_2');
    expect(net.runwayNodes['rwy_1']).toEqual(['rwy_1:T0', 'rwy_1:X:rwy_2', 'rwy_1:T1']);
  });

  it('同一直線上の重なり（共線）と、交わらない組は交差点を作らない', () => {
    let l = free(emptyLayout(), { start: { x: 10, y: 30 }, headingDeg: 90, lengthM: 1000 }).layout;
    l = free(l, { start: { x: 20, y: 30 }, headingDeg: 90, lengthM: 1000 }).layout;
    l = free(l, { start: { x: 10, y: 10 }, headingDeg: 90, lengthM: 500 }).layout;
    expect(buildAirsideNetwork(l).crossings).toBeUndefined();
  });

  it('従来形どうしの交差には交差点を作らない。従来形 × 自由形は作る', () => {
    let l = must(placeRunway(emptyLayout(), { x: 10, y: 30 }, 90, 20)).layout;
    l = must(placeRunway(l, { x: 20, y: 20 }, 180, 20)).layout;
    expect(buildAirsideNetwork(l).crossings).toBeUndefined();
    const m = free(must(placeRunway(emptyLayout(), { x: 10, y: 30 }, 90, 20)).layout, { start: { x: 20.5, y: 20 }, headingDeg: 170, lengthM: 800 });
    const net = buildAirsideNetwork(m.layout);
    expect(net.crossings).toHaveLength(1);
    expect(net.runwayNodes['rwy_1']).toHaveLength(3);
    expect(net.runwayNodes['rwy_2']).toHaveLength(3);
  });

  it('交点に誘導路ノードがあれば、新しいノードを作らずそのノードを使う', () => {
    let l = free(emptyLayout(), { start: { x: 10, y: 30 }, headingDeg: 90, lengthM: 1000 }).layout;
    l = free(l, { start: { x: 30, y: 18 }, headingDeg: 180, lengthM: 600 }).layout;
    l = must(addTaxiwayPath(l, [{ x: 30, y: 25 }, { x: 30, y: 35 }])).layout;
    const taxiNode = Object.values(l.taxiNodes).find((n) => n.pos.y === 30)!;
    const net = buildAirsideNetwork(l);
    expect(net.crossings).toHaveLength(1);
    expect(net.crossings![0]!.nodeId).toBe(taxiNode.id);
    expect(net.nodes[taxiNode.id]!.runwayIds.sort()).toEqual(['rwy_1', 'rwy_2']);
    expect(Object.keys(net.nodes).some((id) => id.includes(':X:'))).toBe(false);
  });
});
