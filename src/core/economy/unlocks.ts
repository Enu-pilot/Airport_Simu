import type { CompanyState, ContractKind } from './company';
import { TIER_NAMES, type Tier } from './goals';
import type { TerminalAreaKind } from '../model/types';

/**
 * 格による解放（フェーズ 4 §2）。機能ごとの「必要な格」を 1 か所で定義する。
 * サンドボックスと、game.goals がない会社（従来の会社を含む）は全解放。
 * 解放と有効化は別: 解放済みでも features が ON になるまで新機能は動かない。
 */
export type FeatureId = 'overnight' | 'based' | 'maintenance' | 'international' | 'hub' | 'cargo';

export interface UnlockDef {
  feature: FeatureId;
  tier: Tier;
  areaKinds?: TerminalAreaKind[];
  gateRouteTypes?: ('international' | 'swing')[];
  contractKinds?: ContractKind[];
  settings?: (keyof NonNullable<CompanyState['features']>)[];
}

export const UNLOCKS: readonly UnlockDef[] = [
  { feature: 'overnight', tier: 1, contractKinds: ['overnight'], settings: ['overnight'] },
  { feature: 'maintenance', tier: 2 },
  { feature: 'based', tier: 2, contractKinds: ['based'], settings: ['based'] },
  {
    // 5-20: 国際線は新格 4（国際空港）へ再配置。旧格 3 の会社は移行で新格 5 になるため解放を失わない
    feature: 'international', tier: 4,
    areaKinds: ['emigration', 'immigration', 'customs'], gateRouteTypes: ['international', 'swing'], settings: ['international'],
  },
  // 5-20: 乗継・ハブは新格 5（国際ハブ空港）へ再配置
  { feature: 'hub', tier: 5, areaKinds: ['transferSecurity'], settings: ['hub'] },
  // 貨物（5-12 / CARGO-08）: 国内貨物は格 3（国内主要空港）で解放。
  // 国際貨物は格 4 が必要で、提案生成側で就航先ごとに判定する（company.ts の generateCargoOffers）。
  { feature: 'cargo', tier: 3, contractKinds: ['cargo'], settings: ['cargo'] },
];

const BY_FEATURE = new Map<FeatureId, UnlockDef>(UNLOCKS.map((u) => [u.feature, u]));

/** 判定に使う格。サンドボックス・目標のない会社は最上位（全解放） */
export function effectiveTier(c: CompanyState): Tier {
  if (c.mode === 'sandbox' || !c.game?.goals || !c.goals) return 7;
  return c.goals.tier;
}

export function isUnlocked(c: CompanyState, f: FeatureId): boolean {
  return effectiveTier(c) >= (BY_FEATURE.get(f)?.tier ?? 0);
}

/** 解放前の表示。解放済みなら null */
export function lockLabel(c: CompanyState, f: FeatureId): string | null {
  if (isUnlocked(c, f)) return null;
  const tier = BY_FEATURE.get(f)!.tier;
  return `格 ${tier}（${TIER_NAMES[tier]}）で解放`;
}

/** 解放済み かつ プレイヤーが有効化しているか。整備は拠点の有効化に含まれる（設定キーは持たない） */
export function featureOn(c: CompanyState, f: FeatureId): boolean {
  if (!isUnlocked(c, f)) return false;
  if (f === 'maintenance') return !!c.features?.based;
  return !!c.features?.[f];
}

/** 契約の種類に対応する機能（turnaround は常時可） */
export function featureForContractKind(kind: ContractKind | undefined): FeatureId | null {
  if (kind === 'overnight') return 'overnight';
  if (kind === 'based') return 'based';
  if (kind === 'cargo') return 'cargo';
  return null;
}

/** エリアの種類に対応する機能 */
export function featureForAreaKind(kind: TerminalAreaKind): FeatureId | null {
  for (const u of UNLOCKS) if (u.areaKinds?.includes(kind)) return u.feature;
  return null;
}
