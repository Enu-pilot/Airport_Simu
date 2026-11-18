import type { SimState } from './types';

/**
 * 乗り遅れの詰まり箇所（ボトルネック）の分類。
 * 乗り遅れが確定した瞬間に、そのグループがどこで詰まっていたかを分類したもの。
 * 分類の判定根拠は passengers.ts の classifyMiss に置く。
 */
export type MissBottleneck =
  | 'checkIn' // チェックインの待ち/処理中
  | 'security' // 保安検査の待ち/処理中
  | 'emigration' // 出国審査の待ち/処理中
  | 'immigration' // 入国審査の待ち/処理中
  | 'customs' // 税関の待ち/処理中
  | 'transferSecurity' // 乗継保安検査の待ち/処理中
  | 'gate' // 搭乗口・待合で待機（搭乗待ち含む）
  | 'walking' // ターミナル内を移動中
  | 'bus' // ランプバス待ち/乗車中
  | 'access' // 空港へのアクセス中（鉄道・バス・道路・ポータル歩行）
  | 'transferLate' // 乗継時間の不足（手続き列の外で締切を迎えた乗継客、締切後の発生）
  | 'unreachable' // 到達不能
  | 'noGate' // ゲートなし
  | 'facilityClosed' // 施設閉鎖で待機
  | 'other'; // その他（手続き前の待機など）

export interface MissBreakdownEntry {
  category: MissBottleneck;
  /** 詰まったエリア/施設の ID（ターミナルエリア ID、ゲート施設 ID、アクセスの交通施設 ID）。特定できないときは null */
  spotId: string | null;
  /** 人数 */
  count: number;
}

/**
 * 乗り遅れ内訳の当日分（リンク利用実績 5-03 と同じ方式）。
 * 状態（SimState）には入れない: 保存と運航フィンガープリントの対象にしないため WeakMap で保持する。
 * 締め処理（settleDay）が読み取って消すので、常に未締めの期間分だけを持つ。
 */
const store = new WeakMap<SimState, Map<string, MissBreakdownEntry>>();

const keyOf = (category: MissBottleneck, spotId: string | null): string => `${category}|${spotId ?? ''}`;

/** 人数の多い順（同数は分類名順で決定的に） */
const sorted = (entries: MissBreakdownEntry[]): MissBreakdownEntry[] =>
  entries.sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0) || ((a.spotId ?? '') < (b.spotId ?? '') ? -1 : 1));

export function recordMissBreakdown(state: SimState, category: MissBottleneck, spotId: string | null, count: number): void {
  if (count <= 0) return;
  let record = store.get(state);
  if (!record) {
    record = new Map();
    store.set(state, record);
  }
  const key = keyOf(category, spotId);
  const entry = record.get(key) ?? { category, spotId, count: 0 };
  entry.count += count;
  record.set(key, entry);
}

/** 運航中の表示用: 現在の集計期間分を消さずに読む */
export function peekMissBreakdown(state: SimState): MissBreakdownEntry[] {
  const record = store.get(state);
  if (!record) return [];
  return sorted([...record.values()].map((e) => ({ ...e })));
}

/** 締め処理用: 現在の記録を取り出して消す */
export function takeMissBreakdown(state: SimState): MissBreakdownEntry[] | undefined {
  const record = store.get(state);
  if (!record) return undefined;
  store.delete(state);
  const entries = sorted([...record.values()]);
  return entries.length > 0 ? entries : undefined;
}
