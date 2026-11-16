import { describe, expect, it } from 'vitest';
import { addRoadPath, connectRoadLevels, placeFacility } from '../../../src/core/layout/operations';
import { CONNECTOR_KIND_LABEL, displayName } from '../../../src/i18n/ja';
import { visibleFacilityLabelIds, visibleInteriorFacilityIds } from '../../../src/render/labels';
import { emptyLayout, must } from '../helpers';

describe('施設ラベル・内部設備の表示条件（1-05: W-1・W-2）', () => {
  it('施設名ラベルは表示中の階の施設だけ（W-1）', () => {
    let l = must(placeFacility(emptyLayout(), 'tower', { x: 5, y: 5 }, { name: '地上塔', mapLevel: 0 })).layout;
    l = must(placeFacility(l, 'tower', { x: 15, y: 5 }, { name: '地下塔', mapLevel: -1 })).layout;
    expect(visibleFacilityLabelIds(l, 0, false)).toEqual(['fac_1']);
    expect(visibleFacilityLabelIds(l, -1, false)).toEqual(['fac_2']);
    expect(visibleFacilityLabelIds(l, 'all', false)).toEqual(['fac_1', 'fac_2']);
  });
  it('名前なし・ゲート・建物内設備・内部表示中のターミナルは出さない', () => {
    let l = must(placeFacility(emptyLayout(), 'terminal', { x: 10, y: 10 }, { name: 'T1', w: 12, h: 8, props: { levels: 2 } })).layout;
    l = must(placeFacility(l, 'gseBase', { x: 12, y: 12 }, { name: '内部', parentFacilityId: 'fac_1', floorIndex: 0 })).layout;
    l = must(placeFacility(l, 'tower', { x: 40, y: 5 })).layout; // 名前なし
    expect(visibleFacilityLabelIds(l, 0, false)).toEqual(['fac_1']);
    expect(visibleFacilityLabelIds(l, 0, true)).toEqual([]);
  });
  it('内部設備は、親の種類を問わず、表示中の階（floorIndex）の設備だけ（W-2）', () => {
    let l = must(placeFacility(emptyLayout(), 'terminal', { x: 10, y: 10 }, { w: 12, h: 8, props: { levels: 2 } })).layout;
    l = must(placeFacility(l, 'hangar', { x: 30, y: 10 }, { props: { levels: 2 } })).layout;
    const hangar = Object.values(l.facilities).find((f) => f.kind === 'hangar')!.id;
    l = must(placeFacility(l, 'gseBase', { x: 12, y: 12 }, { parentFacilityId: 'fac_1', floorIndex: 1 })).layout;
    const hf = Object.values(l.facilities).find((f) => f.kind === 'hangar')!;
    l = must(placeFacility(l, 'gseBase', { x: hf.origin.x + 1, y: hf.origin.y + 1 }, { parentFacilityId: hangar, floorIndex: 1 })).layout;
    l = must(placeFacility(l, 'gseBase', { x: 14, y: 12 }, { parentFacilityId: 'fac_1', floorIndex: 0 })).layout;
    const f1 = visibleInteriorFacilityIds(l, 1);
    expect(f1).toHaveLength(2);
    expect(f1.map((id) => l.facilities[id]!.parentFacilityId).sort()).toEqual(['fac_1', hangar].sort());
    expect(visibleInteriorFacilityIds(l, 0)).toHaveLength(1);
    expect(visibleInteriorFacilityIds(l, 2)).toEqual([]);
  });
});

describe('接続設備の和名（W-8）', () => {
  it('connectorKind があり名前が空か内部名のとき、和名と番号で表示する。保存データの name は変えない', () => {
    let l = must(addRoadPath(emptyLayout(60, 60), [{ x: 10, y: 10 }, { x: 20, y: 10 }], { roadClass: 'walkway', level: 0, capacityPerHour: 600 })).layout;
    l = must(addRoadPath(l, [{ x: 20, y: 10 }, { x: 30, y: 10 }], { roadClass: 'walkway', level: -1, capacityPerHour: 600 })).layout;
    const at = (lv: number) => Object.values(l.roadNodes).find((n) => (n.level ?? 0) === lv && n.pos.x === 20 && n.pos.y === 10)!.id;
    l = must(connectRoadLevels(l, at(-1), at(0), { roadClass: 'walkway', connectorKind: 'stairs' })).layout;
    const c = Object.values(l.roads).find((e) => e.connectorKind)!;
    expect(c.name).toBe('stairs');
    expect(displayName(l, c.id)).toBe(`${CONNECTOR_KIND_LABEL.stairs} #${c.id.slice(c.id.indexOf('_') + 1)}`);
    expect(displayName(l, c.id)).toContain('階段');
    l.roads[c.id] = { ...c, name: '中央階段' };
    expect(displayName(l, c.id)).toBe('中央階段');
    l.roads[c.id] = { ...c, name: '' };
    expect(displayName(l, c.id)).toContain('階段');
  });
  it('通常の道路は従来どおり', () => {
    const l = must(addRoadPath(emptyLayout(60, 60), [{ x: 10, y: 10 }, { x: 20, y: 10 }], { roadClass: 'public' })).layout;
    const id = Object.keys(l.roads)[0]!;
    expect(displayName(l, id)).toBe(l.roads[id]!.name || `道路 #${id.slice(id.indexOf('_') + 1)}`);
  });
});
