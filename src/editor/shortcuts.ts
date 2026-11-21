import type { SizeClass } from '../core/model/types';
import type { Overlays, ToolId } from './store';

/**
 * キーボードショートカットの純粋な対応表（仕様の正本は docs/06 §4.1.1）。
 * DOM・ストアに依存しない判定だけを持ち、実際の状態変更は input.ts が行う。
 * キーは input.ts が小文字化した文字列（KeyInfo.key を toLowerCase したもの）で受ける。
 */

/**
 * 数字キー → 表示階（絶対地図階層）。階ボタン（B3〜4F、FLOOR_SELECTOR_LEVELS）と同一範囲で、
 * キーボードの数字段に B3・B2・B1・1F・2F・3F・4F を 8・9・0・1・2・3・4 の順に連続配置する。
 * 建物内階 = 地図階層 + 1（floorDisplay の換算）なので、数字キーの数字は 1F〜4F では階そのものになる。
 */
export const LEVEL_FOR_DIGIT_KEY: Readonly<Record<string, number>> = {
  '8': -3, // B3F
  '9': -2, // B2F
  '0': -1, // B1F
  '1': 0, // 1F
  '2': 1, // 2F
  '3': 2, // 3F
  '4': 3, // 4F
};

/** 数字キーに対応する表示階。割り当てのないキー（5〜7 など）は null */
export function levelForDigitKey(key: string): number | null {
  return LEVEL_FOR_DIGIT_KEY[key] ?? null;
}

/** サイズキー（S/M/L/F）。F は最大段階（Full）の別名キー */
export type SizeKey = 's' | 'm' | 'l' | 'f';

export function sizeKeyOf(key: string): SizeKey | null {
  return key === 's' || key === 'm' || key === 'l' || key === 'f' ? key : null;
}

/** サイズキーの位置（0 = 最小 … 1 = 最大）。段階への換算に使う */
const SIZE_KEY_POSITION: Record<SizeKey, number> = { s: 0, m: 1 / 3, l: 2 / 3, f: 1 };

/**
 * 段階リスト（昇順）の中からサイズキーに対応する段階の添字を返す一般規則:
 * S は最小、F は最大、M / L はその間を 1/3・2/3 の位置で選ぶ（切り上げ）。
 * - 3 段階では S/M/L が 1 対 1 に対応し、F は最大（L）の別名になる
 * - 4 段階では S/M/L/F が 1 対 1 に対応する
 * - 2 段階では S が最小、M/L/F が最大に倒れる
 */
export function sizeStageIndex(sizeKey: SizeKey, stageCount: number): number {
  if (stageCount <= 1) return 0;
  return Math.min(stageCount - 1, Math.ceil(SIZE_KEY_POSITION[sizeKey] * (stageCount - 1)));
}

/** SizeClass（S/M/L の 3 段階）への換算 */
export const SIZE_CLASS_STAGES: readonly SizeClass[] = ['S', 'M', 'L'];
export function sizeClassForKey(sizeKey: SizeKey): SizeClass {
  return SIZE_CLASS_STAGES[sizeStageIndex(sizeKey, SIZE_CLASS_STAGES.length)]!;
}

/** 滑走路の舗装幅（30/45/60m の 3 段階。RUNWAY_WIDTH_CLASS の S/M/L 級に対応）への換算 */
export const RUNWAY_WIDTH_STAGES: readonly (30 | 45 | 60)[] = [30, 45, 60];
export function runwayWidthForKey(sizeKey: SizeKey): 30 | 45 | 60 {
  return RUNWAY_WIDTH_STAGES[sizeStageIndex(sizeKey, RUNWAY_WIDTH_STAGES.length)]!;
}

/** サイズ変更の対象になるツールオプション（現在のツール文脈で決まる）。対象外のツールは null */
export type SizeOptionTarget =
  | { option: 'taxiWidth'; value: SizeClass }
  | { option: 'standSize'; value: SizeClass }
  | { option: 'runwayWidth'; value: 30 | 45 | 60 };

export function sizeOptionForTool(tool: ToolId, sizeKey: SizeKey): SizeOptionTarget | null {
  switch (tool) {
    case 'taxiway':
      return { option: 'taxiWidth', value: sizeClassForKey(sizeKey) };
    case 'stand':
      return { option: 'standSize', value: sizeClassForKey(sizeKey) };
    case 'runway':
      return { option: 'runwayWidth', value: runwayWidthForKey(sizeKey) };
    default:
      return null;
  }
}

/** ツール切替キー（建設モード）。頭文字が既存キーと衝突しない主要ツールだけに割り当てる */
export const TOOL_FOR_KEY: Readonly<Record<string, ToolId>> = {
  t: 'taxiway', // Taxiway
  p: 'stand', // Parking stand
};

/** キーに対応するツール。割り当てのないキーは null */
export function toolForKey(key: string): ToolId | null {
  return TOOL_FOR_KEY[key] ?? null;
}

/** 表示階を「全レイヤ」にするキー（建設モード。setMapLevel('all') で、配置先の階は維持される） */
export const ALL_LAYERS_KEY = 'a';

/** 表示レイヤ（オーバーレイ）切替の対応。label はレイヤーポップオーバー（Rail）の表示名と一致させる */
export interface OverlayToggle {
  key: string;
  overlay: keyof Overlays;
  label: string;
}

/** 両モード共通のレイヤ切替 */
const COMMON_OVERLAY_TOGGLES: readonly OverlayToggle[] = [
  { key: 'g', overlay: 'grid', label: 'グリッド' },
  { key: 'i', overlay: 'interior', label: 'ターミナル内部' },
  { key: 'n', overlay: 'network', label: '論理ネットワーク・予約' },
  { key: 'e', overlay: 'issues', label: 'エラー表示' },
  { key: 'b', overlay: 'buildable', label: '建設不可エリア' },
  { key: 'c', overlay: 'congestion', label: '混雑マップ' },
];

/** 建設モードのレイヤ切替 */
export const BUILD_OVERLAY_TOGGLES: readonly OverlayToggle[] = [...COMMON_OVERLAY_TOGGLES];

/**
 * 運航モードのレイヤ切替。共通分に、運航中だけ意味を持つ地図注記（PR #76 で復活した表示レイヤ）を加える。
 * 数字キー（建設=階 / 運航=速度）と同じく、モードで意味が変わる割当てがある（P: 建設=スポットツール / 運航=バスの人数）。
 */
export const OPERATE_OVERLAY_TOGGLES: readonly OverlayToggle[] = [
  ...COMMON_OVERLAY_TOGGLES,
  { key: 'f', overlay: 'flightNames', label: '便名' },
  { key: 'p', overlay: 'busPax', label: 'バスの人数' },
  { key: 'k', overlay: 'cargoCounts', label: '貨物数' },
  { key: 'd', overlay: 'daylight', label: '昼夜表現' },
];

/** モード別のレイヤ切替対応。割り当てのないキーは null */
export function overlayToggleForKey(mode: 'build' | 'operate', key: string): OverlayToggle | null {
  const table = mode === 'operate' ? OPERATE_OVERLAY_TOGGLES : BUILD_OVERLAY_TOGGLES;
  return table.find((t) => t.key === key) ?? null;
}

/** レイヤに対応する切替キー（UI のキー表示用）。割り当てのないレイヤは null */
export function keyForOverlayToggle(mode: 'build' | 'operate', overlay: keyof Overlays): string | null {
  const table = mode === 'operate' ? OPERATE_OVERLAY_TOGGLES : BUILD_OVERLAY_TOGGLES;
  return table.find((t) => t.overlay === overlay)?.key ?? null;
}

/** 表示階に対応する数字キー（UI のキー表示用）。割り当てのない階は null */
export function digitKeyForLevel(level: number): string | null {
  return Object.entries(LEVEL_FOR_DIGIT_KEY).find(([, v]) => v === level)?.[0] ?? null;
}
