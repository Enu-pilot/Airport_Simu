import { describe, expect, it } from 'vitest';
import { actions, editorStore } from '../../src/editor/store';

describe('UIデザイン更新 第2段階: 建設レンズの左パネル', () => {
  it('左パネルの初期タブは tools で、setBuildPanel で切り替わる（保存データには触らない）', () => {
    actions.setBuildPanel('tools');
    expect(editorStore.getState().buildPanel).toBe('tools');
    actions.setBuildPanel('facilities');
    expect(editorStore.getState().buildPanel).toBe('facilities');
    actions.setBuildPanel('inbox');
    expect(editorStore.getState().buildPanel).toBe('inbox');
    actions.setBuildPanel('tools');
    expect(editorStore.getState().buildPanel).toBe('tools');
  });

  it('同じタブへの setBuildPanel は状態を変えない', () => {
    actions.setBuildPanel('tools');
    const before = editorStore.getState();
    actions.setBuildPanel('tools');
    expect(editorStore.getState()).toBe(before);
  });

  it('タブ切り替えはレンズやレイアウトに影響しない', () => {
    const layoutBefore = editorStore.getState().history.present;
    const lensBefore = editorStore.getState().lens;
    actions.setBuildPanel('inbox');
    expect(editorStore.getState().history.present).toBe(layoutBefore);
    expect(editorStore.getState().lens).toBe(lensBefore);
    actions.setBuildPanel('tools');
  });
});
