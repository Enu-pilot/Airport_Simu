/**
 * タイルのラスタライズ（vec.ts から移動。関数本体は変更なし。vec.ts から再エクスポートされる）。
 */
import { satOverlapConvex } from './polygon';
import { distance, pointInPolygon, tileKey, type Tile, type Vec2 } from './vec';

/** 多角形（タイル番号空間）に中心が含まれるタイルの一覧 */
export function rasterizePolygon(poly: readonly Vec2[]): Tile[] {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x0 = Math.ceil(Math.min(...xs));
  const x1 = Math.floor(Math.max(...xs));
  const y0 = Math.ceil(Math.min(...ys));
  const y1 = Math.floor(Math.max(...ys));
  const out: Tile[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (pointInPolygon({ x, y }, poly)) out.push({ x, y });
    }
  }
  return out;
}

/**
 * 凸多角形（World フレーム、タイル単位）と内部で重なるタイル（正方形 [x−½, x+½] × [y−½, y+½]）の一覧。
 * `rasterizePolygon`（タイル中心が内側にあるものだけ）と違い、多角形が一部でも覆うタイルを含む。
 * 接触だけ（境界が触れるだけ、POS_EPS_T 以内）は含めない。順序は y、x の昇順。
 */
export function tilesOverlappingPolygon(poly: readonly Vec2[]): Tile[] {
  if (poly.length < 3) return [];
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x0 = Math.floor(Math.min(...xs) - 0.5);
  const x1 = Math.ceil(Math.max(...xs) + 0.5);
  const y0 = Math.floor(Math.min(...ys) - 0.5);
  const y1 = Math.ceil(Math.max(...ys) + 0.5);
  const out: Tile[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sq = [
        { x: x - 0.5, y: y - 0.5 },
        { x: x + 0.5, y: y - 0.5 },
        { x: x + 0.5, y: y + 0.5 },
        { x: x - 0.5, y: y + 0.5 },
      ];
      if (satOverlapConvex(sq, poly)) out.push({ x, y });
    }
  }
  return out;
}

/** 線分（タイル番号空間）が通過するタイル。0.25タイル間隔でサンプリングする */
export function rasterizeSegment(a: Vec2, b: Vec2): Tile[] {
  const n = Math.max(1, Math.ceil(distance(a, b) * 4));
  const seen = new Set<string>();
  const out: Tile[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    const k = tileKey(x, y);
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ x, y });
    }
  }
  return out;
}
