import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TILE_M } from '../../src/core/model/catalog';
import { designatorsOf } from '../../src/core/layout/designators';
import { placeFreeRunway, placeRunway } from '../../src/core/layout/operations';
import { runwayAxis, runwayPolygon, runwayStripPolygon } from '../../src/core/layout/runway';
import { RUNWAY_MARKING_M, RUNWAY_THRESHOLD_STRIPES, runwaySurfaces } from '../../src/core/layout/surfaces';
import { tilesToM, worldPolyToMap, worldPolyToScene, worldToMap, worldToScene } from '../../src/core/geometry/frames';
import type { RunwayFree } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

function free(headingDeg: number, lengthM: number, width: 30 | 45 | 60 = 45, variation = 0) {
  const base = emptyLayout(300, 300);
  if (variation !== 0) base.magneticVariationDeg = variation;
  const res = must(placeFreeRunway(base, { start: { x: 120.3, y: 130.7 }, headingDeg, lengthM }, { surfaceWidthM: width }));
  return { layout: res.layout, r: res.layout.runways[res.created[0]!] as RunwayFree };
}

/** 点を滑走路の (along, lateral)（m）に直す */
function toRunwayM(r: RunwayFree, p: { x: number; y: number }) {
  const ax = runwayAxis(r);
  const dx = p.x - ax.start.x;
  const dy = p.y - ax.start.y;
  return { along: (dx * ax.dir.x + dy * ax.dir.y) * TILE_M, lateral: (dx * -ax.dir.y + dy * ax.dir.x) * TILE_M };
}
const ext = (pts: { x: number; y: number }[], r: RunwayFree) => {
  const q = pts.map((p) => toRunwayM(r, p));
  const a = q.map((v) => v.along);
  const l = q.map((v) => v.lateral);
  return { a0: Math.min(...a), a1: Math.max(...a), l0: Math.min(...l), l1: Math.max(...l) };
};

describe('runwaySurfaces（自由形）', () => {
  it('舗装・肩・着陸帯・RESA は別々の多角形で、寸法は任意の角度で実寸どおり（幅 30/45/60）', () => {
    for (const w of [30, 45, 60] as const) {
      for (const h of [0, 13, 37.5, 90, 143, 270, 359]) {
        const { layout, r } = free(h, 1800, w);
        const s = runwaySurfaces(r, layout);
        const shoulder = w === 30 ? 0 : 7.5;
        const p = ext(s.pavement, r);
        expect(p.a0).toBeCloseTo(0, 6);
        expect(p.a1).toBeCloseTo(1800, 6);
        expect(p.l1 - p.l0).toBeCloseTo(w, 6);
        const pv = ext(s.paved, r);
        expect(pv.l1 - pv.l0).toBeCloseTo(w + 2 * shoulder, 6);
        const st = ext(s.strip, r);
        expect(st.a0).toBeCloseTo(-60, 6);
        expect(st.a1).toBeCloseTo(1860, 6);
        expect(st.l1 - st.l0).toBeCloseTo(280, 6);
        expect(s.resa).toHaveLength(2);
        const [r0, r1] = s.resa.map((q) => ext(q, r)) as [ReturnType<typeof ext>, ReturnType<typeof ext>];
        expect(r0.a0).toBeCloseTo(-150, 6);
        expect(r0.a1).toBeCloseTo(-60, 6);
        expect(r1.a0).toBeCloseTo(1860, 6);
        expect(r1.a1).toBeCloseTo(1950, 6);
        expect(r0.l1 - r0.l0).toBeCloseTo(2 * w, 6);
      }
    }
  });

  it('進入端の縦じまは舗装の内側に収まり、本数は幅ごと（8/12/16 × 両端）', () => {
    for (const w of [30, 45, 60] as const) {
      const { layout, r } = free(61, 1500, w);
      const s = runwaySurfaces(r, layout);
      expect(s.thresholdBars).toHaveLength(2 * RUNWAY_THRESHOLD_STRIPES[w]);
      for (const bar of s.thresholdBars) {
        expect(bar).toHaveLength(4);
        const e = ext(bar, r);
        expect(e.l0).toBeGreaterThanOrEqual(-w / 2);
        expect(e.l1).toBeLessThanOrEqual(w / 2);
        const nearStart = e.a1 <= 100;
        const nearEnd = e.a0 >= 1400;
        expect(nearStart || nearEnd).toBe(true);
        expect(e.a0).toBeGreaterThanOrEqual(RUNWAY_MARKING_M.thresholdOffset - 1e-9);
        expect(e.a1).toBeLessThanOrEqual(1500 - RUNWAY_MARKING_M.thresholdOffset + 1e-9);
      }
    }
  });

  it('中心線の破線は中心線上・30 m 長・番号と縦じまの内側にある', () => {
    const { layout, r } = free(200, 2400);
    const s = runwaySurfaces(r, layout);
    expect(s.centrelineDashes.length).toBeGreaterThan(30);
    const dd = Math.min(0.1 * 2400, 150);
    let prevEnd = -Infinity;
    for (const [a, b] of s.centrelineDashes) {
      const qa = toRunwayM(r, a);
      const qb = toRunwayM(r, b);
      expect(Math.abs(qa.lateral)).toBeLessThan(1e-6);
      expect(Math.abs(qb.lateral)).toBeLessThan(1e-6);
      expect(qb.along - qa.along).toBeCloseTo(30, 6);
      expect(qa.along).toBeGreaterThan(dd);
      expect(qb.along).toBeLessThan(2400 - dd);
      expect(qa.along).toBeGreaterThan(prevEnd);
      prevEnd = qb.along;
    }
  });

  it('番号は designatorsOf と同じ文字・端から min(0.1L, 150 m) の位置・向き', () => {
    const { layout, r } = free(300, 1800, 45, 10);
    const s = runwaySurfaces(r, layout);
    const ds = designatorsOf(r, layout);
    expect(s.designators.map((d) => d.text)).toEqual([...ds.text]);
    expect(toRunwayM(r, s.designators[0]!.pos).along).toBeCloseTo(150, 6);
    expect(toRunwayM(r, s.designators[1]!.pos).along).toBeCloseTo(1650, 6);
    expect(s.designators[0]!.bearingDeg).toBeCloseTo(300, 9);
    expect(s.designators[1]!.bearingDeg).toBeCloseTo(120, 9);
    // 短い滑走路: 0.1 × 長さ
    const sh = free(90, 1000);
    expect(toRunwayM(sh.r, runwaySurfaces(sh.r, sh.layout).designators[0]!.pos).along).toBeCloseTo(100, 6);
  });

  it('偏角を変えると番号が変わる（磁方位）', () => {
    const a = free(90, 1800);
    const b = free(90, 1800, 45, 10);
    expect(runwaySurfaces(a.r, a.layout).designators[0]!.text).toBe('09');
    expect(runwaySurfaces(b.r, b.layout).designators[0]!.text).toBe('08');
  });

  it('従来形は従来の占有の多角形（舗装 = 肩、RESA なし）を返す', () => {
    const l = must(placeRunway(emptyLayout(100, 100), { x: 10, y: 20 }, 135, 30, { surfaceWidthM: 60 }));
    const r = l.layout.runways[l.created[0]!]!;
    const s = runwaySurfaces(r, l.layout);
    expect(s.pavement).toEqual(runwayPolygon(r));
    expect(s.paved).toEqual(runwayPolygon(r));
    expect(s.strip).toEqual(runwayStripPolygon(r));
    expect(s.resa).toEqual([]);
  });

  it('全方位（0〜359°）・最短〜長大の長さで、すべての頂点が有限', () => {
    for (let h = 0; h < 360; h += 7) {
      for (const len of [25, 400, 6000]) {
        const { layout, r } = free(h, len);
        const s = runwaySurfaces(r, layout);
        const all = [...s.paved, ...s.pavement, ...s.strip, ...s.resa.flat(), ...s.thresholdBars.flat(), ...s.centrelineDashes.flat(), ...s.designators.map((d) => d.pos)];
        for (const p of all) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        }
      }
    }
  });
});

describe('2D と 3D は同じ面を使う（frames）', () => {
  it('runwaySurfaces の全頂点を worldPolyToMap / worldPolyToScene へ通すと、Map と Scene が一致する（Scene = Map × 25 m）', () => {
    const { layout, r } = free(33, 2000, 60);
    const s = runwaySurfaces(r, layout);
    const polys = [s.paved, s.pavement, s.strip, ...s.resa, ...s.thresholdBars, ...s.centrelineDashes.map((d) => [d[0], d[1]])];
    for (const poly of polys) {
      const map = worldPolyToMap(poly);
      const scene = worldPolyToScene(poly, 0.3);
      poly.forEach((p, i) => {
        expect(map[i]).toEqual(worldToMap(p));
        expect(scene[i]).toEqual(worldToScene(p, 0.3));
        expect(scene[i]!.x).toBe(tilesToM(map[i]!.x));
        expect(scene[i]!.z).toBe(tilesToM(map[i]!.y));
      });
    }
  });

  it('MapRenderer と Scene3D はどちらも runwaySurfaces を呼ぶ（形を別々に作らない）', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', '..', 'src', f), 'utf8');
    for (const f of ['render/MapRenderer.ts', 'render/three/Scene3D.ts']) {
      const text = src(f);
      expect(text, f).toContain('runwaySurfaces(');
      // 自由形の面を render 側で組み立てていない
      expect(text, f).not.toContain('runwayAreas(');
    }
  });
});
