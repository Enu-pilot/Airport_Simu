import { describe, expect, it } from 'vitest';
import { TILE_M as CATALOG_TILE_M } from '../../../src/core/model/catalog';
import {
  TILE_M,
  bearingToSceneYawRad,
  mToTiles,
  mapToTile,
  mapToWorld,
  tileToWorld,
  tilesToM,
  worldToMap,
  worldToScene,
  worldToTile,
} from '../../../src/core/geometry/frames';
import { Rng } from '../../../src/core/rng';
import { nearlyEqual, POS_EPS_T } from '../../../src/core/geometry/tolerance';

describe('frames', () => {
  it('TILE_M は 25 で、catalog からも同じ値が見える', () => {
    expect(TILE_M).toBe(25);
    expect(CATALOG_TILE_M).toBe(TILE_M);
  });

  it('Tile ↔ World は恒等、Map = World + 0.5', () => {
    expect(tileToWorld({ x: 3, y: -4 })).toEqual({ x: 3, y: -4 });
    expect(worldToMap({ x: 3, y: -4 })).toEqual({ x: 3.5, y: -3.5 });
    expect(mapToWorld({ x: 3.5, y: -3.5 })).toEqual({ x: 3, y: -4 });
  });

  it('World ↔ Map の往復（0.5 刻み・乱数）が厳密に戻る', () => {
    const rng = new Rng('frames');
    for (let i = 0; i < 2000; i++) {
      const p = { x: (rng.int(-4000, 4000) / 2) * 0.5, y: rng.int(-4000, 4000) / 8 };
      expect(mapToWorld(worldToMap(p))).toEqual(p);
    }
  });

  it('mapToTile(worldToMap(p)) === worldToTile(p)（.5 境界を含む）', () => {
    const rng = new Rng('frames-tile');
    const vals = [-2.5, -2, -1.5, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5, 2.5, 3.5, 7.49, 7.5, 7.51];
    for (const x of vals) for (const y of vals) {
      const p = { x, y };
      // Math.round は -0 を返しうるので Object.is ではなく === で比較する
      expect(mapToTile(worldToMap(p)).x === worldToTile(p).x).toBe(true);
      expect(mapToTile(worldToMap(p)).y === worldToTile(p).y).toBe(true);
    }
    for (let i = 0; i < 5000; i++) {
      const p = { x: rng.next() * 200 - 100, y: rng.next() * 200 - 100 };
      expect(mapToTile(worldToMap(p)).x === worldToTile(p).x).toBe(true);
      expect(mapToTile(worldToMap(p)).y === worldToTile(p).y).toBe(true);
    }
  });

  it('整数 World 点は自分自身のタイルに丸まる', () => {
    for (let i = -50; i <= 50; i++) expect(worldToTile({ x: i, y: -i })).toEqual({ x: i, y: -i });
  });

  it('worldToScene は既存の (x + 0.5) * 25 と === で一致する', () => {
    const rng = new Rng('scene');
    for (let i = 0; i < 5000; i++) {
      const p = { x: rng.next() * 400 - 100, y: rng.next() * 400 - 100 };
      const s = worldToScene(p);
      expect(s.x === (p.x + 0.5) * 25).toBe(true);
      expect(s.z === (p.y + 0.5) * 25).toBe(true);
      expect(s.y).toBe(0);
    }
    expect(worldToScene({ x: 0, y: 0 }, 12)).toEqual({ x: 12.5, y: 12, z: 12.5 });
  });

  it('長さの換算とシーン回転', () => {
    expect(tilesToM(4)).toBe(100);
    expect(mToTiles(100)).toBe(4);
    expect(bearingToSceneYawRad(90)).toBe(0);
    expect(bearingToSceneYawRad(0)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('nearlyEqual（許容誤差）', () => {
    expect(nearlyEqual(1, 1 + POS_EPS_T / 2)).toBe(true);
    expect(nearlyEqual(1, 1 + POS_EPS_T * 2)).toBe(false);
  });
});
