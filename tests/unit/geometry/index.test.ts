import { describe, expect, it } from 'vitest';
import * as g from '../../../src/core/geometry';

describe('geometry index', () => {
  it('公開 API が揃っていて、既存の述語も引き続き公開されている', () => {
    for (const k of ['segmentIntersection', 'rasterizePolygon', 'worldToMap', 'bearingToDir', 'classifySegmentIntersection', 'intersectCurves', 'rectAlong', 'satOverlapConvex', 'curveLength', 'arcFromBulge']) {
      expect(typeof (g as Record<string, unknown>)[k]).toBe('function');
    }
    expect(g.TILE_M).toBe(25);
  });
});
