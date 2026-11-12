import { describe, expect, it } from 'vitest';
import { positionOnRunway, runwayAxis, runwayEnd, runwayLengthClass, runwayLengthM, runwayMaxSize } from '../../src/core/layout/runway';
import { TILE_M } from '../../src/core/model/catalog';
import { isFreeRunway, type Heading, type RunwayFree, type RunwayGrid8 } from '../../src/core/model/types';

const free = (headingDeg: number, lengthM: number, start = { x: 3, y: -2 }): RunwayFree => ({
  id: 'rwy_f',
  name: '',
  alignment: 'free',
  start,
  headingDeg,
  lengthM,
  surfaceWidthM: 45,
  buildState: 'operational',
});

describe('自由形の runwayAxis（S0）', () => {
  it('整数の方位 0〜359° と 0.25° 刻み: 端点間の距離が lengthM と一致し、方位・方向が保たれる', () => {
    for (let k = 0; k < 360 * 4; k++) {
      const deg = k / 4;
      const r = free(deg, 2500.5);
      const a = runwayAxis(r);
      expect(a.trueHeadingDeg).toBe(deg);
      const dx = a.end.x - a.start.x;
      const dy = a.end.y - a.start.y;
      expect(Math.hypot(dx, dy) * TILE_M).toBeCloseTo(2500.5, 9);
      expect(Math.hypot(a.dir.x, a.dir.y)).toBeCloseTo(1, 12);
      // 0° = 北 = -y、90° = 東 = +x（時計回り）
      const rad = (deg * Math.PI) / 180;
      expect(a.dir.x).toBeCloseTo(Math.sin(rad), 12);
      expect(a.dir.y).toBeCloseTo(-Math.cos(rad), 12);
      expect(a.lengthM).toBe(2501);
      expect(runwayEnd(r)).toEqual(a.end);
    }
  });

  it('実長は丸めない（lengthT = lengthM / TILE_M）。区分・最大機体は runwayLengthM を通る', () => {
    const r = free(10, 1234.567);
    expect(runwayAxis(r).lengthT).toBe(1234.567 / TILE_M);
    expect(runwayLengthM(r)).toBe(1235);
    expect(runwayLengthClass(free(0, 1999.6))).not.toBeNull();
    expect(runwayMaxSize(free(0, 100))).toBeNull();
  });

  it('従来形と等価な自由形は、終点が従来の整数終点と POS_EPS_T 以内で一致する', () => {
    const headings: Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];
    for (const h of headings) {
      for (const len of [10, 40, 77]) {
        const g: RunwayGrid8 = { id: 'g', name: '', start: { x: 5, y: 6 }, heading: h, length: len, surfaceWidthM: 45, buildState: 'operational' };
        const ga = runwayAxis(g);
        const f = free(h, ga.lengthT * TILE_M, { x: 5, y: 6 });
        const fa = runwayAxis(f);
        expect(Math.hypot(fa.end.x - ga.end.x, fa.end.y - ga.end.y)).toBeLessThan(1e-9);
        expect(positionOnRunway(f, ga.end)).toBe(1);
        expect(positionOnRunway(f, { x: 5, y: 6 })).toBe(0);
      }
    }
  });

  it('positionOnRunway（自由形）: 中心線上は t、外れる・延長線上は null', () => {
    const r = free(30, 1000, { x: 0, y: 0 });
    const a = runwayAxis(r);
    const mid = { x: (a.start.x + a.end.x) / 2, y: (a.start.y + a.end.y) / 2 };
    expect(positionOnRunway(r, mid)).toBeCloseTo(0.5, 12);
    expect(positionOnRunway(r, { x: mid.x + 0.01, y: mid.y })).toBeNull();
    expect(positionOnRunway(r, { x: a.end.x + a.dir.x * 0.5, y: a.end.y + a.dir.y * 0.5 })).toBeNull();
  });

  it('isFreeRunway は alignment で判別する', () => {
    expect(isFreeRunway(free(0, 1000))).toBe(true);
    expect(isFreeRunway({ id: 'g', name: '', start: { x: 0, y: 0 }, heading: 0, length: 5, surfaceWidthM: 30, buildState: 'planned' })).toBe(false);
  });
});
