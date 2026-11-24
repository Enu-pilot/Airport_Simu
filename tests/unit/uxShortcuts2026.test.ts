import { beforeEach, describe, expect, it } from 'vitest';
import { BUILD_OVERLAY_TOGGLES, OPERATE_OVERLAY_TOGGLES, QUICK_BAR_SIZE, TOOL_FOR_KEY, keyForTool, quickSlotForCode } from '../../src/editor/shortcuts';
import { buildShortcutRows, operateShortcutRows } from '../../src/ui/ShortcutHelp';
import { quickTools } from '../../src/ui/quickTools';

/** 操作性改善 UX-1〜3（docs/implementation/active/ui_usability_improvement_plan.md） */
describe('UX-1 ショートカット一覧は対応表（キー処理の正本）と一致する', () => {
  const keysOf = (groups: { rows: { keys: string }[] }[]) => groups.flatMap((g) => g.rows.map((r) => r.keys));
  it('建設: 全ツールキー・全レイヤキー・V・? が載る', () => {
    const keys = keysOf(buildShortcutRows());
    for (const k of Object.keys(TOOL_FOR_KEY)) expect(keys).toContain(k.toUpperCase());
    for (const t of BUILD_OVERLAY_TOGGLES) expect(keys).toContain(t.key.toUpperCase());
    expect(keys).toContain('V');
    expect(keys).toContain('?');
    expect(keys).toContain(`Shift+1〜${QUICK_BAR_SIZE}`);
  });
  it('運航: 速度 1〜5・全レイヤキー・Space が載る', () => {
    const keys = keysOf(operateShortcutRows());
    for (const k of ['1', '2', '3', '4', '5', 'Space']) expect(keys).toContain(k);
    for (const t of OPERATE_OVERLAY_TOGGLES) expect(keys).toContain(t.key.toUpperCase());
  });
});

describe('UX-2 ツールのキー表示', () => {
  it('keyForTool は割当ての逆引き（選択は V、割当てなしは null）', () => {
    for (const [k, t] of Object.entries(TOOL_FOR_KEY)) expect(keyForTool(t)).toBe(k);
    expect(keyForTool('select')).toBe('v');
    expect(keyForTool('facility:tower')).toBeNull();
  });
});

describe('UX-3 クイックバー', () => {
  beforeEach(() => quickTools.resetForTest());
  it('Shift+数字のコードは 1〜6 だけ（7 以上・数字以外は対象外）', () => {
    expect(quickSlotForCode('Digit1')).toBe(0);
    expect(quickSlotForCode('Digit6')).toBe(5);
    expect(quickSlotForCode('Digit7')).toBeNull();
    expect(quickSlotForCode('KeyA')).toBeNull();
  });
  it('最近使った順に並び、同じツールは先頭へ移る。選択ツールは入らない。最大 6 件', () => {
    for (const t of ['runway', 'taxiway', 'stand', 'select', 'taxiway'] as const) quickTools.noteUsed(t);
    expect(quickTools.slots()).toEqual(['taxiway', 'stand', 'runway']);
    for (const t of ['facility:tower', 'facility:hangar', 'facility:gate', 'facility:apron', 'road'] as const) quickTools.noteUsed(t);
    expect(quickTools.slots()).toHaveLength(QUICK_BAR_SIZE);
    expect(quickTools.slots()[0]).toBe('road');
  });
  it('ピン留めは先頭に固定され、最近使った順の重複は除く。もう一度でピンを外す', () => {
    quickTools.noteUsed('runway');
    quickTools.noteUsed('taxiway');
    quickTools.togglePin('runway');
    expect(quickTools.slots()).toEqual(['runway', 'taxiway']);
    quickTools.noteUsed('stand');
    expect(quickTools.slots()).toEqual(['runway', 'stand', 'taxiway']);
    quickTools.togglePin('runway');
    expect(quickTools.isPinned('runway')).toBe(false);
    expect(quickTools.slots()).toEqual(['stand', 'taxiway', 'runway']);
  });
});
