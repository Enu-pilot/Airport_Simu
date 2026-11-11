import { describe, expect, it } from 'vitest';
import {
  headingVector,
  runwayAxis,
  runwayDesignators,
  runwayEnd,
  runwayLengthM,
  runwayMaxSize,
  runwayPolygon,
} from '../../src/core/layout/runway';
import { rasterizePolygon } from '../../src/core/geometry/vec';
import { placeRunway, updateEntity } from '../../src/core/layout/operations';
import type { Runway } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

const rwy = (p: Partial<Runway>): Runway => ({
  id: 'rwy_1',
  name: '',
  start: { x: 0, y: 0 },
  heading: 90,
  length: 80,
  surfaceWidthM: 45,
  buildState: 'operational',
  ...p,
});

describe('滑走路の属性', () => {
  it('長さ（m）と終点', () => {
    expect(runwayLengthM(rwy({ length: 80 }))).toBe(2000);
    expect(runwayEnd(rwy({ start: { x: 5, y: 5 }, heading: 90, length: 10 }))).toEqual({ x: 15, y: 5 });
    expect(runwayEnd(rwy({ start: { x: 5, y: 5 }, heading: 0, length: 10 }))).toEqual({ x: 5, y: -5 });
    // 斜めは1ステップ √2 タイル
    expect(runwayLengthM(rwy({ heading: 45, length: 40 }))).toBe(Math.round(40 * Math.SQRT2 * 25));
  });

  it('対応機種区分は長さと舗装幅の小さい方', () => {
    expect(runwayMaxSize(rwy({ length: 120, surfaceWidthM: 60 }))).toBe('L');
    expect(runwayMaxSize(rwy({ length: 120, surfaceWidthM: 45 }))).toBe('M');
    expect(runwayMaxSize(rwy({ length: 80, surfaceWidthM: 60 }))).toBe('M');
    expect(runwayMaxSize(rwy({ length: 48, surfaceWidthM: 60 }))).toBe('S');
    expect(runwayMaxSize(rwy({ length: 47, surfaceWidthM: 60 }))).toBeNull();
  });

  it('滑走路番号', () => {
    expect(runwayDesignators(90)).toEqual(['09', '27']);
    expect(runwayDesignators(0)).toEqual(['36', '18']);
    expect(runwayDesignators(225)).toEqual(['23', '05']);
  });

  it('占有タイル: 水平は幅3タイル × (長さ+1)', () => {
    expect(rasterizePolygon(runwayPolygon(rwy({ length: 10 })))).toHaveLength(33);
  });

  it('長さ・向き・幅の編集（向きは中点を保つ）', () => {
    const { layout } = must(placeRunway(emptyLayout(), { x: 10, y: 30 }, 90, 40));
    const r1 = must(updateEntity(layout, 'rwy_1', { length: 60, surfaceWidthM: 60 })).layout.runways.rwy_1!;
    expect(r1).toMatchObject({ length: 60, surfaceWidthM: 60 });
    const r2 = must(updateEntity(layout, 'rwy_1', { heading: 180 })).layout.runways.rwy_1!;
    expect(r2.heading).toBe(180);
    expect(r2.start).toEqual({ x: 30, y: 10 });
    expect(updateEntity(layout, 'rwy_1', { length: 0 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(updateEntity(layout, 'rwy_1', { surfaceWidthM: 50 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
});

describe('runwayAxis', () => {
  const headings = [0, 45, 90, 135, 180, 225, 270, 315] as const;
  it('8 方位で端点・単位方向・方位・実長が従来関数と一致する', () => {
    for (const h of headings) {
      const r = rwy({ start: { x: 3, y: -4 }, heading: h, length: 37 });
      const ax = runwayAxis(r);
      expect(ax.start).toEqual({ x: 3, y: -4 });
      expect(ax.end).toEqual(runwayEnd(r));
      expect(ax.bearingDeg).toBe(h);
      expect(ax.lengthM).toBe(runwayLengthM(r));
      expect(Math.hypot(ax.dir.x, ax.dir.y)).toBeCloseTo(1, 15);
    }
  });
  it('90° は厳密に東向き、斜めは ±√½', () => {
    expect(runwayAxis(rwy({ heading: 90 })).dir).toEqual({ x: 1, y: 0 });
    const d = runwayAxis(rwy({ heading: 135 })).dir;
    expect(d.x).toBeCloseTo(Math.SQRT1_2, 15);
    expect(d.y).toBeCloseTo(Math.SQRT1_2, 15);
  });
  it('headingVector は旧式（sin/cos の丸め）と全方位で一致する', () => {
    for (const h of headings) {
      const rad = (h * Math.PI) / 180;
      const v = headingVector(h);
      expect(v.x).toBe(Math.round(Math.sin(rad)) + 0);
      expect(v.y).toBe(Math.round(-Math.cos(rad)) + 0);
    }
  });
});
