import type { SimState } from './types';

/**
 * リンクの時間帯別利用実績（5-03）。キーは予約と同じ ID（連絡設備はリンク ID、上下移動は `vertical:<エリアID>`）、
 * 値は時刻（0〜23）ごとの利用人数。締め処理が読み取って消すので、常に未締めの期間分だけを持つ。
 *
 * 状態（SimState）には入れない: 保存と運航フィンガープリントの対象にしないため、
 * 乗継統計の前回値と同じく WeakMap で保持する（ops.ts の hubStatsPrev と同じ方針）。
 */
const store = new WeakMap<SimState, Record<string, number[]>>();

export function recordLinkUsage(state: SimState, transportId: string, hourOfDay: number, count: number): void {
  let record = store.get(state);
  if (!record) {
    record = {};
    store.set(state, record);
  }
  const hours = record[transportId] ?? (record[transportId] = new Array(24).fill(0));
  hours[hourOfDay] = (hours[hourOfDay] ?? 0) + count;
}

export function unrecordLinkUsage(state: SimState, transportId: string, hourOfDay: number, count: number): void {
  const hours = store.get(state)?.[transportId];
  if (hours) hours[hourOfDay] = Math.max(0, (hours[hourOfDay] ?? 0) - count);
}

/** 締め処理用: 現在の記録を取り出して消す */
export function takeLinkUsage(state: SimState): Record<string, number[]> | undefined {
  const record = store.get(state);
  if (record) store.delete(state);
  return record;
}
