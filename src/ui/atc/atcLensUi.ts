import { useSyncExternalStore } from 'react';

/**
 * ATC レンズの画面状態（UIデザイン更新 第6段階）。
 * 表示だけの状態で、ATC セッション（src/atc/store.ts）にも保存データにも関係しない
 * （reviewUi / opsUi と同じ流儀）。ATC のコア・セッション保存形式には触れない。
 * - savesOpen: 保存データボード（開始画面ボードと同じ受け皿）の開閉。
 *   セッションが無い間は開始画面ボードが保存一覧を兼ねるため、このボードはセッション中だけ開く。
 */
export interface AtcLensUiState {
  savesOpen: boolean;
}

const initial = (): AtcLensUiState => ({ savesOpen: false });

let state: AtcLensUiState = initial();
const listeners = new Set<() => void>();

function set(patch: Partial<AtcLensUiState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const atcLensUi = {
  get: (): AtcLensUiState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  openSaves(): void {
    if (!state.savesOpen) set({ savesOpen: true });
  },
  closeSaves(): void {
    if (state.savesOpen) set({ savesOpen: false });
  },
  reset(): void {
    state = initial();
    for (const l of listeners) l();
  },
};

export function useAtcLensUi<T>(select: (s: AtcLensUiState) => T): T {
  return useSyncExternalStore(atcLensUi.subscribe, () => select(state));
}
