/**
 * 描画用の面の形状。World フレーム・タイル単位で生成し、2D（worldToMap）と 3D（worldToScene）は
 * 変換して描くだけにする（形状を 2D と 3D で別々に作らない）。
 *
 * - 滑走路の舗装・着陸帯は、現行の占有フットプリント（runwayPolygon / runwayStripPolygon）と同じ形。
 *   実寸の舗装（Phase 12）はここに追加する。
 * - 誘導路・道路の帯は、ノード間の中心線を幅 widthM（m）で太らせ、両端を半幅だけ延ばした矩形。
 */
import { ROAD_DRAW_WIDTH_M, TAXIWAY_DRAW_WIDTH_M, TILE_M } from '../model/catalog';
import { isFreeRunway, type AirportLayout, type Runway, type SizeClass } from '../model/types';
import { mToTiles, type WorldPoint } from '../geometry/frames';
import { rectAlong, rectAlongDir } from '../geometry/stroke';
import { designatorsOf } from './designators';
import { runwayAreas } from './runwayAreas';
import { runwayAxis, runwayPolygon, runwayStripPolygon } from './runway';

/** 誘導路の描画幅（m）。codeF は幅区分より優先 */
export function taxiwayDrawWidthM(e: { widthClass: SizeClass; codeF?: boolean }): number {
  return e.codeF ? TAXIWAY_DRAW_WIDTH_M.codeF : TAXIWAY_DRAW_WIDTH_M[e.widthClass];
}

/** 道路・鉄道の描画幅（m） */
export function roadDrawWidthM(e: { roadClass: string }): number {
  return e.roadClass === 'rail' ? ROAD_DRAW_WIDTH_M.rail : ROAD_DRAW_WIDTH_M.road;
}

/** 滑走路の舗装面（World フレーム、4 頂点） */
export function runwayPavementSurface(r: Runway): WorldPoint[] {
  return runwayPolygon(r);
}

/** 滑走路の着陸帯（World フレーム、4 頂点） */
export function runwayStripSurface(r: Runway): WorldPoint[] {
  return runwayStripPolygon(r);
}

/** a → b の帯（幅 widthM、両端を半幅だけ延ばす）。a = b なら空配列 */
export function bandSurface(a: WorldPoint, b: WorldPoint, widthM: number): WorldPoint[] {
  const half = mToTiles(widthM) / 2;
  return rectAlong(a, b, half, half);
}

export function taxiwayBandSurface(a: WorldPoint, b: WorldPoint, e: { widthClass: SizeClass; codeF?: boolean }): WorldPoint[] {
  return bandSurface(a, b, taxiwayDrawWidthM(e));
}

export function roadBandSurface(a: WorldPoint, b: WorldPoint, e: { roadClass: string }): WorldPoint[] {
  return bandSurface(a, b, roadDrawWidthM(e));
}

// ---------------------------------------------------------------- 滑走路の面（2D・3D が共有。Phase 12 S11）

/** 滑走路番号の標示（World フレーム） */
export interface RunwayDesignatorMark {
  pos: WorldPoint;
  text: string;
  /** 文字の向き（真方位）。その端に進入する機体が読める向き（始点側は始点 → 終点の方位、終点側はその逆） */
  bearingDeg: number;
}

/** 滑走路を描くための面（すべて World フレーム・タイル単位。2D は worldPolyToMap、3D は worldPolyToScene で変換する） */
export interface RunwaySurfaces {
  /** 舗装 + 肩（舗装の外側の明るい灰） */
  paved: WorldPoint[];
  /** 舗装（滑走路の幅 × 長さ） */
  pavement: WorldPoint[];
  /** 着陸帯 */
  strip: WorldPoint[];
  /** RESA（両端。長さ 0 なら空） */
  resa: WorldPoint[][];
  /** 中心線の破線（線分。幅は描画側が決める） */
  centrelineDashes: [WorldPoint, WorldPoint][];
  /** 進入端の標示（両端の縦じま。それぞれ 4 頂点） */
  thresholdBars: WorldPoint[][];
  /** 滑走路番号（両端） */
  designators: RunwayDesignatorMark[];
  /**
   * 従来形のみ: 判定（占有）に使うゲームの簡易な多角形（幅 3 タイル、両端 0.5 タイル延長）。描画の舗装は実寸の幅（30/45/60 m）だが、
   * 配置・検証はこちらで行うので、プレイヤーが判定の範囲を理解できるよう薄い輪郭で見せる。自由形は null（舗装・肩・着陸帯・RESA が判定そのもの）
   */
  footprint: WorldPoint[] | null;
}

/**
 * 標示の寸法（m、ゲーム値。標示の概形に倣うが、本数・寸法は表示用で規格の値ではない）。
 * 進入端の縦じまの本数は舗装幅ごと（30 m: 8、45 m: 12、60 m: 16）。
 */
export const RUNWAY_MARKING_M = {
  dash: 30,
  gap: 20,
  thresholdOffset: 6,
  thresholdLength: 30,
  stripeWidth: 1.8,
  stripeEdgeMargin: 3,
  designatorMax: 150,
  designatorFraction: 0.1,
  centreMargin: 12,
} as const;

export const RUNWAY_THRESHOLD_STRIPES: Record<30 | 45 | 60, number> = { 30: 8, 45: 12, 60: 16 };

/**
 * 滑走路の面。自由形は `runwayAreas`（実寸の舗装・肩・着陸帯・RESA）。
 * 従来形は、舗装を実寸の幅（surfaceWidthM = 30/45/60 m、始点〜終点）で描く（表示のみ。占有・検証は従来のまま）。
 * 肩・RESA はなく、着陸帯と `footprint` は判定に使うゲームの占有の多角形そのもの。
 * 標示（中心線・進入端・番号）は中心線の幾何（`runwayAxis`）と `designatorsOf` から作る。
 */
export function runwaySurfaces(r: Runway, layout: AirportLayout): RunwaySurfaces {
  const ax = runwayAxis(r);
  const t = (m: number): number => m / TILE_M;
  const m = RUNWAY_MARKING_M;
  const lengthM = ax.lengthT * TILE_M;
  const at = (distM: number): WorldPoint => ({ x: ax.start.x + ax.dir.x * t(distM), y: ax.start.y + ax.dir.y * t(distM) });

  let pavement: WorldPoint[];
  let paved: WorldPoint[];
  let strip: WorldPoint[];
  let resa: WorldPoint[][] = [];
  let footprint: WorldPoint[] | null = null;
  if (isFreeRunway(r)) {
    const a = runwayAreas(r);
    pavement = a.pavement;
    paved = a.paved;
    strip = a.strip;
    resa = a.resa;
  } else {
    pavement = rectAlongDir(ax.start, ax.end, ax.dir, t(r.surfaceWidthM / 2), 0);
    paved = pavement;
    strip = runwayStripPolygon(r);
    footprint = runwayPolygon(r);
  }

  // 進入端の縦じま（両端）。短い滑走路でも端から端までに収める
  const barOffset = Math.min(m.thresholdOffset, lengthM * 0.05);
  const barLength = Math.min(m.thresholdLength, lengthM * 0.2);
  const n = RUNWAY_THRESHOLD_STRIPES[r.surfaceWidthM];
  const span = r.surfaceWidthM / 2 - m.stripeEdgeMargin;
  const thresholdBars: WorldPoint[][] = [];
  for (const end of ['start', 'end'] as const) {
    for (let i = 0; i < n; i++) {
      const lateral = -span + (2 * span * i) / (n - 1);
      const d0 = end === 'start' ? barOffset : lengthM - barOffset - barLength;
      const a = at(d0);
      const b = at(d0 + barLength);
      const c = { x: -ax.dir.y * t(lateral), y: ax.dir.x * t(lateral) };
      const side = rectAlongDir({ x: a.x + c.x, y: a.y + c.y }, { x: b.x + c.x, y: b.y + c.y }, ax.dir, t(m.stripeWidth / 2), 0);
      thresholdBars.push(side);
    }
  }

  // 番号（端から内側へ min(0.1 × 長さ, 150 m)）
  const dd = Math.min(m.designatorFraction * lengthM, m.designatorMax);
  const ds = designatorsOf(r, layout);
  const designators: RunwayDesignatorMark[] = [
    { pos: at(dd), text: ds.text[0], bearingDeg: ax.trueHeadingDeg },
    { pos: at(lengthM - dd), text: ds.text[1], bearingDeg: (ax.trueHeadingDeg + 180) % 360 },
  ];

  // 中心線の破線（標示と番号の内側から、30 m の線と 20 m の間隔）
  const zone = Math.max(dd, barOffset + barLength) + m.centreMargin;
  const centrelineDashes: [WorldPoint, WorldPoint][] = [];
  for (let d = zone; d + m.dash <= lengthM - zone + 1e-9; d += m.dash + m.gap) centrelineDashes.push([at(d), at(d + m.dash)]);

  return { paved, pavement, strip, resa, centrelineDashes, thresholdBars, designators, footprint };
}
