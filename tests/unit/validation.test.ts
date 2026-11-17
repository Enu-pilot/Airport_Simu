import { describe, expect, it } from 'vitest';
import {
  addRoadPath,
  addTaxiwayPath,
  deleteEntity,
  moveEntity,
  placeFacility,
  placeRunway,
  placeStand,
  rotateEntity,
  updateEntity,
  type OpResult,
} from '../../src/core/layout/operations';
import { analyzeLayout, type IssueCode } from '../../src/core/validation/validate';
import { createSite } from '../../src/core/model/site';
import { createEmptyLayout } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { findNodeAt } from '../../src/core/layout/network';
import type { AirportLayout } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

const codes = (l: AirportLayout) => analyzeLayout(l).issues.map((i) => i.code);
const codesFor = (l: AirportLayout, id: string) => (analyzeLayout(l).byTarget[id] ?? []).map((i) => i.code);

/** 誘導路で滑走路とつながった最小構成（スポット1つ） */
function minimalAirport(): AirportLayout {
  let l = emptyLayout(100, 60);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeRunway(l, { x: 10, y: 10 }, 90, 80, { surfaceWidthM: 45 }));
  step(addTaxiwayPath(l, [{ x: 20, y: 10 }, { x: 20, y: 20 }, { x: 40, y: 20 }], { widthClass: 'M' }));
  step(placeFacility(l, 'apron', { x: 25, y: 21 }, { w: 12, h: 8 }));
  step(placeStand(l, { x: 29, y: 21 }, 'M', 180)); // 入口 (30, 20)
  return l;
}

describe('配置エラー', () => {
  it('立体占有では別階層を重複扱いせず、同階層の実干渉は検出する', () => {
    let l = must(placeFacility(emptyLayout(), 'baggageSort', { x: 30, y: 30 }, { mapLevel: -1 })).layout;
    l = must(placeFacility(l, 'baggageSort', { x: 30, y: 30 }, { mapLevel: 0 })).layout;
    expect(codes(l)).not.toContain('OVERLAP');
    l = must(placeFacility(l, 'baggageSort', { x: 30, y: 30 }, { mapLevel: 2 })).layout;
    expect(codes(l)).not.toContain('OVERLAP');
    l = must(placeFacility(l, 'baggageSort', { x: 30, y: 30 }, { mapLevel: 0 })).layout;
    expect(codes(l)).toContain('OVERLAP');
  });

  it('建物内部設備は階ごとに同位置を使え、親の移動・回転・削除に追従する', () => {
    let l = must(placeFacility(emptyLayout(), 'terminal', { x: 30, y: 30 }, { w: 12, h: 8, props: { levels: 3 } })).layout;
    l = must(placeFacility(l, 'baggageSort', { x: 30, y: 30 }, { parentFacilityId: 'fac_1', floorIndex: 0 })).layout;
    l = must(placeFacility(l, 'gseBase', { x: 30, y: 30 }, { parentFacilityId: 'fac_1', floorIndex: 1 })).layout;
    expect(codesFor(l, 'fac_2')).not.toContain('FACILITY_INTERIOR_OUTSIDE');
    expect(codesFor(l, 'fac_3')).not.toContain('FACILITY_INTERIOR_OUTSIDE');
    expect(codes(l)).not.toContain('OVERLAP');

    l = must(moveEntity(l, 'fac_1', { x: 5, y: 4 })).layout;
    expect(l.facilities.fac_2!.origin).toEqual({ x: 35, y: 34 });
    l = must(rotateEntity(l, 'fac_1')).layout;
    expect(l.facilities.fac_2!.origin).not.toEqual({ x: 35, y: 34 });
    l = must(deleteEntity(l, 'fac_1')).layout;
    expect(l.facilities.fac_2).toBeUndefined();
    expect(l.facilities.fac_3).toBeUndefined();
  });

  it('施設の重複を検出する', () => {
    let l = must(placeFacility(emptyLayout(), 'hangar', { x: 10, y: 10 })).layout;
    l = must(placeFacility(l, 'tower', { x: 12, y: 12 })).layout;
    const overlap = analyzeLayout(l).issues.find((i) => i.code === 'OVERLAP');
    expect(overlap?.targets).toEqual(['fac_1', 'fac_2']);
    expect(overlap?.severity).toBe('error');
    // 離せば解消
    l = must(moveEntity(l, 'fac_2', { x: 10, y: 0 })).layout;
    expect(codes(l)).not.toContain('OVERLAP');
  });

  it('隣接は重複ではない', () => {
    let l = must(placeFacility(emptyLayout(), 'tower', { x: 10, y: 10 })).layout;
    l = must(placeFacility(l, 'tower', { x: 12, y: 10 })).layout;
    expect(codes(l)).not.toContain('OVERLAP');
  });

  it('敷地外・建設不可地形', () => {
    const site = createSite({ width: 40, height: 40, offsiteMargin: 2 });
    site.terrain = site.terrain.map((t, i) => (t === 4 ? 4 : i % 40 >= 30 ? 2 : 0));
    let l = createEmptyLayout(site);
    l = must(placeFacility(l, 'tower', { x: 0, y: 10 })).layout; // 未取得地
    l = must(placeFacility(l, 'tower', { x: 31, y: 10 })).layout; // 水域
    l = must(placeFacility(l, 'tower', { x: 39, y: 10 })).layout; // はみ出し
    l = must(placeFacility(l, 'tower', { x: 10, y: 10 })).layout; // 正常
    expect(codesFor(l, 'fac_1')).toContain('UNBUILDABLE_TERRAIN');
    expect(codesFor(l, 'fac_2')).toContain('UNBUILDABLE_TERRAIN');
    expect(codesFor(l, 'fac_3')).toContain('OUT_OF_BOUNDS');
    expect(codesFor(l, 'fac_4')).toEqual([]);
  });

  it('滑走路保護区域内には建物を置けないが、誘導路は可', () => {
    let l = must(placeRunway(emptyLayout(), { x: 5, y: 20 }, 90, 60)).layout;
    l = must(placeFacility(l, 'tower', { x: 30, y: 22 })).layout;
    expect(codesFor(l, 'fac_1')).toContain('IN_RUNWAY_STRIP');
    // 侵された滑走路側は問題の対象ではなく参照のみ
    expect(codesFor(l, 'rwy_1')).not.toContain('IN_RUNWAY_STRIP');
    expect(analyzeLayout(l).issues.find((i) => i.code === 'IN_RUNWAY_STRIP')?.related).toEqual(['rwy_1']);
    l = must(moveEntity(l, 'fac_1', { x: 0, y: 3 })).layout;
    expect(codesFor(l, 'fac_1')).not.toContain('IN_RUNWAY_STRIP');
    l = must(addTaxiwayPath(l, [{ x: 30, y: 20 }, { x: 30, y: 30 }])).layout;
    expect(codes(l)).not.toContain('IN_RUNWAY_STRIP');
  });

  it('滑走路と平行に重なる誘導路は重複エラー', () => {
    let l = must(placeRunway(emptyLayout(), { x: 5, y: 20 }, 90, 60)).layout;
    l = must(addTaxiwayPath(l, [{ x: 10, y: 21 }, { x: 40, y: 21 }])).layout;
    expect(codes(l)).toContain('OVERLAP');
  });

  it('スポットはエプロン上に置く', () => {
    const l = must(placeStand(emptyLayout(), { x: 10, y: 10 }, 'S', 0)).layout;
    expect(codesFor(l, 'std_1')).toContain('STAND_NOT_ON_APRON');
    const ok = minimalAirport();
    expect(codesFor(ok, 'std_1')).not.toContain('STAND_NOT_ON_APRON');
  });
});

describe('接続エラー・孤立施設の検出', () => {
  it('最小構成はエラーなし', () => {
    const errs = analyzeLayout(minimalAirport()).issues.filter((i) => i.severity === 'error');
    expect(errs).toEqual([]);
  });

  it('滑走路につながらない誘導路は孤立として検出', () => {
    const l = must(addTaxiwayPath(minimalAirport(), [{ x: 60, y: 40 }, { x: 80, y: 40 }])).layout;
    const iss = analyzeLayout(l).issues.find((i) => i.code === 'TAXIWAY_ISOLATED');
    expect(iss?.targets).toHaveLength(1);
    expect(analyzeLayout(l).operability[iss!.targets[0]!]?.reasons).toContain('ISOLATED');
  });

  it('誘導路に接続されていないスポット / 滑走路に到達できないスポット', () => {
    let l = must(placeStand(minimalAirport(), { x: 32, y: 24 }, 'S', 0)).layout; // 入口 (33, 27) 誘導路なし
    expect(codesFor(l, 'std_2')).toContain('STAND_NOT_CONNECTED');
    l = must(addTaxiwayPath(minimalAirport(), [{ x: 60, y: 30 }, { x: 70, y: 30 }])).layout;
    l = must(placeFacility(l, 'apron', { x: 60, y: 31 }, { w: 6, h: 6 })).layout;
    l = must(placeStand(l, { x: 62, y: 31 }, 'S', 180)).layout; // 入口 (63, 30)
    expect(codesFor(l, 'std_2')).toContain('STAND_NO_RUNWAY_ROUTE');
  });

  it('誘導路幅が足りない場合は機体区分による経路制限', () => {
    let l = minimalAirport();
    l = must(updateEntity(l, 'rwy_1', { length: 120, surfaceWidthM: 60 })).layout;
    for (const id of Object.keys(l.taxiways)) l = must(updateEntity(l, id, { widthClass: 'M' })).layout;
    l = must(placeStand(l, { x: 31, y: 21 }, 'L', 180)).layout;
    // M スポットと重なるので M を移動して L 用の場所を作る
    l = must(moveEntity(l, 'std_1', { x: -4, y: 0 })).layout;
    expect(codesFor(l, 'std_2')).toContain('STAND_ROUTE_SIZE_LIMITED');
    for (const id of Object.keys(l.taxiways)) l = must(updateEntity(l, id, { widthClass: 'L' })).layout;
    expect(codesFor(l, 'std_2')).not.toContain('STAND_ROUTE_SIZE_LIMITED');
  });

  it('一方通行で出られない（入れない）スポット', () => {
    let l = minimalAirport();
    for (const id of Object.keys(l.taxiways)) l = must(updateEntity(l, id, { oneWay: true })).layout;
    const c = codesFor(l, 'std_1');
    expect(c.some((x) => x === 'STAND_ONE_WAY_TRAP' || x === 'STAND_NO_RUNWAY_ROUTE')).toBe(true);
  });

  it('誘導路のない滑走路 / 短すぎる滑走路', () => {
    const l = must(placeRunway(emptyLayout(), { x: 5, y: 20 }, 90, 30)).layout;
    expect(codesFor(l, 'rwy_1')).toEqual(expect.arrayContaining<IssueCode>(['RUNWAY_NO_TAXIWAY', 'RUNWAY_TOO_SHORT']));
  });

  it('交差点なしで交差する誘導路（ノードを動かした結果）', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 0, y: 0 }, { x: 10, y: 0 }])).layout;
    l = must(addTaxiwayPath(l, [{ x: 5, y: 2 }, { x: 5, y: 10 }])).layout;
    const n = findNodeAt(l.taxiNodes, { x: 5, y: 2 })!;
    l = must(moveEntity(l, n, { x: 0, y: -4 })).layout;
    expect(codes(l)).toContain('TAXIWAY_CROSSING_NO_JUNCTION');
  });

  it('入口ノードなしで滑走路を横切る誘導路', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 30, y: 10 }, { x: 30, y: 30 }])).layout;
    l = must(placeRunway(l, { x: 5, y: 20 }, 90, 60)).layout; // 後から滑走路を置く
    expect(codes(l)).toContain('TAXIWAY_CROSSES_RUNWAY_NO_ENTRY');
  });

  it('ゲート: ターミナル非隣接・スポット未設定・遠すぎ', () => {
    let l = minimalAirport();
    l = must(placeFacility(l, 'gate', { x: 70, y: 50 })).layout;
    const gate = Object.keys(l.facilities).at(-1)!;
    expect(codesFor(l, gate)).toEqual(expect.arrayContaining<IssueCode>(['GATE_NOT_AT_TERMINAL', 'GATE_NO_STAND']));
    l = must(updateEntity(l, gate, { props: { standId: 'std_1' } })).layout;
    expect(codesFor(l, gate)).toContain('GATE_STAND_TOO_FAR');
  });

  it('エアサイドに接していない支援施設 / 道路のないターミナル', () => {
    let l = must(placeFacility(emptyLayout(), 'fuelFarm', { x: 10, y: 10 })).layout;
    l = must(placeFacility(l, 'terminal', { x: 30, y: 30 })).layout;
    expect(codesFor(l, 'fac_1')).toContain('NO_AIRSIDE_ACCESS');
    expect(codesFor(l, 'fac_2')).toContain('TERMINAL_NO_ROAD');
    l = must(placeFacility(l, 'serviceArea', { x: 13, y: 10 })).layout;
    l = must(addRoadPath(l, [{ x: 25, y: 38 }, { x: 55, y: 38 }])).layout;
    expect(codesFor(l, 'fac_1')).not.toContain('NO_AIRSIDE_ACCESS');
    expect(codesFor(l, 'fac_2')).not.toContain('TERMINAL_NO_ROAD');
  });

  it('敷地の出入口につながらない道路', () => {
    const l = must(addRoadPath(emptyLayout(), [{ x: 10, y: 10 }, { x: 20, y: 10 }])).layout;
    // 全面草地（未取得地なし）なので外周に出口は無い
    expect(codes(l)).toContain('ROAD_NO_ENTRANCE');
  });

  it('空港全体: 滑走路・管制塔がない', () => {
    expect(codes(emptyLayout())).toEqual(expect.arrayContaining<IssueCode>(['NO_RUNWAY', 'NO_TOWER']));
  });
});

describe('建設途中と運用可能の区別', () => {
  it('建設中の誘導路だけでつながるスポットは、設計上は接続済みだが運用不可', () => {
    let l = minimalAirport();
    for (const id of Object.keys(l.taxiways)) l = must(updateEntity(l, id, { buildState: 'underConstruction' })).layout;
    const a = analyzeLayout(l);
    expect(a.byTarget.std_1?.some((i) => i.severity === 'error') ?? false).toBe(false);
    expect(a.operability.std_1).toEqual({ operable: false, reasons: ['NO_OPERATIONAL_ROUTE'] });
    expect(a.operability.rwy_1?.reasons).toContain('NO_OPERATIONAL_ROUTE');
    const twy = Object.keys(l.taxiways)[0]!;
    expect(a.operability[twy]?.reasons).toEqual(['NOT_COMPLETED']);
  });

  it('サンプル空港の滑走路を計画中にすると全スポットが運用不可になる', () => {
    const l = must(updateEntity(createSampleAirport(), 'rwy_1', { buildState: 'planned' })).layout;
    const a = analyzeLayout(l);
    expect(Object.keys(l.stands).every((id) => !a.operability[id]!.operable)).toBe(true);
    expect(a.counts.error).toBe(0);
  });
});

describe('overnightStandIssues: 滞泊スポットの撤去・閉鎖の警告（フェーズ 4 §3.3）', () => {
  it('在泊の記録があるスポットを閉鎖すると警告し、運用中なら警告しない', async () => {
    const { overnightStandIssues } = await import('../../src/core/validation/validate');
    const { createSandboxCompany } = await import('../../src/core/economy/company');
    const layout = createSampleAirport();
    const standId = Object.values(layout.stands).find((s) => s.size === 'M')!.id;
    const c = createSandboxCompany('ovn-val');
    c.features = { overnight: true };
    c.carryOver = {
      forDay: 1,
      aircraft: [{
        sourceAircraftId: 'ac_1', typeId: 'B737-800', airlineId: 'SK', contractId: null, destinationId: 'KTA',
        callsign: 'SK101', depNumber: 102, standId, parkedBeforeSec: 3600, depSecOfDay: 23400, depDelaySec: 0, depPax: 100,
      }],
    };
    expect(overnightStandIssues(layout, c)).toEqual([]);
    layout.stands[standId]!.buildState = 'planned';
    const issues = overnightStandIssues(layout, c);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('OVERNIGHT_STAND_REMOVED');
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.params.count).toBe(1);
    // 記録がなければ警告しない
    delete c.carryOver;
    expect(overnightStandIssues(layout, c)).toEqual([]);
  });
});
