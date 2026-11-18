import { Rng } from '../rng';
import { Terrain, type Site, type TerrainType } from './types';

export const DEFAULT_SITE_WIDTH = 160;
export const DEFAULT_SITE_HEIGHT = 112;

/** 「空の敷地」で選べる敷地の大きさ（タイル数。1 タイル = 25 m） */
export interface SiteSize {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const SITE_SIZES: SiteSize[] = [
  { id: 'standard', label: '標準（160 × 112）', width: DEFAULT_SITE_WIDTH, height: DEFAULT_SITE_HEIGHT },
  { id: 'medium', label: '中（200 × 144）', width: 200, height: 144 },
  { id: 'large', label: '大（288 × 208）', width: 288, height: 208 },
  { id: 'huge', label: '特大（350 × 332）', width: 350, height: 332 },
];

export function siteSizeById(id: string): SiteSize {
  return SITE_SIZES.find((s) => s.id === id) ?? SITE_SIZES[0]!;
}
/** 外周の未取得地の幅（タイル） */
export const DEFAULT_OFFSITE_MARGIN = 6;

export interface SiteOptions {
  width?: number;
  height?: number;
  seed?: string;
  offsiteMargin?: number;
  /** false のとき外周の未取得地を置かない（土地購入時の元の地形の復元に使う） */
  offsite?: boolean;
}

/**
 * 敷地を生成する。シードが同じなら常に同じ地形になる。
 * 中央部（サンプル空港の配置域）には建設不可地形を置かない。
 */
export function createSite(opts: SiteOptions = {}): Site {
  const width = opts.width ?? DEFAULT_SITE_WIDTH;
  const height = opts.height ?? DEFAULT_SITE_HEIGHT;
  const seed = opts.seed ?? 'skyport';
  const margin = opts.offsiteMargin ?? DEFAULT_OFFSITE_MARGIN;
  const rng = new Rng(`site:${seed}`);
  const terrain: TerrainType[] = new Array<TerrainType>(width * height).fill(Terrain.grass);
  const set = (x: number, y: number, t: TerrainType) => {
    if (x >= 0 && y >= 0 && x < width && y < height) terrain[y * width + x] = t;
  };
  const blob = (cx: number, cy: number, rx: number, ry: number, t: TerrainType) => {
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d <= 1) set(x, y, t);
      }
    }
  };

  // 湖（右下）。中心と大きさは少しだけ乱数で揺らす
  const lakeX = width * 0.89 + rng.int(-2, 2);
  const lakeY = height * 0.86 + rng.int(-2, 2);
  blob(lakeX, lakeY, width * 0.08, height * 0.08, Terrain.water);
  blob(lakeX - width * 0.05, lakeY + height * 0.04, width * 0.05, height * 0.05, Terrain.water);

  // 森（上辺の帯）
  const forestCount = 6;
  for (let i = 0; i < forestCount; i++) {
    const cx = rng.int(Math.floor(width * 0.08), Math.floor(width * 0.92));
    const cy = rng.int(margin + 2, Math.floor(height * 0.16));
    blob(cx, cy, rng.int(4, 9), rng.int(2, 4), Terrain.forest);
  }
  // 岩場（左下）
  blob(width * 0.08, height * 0.84, 3, 2, Terrain.rock);

  // 外周の未取得地
  if (opts.offsite === false) return { width, height, terrain, seed };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < margin || y < margin || x >= width - margin || y >= height - margin) {
        terrain[y * width + x] = Terrain.offsite;
      }
    }
  }
  return { width, height, terrain, seed };
}

export function inSite(site: Site, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < site.width && y < site.height;
}

export function terrainAt(site: Site, x: number, y: number): TerrainType {
  if (!inSite(site, x, y)) return Terrain.offsite;
  return site.terrain[y * site.width + x] ?? Terrain.offsite;
}

/** 建設可能か（草地・森。森は将来伐採費用がかかる） */
export function isBuildable(site: Site, x: number, y: number): boolean {
  const t = terrainAt(site, x, y);
  return t === Terrain.grass || t === Terrain.forest;
}

/** 取得済み敷地の外周タイル（道路の出入口判定に使う） */
export function isSiteEdge(site: Site, x: number, y: number): boolean {
  if (!isBuildable(site, x, y)) return false;
  return (
    terrainAt(site, x - 1, y) === Terrain.offsite ||
    terrainAt(site, x + 1, y) === Terrain.offsite ||
    terrainAt(site, x, y - 1) === Terrain.offsite ||
    terrainAt(site, x, y + 1) === Terrain.offsite
  );
}

const baseCache = new Map<string, TerrainType[]>();

/** 未取得地の下にある元の地形（同じシード・寸法で、未取得地を置かずに生成した地形） */
export function baseTerrainAt(site: Site, x: number, y: number): TerrainType {
  const key = `${site.seed}:${site.width}x${site.height}`;
  let base = baseCache.get(key);
  if (!base) {
    base = createSite({ width: site.width, height: site.height, seed: site.seed, offsite: false }).terrain;
    baseCache.set(key, base);
  }
  return base[y * site.width + x] ?? Terrain.grass;
}
