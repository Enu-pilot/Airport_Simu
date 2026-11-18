import { describe, expect, it } from 'vitest';
import { PROP_LABEL, propLabel } from '../../src/i18n/ja';

/**
 * プロパティラベルの種別上書き（2026-11-18 表示バグ修正）:
 * 'level' は鉄道駅では地図階層、管制塔では管制塔レベル（1〜3）と意味が異なる。
 * 共通ラベルのままだと管制塔にも駅用の「階層（地上0・…）」が出てしまっていた。
 */
describe('propLabel: 種別ごとのラベル上書き', () => {
  it('管制塔の level は「管制塔レベル」と表示される', () => {
    expect(propLabel('tower', 'level')).toBe('管制塔レベル（1〜3）');
    expect(propLabel('tower', 'level')).not.toContain('地上0');
  });
  it('鉄道駅の level は従来の階層ラベルのまま', () => {
    expect(propLabel('railStation', 'level')).toBe(PROP_LABEL.level);
    expect(propLabel('railStation', 'level')).toContain('階層');
  });
  it('上書きのないキーは共通ラベル、未知のキーはキー名そのもの', () => {
    expect(propLabel('tower', 'rooms')).toBe(PROP_LABEL.rooms);
    expect(propLabel('terminal', 'checkInCounters')).toBe(PROP_LABEL.checkInCounters);
    expect(propLabel('tower', 'unknownKey')).toBe('unknownKey');
  });
});
