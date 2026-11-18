import type { TaxiwayDesignProfile, TaxiwayEdge } from '../model/types';
import { arcLength, fillet } from '../geometry/arc';
import { TILE_M } from '../geometry/frames';

/**
 * 誘導路の実寸設計プロファイル（5-17 T1/T3）。
 *
 * FAA TDG と EASA OMGWS は異なる制度の区分であり、表を混ぜない。
 * ここにある値はゲーム内の設計参考値であり、実際の空港設計・法令適合・
 * 安全保証を行うものではない。
 *
 * 出典:
 * - FAA AC 150/5300-13B Change 1（改訂 2024-08-16）: TDG 別舗装幅。
 * - EASA Easy Access Rules for Aerodromes (March 2026): OMGWS バンド別舗装幅。
 */

/** FAA TDG → 必要舗装幅 (m)。TDG 3 と 4 は同じ 15.2 m */
export const FAA_TDG_PAVEMENT_WIDTH_M: Readonly<Record<string, number>> = {
  '1A': 7.6, '1B': 7.6, '2A': 10.7, '2B': 10.7, '3': 15.2, '4': 15.2, '5': 22.9, '6': 22.9,
};

/** EASA OMGWS バンド → 必要舗装幅 (m)。バンドは主脚外幅の上限（m、未満）で引く */
export const EASA_OMGWS_BANDS: readonly { maxOmgwsM: number; pavementWidthM: number }[] = [
  { maxOmgwsM: 4.5, pavementWidthM: 7.5 },
  { maxOmgwsM: 6, pavementWidthM: 10.5 },
  { maxOmgwsM: 9, pavementWidthM: 15 },
  { maxOmgwsM: 15, pavementWidthM: 23 },
];

/** プロファイルと設計グループ/OMGWS から必要舗装幅を返す。不明な指定は null（推測しない） */
export function requiredPavementWidthM(
  profile: TaxiwayDesignProfile,
  key: { designGroup?: string; omgwsM?: number },
): number | null {
  if (profile === 'faa-tdg') {
    if (key.designGroup === undefined) return null;
    return FAA_TDG_PAVEMENT_WIDTH_M[key.designGroup] ?? null;
  }
  if (profile === 'easa-omgws') {
    if (key.omgwsM === undefined || !(key.omgwsM > 0)) return null;
    for (const band of EASA_OMGWS_BANDS) {
      if (key.omgwsM < band.maxOmgwsM) return band.pavementWidthM;
    }
    return null; // 15 m 以上は表の範囲外（推測しない）
  }
  return null; // legacy-game は実寸表を持たない
}

export type TaxiwayWidthAssessment =
  /** 旧エッジ（実寸データなし）: 従来の widthClass 判定に従う */
  | 'legacy'
  /** 機体の OMGWS が未確認: 通行可否を推測しない */
  | 'unknown'
  | 'sufficient'
  | 'insufficient';

/**
 * 誘導路エッジの実幅と機体 OMGWS の適合を判定する（直線幅のみの初期判定）。
 * 曲線・フィレット・翼端余裕は 5-17 T4 の対象で、ここでは扱わない。
 */
export function assessTaxiwayWidth(
  edge: Pick<TaxiwayEdge, 'pavementWidthM' | 'designProfile' | 'designGroup'>,
  omgwsM: number | undefined,
): TaxiwayWidthAssessment {
  if (edge.pavementWidthM === undefined) return 'legacy';
  if (omgwsM === undefined) return 'unknown';
  const profile = edge.designProfile ?? 'legacy-game';
  const required = requiredPavementWidthM(profile, { designGroup: edge.designGroup, omgwsM });
  if (required === null) return 'unknown';
  return edge.pavementWidthM >= required ? 'sufficient' : 'insufficient';
}

// ---------------------------------------------------------------------------
// T4: コーナーのフィレットと曲線部の主脚余裕（純粋な幾何・運動学のみ。
// 半径やホイールベースは呼び出し側の設計入力で、ここに規格値は持たない）
// ---------------------------------------------------------------------------

export interface CornerFillet {
  /** コーナーから各辺の接点までの距離 (m) */
  tangentDistM: number;
  /** フィレット円弧の長さ (m) */
  arcLengthM: number;
  /** 旋回角（度。直進 0、直角 90） */
  turnAngleDeg: number;
}

/**
 * 2 辺のなす角を半径 radiusM の円弧で丸めたときの接線長と弧長を返す。
 * 座標はタイル単位で受け、TILE_M でメートルに換算する。
 * 一直線・折り返し・半径が不正なら null。
 */
export function taxiwayCornerFillet(
  prev: { x: number; y: number },
  vertex: { x: number; y: number },
  next: { x: number; y: number },
  radiusM: number,
): CornerFillet | null {
  if (!(radiusM > 0)) return null;
  const toM = (p: { x: number; y: number }) => ({ x: p.x * TILE_M, y: p.y * TILE_M });
  const f = fillet(
    { kind: 'line', p0: toM(prev), p1: toM(vertex) },
    { kind: 'line', p0: toM(vertex), p1: toM(next) },
    radiusM,
  );
  if (!f) return null;
  const v = toM(vertex);
  return {
    tangentDistM: Math.hypot(f.a.p1.x - v.x, f.a.p1.y - v.y),
    arcLengthM: arcLength(f.arc),
    turnAngleDeg: Math.round(((Math.abs(f.arc.sweep) * 180) / Math.PI) * 10) / 10,
  };
}

/**
 * 旋回時の主脚の内側へのずれ（オフトラッキング, m）。
 * 前脚が半径 R の円弧を辿るとき、主脚は sqrt(R² − L²) の円弧を辿る（L = ホイールベース）。
 * L ≥ R では旋回できないため null。
 */
export function mainGearOffTrackM(nosePathRadiusM: number, wheelbaseM: number): number | null {
  if (!(nosePathRadiusM > 0) || !(wheelbaseM >= 0)) return null;
  if (wheelbaseM >= nosePathRadiusM) return null;
  return nosePathRadiusM - Math.sqrt(nosePathRadiusM ** 2 - wheelbaseM ** 2);
}

/** 曲線部で必要な舗装幅 (m): 主脚帯が内側にずれる分だけ直線部より広く要る */
export function curveRequiredWidthM(omgwsM: number, offTrackM: number): number {
  return omgwsM + 2 * offTrackM;
}

// ---------------------------------------------------------------------------
// T5: 高速離脱誘導路（RET）の形状（純粋な幾何と運動学のみ。
// 角度・半径・間隔・速度・減速度はすべて設計入力で、規格値は埋め込まない）
// ---------------------------------------------------------------------------

export interface RetPath {
  /** 滑走路中心線から離脱曲線（円弧）に入り、角度 exitAngleDeg だけ向きを変えるまでの弧長 (m) */
  arcLengthM: number;
  /** 円弧の後に平行誘導路へ到達するまでの直線長 (m) */
  straightLengthM: number;
  totalLengthM: number;
  /** 離脱開始点から、平行誘導路の中心線へ到達するまでの滑走路方向の距離 (m) */
  alongRunwayM: number;
}

/**
 * 離脱角 θ・半径 R で滑走路を離れ、横方向に lateralOffsetM 離れた平行誘導路へ抜ける経路。
 * 円弧だけで横方向の間隔を超えてしまう（R(1−cosθ) > D）場合は成立しないため null。
 */
export function retPath(exitAngleDeg: number, radiusM: number, lateralOffsetM: number): RetPath | null {
  if (!(exitAngleDeg > 0 && exitAngleDeg < 90) || !(radiusM > 0) || !(lateralOffsetM > 0)) return null;
  const th = (exitAngleDeg * Math.PI) / 180;
  const arcLateral = radiusM * (1 - Math.cos(th));
  if (arcLateral > lateralOffsetM) return null;
  const arcLengthM = radiusM * th;
  const straightLengthM = (lateralOffsetM - arcLateral) / Math.sin(th);
  return {
    arcLengthM,
    straightLengthM,
    totalLengthM: arcLengthM + straightLengthM,
    alongRunwayM: radiusM * Math.sin(th) + straightLengthM * Math.cos(th),
  };
}

/** 一定減速度で止まるまでの距離 (m)。v²/(2a) */
export function stoppingDistanceM(speedMps: number, decelMps2: number): number | null {
  if (!(speedMps >= 0) || !(decelMps2 > 0)) return null;
  return (speedMps * speedMps) / (2 * decelMps2);
}

/** 距離 distanceM で止まるために許容できる進入速度 (m/s)。sqrt(2aD) */
export function maxEntrySpeedMps(distanceM: number, decelMps2: number): number | null {
  if (!(distanceM >= 0) || !(decelMps2 > 0)) return null;
  return Math.sqrt(2 * decelMps2 * distanceM);
}
