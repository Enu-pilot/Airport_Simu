import { describe, expect, it } from 'vitest';
import {
  deleteEntity,
  duplicateEntity,
  moveEntity,
  placeFacility,
  placeRunway,
  placeStand,
  rotateEntity,
  setBuildState,
  updateEntity,
} from '../../src/core/layout/operations';
import { facilityTiles, standEntry, standTiles } from '../../src/core/layout/footprint';
import { pickAt } from '../../src/core/layout/pick';
import type { RunwayGrid8 } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

describe('施設の配置・回転・移動・削除・複製', () => {
  it('配置すると安定IDが発行され、元のレイアウトは変更されない', () => {
    const base = emptyLayout();
    const r = must(placeFacility(base, 'hangar', { x: 10, y: 10 }));
    const id = r.created[0]!;
    expect(id).toBe('fac_1');
    expect(base.facilities).toEqual({});
    expect(r.layout.facilities[id]).toMatchObject({ kind: 'hangar', origin: { x: 10, y: 10 }, w: 6, h: 5, rotation: 0 });
    expect(facilityTiles(r.layout.facilities[id]!)).toHaveLength(30);
  });

  it('回転すると幅と高さが入れ替わり、中心が保たれる', () => {
    const { layout, created } = must(placeFacility(emptyLayout(), 'hangar', { x: 10, y: 10 }));
    const rotated = must(rotateEntity(layout, created[0]!)).layout.facilities[created[0]!]!;
    expect(rotated.rotation).toBe(90);
    // 6x5 → 5x6、中心 (13, 12.5) をできるだけ保つ（半タイルのずれは切り捨て）
    expect(rotated.origin).toEqual({ x: 10, y: 9 });
    const tiles = facilityTiles(rotated);
    expect(Math.max(...tiles.map((t) => t.x)) - Math.min(...tiles.map((t) => t.x)) + 1).toBe(5);
    expect(Math.max(...tiles.map((t) => t.y)) - Math.min(...tiles.map((t) => t.y)) + 1).toBe(6);
    // 4回で元に戻る
    let l = layout;
    for (let i = 0; i < 4; i++) l = must(rotateEntity(l, created[0]!)).layout;
    expect(l.facilities[created[0]!]).toEqual(layout.facilities[created[0]!]);
  });

  it('移動・削除・複製', () => {
    const { layout, created } = must(placeFacility(emptyLayout(), 'tower', { x: 5, y: 5 }));
    const id = created[0]!;
    const moved = must(moveEntity(layout, id, { x: 3, y: -2 })).layout;
    expect(moved.facilities[id]!.origin).toEqual({ x: 8, y: 3 });

    const dup = must(duplicateEntity(moved, id));
    const copy = dup.layout.facilities[dup.created[0]!]!;
    expect(copy.id).not.toBe(id);
    expect(copy.origin).toEqual({ x: 11, y: 3 });

    const deleted = must(deleteEntity(dup.layout, id)).layout;
    expect(deleted.facilities[id]).toBeUndefined();
    expect(deleted.facilities[copy.id]).toBeDefined();
    // 削除しても ID は再利用されない
    const again = must(placeFacility(deleted, 'tower', { x: 30, y: 30 }));
    expect(again.created[0]).toBe('fac_3');
  });

  it('存在しない対象への操作は失敗し、変更されない', () => {
    const base = emptyLayout();
    expect(moveEntity(base, 'fac_99', { x: 1, y: 0 })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(deleteEntity(base, 'xyz')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('スポットの回転で入口の向きが変わる', () => {
    const { layout, created } = must(placeStand(emptyLayout(), { x: 10, y: 10 }, 'M', 0));
    const s0 = layout.stands[created[0]!]!;
    expect(standTiles(s0)).toHaveLength(6); // M = 3×2
    expect(standEntry(s0)).toEqual({ x: 11, y: 12 }); // 機首北 → 入口南
    const s90 = must(rotateEntity(layout, s0.id)).layout.stands[s0.id]!;
    expect(s90.rotation).toBe(90);
    const e = standEntry(s90);
    expect(e.x).toBe(s90.origin.x - 1); // 機首東 → 入口西
  });

  it('滑走路の回転は45度刻みで中点を保つ', () => {
    const { layout, created } = must(placeRunway(emptyLayout(), { x: 10, y: 20 }, 90, 40));
    const r = must(rotateEntity(layout, created[0]!)).layout.runways[created[0]!]!;
    expect((r as RunwayGrid8).heading).toBe(135);
    expect(r.start).toEqual({ x: 10, y: 0 });
  });
});

describe('プロパティ編集', () => {
  it('検証を通る値のみ反映する', () => {
    const { layout, created } = must(placeFacility(emptyLayout(), 'terminal', { x: 5, y: 5 }));
    const id = created[0]!;
    const ok = must(updateEntity(layout, id, { w: 10, props: { levels: 3 }, name: 'T1' })).layout.facilities[id]!;
    expect(ok).toMatchObject({ w: 10, name: 'T1', props: { levels: 3 } });
    expect(updateEntity(layout, id, { props: { levels: 5 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(updateEntity(layout, id, { w: 1 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(updateEntity(layout, id, { props: { unknown: 1 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(updateEntity(layout, id, { color: 'red' })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('固定サイズの施設は寸法を変えられない', () => {
    const { layout, created } = must(placeFacility(emptyLayout(), 'tower', { x: 5, y: 5 }));
    expect(updateEntity(layout, created[0]!, { w: 4 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('ゲートのスポット参照は存在するスポットのみ', () => {
    let l = must(placeStand(emptyLayout(), { x: 10, y: 10 }, 'S', 0)).layout;
    const g = must(placeFacility(l, 'gate', { x: 30, y: 30 }));
    l = g.layout;
    const gateId = g.created[0]!;
    expect(l.facilities[gateId]!.props.standId).toBeNull(); // 遠いので自動紐付けなし
    expect(must(updateEntity(l, gateId, { props: { standId: 'std_1' } })).layout.facilities[gateId]!.props.standId).toBe('std_1');
    expect(updateEntity(l, gateId, { props: { standId: 'std_9' } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('スポットを削除するとゲートの紐付けが解除される', () => {
    let l = must(placeStand(emptyLayout(), { x: 10, y: 10 }, 'S', 0)).layout;
    l = must(placeFacility(l, 'gate', { x: 11, y: 9 })).layout;
    expect(l.facilities.fac_1!.props.standId).toBe('std_1'); // 近いので自動紐付け
    l = must(deleteEntity(l, 'std_1')).layout;
    expect(l.facilities.fac_1!.props.standId).toBeNull();
  });

  it('建設状態の一括変更', () => {
    let l = must(placeFacility(emptyLayout(), 'tower', { x: 5, y: 5 }, { buildState: 'planned' })).layout;
    l = must(placeFacility(l, 'fuelFarm', { x: 20, y: 5 }, { buildState: 'underConstruction' })).layout;
    l = must(setBuildState(l, 'operational')).layout;
    expect(Object.values(l.facilities).every((f) => f.buildState === 'operational')).toBe(true);
    expect(setBuildState(l, 'operational')).toEqual({ ok: false, reason: 'NO_CHANGE' });
  });
});

describe('選択（ピック）', () => {
  it('重なっている場合は小さい・上にあるものを選ぶ', () => {
    let l = must(placeFacility(emptyLayout(), 'apron', { x: 0, y: 0 }, { w: 20, h: 20 })).layout;
    l = must(placeStand(l, { x: 5, y: 5 }, 'S', 0)).layout;
    expect(pickAt(l, { x: 6.5, y: 6.5 })).toBe('std_1');
    expect(pickAt(l, { x: 15.5, y: 15.5 })).toBe('fac_1');
    expect(pickAt(l, { x: 50.5, y: 50.5 })).toBeNull();
  });
});
