import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, createHistory, redo, undo } from '../../src/core/editor/history';
import { placeFacility } from '../../src/core/layout/operations';
import { emptyLayout, must } from './helpers';

describe('Undo / Redo', () => {
  it('commit → undo → redo', () => {
    let h = createHistory('a');
    h = commit(h, 'b');
    h = commit(h, 'c');
    expect(h.present).toBe('c');
    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);
    h = undo(h);
    expect(h.present).toBe('a');
    h = redo(h);
    expect(h.present).toBe('b');
    expect(canRedo(h)).toBe(true);
  });

  it('Undo 後に新しい操作をすると Redo 履歴は破棄される', () => {
    let h = commit(commit(createHistory(1), 2), 3);
    h = undo(h);
    h = commit(h, 4);
    expect(h.present).toBe(4);
    expect(canRedo(h)).toBe(false);
    expect(undo(h).present).toBe(2);
  });

  it('履歴は上限件数で古いものから捨てる', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 10; i++) h = commit(h, i, 3);
    expect(h.past).toEqual([7, 8, 9]);
  });

  it('レイアウト操作を取り消すと元のレイアウトに戻る（削除の誤操作の復元）', () => {
    const base = emptyLayout();
    const placed = must(placeFacility(base, 'tower', { x: 5, y: 5 }));
    let h = commit(createHistory(base), placed.layout);
    expect(Object.keys(h.present.facilities)).toHaveLength(1);
    h = undo(h);
    expect(h.present).toBe(base);
    expect(Object.keys(h.present.facilities)).toHaveLength(0);
    h = redo(h);
    expect(h.present.facilities[placed.created[0]!]?.kind).toBe('tower');
  });
});
