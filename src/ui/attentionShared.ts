import { buildAttentionItems, type AttentionItem } from '../core/attention';
import { composeCapabilityReadings } from '../core/capability';
import type { CompanyState } from '../core/economy/company';
import type { AirportLayout } from '../core/model/types';
import type { LayoutAnalysis } from '../core/validation/validate';
import { editorStore } from '../editor/store';
import { opsInboxAttentionFromSim } from './operate/alerts';

/**
 * 要対応の項目（検証・能力の状態・運航アラート）の画面間共有（性能改善 第8弾）。
 * 建設パネルの要対応バッジ・レールの要対応バッジ・要対応の一覧の 3 か所が、運航中は画面更新（uiVersion）のたびに
 * 同じ入力で buildAttentionItems を計算していた。入力（レイアウト・検証結果・会社・運航の参照と時刻・uiVersion）が
 * 同じなら結果も同じなので、最後の 1 件だけを覚えて使い回す。返す配列は共有なので呼び出し側は変更しないこと。
 */
let memo: { layout: AirportLayout; analysis: LayoutAnalysis; company: CompanyState; uiVersion: number; sim: unknown; now: number | null; items: AttentionItem[] } | null = null;

export function sharedAttentionItems(layout: AirportLayout, analysis: LayoutAnalysis, company: CompanyState, uiVersion: number): AttentionItem[] {
  const sim = editorStore.getState().ops?.sim;
  const now = sim?.state.now ?? null;
  if (memo && memo.layout === layout && memo.analysis === analysis && memo.company === company && memo.uiVersion === uiVersion && memo.sim === sim && memo.now === now) return memo.items;
  const items = buildAttentionItems({
    layout,
    analysis,
    company,
    capabilities: composeCapabilityReadings(layout, sim?.state),
    opsAlerts: opsInboxAttentionFromSim(sim, company, uiVersion),
  });
  memo = { layout, analysis, company, uiVersion, sim, now, items };
  return items;
}
