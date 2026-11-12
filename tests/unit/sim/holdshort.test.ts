import { describe, expect, it } from 'vitest';
import { addTaxiwayPath, placeFreeRunway } from '../../../src/core/layout/operations';
import { runwayAxis } from '../../../src/core/layout/runway';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { createContext } from '../../../src/core/sim/context';
import { holdShortDistance, holdShortOnRoute, makeRoute } from '../../../src/core/sim/routes';
import { findPath } from '../../../src/core/sim/pathfinding';
import { compareIds } from '../../../src/core/model/ids';
import { TILE_M } from '../../../src/core/model/catalog';
import { distPointSegment } from '../../../src/core/geometry/vec';
import { loadFixture } from '../../golden/io';
import { emptyLayout, must } from '../helpers';
import type { AirportLayout, RunwayFree } from '../../../src/core/model/types';
import type { SimContext } from '../../../src/core/sim/context';

/** 自由形の滑走路 1 本（始点 (50,60)・方位 headingDeg・3000 m）。中心線上の点 P（始点から tAlong タイル）に、東向き（x+）の誘導路が入る */
function build(headingDeg: number, tAlong: number, xs: number[]): { layout: AirportLayout; r: RunwayFree; p: { x: number; y: number } } {
  let l = emptyLayout(200, 150);
  const res = must(placeFreeRunway(l, { start: { x: 50, y: 60 }, headingDeg, lengthM: 3000 }, { surfaceWidthM: 45 }));
  l = res.layout;
  const r = l.runways[res.created[0]!] as RunwayFree;
  const ax = runwayAxis(r);
  const p = { x: ax.start.x + ax.dir.x * tAlong, y: ax.start.y + ax.dir.y * tAlong };
  // 誘導路: 西から P へ（xs = P から西へ向かう各点までの距離（タイル））
  const pts = [...xs].reverse().map((d) => ({ x: p.x - d, y: p.y }));
  l = must(addTaxiwayPath(l, [...pts, p])).layout;
  return { layout: l, r: l.runways[r.id] as RunwayFree, p };
}

/** 位置から経路（西 → P）を作る */
function routeTo(ctx: SimContext, p: { x: number; y: number }, xs: number[]) {
  const nodeAt = (x: number, y: number) =>
    Object.values(ctx.network.nodes).find((n) => Math.abs(n.pos.x - x) < 1e-6 && Math.abs(n.pos.y - y) < 1e-6)!.id;
  const ids = [...xs].reverse().map((d) => nodeAt(p.x - d, p.y));
  ids.push(nodeAt(p.x, p.y));
  const edges: string[] = [];
  for (let i = 0; i + 1 < ids.length; i++) {
    const e = Object.values(ctx.network.edges).find((x) => x.kind === 'taxiway' && ((x.from === ids[i] && x.to === ids[i + 1]) || (x.to === ids[i] && x.from === ids[i + 1])))!;
    edges.push(e.id);
  }
  return makeRoute(ctx, 'taxiOut', ids, edges);
}

/** 経路上で停止位置（P から dist m 手前）の点から滑走路中心線までの距離（m） */
function perpAt(ctx: SimContext, route: ReturnType<typeof makeRoute>, rwy: RunwayFree, dist: number): number {
  const i = route.nodes.length - 1;
  const target = route.cum[i]! - dist;
  let k = 0;
  while (k + 1 < route.cum.length && route.cum[k + 1]! < target) k++;
  const a = ctx.network.nodes[route.nodes[k]!]!.pos;
  const b = ctx.network.nodes[route.nodes[k + 1]!]!.pos;
  const t = (target - route.cum[k]!) / (route.cum[k + 1]! - route.cum[k]!);
  const pt = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const ax = runwayAxis(rwy);
  return distPointSegment(pt, ax.start, ax.end).dist * TILE_M;
}

describe('自由形の停止位置（M1）', () => {
  it('浅い角度（θ = 20°）で、エッジが短く換算が頭打ちになるとき、経路に沿って H（90 m）まで戻る', () => {
    // 方位 70° の滑走路に東向きの誘導路 → θ = 20°。エッジ 12 タイル = 300 m: 従来の換算は min(90/sin20° = 263, 0.6 × 300) = 180 m（中心線から 61.6 m）
    const { layout, r, p } = build(70, 20, [12, 32]);
    const ctx = createContext(layout);
    const route = routeTo(ctx, p, [12, 32]);
    const d = holdShortOnRoute(ctx, route, route.nodes.length - 1, -1);
    expect(d).toBeGreaterThan(180);
    expect(perpAt(ctx, route, r, d)).toBeGreaterThanOrEqual(90 - 1e-6);
    expect(d).toBeCloseTo(90 / Math.sin((20 * Math.PI) / 180), 3);
  });

  it('90° でも短いエッジ（50 m）: 停止位置は手前のエッジの上で H', () => {
    const { layout, r, p } = build(0, 10, [2, 20]); // 北向きの滑走路に、50 m と 450 m のエッジ
    const ctx = createContext(layout);
    const route = routeTo(ctx, p, [2, 20]);
    const d = holdShortOnRoute(ctx, route, route.nodes.length - 1, -1);
    expect(d).toBeCloseTo(90, 6);
    expect(perpAt(ctx, route, r, d)).toBeCloseTo(90, 6);
  });

  it('換算が頭打ちにならない自由形は、従来の値のまま（既存の挙動を変えない）', () => {
    const { layout, p } = build(0, 10, [20]);
    const ctx = createContext(layout);
    const route = routeTo(ctx, p, [20]);
    const i = route.nodes.length - 1;
    expect(holdShortOnRoute(ctx, route, i, -1)).toBe(90);
  });

  it('届かない配置（θ = 10°・300 m）は換算の値に戻り、HOLD_SHORT_TOO_CLOSE の警告が出る。十分な配置では出ない', () => {
    const bad = build(80, 20, [12]);
    const ctx = createContext(bad.layout);
    const route = routeTo(ctx, bad.p, [12]);
    const i = route.nodes.length - 1;
    const d0 = Math.min(90 / Math.sin((15 * Math.PI) / 180), 0.6 * 300);
    expect(holdShortOnRoute(ctx, route, i, -1)).toBeCloseTo(d0, 6);
    const issues = analyzeLayout(bad.layout).issues.filter((x) => x.code === 'HOLD_SHORT_TOO_CLOSE');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.severity).toBe('warning');
    expect(Number(issues[0]!.params.achievedM)).toBeLessThan(90);
    expect(issues[0]!.params.requiredM).toBe(90);
    const good = build(0, 10, [20]);
    expect(analyzeLayout(good.layout).issues.filter((x) => x.code === 'HOLD_SHORT_TOO_CLOSE')).toEqual([]);
  });
});

describe('従来形は 1 ビットも変わらない（M1）', () => {
  it('固定フィクスチャのすべての経路で、holdShortOnRoute は従来の式（holdShortDistance）と === 一致する', () => {
    let checked = 0;
    for (const name of ['sample', 'stress', 'all-headings'] as const) {
      const ctx = createContext(loadFixture(name));
      const stands = Object.values(ctx.stands).sort((a, b) => compareIds(a.id, b.id));
      for (const st of stands) {
        for (const rw of Object.values(ctx.runways)) {
          for (const node of rw.nodes) {
            for (const dir of ['dep', 'arr'] as const) {
              const path = findPath(ctx.network, {
                sources: [{ node: dir === 'dep' ? st.node : node, cost: 0 }],
                goals: new Map([[dir === 'dep' ? node : st.node, 0]]),
                size: st.size,
                speed: 10,
                allowStands: [st.id],
              });
              if (!path) continue;
              const route = makeRoute(ctx, dir === 'dep' ? 'taxiOut' : 'taxiIn', path.nodes, path.edges);
              route.nodes.forEach((n, i) => {
                if (ctx.network.nodes[n]!.runwayIds.length === 0) return;
                if (i >= 1) {
                  expect(holdShortOnRoute(ctx, route, i, -1)).toBe(holdShortDistance(route.cum[i]! - route.cum[i - 1]!));
                  checked++;
                }
                if (i + 1 < route.nodes.length) {
                  expect(holdShortOnRoute(ctx, route, i, 1)).toBe(holdShortDistance(route.cum[i + 1]! - route.cum[i]!));
                  checked++;
                }
              });
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});
