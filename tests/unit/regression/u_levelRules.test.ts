import { describe, expect, it } from 'vitest';
import { floorExistsInParent, interiorPlacementProblem, levelsInUse, terminalAreaLevelProblem } from '../../../src/core/layout/levelRules';
import { placeFacility, placeTerminalArea, updateEntity } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { emptyLayout, must } from '../helpers';

/** 1-04（V-5・V-6・W-6・W-10）: 置けない階の理由。コアの失敗コード（INVALID_VALUE）は変えない */
function terminal(levels = 2): AirportLayout {
  return must(placeFacility(emptyLayout(), 'terminal', { x: 10, y: 10 }, { w: 12, h: 8, props: { levels } })).layout;
}
const inside = [{ x: 12, y: 12 }];

describe('interiorPlacementProblem', () => {
  it('境界値: 階数 − 1 は可、階数は不可、-5 は可、-6 は不可', () => {
    const l = terminal(2);
    expect(interiorPlacementProblem(l, 'fac_1', 1, inside)).toBeNull();
    expect(interiorPlacementProblem(l, 'fac_1', 2, inside)).toBe('floorOutOfRange');
    expect(interiorPlacementProblem(l, 'fac_1', -5, inside)).toBeNull();
    expect(interiorPlacementProblem(l, 'fac_1', -6, inside)).toBe('floorOutOfRange');
    expect(interiorPlacementProblem(l, 'fac_1', 0.5, inside)).toBe('floorOutOfRange');
  });
  it('1 階建てで 2 階は不可（V-5）。コアも INVALID_VALUE のまま', () => {
    const l = terminal(1);
    expect(interiorPlacementProblem(l, 'fac_1', 1, inside)).toBe('floorOutOfRange');
    expect(placeFacility(l, 'gseBase', { x: 12, y: 12 }, { parentFacilityId: 'fac_1', floorIndex: 1 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
  it('親の範囲の外は outsideParent。コアも INVALID_VALUE', () => {
    const l = terminal(2);
    expect(interiorPlacementProblem(l, 'fac_1', 0, [{ x: 12, y: 12 }, { x: 40, y: 40 }])).toBe('outsideParent');
    expect(placeFacility(l, 'gseBase', { x: 40, y: 40 }, { parentFacilityId: 'fac_1', floorIndex: 0 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
  it('階の範囲外と範囲外の位置が同時なら、階の理由を優先する。親が無ければ null（コアに任せる）', () => {
    const l = terminal(1);
    expect(interiorPlacementProblem(l, 'fac_1', 3, [{ x: 40, y: 40 }])).toBe('floorOutOfRange');
    expect(interiorPlacementProblem(l, 'fac_9', 0, inside)).toBeNull();
  });
  it('floorExistsInParent は選択肢の注記に使う', () => {
    const l = terminal(2);
    expect([0, 1, 2].map((f) => floorExistsInParent(l, 'fac_1', f))).toEqual([true, true, false]);
  });
});

describe('terminalAreaLevelProblem（V-6）', () => {
  it('2 階建てのターミナルの 3F（level 2）は不可。コアも INVALID_VALUE', () => {
    const l = terminal(2);
    expect(terminalAreaLevelProblem(l, 'fac_1', 1)).toBeNull();
    expect(terminalAreaLevelProblem(l, 'fac_1', 2)).toBe('floorOutOfRange');
    expect(terminalAreaLevelProblem(l, 'fac_1', -1)).toBe('floorOutOfRange');
    expect(placeTerminalArea(l, 'fac_1', 2, 'waiting', { x: 12, y: 12 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
});

describe('levelsInUse（W-10）', () => {
  it('エリアがある階を減らすと使用中。上の階が空なら不使用', () => {
    let l = terminal(3);
    l = must(placeTerminalArea(l, 'fac_1', 2, 'waiting', { x: 12, y: 12 }, { w: 3, h: 3 })).layout;
    expect(levelsInUse(l, 'fac_1', 2)).toBe(true);
    expect(levelsInUse(l, 'fac_1', 3)).toBe(false);
    expect(levelsInUse(l, 'fac_1', 1)).toBe(true);
    const e = must(placeTerminalArea(terminal(3), 'fac_1', 0, 'waiting', { x: 12, y: 12 }, { w: 3, h: 3 })).layout;
    expect(levelsInUse(e, 'fac_1', 1)).toBe(false);
  });
  it('建物内の設備がある階を減らすと使用中（コアも拒否）', () => {
    let l = terminal(3);
    l = must(placeFacility(l, 'gseBase', { x: 12, y: 12 }, { parentFacilityId: 'fac_1', floorIndex: 2 })).layout;
    expect(levelsInUse(l, 'fac_1', 2)).toBe(true);
    expect(updateEntity(l, 'fac_1', { props: { levels: 2 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(levelsInUse(l, 'fac_1', 3)).toBe(false);
  });
  it('地下階（floorIndex < 0）の設備は階数を減らしても使用中にならない', () => {
    let l = terminal(2);
    l = must(placeFacility(l, 'gseBase', { x: 12, y: 12 }, { parentFacilityId: 'fac_1', floorIndex: -1 })).layout;
    expect(levelsInUse(l, 'fac_1', 1)).toBe(false);
  });
});
