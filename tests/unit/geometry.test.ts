import { describe, expect, it } from 'vitest';
import {
  pointOnSegmentInterior,
  rasterizePolygon,
  rasterizeSegment,
  segmentIntersection,
  snapToOctant,
} from '../../src/core/geometry/vec';
import { centerOn, panBy, screenToTile, screenToWorld, worldToScreen, zoomAt, MAX_ZOOM } from '../../src/core/geometry/camera';

describe('座標変換（カメラ）', () => {
  const cam = { x: 10, y: 20, zoom: 16 };

  it('世界座標 ↔ 画面座標の往復で一致する', () => {
    const p = { x: 13.25, y: 27.5 };
    const s = worldToScreen(cam, p);
    expect(s).toEqual({ x: 52, y: 120 });
    expect(screenToWorld(cam, s)).toEqual(p);
  });

  it('画面座標からタイルを求める（タイル境界は左上側に含む）', () => {
    expect(screenToTile(cam, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    expect(screenToTile(cam, { x: 15.9, y: 16 })).toEqual({ x: 10, y: 21 });
    expect(screenToTile({ x: -0.5, y: 0, zoom: 10 }, { x: 0, y: 0 })).toEqual({ x: -1, y: 0 });
  });

  it('ズームしてもカーソル位置の世界座標は動かない', () => {
    const anchor = { x: 300, y: 200 };
    const before = screenToWorld(cam, anchor);
    const zoomed = zoomAt(cam, anchor, 40);
    expect(zoomed.zoom).toBe(40);
    const after = screenToWorld(zoomed, anchor);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it('ズームは上限でクランプされる', () => {
    expect(zoomAt(cam, { x: 0, y: 0 }, 1000).zoom).toBe(MAX_ZOOM);
  });

  it('パンはドラッグ方向と逆にカメラが動く / centerOn で中央に表示', () => {
    expect(panBy(cam, 32, -16)).toEqual({ x: 8, y: 21, zoom: 16 });
    const c = centerOn(cam, { x: 50, y: 50 }, 800, 600);
    expect(screenToWorld(c, { x: 400, y: 300 })).toEqual({ x: 50, y: 50 });
  });
});

describe('幾何', () => {
  it('線分の内部判定（端点は含まない）', () => {
    expect(pointOnSegmentInterior({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(0.5);
    expect(pointOnSegmentInterior({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull();
    expect(pointOnSegmentInterior({ x: 2, y: 1 }, { x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull();
  });

  it('線分の交差（内部同士のみ）', () => {
    const hit = segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: -2 }, { x: 2, y: 2 });
    expect(hit?.point).toEqual({ x: 2, y: 0 });
    // 端点での接触は交差としない
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 })).toBeNull();
    // 平行
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 1 }, { x: 4, y: 1 })).toBeNull();
  });

  it('8方向スナップ', () => {
    expect(snapToOctant({ x: 0, y: 0 }, { x: 10, y: 2 })).toEqual({ x: 10, y: 0 });
    expect(snapToOctant({ x: 0, y: 0 }, { x: 5, y: 6 })).toEqual({ x: 6, y: 6 });
    expect(snapToOctant({ x: 0, y: 0 }, { x: -1, y: -9 })).toEqual({ x: 0, y: -9 });
  });

  it('ラスタライズ', () => {
    expect(rasterizeSegment({ x: 0, y: 0 }, { x: 3, y: 0 })).toHaveLength(4);
    const square = rasterizePolygon([
      { x: -0.5, y: -0.5 },
      { x: 2.5, y: -0.5 },
      { x: 2.5, y: 1.5 },
      { x: -0.5, y: 1.5 },
    ]);
    expect(square).toHaveLength(6);
  });
});
