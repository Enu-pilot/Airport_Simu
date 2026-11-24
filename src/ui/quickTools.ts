import { useSyncExternalStore } from 'react';
import { editorStore, type ToolId } from '../editor/store';
import { QUICK_BAR_SIZE } from '../editor/shortcuts';

/**
 * クイックバー（UX-3）: 最近使ったツールとピン留め。ブラウザの設定（localStorage）に保存し、プロジェクトには入れない。
 * 並び = ピン留め（ピンした順）→ 最近使った順（ピン留めを除く）の先頭 QUICK_BAR_SIZE 件。Shift+1〜6 で呼び出す。
 */
const KEY = 'skyport.quickTools.v1';
interface QuickState {
  recent: ToolId[];
  pinned: ToolId[];
}

function load(): QuickState {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { recent: [], pinned: [] };
    const v = JSON.parse(raw) as Partial<QuickState>;
    const list = (x: unknown): ToolId[] => (Array.isArray(x) ? x.filter((t): t is ToolId => typeof t === 'string') : []);
    return { recent: list(v.recent).slice(0, 12), pinned: list(v.pinned).slice(0, QUICK_BAR_SIZE) };
  } catch {
    return { recent: [], pinned: [] };
  }
}

let state: QuickState = load();
let slotsCache: ToolId[] = computeSlots(state);
const listeners = new Set<() => void>();

function computeSlots(s: QuickState): ToolId[] {
  return [...s.pinned, ...s.recent.filter((t) => !s.pinned.includes(t))].slice(0, QUICK_BAR_SIZE);
}

function commit(next: QuickState): void {
  state = next;
  slotsCache = computeSlots(state);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(state));
  } catch {
    // 保存できなくても表示は続ける
  }
  for (const l of listeners) l();
}

/** 「選択・移動」は常設なのでクイックバーには入れない */
const TRACKED = (t: ToolId): boolean => t !== 'select';

export const quickTools = {
  slots: (): readonly ToolId[] => slotsCache,
  isPinned: (t: ToolId): boolean => state.pinned.includes(t),
  noteUsed(t: ToolId): void {
    if (!TRACKED(t)) return;
    if (state.recent[0] === t) return;
    commit({ ...state, recent: [t, ...state.recent.filter((x) => x !== t)].slice(0, 12) });
  },
  togglePin(t: ToolId): void {
    if (!TRACKED(t)) return;
    const pinned = state.pinned.includes(t) ? state.pinned.filter((x) => x !== t) : [...state.pinned, t].slice(-QUICK_BAR_SIZE);
    commit({ ...state, pinned });
  },
  /** テスト用: 記録を消す */
  resetForTest(): void {
    commit({ recent: [], pinned: [] });
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useQuickSlots(): readonly ToolId[] {
  return useSyncExternalStore(quickTools.subscribe, quickTools.slots, quickTools.slots);
}

// ツールが切り替わるたびに「最近使った」に記録する（キー・ボタン・クイックバーのどこから選んでも同じ）
editorStore.subscribe((s, prev) => {
  if (s.tool !== prev.tool) quickTools.noteUsed(s.tool);
});
