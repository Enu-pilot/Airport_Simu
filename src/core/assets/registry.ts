import type { AircraftModel } from '../aircraft/catalog';

/**
 * 3D 表示のアセット登録簿（Phase 9）。
 *
 * SkyPort の 3D 機体はすべて「手続き生成」（コードで胴体・主翼・尾翼・エンジンを組み立てる）で、
 * 外部の 3D モデルファイルは使っていない。寸法（全長・翼幅・全高）は登録簿ではなく機種カタログの値
 * （公式値、未設定なら汎用値）を毎回読み、形の違い（胴体の太さ・尾翼の比率・エンジン数・2階席）だけを
 * テンプレートとして持つ。したがって「専用アセット」（その機種のために作った精密モデル）は1件もなく、
 * すべて dedicated = false。対応状況の一覧は supportList() で出す。
 *
 * このファイルは描画ライブラリに依存しない純粋なデータで、保存形式（プロジェクト）からも参照する。
 */

export const ASSET_VERSION = '2026.11.0';

export type LodLevel = {
  /** この距離（m）未満で使う */
  maxDistanceM: number;
  detail: 'high' | 'medium' | 'low';
};

export interface AircraftAsset {
  id: string;
  label: string;
  version: string;
  /** 寸法の出典。手続き生成アセットは機種カタログの値をそのまま使う */
  dimensions: 'catalog';
  /** 原点: 機体中心（胴体の長さ方向の中点、主脚の接地面の高さ） */
  origin: 'center-ground';
  /** 1 単位 = 1 m */
  unitM: 1;
  lod: LodLevel[];
  source: string;
  license: string;
  /** その機種専用に作ったモデルか（false = 系統のテンプレートを寸法で変形したもの） */
  dedicated: boolean;
  /** 代替表示（機種固有の形を持たない汎用の形） */
  fallback: boolean;
  /** 形のテンプレート（胴体径 ÷ 全長、垂直尾翼の高さ比、主翼の後退角（度）） */
  shape: { fuselageRatio: number; tailRatio: number; sweepDeg: number; noseStyle: 'boeing' | 'airbus' | 'generic' };
}

const LOD: LodLevel[] = [
  { maxDistanceM: 900, detail: 'high' },
  { maxDistanceM: 3500, detail: 'medium' },
  { maxDistanceM: Infinity, detail: 'low' },
];

const proc = (id: string, label: string, shape: AircraftAsset['shape'], fallback = false): AircraftAsset => ({
  id,
  label,
  version: ASSET_VERSION,
  dimensions: 'catalog',
  origin: 'center-ground',
  unitM: 1,
  lod: LOD,
  source: 'SkyPort 内製（手続き生成）',
  license: 'プロジェクトのソースコードと同じ（外部素材なし）',
  dedicated: false,
  fallback,
  shape,
});

export const AIRCRAFT_ASSETS: Record<string, AircraftAsset> = Object.fromEntries(
  [
    proc('generic-regional', '汎用・リージョナル機', { fuselageRatio: 0.095, tailRatio: 0.24, sweepDeg: 22, noseStyle: 'generic' }, true),
    proc('generic-narrow', '汎用・小型ジェット', { fuselageRatio: 0.1, tailRatio: 0.3, sweepDeg: 25, noseStyle: 'generic' }, true),
    proc('generic-wide', '汎用・ワイドボディ', { fuselageRatio: 0.09, tailRatio: 0.27, sweepDeg: 30, noseStyle: 'generic' }, true),
    proc('proc-narrow-boeing', '737 系（手続き生成）', { fuselageRatio: 0.095, tailRatio: 0.31, sweepDeg: 25, noseStyle: 'boeing' }),
    proc('proc-narrow-airbus', 'A320 系（手続き生成）', { fuselageRatio: 0.105, tailRatio: 0.31, sweepDeg: 25, noseStyle: 'airbus' }),
    proc('proc-wide-767', '767 系（手続き生成）', { fuselageRatio: 0.092, tailRatio: 0.29, sweepDeg: 31, noseStyle: 'boeing' }),
    proc('proc-regional-jet', 'E-Jets 系（手続き生成）', { fuselageRatio: 0.095, tailRatio: 0.3, sweepDeg: 25, noseStyle: 'generic' }),
    proc('proc-turboprop', 'ターボプロップ機（手続き生成。主翼は低翼で近似）', { fuselageRatio: 0.1, tailRatio: 0.3, sweepDeg: 3, noseStyle: 'generic' }),
    proc('proc-wide-777', '777 系（手続き生成）', { fuselageRatio: 0.084, tailRatio: 0.25, sweepDeg: 31, noseStyle: 'boeing' }),
    proc('proc-wide-787', '787 系（手続き生成）', { fuselageRatio: 0.092, tailRatio: 0.27, sweepDeg: 32, noseStyle: 'boeing' }),
    proc('proc-wide-a350', 'A350 系（手続き生成）', { fuselageRatio: 0.09, tailRatio: 0.26, sweepDeg: 31, noseStyle: 'airbus' }),
    proc('proc-a380', 'A380（手続き生成・2階建て）', { fuselageRatio: 0.11, tailRatio: 0.33, sweepDeg: 33, noseStyle: 'airbus' }),
  ].map((a) => [a.id, a]),
);

/** 登録簿にない ID のときの代替アセット */
export const FALLBACK_ASSET_ID = 'generic-narrow';

export function assetOf(id: string | undefined): AircraftAsset {
  return (id && AIRCRAFT_ASSETS[id]) || AIRCRAFT_ASSETS[FALLBACK_ASSET_ID]!;
}

export interface AssetSupport {
  modelId: string;
  assetId: string;
  /** dedicated: 専用モデル / template: 系統テンプレート＋機種寸法 / fallback: 汎用の形 / missing: 登録簿にない（代替表示） */
  level: 'dedicated' | 'template' | 'fallback' | 'missing';
}

export function supportList(models: Record<string, AircraftModel>): AssetSupport[] {
  return Object.values(models).map((m) => {
    const a = AIRCRAFT_ASSETS[m.assetId];
    const level = !a ? 'missing' : a.dedicated ? 'dedicated' : a.fallback ? 'fallback' : 'template';
    return { modelId: m.id, assetId: a ? a.id : FALLBACK_ASSET_ID, level };
  });
}

// ---------------------------------------------------------------- 塗装（架空）

/** 架空の航空会社の塗装。実在の航空会社の塗装・ロゴは使わない */
export interface Livery {
  id: string;
  airlineId: string | null;
  body: number;
  tail: number;
  stripe: number;
  engine: number;
}

export const LIVERIES: Record<string, Livery> = {
  SK: { id: 'liv-sk', airlineId: 'SK', body: 0xf4f6fa, tail: 0x1d4ed8, stripe: 0x60a5fa, engine: 0x9ca3af },
  NP: { id: 'liv-np', airlineId: 'NP', body: 0xf8fafc, tail: 0x0f766e, stripe: 0xf59e0b, engine: 0xd1d5db },
  RJ: { id: 'liv-rj', airlineId: 'RJ', body: 0xeef2f7, tail: 0x7c3aed, stripe: 0x7c3aed, engine: 0x9ca3af },
  AQ: { id: 'liv-aq', airlineId: 'AQ', body: 0xffffff, tail: 0x06b6d4, stripe: 0x0891b2, engine: 0x06b6d4 },
  HB: { id: 'liv-hb', airlineId: 'HB', body: 0xfffbeb, tail: 0xdc2626, stripe: 0x16a34a, engine: 0xe5e7eb },
  AS: { id: 'liv-as', airlineId: 'AS', body: 0xf8fafc, tail: 0x4338ca, stripe: 0xc4b5fd, engine: 0x94a3b8 },
  NW: { id: 'liv-nw', airlineId: 'NW', body: 0xf1f5f9, tail: 0x0f172a, stripe: 0x38bdf8, engine: 0x94a3b8 },
  ML: { id: 'liv-ml', airlineId: 'ML', body: 0xecfdf5, tail: 0x047857, stripe: 0xa3e635, engine: 0x9ca3af },
};

/** 契約のない便（手動・ランダム生成）の塗装 */
export const DEFAULT_LIVERY: Livery = { id: 'liv-plain', airlineId: null, body: 0xe5e7eb, tail: 0x6b7280, stripe: 0x9ca3af, engine: 0x9ca3af };

export function liveryOf(airlineId: string | null | undefined): Livery {
  return (airlineId && LIVERIES[airlineId]) || DEFAULT_LIVERY;
}
