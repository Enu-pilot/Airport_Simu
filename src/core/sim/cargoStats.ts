import type { SimState } from './types';

/**
 * 貨物の実績（5-12）: その締め期間に実際に積み下ろしした量 (m3)。
 * 乗り遅れ内訳（missBreakdown）と同じ方式で、状態（SimState）には入れない:
 * 保存と運航フィンガープリントの対象にしないため WeakMap で保持する。
 * 締め処理（settleDay）が読み取って消すので、常に未締めの期間分だけを持つ。
 * 記録は貨物タスクの完了時にだけ行う（運航しなかった・ダイバードした便は数えない）。
 */
export interface CargoHandled {
  /** 到着便から荷下ろしした量 (m3) */
  unloadedM3: number;
  /** 出発便へ積み込んだ量 (m3) */
  loadedM3: number;
}

const store = new WeakMap<SimState, CargoHandled>();

/** 貨物タスクの完了時に、実際に扱った量を記録する */
export function recordCargoHandled(state: SimState, kind: 'unloaded' | 'loaded', volumeM3: number): void {
  if (!(volumeM3 > 0)) return;
  let record = store.get(state);
  if (!record) {
    record = { unloadedM3: 0, loadedM3: 0 };
    store.set(state, record);
  }
  if (kind === 'unloaded') record.unloadedM3 += volumeM3;
  else record.loadedM3 += volumeM3;
}

/** 締め処理用: 現在の記録を取り出して消す。記録がなければ undefined */
export function takeCargoHandled(state: SimState): CargoHandled | undefined {
  const record = store.get(state);
  if (!record) return undefined;
  store.delete(state);
  return record.unloadedM3 > 0 || record.loadedM3 > 0 ? record : undefined;
}
