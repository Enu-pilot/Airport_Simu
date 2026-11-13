import { useSyncExternalStore } from 'react';

/**
 * 運航モードの画面の状態（開いているオーバーレイ・運航表の表示など）。
 * 表示だけの状態で、シミュレーションにも保存データにも関係しない。運航モードを離れると初期化する。
 */
export type OverlayKey =
  | 'terminal'
  | 'ground'
  | 'baggage'
  | 'events'
  | 'disruptions'
  | 'plan'
  | 'finance'
  | 'access'
  | 'expansion'
  | 'analytics'
  | 'scenarios'
  | 'catalog'
  | 'project'
  | 'issues'
  | 'airlines';

export interface OpsUiState {
  /** 開いている大きなオーバーレイ（なければ null） */
  overlay: OverlayKey | null;
  /** 運航表: 出発 / 到着 / すべて、完了を隠す、折りたたみ、全列表示（tab-flights） */
  fidsFilter: 'all' | 'arrival' | 'departure';
  fidsHideDone: boolean;
  fidsCollapsed: boolean;
  fidsFull: boolean;
  /** 運航表の行メニューを開いている便の ID */
  fidsMenu: string | null;
  /** 下部の詳細を折りたたむ */
  detailCollapsed: boolean;
  /** 閉じたアラートのキー（保存しない） */
  dismissed: string[];
}

const initial = (): OpsUiState => ({
  overlay: null,
  fidsFilter: 'all',
  fidsHideDone: true,
  fidsCollapsed: false,
  fidsFull: false,
  fidsMenu: null,
  detailCollapsed: false,
  dismissed: [],
});

let state: OpsUiState = initial();
const listeners = new Set<() => void>();

function set(patch: Partial<OpsUiState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const opsUi = {
  get: (): OpsUiState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  patch: set,
  /** 同じキーをもう一度押すと閉じる */
  toggleOverlay(k: OverlayKey): void {
    set({ overlay: state.overlay === k ? null : k });
  },
  openOverlay(k: OverlayKey): void {
    set({ overlay: k });
  },
  closeOverlay(): void {
    if (state.overlay !== null) set({ overlay: null });
  },
  dismiss(key: string): void {
    if (!state.dismissed.includes(key)) set({ dismissed: [...state.dismissed, key] });
  },
  reset(): void {
    state = initial();
    for (const l of listeners) l();
  },
};

export function useOpsUi<T>(select: (s: OpsUiState) => T): T {
  return useSyncExternalStore(opsUi.subscribe, () => select(state));
}
