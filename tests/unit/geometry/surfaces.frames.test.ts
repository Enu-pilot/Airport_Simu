import { describe, expect, it } from 'vitest';
import { tilesToM, worldPolyToMap, worldPolyToScene, worldToMap, worldToScene } from '../../../src/core/geometry/frames';
import { roadBandSurface, runwayPavementSurface, runwayStripSurface, taxiwayBandSurface } from '../../../src/core/layout/surfaces';
import type { Runway } from '../../../src/core/model/types';

/**
 * 同じ World 頂点を 2D（worldToMap）と 3D（worldToScene）へ変換したとき、位置が一貫する:
 * Scene = Map × 25 m（x, z）。滑走路・誘導路・道路で同じ規約（以前は 3D の滑走路だけ +0.5 が抜けていた）。
 */
describe('surfaces の頂点が 2D と 3D で一貫して変換される', () => {
  const mk = (heading: Runway['heading']): Runway =>
    ({ id: 'r', name: '', start: { x: 4, y: 7 }, heading, length: 30, surfaceWidthM: 45, buildState: 'operational' }) as Runway;
  const shapes = [
    ...([0, 45, 90, 135, 180, 225, 270, 315] as const).flatMap((h) => [runwayPavementSurface(mk(h)), runwayStripSurface(mk(h))]),
    taxiwayBandSurface({ x: 1, y: 2 }, { x: 9, y: 2 }, { widthClass: 'M' }),
    taxiwayBandSurface({ x: 1, y: 2 }, { x: 6, y: 8 }, { widthClass: 'S', codeF: true }),
    roadBandSurface({ x: 0, y: 0 }, { x: 3, y: 5 }, { roadClass: 'rail' }),
  ];

  it('worldPolyToMap / worldPolyToScene は各頂点に worldToMap / worldToScene を適用した結果と === 一致する（描画が使う変換）', () => {
    for (const poly of shapes) {
      expect(poly.length).toBe(4);
      const map = worldPolyToMap(poly);
      const scene = worldPolyToScene(poly, 7);
      expect(map).toHaveLength(4);
      expect(scene).toHaveLength(4);
      poly.forEach((p, i) => {
        expect(map[i]!.x === p.x + 0.5 && map[i]!.y === p.y + 0.5).toBe(true);
        expect(map[i]).toEqual(worldToMap(p));
        // 3D: Scene.x = (World.x + 0.5) × 25、Scene.z = (World.y + 0.5) × 25、Scene.y = 標高
        expect(scene[i]!.x === (p.x + 0.5) * 25 && scene[i]!.z === (p.y + 0.5) * 25).toBe(true);
        expect(scene[i]!.y).toBe(7);
        expect(scene[i]).toEqual(worldToScene(p, 7));
        // 2D と 3D の整合: Scene = Map × 25
        expect(scene[i]!.x).toBe(tilesToM(map[i]!.x));
        expect(scene[i]!.z).toBe(tilesToM(map[i]!.y));
      });
    }
    expect(worldPolyToMap([])).toEqual([]);
    expect(worldPolyToScene([])).toEqual([]);
  });

  it('滑走路の中心線端点（タイル中心）は Map で +0.5、Scene で (x + 0.5) × 25 に来る', () => {
    const r = mk(90);
    const [v0, , , v3] = runwayPavementSurface(r);
    // 始点側の 2 頂点の中点 = 始点を延長 0.5 だけ戻した位置の中心線上
    const mid = { x: (v0!.x + v3!.x) / 2, y: (v0!.y + v3!.y) / 2 };
    expect(mid.x).toBeCloseTo(3.5, 12);
    expect(mid.y).toBeCloseTo(7, 12);
    expect(worldToMap(mid).x).toBeCloseTo(4, 12);
    expect(worldToScene(mid).x).toBeCloseTo(100, 9);
    expect(worldToScene(mid).z).toBeCloseTo(7.5 * 25, 9);
  });
});
