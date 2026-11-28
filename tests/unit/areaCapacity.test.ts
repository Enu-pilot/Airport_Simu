import { describe, expect, it } from 'vitest';
import { areaProcessingPerHour, areaServerCount, isProcessingArea } from '../../src/core/terminal/capacity';

describe('エリアの処理能力（表示用ヘルパー）', () => {
  it('処理系の判定は docs/12 の既定処理時間がある種別だけ', () => {
    // トイレは設備数（fixtures）と既定処理時間 90 秒を持つ処理系（docs/12「トイレ: 設備数」、PR #52）
    for (const k of ['checkIn', 'security', 'emigration', 'immigration', 'customs', 'transferSecurity', 'restroom'] as const) {
      expect(isProcessingArea(k)).toBe(true);
    }
    for (const k of ['waiting', 'hall', 'departureLobby', 'arrivalCorridor', 'baggageClaim', 'entrance'] as const) {
      expect(isProcessingArea(k)).toBe(false);
    }
  });

  it('窓口数は運航側と同じ優先順（counters → booths → lanes → fixtures → capacity）', () => {
    expect(areaServerCount({ counters: 3, lanes: 9 })).toBe(3);
    expect(areaServerCount({ booths: 2 })).toBe(2);
    expect(areaServerCount({ lanes: 4 })).toBe(4);
    expect(areaServerCount({ fixtures: 5 })).toBe(5);
    expect(areaServerCount({ capacity: 6 })).toBe(6);
    expect(areaServerCount({})).toBe(0);
    expect(areaServerCount({ counters: -2 })).toBe(0);
  });

  it('処理能力 = 窓口数 × 3600 ÷ 処理秒数', () => {
    // チェックイン既定 50 秒、カウンター 4 → 288 人/時
    expect(areaProcessingPerHour('checkIn', { counters: 4 })).toBe(288);
    // 保安検査既定 15 秒、レーン 2 → 480 人/時
    expect(areaProcessingPerHour('security', { lanes: 2 })).toBe(480);
    // 個別設定の処理時間が優先される
    expect(areaProcessingPerHour('checkIn', { counters: 3, serviceSecPerPax: 20 })).toBe(540);
    // 窓口がなければ 0
    expect(areaProcessingPerHour('security', {})).toBe(0);
  });
});
