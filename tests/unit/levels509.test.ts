import { describe, expect, it } from 'vitest';
import { placeFacility, updateEntity } from '../../src/core/layout/operations';
import { analyzeLayout } from '../../src/core/validation/validate';
import { emptyLayout, must } from './helpers';
import { actions, editorStore } from '../../src/editor/store';

/**
 * 5-09 階層の残件: W-3（内部設備の接続警告）・W-7（地下に置ける種類）・W-11（全レイヤ表示中の配置先）。
 * 仕様の確定内容は docs/34 に記載。
 */
describe('階層の残件（5-09）', () => {
  it('W-7: 地下に単独で置けるのは駐車場・従業員駐車場・鉄道駅だけ', () => {
    const base = emptyLayout(60, 40);
    expect(placeFacility(base, 'tower', { x: 5, y: 5 }, { mapLevel: -1 }).ok).toBe(false);
    expect(placeFacility(base, 'hangar', { x: 5, y: 5 }, { mapLevel: -1 }).ok).toBe(false);
    expect(placeFacility(base, 'fireStation', { x: 5, y: 5 }, { mapLevel: -2 }).ok).toBe(false);
    expect(placeFacility(base, 'parking', { x: 5, y: 5 }, { mapLevel: -1 }).ok).toBe(true);
    expect(placeFacility(base, 'railStation', { x: 20, y: 5 }, { mapLevel: -1 }).ok).toBe(true);
    expect(placeFacility(base, 'tower', { x: 5, y: 5 }, { mapLevel: 0 }).ok).toBe(true);
  });

  it('W-7: 配置後の階変更でも地下の種類制限が効く', () => {
    let layout = emptyLayout(60, 40);
    layout = must(placeFacility(layout, 'tower', { x: 5, y: 5 }, {})).layout;
    const towerId = Object.values(layout.facilities).find((f) => f.kind === 'tower')!.id;
    expect(updateEntity(layout, towerId, { mapLevel: -1 }).ok).toBe(false);
    layout = must(placeFacility(layout, 'parking', { x: 20, y: 5 }, {})).layout;
    const parkingId = Object.values(layout.facilities).find((f) => f.kind === 'parking')!.id;
    expect(updateEntity(layout, parkingId, { mapLevel: -1 }).ok).toBe(true);
  });

  it('W-7: 既存データの地下の管制塔には検証の警告が出る', () => {
    let layout = emptyLayout(60, 40);
    layout = must(placeFacility(layout, 'tower', { x: 5, y: 5 }, {})).layout;
    const tower = Object.values(layout.facilities).find((f) => f.kind === 'tower')!;
    tower.mapLevel = -1; // 旧データの直接模擬
    const issues = analyzeLayout(layout).issues;
    expect(issues.some((i) => i.code === 'FACILITY_UNDERGROUND_KIND' && i.targets.includes(tower.id))).toBe(true);
  });

  it('W-3: 建物内の GSE 基地には接地警告を出さず、未接続の情報だけを出す', () => {
    let layout = emptyLayout(60, 40);
    layout = must(placeFacility(layout, 'hangar', { x: 5, y: 5 }, { w: 10, h: 8 })).layout;
    const hangar = Object.values(layout.facilities).find((f) => f.kind === 'hangar')!;
    layout = must(placeFacility(layout, 'gseBase', { x: 6, y: 6 }, { parentFacilityId: hangar.id, floorIndex: 0 })).layout;
    const child = Object.values(layout.facilities).find((f) => f.kind === 'gseBase')!;
    const issues = analyzeLayout(layout).issues;
    expect(issues.some((i) => i.code === 'NO_AIRSIDE_ACCESS' && i.targets.includes(child.id))).toBe(false);
    expect(issues.some((i) => i.code === 'INTERIOR_FACILITY_UNLINKED' && i.targets.includes(child.id))).toBe(true);
  });

  it('W-11: 全レイヤ表示に切り替えても配置先の階は最後に選んだ階のまま', () => {
    actions.setMapLevel(-2);
    expect(editorStore.getState().options.roadLevel).toBe(-2);
    actions.setMapLevel('all');
    expect(editorStore.getState().mapLevel).toBe('all');
    expect(editorStore.getState().options.roadLevel).toBe(-2);
    actions.setMapLevel(0);
    expect(editorStore.getState().options.roadLevel).toBe(0);
  });
});
