import { beforeEach, describe, expect, it } from 'vitest';
import { canUndo, commit, createHistory } from '../../src/core/editor/history';
import type { AirportLayout } from '../../src/core/model/types';
import { actions, editorStore } from '../../src/editor/store';
import { emptyLayout } from './helpers';

/**
 * ターミナル専用設計 Workspace（5-18 T2）の store 境界:
 * 開く/閉じるは UI 状態だけで、history・charges・Undo 可能性を壊さない。
 * 表示階は対象ターミナルの有効な階へクランプされる。運航中は開けない。
 */
function fixture(): AirportLayout {
  const layout = emptyLayout(120, 60);
  layout.facilities['tA'] = { id: 'tA', kind: 'terminal', name: 'A', origin: { x: 10, y: 10 }, w: 20, h: 8, rotation: 0, buildState: 'operational', props: { levels: 2 } };
  layout.facilities['tB'] = { id: 'tB', kind: 'terminal', name: 'B', origin: { x: 50, y: 10 }, w: 20, h: 8, rotation: 0, buildState: 'operational', props: { levels: 1 } };
  layout.facilities['tC'] = { id: 'tC', kind: 'terminal', name: 'C', origin: { x: 90, y: 10 }, w: 10, h: 8, rotation: 0, buildState: 'operational', props: { levels: 1 } };
  const area = (id: string, terminalId: string, level: number) => {
    layout.terminalAreas[id] = {
      id, terminalId, level, kind: 'hall', name: '', origin: { x: 12, y: 12 }, w: 4, h: 2, zone: 'landside', props: {},
    };
  };
  area('aB1', 'tA', -1);
  area('a1F', 'tA', 0);
  // tC は階数 1 なのに level 2 のエリアを持つ（壊れたデータでのクランプ確認用）
  area('aBad', 'tC', 2);
  return layout;
}

beforeEach(() => {
  editorStore.setState({
    history: createHistory(fixture()),
    charges: { past: [], future: [] },
    terminalWorkspace: null,
    selection: null,
    mode: 'build',
    tool: 'select',
    draft: null,
    interiorLevel: 0,
    mapLevel: 0,
  });
});

describe('ターミナル設計 Workspace の開閉（store）', () => {
  it('開くと対象・選択・内部表示が移り、history と charges は不変', () => {
    const before = editorStore.getState();
    actions.openTerminalWorkspace('tA');
    const after = editorStore.getState();
    expect(after.terminalWorkspace).toEqual({ terminalId: 'tA' });
    expect(after.selection).toBe('tA');
    expect(after.overlays.interior).toBe(true);
    expect(after.history).toBe(before.history);
    expect(after.charges).toBe(before.charges);
    expect(after.tool).toBe(before.tool);
  });

  it('表示階は既存エリアのある最小の階へクランプされる（tA は B1 から）', () => {
    actions.openTerminalWorkspace('tA');
    const s = editorStore.getState();
    expect(s.interiorLevel).toBe(-1);
    expect(s.mapLevel).toBe(-1);
  });

  it('エリアの無いターミナルは 1F（0）、範囲外のエリア階は階数の範囲へクランプ', () => {
    actions.openTerminalWorkspace('tB');
    expect(editorStore.getState().interiorLevel).toBe(0);
    actions.openTerminalWorkspace('tC');
    expect(editorStore.getState().interiorLevel).toBe(0);
  });

  it('閉じると対象だけ外れ、選択・表示階・history は保持される', () => {
    actions.openTerminalWorkspace('tA');
    actions.select('a1F');
    const before = editorStore.getState();
    actions.closeTerminalWorkspace();
    const after = editorStore.getState();
    expect(after.terminalWorkspace).toBeNull();
    expect(after.selection).toBe('a1F');
    expect(after.interiorLevel).toBe(before.interiorLevel);
    expect(after.history).toBe(before.history);
    expect(after.charges).toBe(before.charges);
  });

  it('Undo スタックは開閉で変わらない', () => {
    const layout = fixture();
    const history = commit(createHistory(layout), { ...layout });
    editorStore.setState({ history });
    expect(canUndo(editorStore.getState().history)).toBe(true);
    actions.openTerminalWorkspace('tA');
    actions.closeTerminalWorkspace();
    const s = editorStore.getState();
    expect(s.history).toBe(history);
    expect(canUndo(s.history)).toBe(true);
  });

  it('運航中は開けない', () => {
    editorStore.setState({ mode: 'operate' });
    actions.openTerminalWorkspace('tA');
    expect(editorStore.getState().terminalWorkspace).toBeNull();
  });

  it('ターミナルでない施設・存在しない ID では開けない', () => {
    actions.openTerminalWorkspace('missing');
    expect(editorStore.getState().terminalWorkspace).toBeNull();
  });
});
