/**
 * タイルのラスタライズ（vec.ts から移動。関数本体は変更なし。vec.ts から再エクスポートされる）。
 */
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
