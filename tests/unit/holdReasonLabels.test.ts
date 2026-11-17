import { describe, expect, it } from 'vitest';
import { HOLD_REASON_EXPLANATION, HOLD_REASON_LABEL } from '../../src/i18n/ja';

describe('2-06: 区間ごとの走行の待機理由の文言', () => {
  it('blockFull・opposingTraffic・runwayQueue は日本語の名前と説明を持つ。既存の理由と重複しない', () => {
    const reasons = ['blockFull', 'opposingTraffic', 'runwayQueue'] as const;
    for (const r of reasons) {
      expect(HOLD_REASON_LABEL[r]).toMatch(/[぀-ヿ一-鿿]/);
      expect(HOLD_REASON_EXPLANATION[r]).toMatch(/[぀-ヿ一-鿿]/);
    }
    expect(HOLD_REASON_LABEL.blockFull).toBe('前の区間が満杯');
    const labels = Object.values(HOLD_REASON_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
