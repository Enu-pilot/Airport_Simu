/**
 * 座標フレームと単位変換（位置変換はこのファイルだけで行う）。
 *
 * - Tile  : 整数タイル番号 (i, j)。地形・施設の origin・占有ラスタ。
 * - World : タイル単位の実数。整数 = タイル中心（ノード・滑走路端・機体 x/y の座標系）。+x = 東、+y = 南。
 * - Map   : 2D 描画フレーム。タイル (i, j) は [i, i+1) × [j, j+1)。Map = World + 0.5。
 * - Scene : 3D（メートル）。X = Map.x × 25、Z = Map.y × 25、Y = 上（標高 m）。
 *
 * メートルは長さ・幅・半径にだけ使い、位置には使わない（位置 × 25 を経由すると距離が 1ulp ずれる）。
 * 演算順は既存コード（`(x + 0.5) * 25`, `x - 0.5`）と同一にしてある。
 */
import type { Tile, Vec2 } from './vec';

/** 1 タイルの実寸（m）。catalog.ts はこれを再エクスポートする */
export const TILE_M = 25;

export type WorldPoint = Vec2;
export type MapPoint = Vec2;
export interface ScenePoint {
  x: number;
  y: number;
  z: number;
}

export const tileToWorld = (t: Tile): WorldPoint => ({ x: t.x, y: t.y });
/** 最も近いタイル（.5 は +∞ 側。`mapToTile(worldToMap(p))` と一致） */
export const worldToTile = (p: WorldPoint): Tile => ({ x: Math.round(p.x), y: Math.round(p.y) });
export const worldToMap = (p: WorldPoint): MapPoint => ({ x: p.x + 0.5, y: p.y + 0.5 });
export const mapToWorld = (p: MapPoint): WorldPoint => ({ x: p.x - 0.5, y: p.y - 0.5 });
export const mapToTile = (p: MapPoint): Tile => ({ x: Math.floor(p.x), y: Math.floor(p.y) });
export const worldToScene = (p: WorldPoint, elevM = 0): ScenePoint => ({
  x: (p.x + 0.5) * TILE_M,
  y: elevM,
  z: (p.y + 0.5) * TILE_M,
});
/** World 多角形・折れ線 → Map（2D 描画） */
export const worldPolyToMap = (pts: readonly WorldPoint[]): MapPoint[] => pts.map(worldToMap);
/** World 多角形・折れ線 → Scene（3D、同じ標高 elevM）。各頂点に `worldToScene` と同じ演算を適用する */
export const worldPolyToScene = (pts: readonly WorldPoint[], elevM = 0): ScenePoint[] => pts.map((p) => worldToScene(p, elevM));
export const tilesToM = (t: number): number => t * TILE_M;
export const mToTiles = (m: number): number => m / TILE_M;
/** 真方位（度、0 = 北 = -y、時計回り）→ three.js の Y 軸まわり回転（ラジアン）。「90° − h」規約 */
export const bearingToSceneYawRad = (deg: number): number => ((90 - deg) * Math.PI) / 180;
