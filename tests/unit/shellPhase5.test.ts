import { afterEach, describe, expect, it } from 'vitest';
import { hubConnectionRate, transferMissedEntries } from '../../src/ui/DayReview';
import { reviewUi } from '../../src/ui/shell/reviewUi';
import type { MissBreakdownEntry } from '../../src/core/sim/missBreakdown';

/**
 * UIデザイン更新 第5段階: 日報ドロワーとタイムライン連動。
 * - ドロワーのタブは「開くきっかけ」に同期し、手動選択は上書きされない。
 * - ハブ日報の追加表示は日報の既存フィールドだけから作る（接続成功率・乗継の乗り遅れ内訳）。
 * - タイムラインからの時間帯ジャンプは nonce 付きで保持される。
 */

afterEach(() => {
  reviewUi.reset();
});

describe('第5段階: ドロワーのタブ同期（reviewUi）', () => {
  it('履歴が開かれたら履歴タブになり、振り返りが閉じても履歴タブのまま', () => {
    reviewUi.syncDrawer({ historyOpen: false, reviewKey: null, hasReview: false });
    expect(reviewUi.get().tab).toBe('review');
    reviewUi.syncDrawer({ historyOpen: true, reviewKey: null, hasReview: false });
    expect(reviewUi.get().tab).toBe('history');
  });

  it('新しい振り返りが表示対象になったら振り返りタブになる', () => {
    reviewUi.syncDrawer({ historyOpen: true, reviewKey: null, hasReview: false });
    expect(reviewUi.get().tab).toBe('history');
    reviewUi.syncDrawer({ historyOpen: true, reviewKey: 'view:3', hasReview: true });
    expect(reviewUi.get().tab).toBe('review');
  });

  it('手動のタブ選択は、きっかけの変化がない限り同期で上書きされない', () => {
    reviewUi.syncDrawer({ historyOpen: true, reviewKey: 'view:3', hasReview: true });
    reviewUi.setTab('history');
    // 同じ入力での再同期では手動選択を尊重する
    reviewUi.syncDrawer({ historyOpen: true, reviewKey: 'view:3', hasReview: true });
    expect(reviewUi.get().tab).toBe('history');
    reviewUi.setTab('review');
    reviewUi.syncDrawer({ historyOpen: true, reviewKey: 'view:3', hasReview: true });
    expect(reviewUi.get().tab).toBe('review');
  });

  it('振り返りが閉じて履歴だけが残ったら履歴タブへ戻る', () => {
    reviewUi.syncDrawer({ historyOpen: true, reviewKey: null, hasReview: false });
    reviewUi.syncDrawer({ historyOpen: true, reviewKey: 'view:3', hasReview: true });
    expect(reviewUi.get().tab).toBe('review');
    reviewUi.syncDrawer({ historyOpen: true, reviewKey: null, hasReview: false });
    expect(reviewUi.get().tab).toBe('history');
  });

  it('ライブの振り返り（締め直後）が始まったら振り返りタブになる', () => {
    reviewUi.syncDrawer({ historyOpen: false, reviewKey: null, hasReview: false });
    reviewUi.syncDrawer({ historyOpen: false, reviewKey: 'live:5', hasReview: true });
    expect(reviewUi.get().tab).toBe('review');
  });
});

describe('第5段階: タイムラインからの時間帯ジャンプ', () => {
  it('requestFocusHour は時間帯を保持し、同じ時間帯でも nonce が増える', () => {
    expect(reviewUi.get().focusHour).toBeNull();
    reviewUi.requestFocusHour(8);
    expect(reviewUi.get().focusHour).toBe(8);
    const n = reviewUi.get().focusNonce;
    reviewUi.requestFocusHour(8);
    expect(reviewUi.get().focusNonce).toBe(n + 1);
    reviewUi.requestFocusHour(17);
    expect(reviewUi.get().focusHour).toBe(17);
  });

  it('clearFocusHour で時間帯指定だけが消える（nonce は戻らない）', () => {
    reviewUi.requestFocusHour(8);
    const n = reviewUi.get().focusNonce;
    reviewUi.clearFocusHour();
    expect(reviewUi.get().focusHour).toBeNull();
    expect(reviewUi.get().focusNonce).toBe(n);
  });
});

describe('第5段階: ハブ日報の表示材料（日報の既存フィールドのみ）', () => {
  it('接続成功率は connected / spawned で、発生 0 の日は null（— 表示）', () => {
    expect(hubConnectionRate({ spawned: 200, connected: 150 })).toBe(0.75);
    expect(hubConnectionRate({ spawned: 0, connected: 0 })).toBeNull();
  });

  it('乗継の乗り遅れ内訳は transferSecurity / transferLate だけを順序どおり取り出す', () => {
    const entries: MissBreakdownEntry[] = [
      { category: 'checkIn', spotId: 'ta_1', count: 30 },
      { category: 'transferSecurity', spotId: 'ta_9', count: 12 },
      { category: 'walking', spotId: null, count: 5 },
      { category: 'transferLate', spotId: null, count: 7 },
    ];
    expect(transferMissedEntries(entries)).toEqual([entries[1], entries[3]]);
    expect(transferMissedEntries(undefined)).toEqual([]);
    expect(transferMissedEntries([])).toEqual([]);
  });
});
