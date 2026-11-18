import type { SimState } from './types';

export interface PortalUsageEntry {
  portalId: string;
  /** 入場方向（交通施設→ターミナル）の通過人数 */
  enter: number;
  /** 退出方向（ターミナル→交通施設）の通過人数 */
  exit: number;
}

/**
 * Portal 通過人数（5-16 T8）。ポータル区間を開始したグループの人数を方向別に数える。
 * リンク利用実績（5-03）と同じく SimState には入れない: 保存と運航フィンガープリントの
 * 対象にしないため WeakMap で保持する。締め処理が読み取って消すので、常に未締めの期間分だけを持つ。
 */
const store = new WeakMap<SimState, Map<string, PortalUsageEntry>>();

export function recordPortalPassage(state: SimState, portalId: string, phase: 'enter' | 'exit', count: number): void {
  if (count <= 0) return;
  let record = store.get(state);
  if (!record) {
    record = new Map();
    store.set(state, record);
  }
  const entry = record.get(portalId) ?? { portalId, enter: 0, exit: 0 };
  entry[phase] += count;
  record.set(portalId, entry);
}

/** 運航中の表示・検証用: 現在の集計期間分を消さずに読む（ポータル ID 順で決定的に） */
export function peekPortalUsage(state: SimState): PortalUsageEntry[] {
  const record = store.get(state);
  if (!record) return [];
  return [...record.values()].map((e) => ({ ...e })).sort((a, b) => (a.portalId < b.portalId ? -1 : 1));
}

/** 締め処理用: 現在の記録を取り出して消す */
export function takePortalUsage(state: SimState): PortalUsageEntry[] | undefined {
  const record = store.get(state);
  if (!record) return undefined;
  store.delete(state);
  const entries = [...record.values()].map((e) => ({ ...e })).sort((a, b) => (a.portalId < b.portalId ? -1 : 1));
  return entries.length > 0 ? entries : undefined;
}
