import { describe, expect, it } from 'vitest';
import { resolveRunwayDims, runwayAreas } from '../../src/core/layout/runwayAreas';
import { runwayAxis } from '../../src/core/layout/runway';
import { TILE_M } from '../../src/core/model/catalog';
import {
  FREE_RUNWAY_DEFAULTS,
  FREE_RUNWAY_DEFAULT_BASIS,
  RUNWAY_REFERENCE,
  RUNWAY_REFERENCE_DISCLAIMER,
  RUNWAY_REF_SOURCES,
} from '../../src/core/model/runwayReference';
import type { RunwayFree } from '../../src/core/model/types';
import { isConvex } from '../../src/core/geometry/polygon';
import { rasterizePolygon, tilesOverlappingPolygon } from '../../src/core/geometry/raster';
import type { Vec2 } from '../../src/core/geometry/vec';

const free = (headingDeg: number, w: 30 | 45 | 60, lengthM = 3000, dims?: RunwayFree['dims']): RunwayFree => ({
  id: 'rwy_1',
  name: '',
  alignment: 'free',
  start: { x: 12.3, y: -4.7 },
  headingDeg,
  lengthM,
  surfaceWidthM: w,
  buildState: 'operational',
  ...(dims ? { dims } : {}),
});

/** 多角形の軸方向（along）・直交方向（across）の範囲（m） */
function extent(poly: Vec2[], r: RunwayFree): { along: [number, number]; across: [number, number] } {
  const { start, dir } = runwayAxis(r);
  const n = { x: -dir.y, y: dir.x };
  const a = poly.map((p) => ((p.x - start.x) * dir.x + (p.y - start.y) * dir.y) * TILE_M);
  const c = poly.map((p) => ((p.x - start.x) * n.x + (p.y - start.y) * n.y) * TILE_M);
  return { along: [Math.min(...a), Math.max(...a)], across: [Math.min(...c), Math.max(...c)] };
}

const ANGLES = [0, 17.3, 45, 90, 123.4, 180, 225, 270, 359.9];

describe('自由形の領域 runwayAreas（S3）: 幅 30/45/60 m を任意の角度で', () => {
  for (const w of [30, 45, 60] as const) {
    it(`舗装幅 ${w} m: 舗装・肩・着陸帯・RESA の寸法（既定値）`, () => {
      const d = FREE_RUNWAY_DEFAULTS[w];
      for (const deg of ANGLES) {
        const r = free(deg, w);
        const A = runwayAreas(r);
        const L = r.lengthM;
        const p = extent(A.pavement, r);
        expect(p.along[0]).toBeCloseTo(0, 6);
        expect(p.along[1]).toBeCloseTo(L, 6);
        expect(p.across[1] - p.across[0]).toBeCloseTo(w, 6);
        const s = extent(A.paved, r);
        expect(s.across[1] - s.across[0]).toBeCloseTo(w + 2 * d.shoulderWidthM, 6);
        expect(s.along[1] - s.along[0]).toBeCloseTo(L, 6);
        const st = extent(A.strip, r);
        expect(st.along[0]).toBeCloseTo(-d.stripEndM, 6);
        expect(st.along[1]).toBeCloseTo(L + d.stripEndM, 6);
        expect(st.across[1] - st.across[0]).toBeCloseTo(2 * d.stripHalfWidthM, 6);
        expect(A.resa).toHaveLength(2);
        const r0 = extent(A.resa[0]!, r);
        const r1 = extent(A.resa[1]!, r);
        expect(r0.along[1]).toBeCloseTo(-d.stripEndM, 6);
        expect(r0.along[0]).toBeCloseTo(-d.stripEndM - d.resaLengthM, 6);
        expect(r1.along[0]).toBeCloseTo(L + d.stripEndM, 6);
        expect(r1.along[1]).toBeCloseTo(L + d.stripEndM + d.resaLengthM, 6);
        for (const x of [r0, r1]) expect(x.across[1] - x.across[0]).toBeCloseTo(d.resaWidthM, 6);
        for (const poly of [A.pavement, A.paved, A.strip, ...A.resa]) {
          expect(poly).toHaveLength(4);
          expect(isConvex(poly)).toBe(true);
        }
      }
    });
  }

  it('既定値: 肩 0/7.5/7.5、RESA 幅 = 舗装幅の 2 倍、停止位置 90/90/107.5、着陸帯の半幅 140・端部 60・RESA 長さ 90', () => {
    expect(FREE_RUNWAY_DEFAULTS[30].shoulderWidthM).toBe(0);
    expect(FREE_RUNWAY_DEFAULTS[45].shoulderWidthM).toBe(7.5);
    expect(FREE_RUNWAY_DEFAULTS[60].shoulderWidthM).toBe(7.5);
    for (const w of [30, 45, 60] as const) {
      const d = FREE_RUNWAY_DEFAULTS[w];
      expect(d.resaWidthM).toBe(2 * w);
      expect([d.stripHalfWidthM, d.stripEndM, d.resaLengthM]).toEqual([140, 60, 90]);
    }
    expect([30, 45, 60].map((w) => FREE_RUNWAY_DEFAULTS[w as 30].holdingPositionM)).toEqual([90, 90, 107.5]);
  });

  it('dims の上書きが効き、欠落した項目は既定値。RESA 長さ 0 なら RESA なし', () => {
    const r = free(40, 45, 2500, { stripHalfWidthM: 100, resaLengthM: 0, shoulderWidthM: 3 });
    const d = resolveRunwayDims(r);
    expect(d.stripHalfWidthM).toBe(100);
    expect(d.stripEndM).toBe(60);
    expect(d.shoulderWidthM).toBe(3);
    const A = runwayAreas(r);
    expect(A.resa).toEqual([]);
    const st = extent(A.strip, r);
    expect(st.across[1] - st.across[0]).toBeCloseTo(200, 6);
  });
});

describe('参考値の表と出典キー（S3）', () => {
  it('参考値はすべて official で、出典キーが RUNWAY_REF_SOURCES に存在し、注記がある', () => {
    for (const [k, v] of Object.entries(RUNWAY_REFERENCE)) {
      expect(v.status, k).toBe('official');
      expect(typeof v.value, k).toBe('number');
      expect(RUNWAY_REF_SOURCES[v.source!], k).toBeDefined();
      expect(v.note, k).toBeTruthy();
    }
    for (const s of Object.values(RUNWAY_REF_SOURCES)) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.accessed).toBe('2026-11-11');
    }
  });
  it('ゲーム既定値の各項目に採用元の出典と参考値のキーがあり、すべて存在し、ゲーム値と明記されている', () => {
    for (const [k, b] of Object.entries(FREE_RUNWAY_DEFAULT_BASIS)) {
      expect(RUNWAY_REF_SOURCES[b.source], k).toBeDefined();
      expect(b.refKeys.length, k).toBeGreaterThan(0);
      for (const rk of b.refKeys) expect(RUNWAY_REFERENCE[rk], `${k} → ${rk}`).toBeDefined();
      expect(b.note, k).toContain('ゲーム値');
    }
    expect(Object.keys(FREE_RUNWAY_DEFAULT_BASIS).sort()).toEqual(Object.keys(FREE_RUNWAY_DEFAULTS[45]).sort());
  });
  it('既定値は採用元の参考値と一致する（140・60・90・90/107.5・肩 (全幅 − 舗装幅) / 2）', () => {
    const v = (k: string) => RUNWAY_REFERENCE[k]!.value;
    expect(FREE_RUNWAY_DEFAULTS[45].stripHalfWidthM).toBe(v('easa.strip.halfWidthM.code34'));
    expect(FREE_RUNWAY_DEFAULTS[45].stripEndM).toBe(v('easa.strip.endM'));
    expect(FREE_RUNWAY_DEFAULTS[45].resaLengthM).toBe(v('easa.resa.minLengthM'));
    expect(FREE_RUNWAY_DEFAULTS[45].holdingPositionM).toBe(v('easa.holding.precisionCat1.code34M'));
    expect(FREE_RUNWAY_DEFAULTS[60].holdingPositionM).toBe(v('easa.holding.precisionCat1.codeFM'));
    expect(FREE_RUNWAY_DEFAULTS[45].shoulderWidthM).toBe((v('easa.shoulder.totalWidthM.codeDE')! - 45) / 2);
    expect(FREE_RUNWAY_DEFAULTS[60].shoulderWidthM).toBe((v('easa.shoulder.totalWidthM.codeF.4Engines')! - 60) / 2);
    expect(FREE_RUNWAY_DEFAULTS[45].resaWidthM).toBe(45 * v('easa.resa.widthFactor')!);
  });
  it('定型文（参考値であり適合を保証しない）がある', () => {
    expect(RUNWAY_REFERENCE_DISCLAIMER).toContain('保証しません');
  });
});

describe('tilesOverlappingPolygon（S3）', () => {
  const sq = (cx: number, cy: number, h: number): Vec2[] => [
    { x: cx - h, y: cy - h },
    { x: cx + h, y: cy - h },
    { x: cx + h, y: cy + h },
    { x: cx - h, y: cy + h },
  ];
  it('タイルより小さい多角形でも、覆うタイルを返す（rasterizePolygon は空）', () => {
    const p = sq(3.4, 5, 0.1);
    expect(rasterizePolygon(p)).toEqual([]);
    expect(tilesOverlappingPolygon(p)).toEqual([{ x: 3, y: 5 }]);
  });
  it('境界が触れるだけのタイルは含めない。タイルの角をまたぐと 4 タイル', () => {
    expect(tilesOverlappingPolygon(sq(0, 0, 0.5))).toEqual([{ x: 0, y: 0 }]);
    expect(tilesOverlappingPolygon(sq(0.5, 0.5, 0.1))).toHaveLength(4);
  });
  it('rasterizePolygon の上位集合で、順序は y・x の昇順', () => {
    const r = free(33, 45, 1000);
    const poly = runwayAreas(r).strip;
    const all = tilesOverlappingPolygon(poly);
    const key = (t: Vec2) => `${t.x},${t.y}`;
    const set = new Set(all.map(key));
    for (const t of rasterizePolygon(poly)) expect(set.has(key(t))).toBe(true);
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!;
      const b = all[i]!;
      expect(a.y < b.y || (a.y === b.y && a.x < b.x)).toBe(true);
    }
  });
  it('退化（3 点未満）は空', () => {
    expect(tilesOverlappingPolygon([])).toEqual([]);
    expect(tilesOverlappingPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([]);
  });
});
