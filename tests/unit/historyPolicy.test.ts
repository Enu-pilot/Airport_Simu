import { describe, expect, it } from 'vitest';
import { retainHistoryDays } from '../../src/core/io/historyPolicy';

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('履歴の保持規則', () => {
  it('直近 7 日はすべて残す', () => {
    const r = retainHistoryDays(range(1, 7), 7);
    expect(r.keep.sort((a, b) => a - b)).toEqual(range(1, 7));
    expect(r.drop).toEqual([]);
  });
  it('古いものは 7 日ごとに 1 件（区間で最も新しい日）・最大 8 件、合計 15 件まで', () => {
    const r = retainHistoryDays(range(0, 100), 100);
    expect(r.keep.length).toBe(15);
    expect(r.keep.slice(0, 7)).toEqual(range(94, 100).reverse());
    // 経過 7〜13 日の区間 → 93 日（最も新しい）、次の区間 → 86、…
    expect(r.keep.slice(7)).toEqual([93, 86, 79, 72, 65, 58, 51, 44]);
    expect(r.keep.length + r.drop.length).toBe(101);
  });
  it('現在の日より先の履歴は捨てる（別の経過の残り）', () => {
    const r = retainHistoryDays([3, 4, 5, 6, 7], 4);
    expect(r.keep.sort()).toEqual([3, 4]);
    expect(r.drop.sort()).toEqual([5, 6, 7]);
  });
  it('履歴が少ない・飛び飛びでも規則どおり（重複は 1 件）', () => {
    const r = retainHistoryDays([2, 2, 20, 21, 30], 30);
    expect(r.keep.sort((a, b) => a - b)).toEqual([2, 21, 30]);
    expect(r.drop).toEqual([20]);
    expect(retainHistoryDays([], 5)).toEqual({ keep: [], drop: [] });
  });
});
