import { useSyncExternalStore } from 'react';

/**
 * 日報ドロワーの画面状態（UIデザイン更新 第5段階）。
 * 表示だけの状態で、シミュレーションにも保存データにも関係しない（opsUi と同じ流儀）。
 * - tab: ドロワーのタブ（振り返り／履歴）。開くきっかけ（履歴を開く・振り返りを開く）に
 *   合わせて切り替わり、以降はプレイヤーのタブ選択を尊重する。
 * - focusHour: タイムラインから指定された時間帯。日報の工程ピーク行の強調とスクロールに使う。
 */
export type ReviewDrawerTab = 'review' | 'history';

export interface ReviewUiState {
  tab: ReviewDrawerTab;
  focusHour: number | null;
  focusNonce: number;
}

const initial = (): ReviewUiState => ({ tab: 'review', focusHour: null, focusNonce: 0 });

let state: ReviewUiState = initial();
const listeners = new Set<() => void>();

function set(patch: Partial<ReviewUiState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

// ドロワーのタブ自動切替の判定材料（前回同期時の値）。手動選択を上書きしないために保持する
let prevHistoryOpen = false;
let prevReviewKey: string | null = null;

export const reviewUi = {
  get: (): ReviewUiState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** プレイヤーのタブ選択 */
  setTab(tab: ReviewDrawerTab): void {
    if (state.tab !== tab) set({ tab });
  },
  /**
   * ドロワーを開くきっかけの変化にタブを同期する（コンポーネントの effect から毎回呼ぶ）。
   * - 履歴が開かれた（historyOpen の立ち上がり）→ 履歴タブ
   * - 新しい振り返りが表示対象になった（reviewKey の変化）→ 振り返りタブ
   * - 振り返りが閉じて履歴だけが残った → 履歴タブ
   * それ以外では手動選択を変えない。
   */
  syncDrawer(input: { historyOpen: boolean; reviewKey: string | null; hasReview: boolean }): void {
    let tab = state.tab;
    if (input.historyOpen && !prevHistoryOpen) tab = 'history';
    else if (input.reviewKey !== null && input.reviewKey !== prevReviewKey) tab = 'review';
    else if (!input.hasReview && input.historyOpen) tab = 'history';
    prevHistoryOpen = input.historyOpen;
    prevReviewKey = input.reviewKey;
    if (tab !== state.tab) set({ tab });
  },
  /** タイムラインの時間帯から日報の該当行へジャンプする指定（nonce で再指定でも effect を起こす） */
  requestFocusHour(hour: number): void {
    set({ focusHour: hour, focusNonce: state.focusNonce + 1 });
  },
  /** ドロワーを閉じたら時間帯指定を消す（次に開いたとき意図せずスクロールしないため） */
  clearFocusHour(): void {
    if (state.focusHour !== null) set({ focusHour: null });
  },
  reset(): void {
    state = initial();
    prevHistoryOpen = false;
    prevReviewKey = null;
    for (const l of listeners) l();
  },
};

export function useReviewUi<T>(select: (s: ReviewUiState) => T): T {
  // 第3引数（サーバー側スナップショット）はクライアント挙動を変えない。SSR 描画でも壊れないために渡す
  return useSyncExternalStore(reviewUi.subscribe, () => select(state), () => select(state));
}
