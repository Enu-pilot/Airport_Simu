import { describe, expect, it } from 'vitest';
import { addRoadPath, placeFacility, placeStand, placeTerminalArea } from '../../../src/core/layout/operations';
import { pickAt, pickCandidatesAt, pickTerminalArea, type PickView } from '../../../src/core/layout/pick';
import type { AirportLayout } from '../../../src/core/model/types';
import { emptyLayout, must } from '../helpers';

/** 1-03（V-3・V-4）: クリックでの選択を描画と同じ条件（階層・内部表示）に合わせる */
const view = (mapLevel: number | 'all', shown = false, level = 1): PickView => ({ mapLevel, interior: { shown, level } });
// 道路のノードは mapToWorld でタイル中心に置かれる。世界座標でタイルの中心 +0.5 を指す
const at = (x: number, y: number) => ({ x: x + 0.5, y: y + 0.5 });

function twoFloorTerminal(): AirportLayout {
  let l = must(placeFacility(emptyLayout(), 'terminal', { x: 10, y: 10 }, { w: 12, h: 8, props: { levels: 2 } })).layout;
  l = must(placeTerminalArea(l, 'fac_1', 1, 'waiting', { x: 12, y: 12 }, { w: 4, h: 4 })).layout;
  return l;
}

describe('pickAt / pickCandidatesAt（階層・内部表示）', () => {
  it('同じ位置に地上と地下 1 のノード → 表示中の階のノードだけが選ばれる', () => {
    let l = must(addRoadPath(emptyLayout(), [{ x: 10, y: 10 }, { x: 20, y: 10 }], { roadClass: 'walkway', level: 0 })).layout;
    l = must(addRoadPath(l, [{ x: 10, y: 10 }, { x: 10, y: 20 }], { roadClass: 'walkway', level: -1 })).layout;
    const ground = Object.values(l.roadNodes).find((n) => (n.level ?? 0) === 0 && n.pos.x === 10 && n.pos.y === 10)!.id;
    const basement = Object.values(l.roadNodes).find((n) => n.level === -1 && n.pos.x === 10 && n.pos.y === 10)!.id;
    const p = { x: 10.5, y: 10.5 };
    expect(pickCandidatesAt(l, p, view(0))).toContain(ground);
    expect(pickCandidatesAt(l, p, view(0))).not.toContain(basement);
    expect(pickCandidatesAt(l, p, view(-1))).toContain(basement);
    expect(pickCandidatesAt(l, p, view(-1))).not.toContain(ground);
    // 'all' は従来どおり両方
    expect(pickCandidatesAt(l, p, view('all'))).toEqual(expect.arrayContaining([ground, basement]));
  });

  it('表示していない階の独立施設は候補にならない（V-4）', () => {
    const l = must(placeFacility(emptyLayout(), 'tower', { x: 5, y: 5 }, { mapLevel: -1 })).layout;
    const p = at(5, 5);
    expect(pickAt(l, p, view(0))).toBeNull();
    expect(pickAt(l, p, view(-1))).toBe('fac_1');
    expect(pickAt(l, p, view('all'))).toBe('fac_1');
  });

  it('内部表示オン・階が一致 → 内部設備がエリアより優先される', () => {
    let l = twoFloorTerminal();
    l = must(placeFacility(l, 'gseBase', { x: 13, y: 13 }, { parentFacilityId: 'fac_1', floorIndex: 1 })).layout;
    const inner = Object.values(l.facilities).find((f) => f.parentFacilityId)!.id;
    const p = at(13, 13);
    expect(pickCandidatesAt(l, p, view(0, true, 1)).slice(0, 2)).toEqual([inner, 'ta_1']);
  });

  it('内部表示の階が不一致 → 内部設備もエリアも選ばれず、親のターミナルになる', () => {
    let l = twoFloorTerminal();
    l = must(placeFacility(l, 'gseBase', { x: 13, y: 13 }, { parentFacilityId: 'fac_1', floorIndex: 1 })).layout;
    const p = at(13, 13);
    expect(pickAt(l, p, view(0, true, 0))).toBe('fac_1');
  });

  it('内部表示オフ → 建物内設備は候補にならない（V-3: 親の建物を選べる）', () => {
    let l = twoFloorTerminal();
    l = must(placeFacility(l, 'gseBase', { x: 13, y: 13 }, { parentFacilityId: 'fac_1', floorIndex: 1 })).layout;
    const p = at(13, 13);
    expect(pickCandidatesAt(l, p, view(0, false, 1))).toEqual(['fac_1']);
  });

  it('view 省略 → 従来の結果と一致する（階層・内部表示を見ない）', () => {
    let l = twoFloorTerminal();
    l = must(placeFacility(l, 'gseBase', { x: 13, y: 13 }, { parentFacilityId: 'fac_1', floorIndex: 1 })).layout;
    const inner = Object.values(l.facilities).find((f) => f.parentFacilityId)!.id;
    // 従来: 建物の中では id が大きいものが上（内部設備 fac_2 > fac_1）
    expect(pickAt(l, at(13, 13))).toBe(inner);
    let l2 = must(placeFacility(emptyLayout(), 'apron', { x: 0, y: 0 }, { w: 20, h: 20 })).layout;
    l2 = must(placeStand(l2, { x: 5, y: 5 }, 'S', 0)).layout;
    expect(pickAt(l2, { x: 6.5, y: 6.5 })).toBe('std_1');
    expect(pickAt(l2, { x: 15.5, y: 15.5 })).toBe('fac_1');
    expect(pickAt(l2, { x: 50.5, y: 50.5 })).toBeNull();
  });

  it('高架 1 階のターミナルでは、建物内階 0 のエリア・設備が表示階 1 で選ばれる（実効階層）', () => {
    let l = must(placeFacility(emptyLayout(), 'terminal', { x: 10, y: 10 }, { w: 12, h: 8, props: { levels: 2 }, mapLevel: 1 })).layout;
    l = must(placeTerminalArea(l, 'fac_1', 0, 'waiting', { x: 12, y: 12 }, { w: 4, h: 4 })).layout;
    l = must(placeFacility(l, 'gseBase', { x: 13, y: 13 }, { parentFacilityId: 'fac_1', floorIndex: 0 })).layout;
    const inner = Object.values(l.facilities).find((f) => f.parentFacilityId)!.id;
    const p = at(13, 13);
    // エリアの実効階層は 1（ターミナル 1 ＋ 建物内階 0）
    expect(pickTerminalArea(l, p, 1)).toBe('ta_1');
    expect(pickTerminalArea(l, p, 0)).toBeNull();
    expect(pickCandidatesAt(l, p, view(1, true, 1)).slice(0, 2)).toEqual([inner, 'ta_1']);
    // 表示階 0 では内部設備もエリアも選ばれず、親のターミナルになる
    expect(pickAt(l, p, view(1, true, 0))).toBe('fac_1');
  });

  it('重なりの候補の順序: スポット > エプロン。先頭が pickAt と同じ。重複しない', () => {
    let l = must(placeFacility(emptyLayout(), 'apron', { x: 0, y: 0 }, { w: 20, h: 20 })).layout;
    l = must(placeStand(l, { x: 5, y: 5 }, 'S', 0)).layout;
    const c = pickCandidatesAt(l, { x: 6.5, y: 6.5 }, view('all'));
    expect(c).toEqual(['std_1', 'fac_1']);
    expect(new Set(c).size).toBe(c.length);
    expect(pickAt(l, { x: 6.5, y: 6.5 }, view('all'))).toBe(c[0]);
  });
});
