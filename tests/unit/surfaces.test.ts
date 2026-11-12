import { describe, expect, it } from 'vitest';
import { ROAD_DRAW_WIDTH_M, TAXIWAY_DRAW_WIDTH_M } from '../../src/core/model/catalog';
import { runwayPolygon, runwayStripPolygon } from '../../src/core/layout/runway';
import {
  bandSurface,
  roadBandSurface,
  roadDrawWidthM,
  runwayPavementSurface,
  runwayStripSurface,
  taxiwayBandSurface,
  taxiwayDrawWidthM,
} from '../../src/core/layout/surfaces';
import type { Runway } from '../../src/core/model/types';

const rwy: Runway = { id: 'r', name: '', start: { x: 2, y: 3 }, heading: 135, length: 20, surfaceWidthM: 45, buildState: 'operational' } as Runway;

describe('描画用の面（surfaces）', () => {
  it('誘導路の描画幅は m の単一の表で、codeF は区分より優先', () => {
    expect(TAXIWAY_DRAW_WIDTH_M).toEqual({ S: 15, M: 23, L: 30, codeF: 38 });
    expect(taxiwayDrawWidthM({ widthClass: 'S' })).toBe(15);
    expect(taxiwayDrawWidthM({ widthClass: 'M' })).toBe(23);
    expect(taxiwayDrawWidthM({ widthClass: 'L' })).toBe(30);
    expect(taxiwayDrawWidthM({ widthClass: 'S', codeF: true })).toBe(38);
    expect(roadDrawWidthM({ roadClass: 'rail' })).toBe(ROAD_DRAW_WIDTH_M.rail);
    expect(roadDrawWidthM({ roadClass: 'public' })).toBe(ROAD_DRAW_WIDTH_M.road);
  });

  it('滑走路の面は占有フットプリントと同一の頂点（World フレーム）', () => {
    expect(runwayPavementSurface(rwy)).toEqual(runwayPolygon(rwy));
    expect(runwayStripSurface(rwy)).toEqual(runwayStripPolygon(rwy));
  });

  it('帯は幅 widthM・両端を半幅延長した矩形（水平）', () => {
    const p = bandSurface({ x: 0, y: 0 }, { x: 10, y: 0 }, 25);
    // 幅 25 m = 1 タイル → 半幅 0.5、両端 0.5 延長
    expect(p).toHaveLength(4);
    const xs = p.map((q) => q.x);
    const ys = p.map((q) => q.y);
    expect(Math.min(...xs)).toBeCloseTo(-0.5, 12);
    expect(Math.max(...xs)).toBeCloseTo(10.5, 12);
    expect(Math.min(...ys)).toBeCloseTo(-0.5, 12);
    expect(Math.max(...ys)).toBeCloseTo(0.5, 12);
  });

  it('斜めの帯でも辺の長さと幅が正しい', () => {
    const a = { x: 1, y: 1 };
    const b = { x: 7, y: 9 };
    const q = taxiwayBandSurface(a, b, { widthClass: 'L' });
    const w = 30 / 25;
    expect(Math.hypot(q[0]!.x - q[3]!.x, q[0]!.y - q[3]!.y)).toBeCloseTo(w, 12);
    expect(Math.hypot(q[1]!.x - q[0]!.x, q[1]!.y - q[0]!.y)).toBeCloseTo(Math.hypot(6, 8) + w, 12);
  });

  it('道路帯は道路・鉄道で幅が違い、退化（a = b）は空', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 4, y: 0 };
    const h = (poly: { x: number; y: number }[]) => Math.max(...poly.map((p) => p.y)) - Math.min(...poly.map((p) => p.y));
    expect(h(roadBandSurface(a, b, { roadClass: 'public' }))).toBeCloseTo(12 / 25, 12);
    expect(h(roadBandSurface(a, b, { roadClass: 'rail' }))).toBeCloseTo(8 / 25, 12);
    expect(bandSurface(a, a, 12)).toEqual([]);
  });
});
