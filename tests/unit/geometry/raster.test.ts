import { describe, expect, it } from 'vitest';
import { rasterizeCurve, evaluate, type Curve } from '../../../src/core/geometry/curve';
import * as raster from '../../../src/core/geometry/raster';
import { rasterizePolygon, rasterizeSegment } from '../../../src/core/geometry/vec';

const P = (x: number, y: number) => ({ x, y });

describe('raster（vec.ts から移動、再エクスポートで同一関数）', () => {
  it('vec.ts からの export は raster.ts と同じ関数', () => {
    expect(rasterizePolygon).toBe(raster.rasterizePolygon);
    expect(rasterizeSegment).toBe(raster.rasterizeSegment);
  });

  it('挙動の確認（既存 geometry.test.ts と同じ前提）', () => {
    expect(rasterizePolygon([P(-0.5, -0.5), P(2.5, -0.5), P(2.5, 2.5), P(-0.5, 2.5)])).toHaveLength(9);
    expect(rasterizeSegment(P(0, 0), P(3, 0))).toEqual([P(0, 0), P(1, 0), P(2, 0), P(3, 0)]);
  });
});

describe('rasterizeCurve', () => {
  it('線分は rasterizeSegment と一致する', () => {
    const c: Curve = { kind: 'line', p0: P(0, 0), p1: P(7, 3) };
    expect(rasterizeCurve(c)).toEqual(rasterizeSegment(P(0, 0), P(7, 3)));
  });

  it('円弧: 重複なし、曲線上の点のタイルを必ず含む', () => {
    const c: Curve = { kind: 'arc', c: P(0, 0), r: 20, theta0: 0, sweep: Math.PI / 2 };
    const tiles = rasterizeCurve(c);
    const keys = new Set(tiles.map((t) => `${t.x},${t.y}`));
    expect(keys.size).toBe(tiles.length);
    for (let i = 0; i <= 200; i++) {
      const p = evaluate(c, i / 200);
      expect(keys.has(`${Math.round(p.x)},${Math.round(p.y)}`)).toBe(true);
    }
  });
});
