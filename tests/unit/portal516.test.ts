import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { addPortal, deleteEntity, deletePortal, placeFacility } from '../../src/core/layout/operations';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { must } from './helpers';
import { analyzeLayout } from '../../src/core/validation/validate';

/**
 * 5-16 T2: 歩行ポータル（PedestrianPortal）のデータモデルと配置操作。
 * 交通施設とターミナル内エリアの明示接続のみが接続とみなされ、
 * 階・階層の不一致や参照切れは拒否される。旧レイアウト（portals 欠落）は
 * ポータルなしとして扱われ、自動接続は推測しない。
 */
function layoutWithBusTerminal() {
  let l = createStarterAirfield();
  l = must(placeFacility(l, 'busTerminal', { x: 36, y: 58 })).layout;
  const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
  const entrance = Object.values(l.terminalAreas).find((a) => a.kind === 'entrance')!;
  return { l, bt, entrance };
}

describe('5-16 T2 歩行ポータル', () => {
  it('交通施設と入口エリアを接続でき、階・階層は相手から導出される', () => {
    const { l, bt, entrance } = layoutWithBusTerminal();
    expect(l.portals).toBeUndefined();
    const r = addPortal(l, { facilityId: bt.id, areaId: entrance.id });
    expect(r.ok).toBe(true);
    const after = must(r);
    const portal = Object.values(after.layout.portals!)[0]!;
    expect(portal.facilityId).toBe(bt.id);
    expect(portal.areaId).toBe(entrance.id);
    expect(portal.floorIndex).toBe(entrance.level);
    expect(portal.mapLevel).toBe(0);
    expect(portal.buildState).toBe('operational');
  });

  it('交通施設でない施設への接続は拒否される', () => {
    const { l, entrance } = layoutWithBusTerminal();
    const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
    const r = addPortal(l, { facilityId: gate.id, areaId: entrance.id });
    expect(r.ok).toBe(false);
  });

  it('階・階層の不一致は拒否される', () => {
    const { l, bt, entrance } = layoutWithBusTerminal();
    expect(addPortal(l, { facilityId: bt.id, areaId: entrance.id, floorIndex: entrance.level + 1 }).ok).toBe(false);
    expect(addPortal(l, { facilityId: bt.id, areaId: entrance.id, mapLevel: 1 }).ok).toBe(false);
  });

  it('参照切れは拒否され、施設を消すとポータルも消える', () => {
    const { l, bt, entrance } = layoutWithBusTerminal();
    expect(addPortal(l, { facilityId: 'missing', areaId: entrance.id }).ok).toBe(false);
    const withPortal = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
    expect(Object.keys(withPortal.portals!)).toHaveLength(1);
    const afterDelete = must(deleteEntity(withPortal, bt.id)).layout;
    expect(Object.keys(afterDelete.portals ?? {})).toHaveLength(0);
  });

  it('削除でき、存在しないポータルの削除は失敗する', () => {
    const { l, bt, entrance } = layoutWithBusTerminal();
    const withPortal = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
    const id = Object.keys(withPortal.portals!)[0]!;
    const after = must(deletePortal(withPortal, id)).layout;
    expect(Object.keys(after.portals ?? {})).toHaveLength(0);
    expect(deletePortal(withPortal, 'por_999').ok).toBe(false);
  });

  it('作成後にエリアの階が変わると検証が階不一致を警告する', () => {
    const { l, bt, entrance } = layoutWithBusTerminal();
    const withPortal = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
    const drifted = structuredClone(withPortal);
    drifted.terminalAreas[entrance.id] = { ...entrance, level: entrance.level + 1 };
    const codes = analyzeLayout(drifted).issues.map((i) => i.code);
    expect(codes).toContain('PORTAL_LEVEL_MISMATCH');
    expect(analyzeLayout(withPortal).issues.map((i) => i.code)).not.toContain('PORTAL_LEVEL_MISMATCH');
  });

  it('書き出し・読み戻しでポータルが保持される', () => {
    const { l, bt, entrance } = layoutWithBusTerminal();
    const withPortal = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
    const roundTripped = importLayout(exportLayout(withPortal));
    expect(Object.values(roundTripped.portals!)).toEqual(Object.values(withPortal.portals!));
  });
});
