import { afterEach, describe, expect, it } from 'vitest';
import { OPS_NAV } from '../../src/i18n/ja';
import { OPS_BOARD_KEYS, overlayLabel } from '../../src/ui/operate/DetailOverlay';
import { opsUi } from '../../src/ui/operate/opsUi';

/**
 * UIデザイン更新 第4段階: 運航レンズ。
 * - 運航ボード（従来の大きなオーバーレイのボード化）は opsUi の overlay 状態をそのまま使う。
 *   開閉・トグル・リセットの意味が従来どおりであることを担保する。
 * - ボードで開ける全キーに、運航ナビ（OPS_NAV）の表示名と中身が対応していることを担保する。
 */

afterEach(() => {
  opsUi.reset();
});

describe('第4段階: 運航ボードの状態（opsUi）', () => {
  it('openOverlay / closeOverlay で開閉し、同じキーのトグルで閉じる', () => {
    expect(opsUi.get().overlay).toBeNull();
    opsUi.openOverlay('terminal');
    expect(opsUi.get().overlay).toBe('terminal');
    opsUi.toggleOverlay('ground');
    expect(opsUi.get().overlay).toBe('ground');
    opsUi.toggleOverlay('ground');
    expect(opsUi.get().overlay).toBeNull();
    opsUi.openOverlay('events');
    opsUi.closeOverlay();
    expect(opsUi.get().overlay).toBeNull();
  });

  it('開いていないときの closeOverlay は状態を変えない', () => {
    const before = opsUi.get();
    opsUi.closeOverlay();
    expect(opsUi.get()).toBe(before);
  });

  it('運航を離れるときの reset でボードが閉じ、詳細の畳み状態も初期化される', () => {
    opsUi.openOverlay('finance');
    opsUi.patch({ detailCollapsed: true });
    opsUi.reset();
    expect(opsUi.get().overlay).toBeNull();
    expect(opsUi.get().detailCollapsed).toBe(false);
  });

  it('詳細の畳み（右インスペクタ化後も同じ状態キー）', () => {
    expect(opsUi.get().detailCollapsed).toBe(false);
    opsUi.patch({ detailCollapsed: true });
    expect(opsUi.get().detailCollapsed).toBe(true);
  });
});

describe('第4段階: 運航ボードのキーと表示名', () => {
  it('ボードの全キーに運航ナビの表示名がある', () => {
    for (const key of OPS_BOARD_KEYS) {
      expect(overlayLabel(key)).not.toBe(key);
    }
  });

  it('運航ナビの項目は、運航表（flights: マップ上の切替）かボードのキーのどちらかに必ず対応する', () => {
    const boardKeys = new Set<string>(OPS_BOARD_KEYS);
    for (const [k] of OPS_NAV) {
      expect(k === 'flights' || boardKeys.has(k)).toBe(true);
    }
    // ボード側にだけあるキーはない（ナビから到達できないパネルを作らない）
    const navKeys = new Set(OPS_NAV.map(([k]) => k));
    for (const key of OPS_BOARD_KEYS) {
      expect(navKeys.has(key)).toBe(true);
    }
  });
});
