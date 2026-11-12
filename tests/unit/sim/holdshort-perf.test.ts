import { describe, expect, it } from 'vitest';
import { addTaxiwayPath, placeFreeRunway } from '../../../src/core/layout/operations';
import { runwayAxis } from '../../../src/core/layout/runway';
import { resolveRunwayDims } from '../../../src/core/layout/runwayAreas';
import { holdWalkLimitM, walkToClear } from '../../../src/core/layout/holdShort';
import { buildAirsideNetwork } from '../../../src/core/airside/network';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { TILE_M } from '../../../src/core/model/catalog';
import { emptyLayout, must } from '../helpers';
import type { AirportLayout } from '../../../src/core/model/types';

/** 自由形の滑走路 1 本の隣に、n×n の誘導路の格子（間隔 1 タイル）を置く（F1 の再現配置） */
function gridLayout(n: number): AirportLayout {
  let l = emptyLayout(130, 90);
  l = must(placeFreeRunway(l, { start: { x: 10, y: 30 }, headingDeg: 90, lengthM: 90 * 25 }, { surfaceWidthM: 45 })).layout;
  for (let i = 0; i <= n; i++) l = must(addTaxiwayPath(l, [{ x: 40, y: 31 + i }, { x: 40 + n, y: 31 + i }])).layout;
  for (let i = 0; i <= n; i++) l = must(addTaxiwayPath(l, [{ x: 40 + i, y: 31 }, { x: 40 + i, y: 31 + n }])).layout;
  return must(addTaxiwayPath(l, [{ x: 40, y: 30 }, { x: 40, y: 31 }])).layout;
}

/** 総当たりの基準: ノードを再訪しない全経路を列挙し、届かない枝（端・他の滑走路・上限）があるか */
function bruteWarns(layout: AirportLayout): Set<string> {
  const net = buildAirsideNetwork(layout);
  const out = new Set<string>();
  for (const r of Object.values(layout.runways)) {
    const ax = runwayAxis(r as never);
    const holdM = resolveRunwayDims(r as never).holdingPositionM;
    const zones = [{ a: ax.start, b: ax.end, holdM }];
    const limit = holdWalkLimitM(holdM);
    const nexts = (id: string, from: string) =>
      [...(net.outgoing[id] ?? []), ...(net.incoming[id] ?? [])]
        .map((e) => net.edges[e]!)
        .filter((e) => e.kind === 'taxiway')
        .map((e) => (e.from === id ? e.to : e.from))
        .filter((t) => t !== from);
    for (const nodeId of net.runwayNodes[r.id] ?? []) {
      if (nexts(nodeId, '').length === 0) continue;
      const rec = (id: string, from: string, pts: { x: number; y: number }[], dist: number, seen: Set<string>): void => {
        const ns = nexts(id, from);
        const fail = (): void => {
          if (walkToClear(pts, zones, Math.min(limit, dist)).clearM === null) out.add(r.id);
        };
        if (pts.length > 1 && walkToClear(pts, zones, Math.min(limit, dist)).clearM !== null) return;
        if (pts.length > 1 && (net.nodes[id]!.runwayIds.length > 0 || dist >= limit)) return fail();
        if (ns.length === 0) return fail();
        for (const t of ns) {
          if (seen.has(t)) continue;
          const p = net.nodes[t]!.pos;
          const q = pts[pts.length - 1]!;
          rec(t, id, [...pts, p], dist + Math.hypot(p.x - q.x, p.y - q.y) * TILE_M, new Set([...seen, t]));
        }
      };
      rec(nodeId, '', [net.nodes[nodeId]!.pos], 0, new Set([nodeId]));
    }
  }
  return out;
}

const holdWarnRunways = (l: AirportLayout): Set<string> =>
  new Set(analyzeLayout(l).issues.filter((i) => i.code === 'HOLD_SHORT_TOO_CLOSE').flatMap((i) => i.targets as string[]));

describe('HOLD_SHORT_TOO_CLOSE の探索量（F1）', () => {
  it('滑走路の隣の 6×6 の誘導路の格子でも analyzeLayout は 500 ms 未満', () => {
    const l = gridLayout(6);
    const t = performance.now();
    analyzeLayout(l);
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(500);
  });

  it('小さな格子の乱択で、総当たり（再訪なしの全経路）と警告の有無が一致する', () => {
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let warned = 0;
    for (let k = 0; k < 40; k++) {
      let l = emptyLayout(80, 60);
      const heading = [90, 80, 70, 60][Math.floor(rnd() * 4)]!;
      l = must(placeFreeRunway(l, { start: { x: 10, y: 20 }, headingDeg: heading, lengthM: 1800 }, { surfaceWidthM: 45 })).layout;
      const ox = 20 + Math.floor(rnd() * 8);
      const oy = 17 + Math.floor(rnd() * 8);
      const n = 2 + Math.floor(rnd() * 2);
      const gap = 1 + Math.floor(rnd() * 3);
      const pts = (i: number, j: number) => ({ x: ox + i * gap, y: oy + j * gap });
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) {
          if (i < n && rnd() < 0.7) {
            const r1 = addTaxiwayPath(l, [pts(i, j), pts(i + 1, j)]);
            if (r1.ok) l = r1.layout;
          }
          if (j < n && rnd() < 0.7) {
            const r2 = addTaxiwayPath(l, [pts(i, j), pts(i, j + 1)]);
            if (r2.ok) l = r2.layout;
          }
        }
      }
      const ra = addTaxiwayPath(l, [{ x: ox, y: oy }, { x: ox - 3, y: oy - 3 }]);
      if (ra.ok) l = ra.layout;
      const a = [...holdWarnRunways(l)].sort();
      const b = [...bruteWarns(l)].sort();
      expect(a).toEqual(b);
      if (a.length > 0) warned++;
    }
    expect(warned).toBeGreaterThan(0);
  });
});
