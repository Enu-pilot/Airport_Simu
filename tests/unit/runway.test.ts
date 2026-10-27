import { describe, expect, it } from 'vitest';
import {
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
