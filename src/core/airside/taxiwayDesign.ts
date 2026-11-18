import type { TaxiwayDesignProfile, TaxiwayEdge } from '../model/types';

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
