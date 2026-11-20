import { describe, expect, it } from 'vitest';
import { createHistory } from '../../../src/core/editor/history';
import { placeFacility } from '../../../src/core/layout/operations';
import { actions, editorStore } from '../../../src/editor/store';
import { computeOp } from '../../../src/editor/tools';
import type { AirportLayout } from '../../../src/core/model/types';
import { emptyLayout, must } from '../helpers';

/**
 * 建物の内外で表示階を一致させる（表示階の一元化）:
 * - store の mapLevel と interiorLevel は数値のとき常に同期する
 * - エリア配置は表示階（絶対階層）を対象ターミナルの建物内階に変換して渡す
 */
describe('表示階の同期（store）', () => {
  it('地図の階層を変えると内部の表示階も同じ値になる', () => {
    actions.setMapLevel(2);
    expect(editorStore.getState().mapLevel).toBe(2);
    expect(editorStore.getState().interiorLevel).toBe(2);
    expect(editorStore.getState().options.roadLevel).toBe(2);
  });
  it('内部の階を変えると地図の階層も同じ値になる', () => {
    actions.setInteriorLevel(-1);
    expect(editorStore.getState().interiorLevel).toBe(-1);
    expect(editorStore.getState().mapLevel).toBe(-1);
    expect(editorStore.getState().options.roadLevel).toBe(-1);
    expect(editorStore.getState().overlays.interior).toBe(true);
  });
  it('全レイヤ表示では内部の階を保持し、内部の階を変えると地図はその数値に切り替わる', () => {
    actions.setInteriorLevel(-1);
    actions.setMapLevel('all');
    expect(editorStore.getState().mapLevel).toBe('all');
    expect(editorStore.getState().interiorLevel).toBe(-1);
    expect(editorStore.getState().options.roadLevel).toBe(-1);
    actions.setInteriorLevel(1);
    expect(editorStore.getState().mapLevel).toBe(1);
    expect(editorStore.getState().interiorLevel).toBe(1);
  });
});

describe('エリア配置の階変換（表示階 − ターミナルの地図階層）', () => {
  // 高架 2 階（mapLevel 2）・3 層のターミナル
  function elevatedTerminal(): AirportLayout {
    return must(placeFacility(emptyLayout(), 'terminal', { x: 10, y: 10 }, { w: 12, h: 8, props: { levels: 3 }, mapLevel: 2 })).layout;
  }
  function opAt(layout: AirportLayout, displayLevel: number) {
    const base = editorStore.getState();
    const state = {
      tool: 'area:waiting' as const,
      options: base.options,
      hover: { x: 12, y: 12 },
      hoverW: undefined,
      draft: null,
      history: createHistory(layout),
      interiorLevel: displayLevel,
    };
    return computeOp(state as never);
  }
  it('表示階 2（ターミナルの 1F 相当）→ 建物内階 0 で置かれる', () => {
    const op = opAt(elevatedTerminal(), 2);
    expect(op?.result.ok).toBe(true);
    if (!op?.result.ok) return;
    const area = Object.values(op.result.layout.terminalAreas)[0]!;
    expect(area.level).toBe(0);
  });
  it('表示階 4 → 建物内階 2、表示階 1 → 建物内階 -1（B1）で置かれる', () => {
    const op4 = opAt(elevatedTerminal(), 4);
    expect(op4?.result.ok).toBe(true);
    if (op4?.result.ok) expect(Object.values(op4.result.layout.terminalAreas)[0]!.level).toBe(2);
    const op1 = opAt(elevatedTerminal(), 1);
    expect(op1?.result.ok).toBe(true);
    if (op1?.result.ok) expect(Object.values(op1.result.layout.terminalAreas)[0]!.level).toBe(-1);
  });
  it('建物の範囲外の表示階では floorOutOfRange になる', () => {
    const op = opAt(elevatedTerminal(), 6); // 建物内階 4 は levels 3 の範囲外
    expect(op?.result.ok).toBe(false);
    expect(op?.problem).toBe('floorOutOfRange');
  });
  it('地上のターミナルでは従来どおり表示階がそのまま建物内階になる', () => {
    const layout = must(placeFacility(emptyLayout(), 'terminal', { x: 10, y: 10 }, { w: 12, h: 8, props: { levels: 3 } })).layout;
    const op = opAt(layout, 1);
    expect(op?.result.ok).toBe(true);
    if (op?.result.ok) expect(Object.values(op.result.layout.terminalAreas)[0]!.level).toBe(1);
  });
});
