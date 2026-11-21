import { describe, expect, it } from 'vitest';
import {
  addAgtSegment,
  addAgtSystem,
  addPortal,
  deleteAgtSystem,
  deleteEntity,
  groupAgtConnectionFacility,
  placeFacility,
  placeTerminalArea,
  updateAgtSystem,
} from '../../src/core/layout/operations';
import { agtSegmentCapacityPerHour, agtSegmentTravelSec, agtSystemTrainsets } from '../../src/core/model/agt';
import { AGT_SEGMENT_DETOUR, TILE_M } from '../../src/core/model/catalog';
import { agtStationConnectedAreas } from '../../src/core/terminal/agt';
import { findTerminalTransferRoute } from '../../src/core/terminal/interTerminal';
import { terminalTransitStatus } from '../../src/core/terminal/transitStatus';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { analyzeLayout } from '../../src/core/validation/validate';
import { buildProject, formatVersionOf, serializeProject } from '../../src/core/io/project';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { createSandboxCompany } from '../../src/core/economy/company';
import { BALANCE } from '../../src/core/economy/balance';
import { connectionFacilityCost, facilityValue, layoutItems } from '../../src/core/economy/construction';
import { dailyFixedCosts } from '../../src/core/economy/ops';
import { createContext } from '../../src/core/sim/context';
import type { AirportLayout } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * 機能I: AGT（新交通システム）。設計は design-GHIJ-detail.md §I が正本。
 * 受入条件: AGT を配置しない既存レイアウトでは結果が変わらないこと（ゴールデン全件不変で担保）。
 */

const SYS = { name: 'AGT 1号線', vehicleCapacity: 100, headwaySec: 180, dwellSec: 20, speedMps: 10 } as const;

interface Cdg {
  layout: AirportLayout;
  sysId: string;
  termA: string;
  termB: string;
  areaA: string;
  areaB: string;
  stA: string;
  stB: string;
  segId: string;
}

/** CDG 型レシピ: 本館 B1 駅 ⇔ 地下セグメント ⇔ サテライト B1 駅 */
function cdgFixture(): Cdg {
  let l = emptyLayout(120, 80);
  l = must(addAgtSystem(l, { ...SYS })).layout;
  const sysId = Object.keys(l.agtSystems!)[0]!;
  l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { w: 16, h: 10, props: { levels: 3 }, name: '本館' })).layout;
  const termA = Object.values(l.facilities).find((f) => f.name === '本館')!.id;
  l = must(placeFacility(l, 'terminal', { x: 60, y: 10 }, { w: 16, h: 10, props: { levels: 3 }, name: 'サテライト' })).layout;
  const termB = Object.values(l.facilities).find((f) => f.name === 'サテライト')!.id;
  l = must(placeTerminalArea(l, termA, -1, 'hall', { x: 12, y: 12 }, { w: 4, h: 3, zone: 'departure' })).layout;
  const areaA = Object.values(l.terminalAreas).find((a) => a.terminalId === termA)!.id;
  l = must(placeTerminalArea(l, termB, -1, 'hall', { x: 62, y: 12 }, { w: 4, h: 3, zone: 'departure' })).layout;
  const areaB = Object.values(l.terminalAreas).find((a) => a.terminalId === termB)!.id;
  l = must(placeFacility(l, 'agtStation', { x: 16, y: 12 }, { parentFacilityId: termA, floorIndex: -1, props: { systemId: sysId }, name: '本館駅' })).layout;
  const stA = Object.values(l.facilities).find((f) => f.name === '本館駅')!.id;
  l = must(placeFacility(l, 'agtStation', { x: 66, y: 12 }, { parentFacilityId: termB, floorIndex: -1, props: { systemId: sysId }, name: 'サテライト駅' })).layout;
  const stB = Object.values(l.facilities).find((f) => f.name === 'サテライト駅')!.id;
  l = must(addAgtSegment(l, { fromStationId: stA, toStationId: stB })).layout;
  const segId = Object.keys(l.agtSegments!)[0]!;
  return { layout: l, sysId, termA, termB, areaA, areaB, stA, stB, segId };
}

const codesFor = (layout: AirportLayout, id: string): string[] =>
  analyzeLayout(layout).byTarget[id]?.map((i) => i.code) ?? [];

describe('I1: 記録と保存形式', () => {
  it('系統・セグメントの記録が作られ、距離は駅中心間の直線 × TILE_M × 迂回係数で固定される', () => {
    const f = cdgFixture();
    const sys = f.layout.agtSystems![f.sysId]!;
    expect(sys).toMatchObject({ ...SYS, buildState: 'operational' });
    const seg = f.layout.agtSegments![f.segId]!;
    expect(seg.systemId).toBe(f.sysId);
    expect(seg.level).toBe(-1);
    // 駅中心 (17, 12.5) と (67, 12.5): 50 タイル
    expect(seg.distanceM).toBe(Math.round(50 * TILE_M * AGT_SEGMENT_DETOUR));
  });

  it('レイアウトの往復保存で AGT の記録が一致する', () => {
    const f = cdgFixture();
    const restored = importLayout(exportLayout(f.layout));
    expect(restored.agtSystems).toEqual(f.layout.agtSystems);
    expect(restored.agtSegments).toEqual(f.layout.agtSegments);
    expect(restored.facilities[f.stA]?.props.systemId).toBe(f.sysId);
  });

  it('AGT を含むプロジェクトは formatVersion 9、含まないプロジェクトは従来版のまま', () => {
    const f = cdgFixture();
    const projectOf = (layout: AirportLayout) =>
      buildProject({ name: 'agt', savedAt: '2026-11-21T00:00:00.000Z', layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    expect(formatVersionOf(projectOf(f.layout))).toBe(9);
    const parsed = JSON.parse(serializeProject(projectOf(f.layout))) as { formatVersion: number };
    expect(parsed.formatVersion).toBe(9);
    // AGT の記録と駅を取り除いたレイアウトは版 9 にならない
    const plain: AirportLayout = { ...f.layout, agtSystems: undefined, agtSegments: undefined };
    plain.facilities = Object.fromEntries(Object.entries(plain.facilities).filter(([, x]) => x.kind !== 'agtStation'));
    expect(formatVersionOf(projectOf(plain))).not.toBe(9);
  });

  it('AGT の項目が無い旧レイアウトはそのまま読める（欠落 = 空）', () => {
    let l = emptyLayout(40, 40);
    l = must(placeFacility(l, 'terminal', { x: 2, y: 2 }, { name: 'T' })).layout;
    const restored = importLayout(exportLayout(l));
    expect(restored.agtSystems).toBeUndefined();
    expect(restored.agtSegments).toBeUndefined();
  });

  it('形の壊れた AGT 記録は読み込みで拒否する', () => {
    const f = cdgFixture();
    const json = JSON.parse(exportLayout(f.layout)) as { layout: AirportLayout };
    (json.layout.agtSegments![f.segId] as { distanceM: number }).distanceM = -5;
    expect(() => importLayout(JSON.stringify(json))).toThrow();
  });
});

describe('I2: 生成・編集 op', () => {
  it('系統パラメータの範囲外は INVALID_VALUE で止まる', () => {
    const l = emptyLayout(40, 40);
    expect(addAgtSystem(l, { ...SYS, vehicleCapacity: 9 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(addAgtSystem(l, { ...SYS, vehicleCapacity: 601 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(addAgtSystem(l, { ...SYS, headwaySec: 29 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(addAgtSystem(l, { ...SYS, headwaySec: 1801 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(addAgtSystem(l, { ...SYS, dwellSec: 4 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(addAgtSystem(l, { ...SYS, dwellSec: 121 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(addAgtSystem(l, { ...SYS, speedMps: 4 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(addAgtSystem(l, { ...SYS, speedMps: 26 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(addAgtSystem(l, { ...SYS }).ok).toBe(true);
  });

  it('系統の更新でも範囲外は止まり、削除は駅・セグメントが残る間は止まる', () => {
    const f = cdgFixture();
    expect(updateAgtSystem(f.layout, f.sysId, { headwaySec: 10 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(updateAgtSystem(f.layout, f.sysId, { headwaySec: 240 }).ok).toBe(true);
    expect(deleteAgtSystem(f.layout, f.sysId)).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('セグメント: 系統が違う駅同士・重複・階の食い違い（暗黙）は INVALID_VALUE', () => {
    const f = cdgFixture();
    // 重複（逆向きも同じ辺）
    expect(addAgtSegment(f.layout, { fromStationId: f.stB, toStationId: f.stA })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    // 別の系統の駅
    let l = must(addAgtSystem(f.layout, { name: '2号線', vehicleCapacity: 50, headwaySec: 120, dwellSec: 15, speedMps: 8 })).layout;
    const sys2 = Object.keys(l.agtSystems!).find((id) => id !== f.sysId)!;
    l = must(placeFacility(l, 'agtStation', { x: 20, y: 12 }, { parentFacilityId: f.termA, floorIndex: -1, props: { systemId: sys2 }, name: '別系統駅' })).layout;
    const stOther = Object.values(l.facilities).find((x) => x.name === '別系統駅')!.id;
    expect(addAgtSegment(l, { fromStationId: f.stA, toStationId: stOther })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    // 階の違う駅（地上階の駅）とは、階を明示しない限り結べない
    l = must(placeFacility(l, 'agtStation', { x: 20, y: 15 }, { parentFacilityId: f.termA, floorIndex: 0, props: { systemId: f.sysId }, name: '地上駅' })).layout;
    const stGround = Object.values(l.facilities).find((x) => x.name === '地上駅')!.id;
    expect(addAgtSegment(l, { fromStationId: f.stA, toStationId: stGround })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(addAgtSegment(l, { fromStationId: f.stA, toStationId: stGround, level: 0 }).ok).toBe(true);
  });

  it('駅を削除するとセグメントも落ちる（finalize の剪定）', () => {
    const f = cdgFixture();
    const l = must(deleteEntity(f.layout, f.stA)).layout;
    expect(l.facilities[f.stA]).toBeUndefined();
    expect(Object.keys(l.agtSegments ?? {})).toHaveLength(0);
  });
});

describe('I3: 接続判定とプランナ統合（CDG 型レシピ）', () => {
  it('建物内の駅は同一階で辺を共有するエリアに接続する', () => {
    const f = cdgFixture();
    expect(agtStationConnectedAreas(f.layout, f.layout.facilities[f.stA]!)).toEqual([f.areaA]);
    expect(agtStationConnectedAreas(f.layout, f.layout.facilities[f.stB]!)).toEqual([f.areaB]);
  });

  it('AGT 経由の乗継が成立し、待ち時間・容量が式どおりになる', () => {
    const f = cdgFixture();
    const sys = f.layout.agtSystems![f.sysId]!;
    const seg = f.layout.agtSegments![f.segId]!;
    expect(agtSegmentTravelSec(sys, seg)).toBeCloseTo(180 / 2 + seg.distanceM / 10 + 20);
    expect(agtSegmentCapacityPerHour(sys)).toBe(2000);
    const route = findTerminalTransferRoute(f.layout, { fromAreaId: f.areaA, toAreaId: f.areaB, zone: 'departure' });
    expect(route).not.toBeNull();
    expect(route!.areas).toEqual([f.areaA, f.areaB]);
    expect(route!.connectionIds).toEqual([f.segId]);
    expect(route!.travelSec).toBeCloseTo(agtSegmentTravelSec(sys, seg));
    expect(route!.distanceM).toBe(seg.distanceM);
    expect(route!.capacityPerHour).toBe(2000);
    // 逆向きも同じ（無向）
    const back = findTerminalTransferRoute(f.layout, { fromAreaId: f.areaB, toAreaId: f.areaA, zone: 'departure' });
    expect(back?.connectionIds).toEqual([f.segId]);
  });

  it('閉鎖指定・未確認旅客・系統の未稼働では AGT の辺を使わない', () => {
    const f = cdgFixture();
    expect(findTerminalTransferRoute(f.layout, { fromAreaId: f.areaA, toAreaId: f.areaB, zone: 'departure', closedLinkIds: new Set([f.segId]) })).toBeNull();
    expect(findTerminalTransferRoute(f.layout, { fromAreaId: f.areaA, toAreaId: f.areaB, zone: 'departure', uncleared: true })).toBeNull();
    const stopped = must(updateAgtSystem(f.layout, f.sysId, { buildState: 'underConstruction' })).layout;
    expect(findTerminalTransferRoute(stopped, { fromAreaId: f.areaA, toAreaId: f.areaB, zone: 'departure' })).toBeNull();
  });

  it('単独駅は歩行ポータルで接続し、ポータルが無ければ経路に使われない', () => {
    let l = emptyLayout(120, 80);
    l = must(addAgtSystem(l, { ...SYS })).layout;
    const sysId = Object.keys(l.agtSystems!)[0]!;
    l = must(placeFacility(l, 'terminal', { x: 10, y: 40 }, { w: 16, h: 10, props: { levels: 2 }, name: 'C棟' })).layout;
    const termC = Object.values(l.facilities).find((f) => f.name === 'C棟')!.id;
    l = must(placeFacility(l, 'terminal', { x: 60, y: 40 }, { w: 16, h: 10, props: { levels: 2 }, name: 'D棟' })).layout;
    const termD = Object.values(l.facilities).find((f) => f.name === 'D棟')!.id;
    l = must(placeTerminalArea(l, termC, 0, 'hall', { x: 12, y: 42 }, { w: 4, h: 3, zone: 'departure' })).layout;
    const areaC = Object.values(l.terminalAreas).find((a) => a.terminalId === termC)!.id;
    l = must(placeTerminalArea(l, termD, 0, 'hall', { x: 62, y: 42 }, { w: 4, h: 3, zone: 'departure' })).layout;
    const areaD = Object.values(l.terminalAreas).find((a) => a.terminalId === termD)!.id;
    l = must(placeFacility(l, 'agtStation', { x: 16, y: 42 }, { parentFacilityId: termC, floorIndex: 0, props: { systemId: sysId }, name: 'C駅' })).layout;
    const stC = Object.values(l.facilities).find((f) => f.name === 'C駅')!.id;
    // D 側は単独駅（ターミナルの外）
    l = must(placeFacility(l, 'agtStation', { x: 56, y: 42 }, { props: { systemId: sysId }, name: 'D駅' })).layout;
    const stD = Object.values(l.facilities).find((f) => f.name === 'D駅')!.id;
    l = must(addAgtSegment(l, { fromStationId: stC, toStationId: stD })).layout;
    // ポータルが無い間は未接続で、経路は引けない
    expect(agtStationConnectedAreas(l, l.facilities[stD]!)).toEqual([]);
    expect(findTerminalTransferRoute(l, { fromAreaId: areaC, toAreaId: areaD, zone: 'departure' })).toBeNull();
    expect(codesFor(l, stD)).toContain('AGT_STATION_ORPHAN');
    // ポータルで接続すると経路が成立し、警告も消える
    l = must(addPortal(l, { facilityId: stD, areaId: areaD })).layout;
    expect(agtStationConnectedAreas(l, l.facilities[stD]!)).toEqual([areaD]);
    expect(findTerminalTransferRoute(l, { fromAreaId: areaC, toAreaId: areaD, zone: 'departure' })).not.toBeNull();
    expect(codesFor(l, stD)).not.toContain('AGT_STATION_ORPHAN');
  });
});

describe('I4: 状態表示への統合', () => {
  it('transitStatus に AGT セグメントが同列で出て、予約・待ちがセグメント ID で引ける', () => {
    const f = cdgFixture();
    const status = terminalTransitStatus(
      f.layout,
      buildTerminalModel(f.layout),
      { hour: 3, passengersByLink: { [f.segId]: 700 } },
      { [f.segId]: 9 },
    );
    const entry = status.find((s) => s.id === f.segId);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ capacityPerHour: 2000, reservedThisHour: 700, waitingPax: 9, fromTerminalId: f.termA, toTerminalId: f.termB });
  });
});

describe('I5/J-2: 検証コードと複合連絡施設の解決', () => {
  it('正しく組まれた CDG レシピでは AGT の検証コードは出ない', () => {
    const f = cdgFixture();
    for (const id of [f.sysId, f.stA, f.stB, f.segId]) {
      expect(codesFor(f.layout, id).filter((c) => c.startsWith('AGT_'))).toEqual([]);
    }
  });

  it('AGT_STATION_ISOLATED: セグメントが無い系統の駅で発火し、結ぶと消える', () => {
    let l = emptyLayout(120, 80);
    l = must(addAgtSystem(l, { ...SYS })).layout;
    const sysId = Object.keys(l.agtSystems!)[0]!;
    l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { w: 16, h: 10, props: { levels: 3 }, name: '本館' })).layout;
    const termA = Object.values(l.facilities).find((f) => f.name === '本館')!.id;
    l = must(placeTerminalArea(l, termA, -1, 'hall', { x: 12, y: 12 }, { w: 4, h: 3, zone: 'departure' })).layout;
    l = must(placeFacility(l, 'agtStation', { x: 16, y: 12 }, { parentFacilityId: termA, floorIndex: -1, props: { systemId: sysId }, name: '駅' })).layout;
    const st = Object.values(l.facilities).find((f) => f.name === '駅')!.id;
    expect(codesFor(l, st)).toContain('AGT_STATION_ISOLATED');
    expect(codesFor(l, st)).not.toContain('AGT_STATION_ORPHAN');
    const f = cdgFixture();
    expect(codesFor(f.layout, f.stA)).not.toContain('AGT_STATION_ISOLATED');
  });

  it('AGT_SEGMENT_ENDPOINT / AGT_LEVEL_MISMATCH / AGT_PARAM_RANGE が手編集の不整合で発火する', () => {
    const f = cdgFixture();
    const broken: AirportLayout = structuredClone(f.layout);
    // 駅の所属系統を外す → 端点不整合
    broken.facilities[f.stB]!.props.systemId = null;
    expect(codesFor(broken, f.segId)).toContain('AGT_SEGMENT_ENDPOINT');
    // セグメントの階をずらす → 階不一致
    const broken2: AirportLayout = structuredClone(f.layout);
    broken2.agtSegments![f.segId]!.level = 0;
    expect(codesFor(broken2, f.segId)).toContain('AGT_LEVEL_MISMATCH');
    // 系統パラメータの範囲外
    const broken3: AirportLayout = structuredClone(f.layout);
    broken3.agtSystems![f.sysId]!.vehicleCapacity = 5;
    expect(codesFor(broken3, f.sysId)).toContain('AGT_PARAM_RANGE');
  });

  it('AGT_CLEARANCE: 宣言なしの高架は全体基準、宣言 C はデッキ床高 18m（階層 +3）で足りる', () => {
    const f = cdgFixture();
    const elevated: AirportLayout = structuredClone(f.layout);
    elevated.agtSegments![f.segId]!.level = 1;
    expect(codesFor(elevated, f.segId)).toContain('AGT_CLEARANCE');
    const declared: AirportLayout = structuredClone(f.layout);
    declared.agtSegments![f.segId]!.level = 3;
    declared.agtSegments![f.segId]!.crossingMaxCode = 'C';
    expect(codesFor(declared, f.segId)).not.toContain('AGT_CLEARANCE');
    const declaredLow: AirportLayout = structuredClone(f.layout);
    declaredLow.agtSegments![f.segId]!.level = 2;
    declaredLow.agtSegments![f.segId]!.crossingMaxCode = 'C';
    expect(codesFor(declaredLow, f.segId)).toContain('AGT_CLEARANCE');
  });

  it('J-2: AGT セグメントを束ねた複合連絡施設は DANGLING にならず、費用にセグメント分が入る', () => {
    const f = cdgFixture();
    const r = groupAgtConnectionFacility(f.layout, { name: 'AGT 連絡', segmentId: f.segId });
    expect(r.ok).toBe(true);
    const cfId = r.ok ? r.created[0]! : '';
    const cf = (r.ok ? r.layout : f.layout).connectionFacilities?.[cfId];
    expect(cf?.segment).toEqual({ kind: 'agt', segmentId: f.segId });
    expect(codesFor(r.ok ? r.layout : f.layout, cfId)).not.toContain('CONNECTION_FACILITY_DANGLING');
    expect(connectionFacilityCost(r.ok ? r.layout : f.layout, cfId)).toBeGreaterThan(0);
    // 存在しないセグメントを指す記録は従来どおり DANGLING
    const dangling: AirportLayout = structuredClone(f.layout);
    dangling.connectionFacilities = {
      cf_x: { id: 'cf_x', name: '壊れた記録', segment: { kind: 'agt', segmentId: 'agseg_missing' }, aVerticalAreaIds: [], bVerticalAreaIds: [], stepFree: true },
    };
    expect(codesFor(dangling, 'cf_x')).toContain('CONNECTION_FACILITY_DANGLING');
  });
});

describe('I7: 経済', () => {
  it('駅は固定費、地下セグメントは距離単価 × 距離 × 掘削係数で資産に入る', () => {
    const f = cdgFixture();
    expect(facilityValue(f.layout.facilities[f.stA]!)).toBe(BALANCE.construction.agt.station);
    const seg = f.layout.agtSegments![f.segId]!;
    const items = layoutItems(f.layout);
    expect(items[f.segId]).toBe(Math.round(seg.distanceM * BALANCE.construction.agt.segmentPerMeter * BALANCE.construction.undergroundTerminalPerFloor));
    expect(items[f.stA]).toBe(BALANCE.construction.agt.station);
  });

  it('運営費は 編成数 × 180,000 + 駅数 × 20,000 で、AGT の無い空港では現れない', () => {
    const f = cdgFixture();
    const sys = f.layout.agtSystems![f.sysId]!;
    expect(agtSystemTrainsets(f.layout, sys)).toBe(2);
    const fixed = dailyFixedCosts(createContext(f.layout));
    expect(fixed.agtOps).toBe(2 * BALANCE.daily.agt.trainsetPerDay + 2 * BALANCE.daily.agt.stationPerDay);
    const plain = dailyFixedCosts(createContext(emptyLayout(40, 40)));
    expect(plain.agtOps).toBeUndefined();
  });
});
