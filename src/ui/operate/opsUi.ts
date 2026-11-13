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
  | 'airlines'
  | 'goals';

export interface OpsUiState {
  /** 開いている大きなオーバーレイ（なければ null） */
  overlay: OverlayKey | null;
  /** 運航表: 出発 / 到着 / すべて、完了を隠す、折りたたみ、全列表示（tab-flights） */
  fidsFilter: 'all' | 'arrival' | 'departure';
  fidsHideDone: boolean;
  fidsCollapsed: boolean;
  fidsFull: boolean;
  /** 運航表: 直近の便だけ（コンパクト）/ 全件。位置はマップ左上からの px（null = 既定の右上）。閲覧環境の設定として localStorage に覚える */
  fidsCompact: boolean;
  fidsPos: { x: number; y: number } | null;
  /** 運航表の行メニューを開いている便の ID */
  fidsMenu: string | null;
  /** 下部の詳細を折りたたむ */
  detailCollapsed: boolean;
  /** アラートを全件展開する */
  alertsExpanded: boolean;
  /** 閉じたアラートのキー（保存しない） */
  dismissed: string[];
}

const FIDS_PREF_KEY = 'skyport.fids.v1';

/** 運航表の閲覧環境の設定（位置・コンパクト）を読む。壊れていても既定に戻すだけ */
function loadFidsPrefs(): Pick<OpsUiState, 'fidsCompact' | 'fidsPos'> {
  try {
    const raw = globalThis.localStorage?.getItem(FIDS_PREF_KEY);
    if (!raw) return { fidsCompact: false, fidsPos: null };
    const j = JSON.parse(raw) as { compact?: unknown; pos?: { x?: unknown; y?: unknown } | null };
    const pos = j.pos && Number.isFinite(j.pos.x) && Number.isFinite(j.pos.y) ? { x: Number(j.pos.x), y: Number(j.pos.y) } : null;
    return { fidsCompact: j.compact === true, fidsPos: pos };
  } catch {
    return { fidsCompact: false, fidsPos: null };
  }
}

export function saveFidsPrefs(): void {
  try {
    globalThis.localStorage?.setItem(FIDS_PREF_KEY, JSON.stringify({ compact: state.fidsCompact, pos: state.fidsPos }));
  } catch {
    // 保存できなくても表示には影響しない
  }
}

const initial = (): OpsUiState => ({
  overlay: null,
  fidsFilter: 'all',
  fidsHideDone: true,
  fidsCollapsed: false,
  fidsFull: false,
  ...loadFidsPrefs(),
  fidsMenu: null,
  detailCollapsed: false,
  alertsExpanded: false,
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
