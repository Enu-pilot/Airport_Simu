import { describe, expect, it } from 'vitest';
import {
  addRoadPath,
  addTaxiwayPath,
  addTerminalTransitLink,
  placeFacility,
  placeRunway,
  placeStand,
  placeTerminalArea,
  type OpResult,
} from '../../src/core/layout/operations';
import { analyzeLayout } from '../../src/core/validation/validate';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import type { AirportLayout } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * 5-10: 個別テストのなかった検証コード 29 種のカバレッジ。
 * 各テストは「そのコードが実際に出る最小構成」を作り、analyzeLayout の結果に含まれることを assert する。
 */
const codes = (l: AirportLayout) => analyzeLayout(l).issues.map((i) => i.code);
const codesFor = (l: AirportLayout, id: string) => (analyzeLayout(l).byTarget[id] ?? []).map((i) => i.code);

/** 誘導路で滑走路とつながった最小構成（スポット1つ、地上支援施設なし） */
function minimalAirport(): AirportLayout {
  let l = emptyLayout(100, 60);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeRunway(l, { x: 10, y: 10 }, 90, 80, { surfaceWidthM: 45 }));
  step(addTaxiwayPath(l, [{ x: 20, y: 10 }, { x: 20, y: 20 }, { x: 40, y: 20 }], { widthClass: 'M' }));
  step(placeFacility(l, 'apron', { x: 25, y: 21 }, { w: 12, h: 8 }));
  step(placeStand(l, { x: 29, y: 21 }, 'M', 180)); // 入口 (30, 20)
  return l;
}

/** エリアもゲートもないターミナルだけの構成 */
function bareTerminal(): { layout: AirportLayout; terminalId: string } {
  const r = must(placeFacility(emptyLayout(), 'terminal', { x: 30, y: 30 }));
  return { layout: r.layout, terminalId: r.created[0]! };
}

describe('ネットワーク形状の検証コード', () => {
  it('DUPLICATE_NODE: 同じ位置・階層にノードが 2 つある', () => {
    const l = must(addTaxiwayPath(emptyLayout(), [{ x: 10, y: 10 }, { x: 20, y: 10 }])).layout;
    const n = Object.values(l.taxiNodes)[0]!;
    l.taxiNodes['tn_dup'] = { ...n, id: 'tn_dup' };
    const iss = analyzeLayout(l).issues.find((i) => i.code === 'DUPLICATE_NODE');
    expect(iss).toBeDefined();
    expect(iss!.targets).toEqual(expect.arrayContaining([n.id, 'tn_dup']));
  });

  it('DUPLICATE_EDGE: 同じ両端を持つ区間が 2 本ある', () => {
    const l = must(addTaxiwayPath(emptyLayout(), [{ x: 10, y: 10 }, { x: 20, y: 10 }])).layout;
    const e = Object.values(l.taxiways)[0]!;
    l.taxiways['tw_dup'] = { ...e, id: 'tw_dup' };
    const iss = analyzeLayout(l).issues.find((i) => i.code === 'DUPLICATE_EDGE');
    expect(iss).toBeDefined();
    expect(iss!.targets).toEqual(expect.arrayContaining([e.id, 'tw_dup']));
  });

  it('TAXIWAY_OVERLAP: ノードを共有せず同一直線上で重なる誘導路', () => {
    const l = emptyLayout();
    const node = (id: string, x: number, y: number) => {
      l.taxiNodes[id] = { id, pos: { x, y }, name: '', holdShort: false };
    };
    node('tn_a', 0, 10);
    node('tn_b', 20, 10);
    node('tn_c', 10, 10);
    node('tn_d', 30, 10);
    l.taxiways['tw_1'] = { id: 'tw_1', from: 'tn_a', to: 'tn_b', name: '', widthClass: 'M', oneWay: false, buildState: 'operational' };
    l.taxiways['tw_2'] = { id: 'tw_2', from: 'tn_c', to: 'tn_d', name: '', widthClass: 'M', oneWay: false, buildState: 'operational' };
    const iss = analyzeLayout(l).issues.find((i) => i.code === 'TAXIWAY_OVERLAP');
    expect(iss).toBeDefined();
    expect(iss!.targets).toEqual(expect.arrayContaining(['tw_1', 'tw_2']));
  });

  it('TAXIWAY_DEAD_END: 接続が 1 本だけの誘導路ノードは行き止まり', () => {
    const l = must(addTaxiwayPath(emptyLayout(), [{ x: 10, y: 10 }, { x: 20, y: 10 }])).layout;
    expect(codes(l)).toContain('TAXIWAY_DEAD_END');
  });

  it('ROAD_CROSSING_NO_JUNCTION: 交点にノードがない道路の交差', () => {
    const l = emptyLayout();
    const node = (id: string, x: number, y: number) => {
      l.roadNodes[id] = { id, pos: { x, y }, name: '', holdShort: false };
    };
    node('rn_a', 0, 20);
    node('rn_b', 20, 20);
    node('rn_c', 10, 10);
    node('rn_d', 10, 30);
    l.roads['rd_1'] = { id: 'rd_1', from: 'rn_a', to: 'rn_b', name: '', roadClass: 'public', oneWay: false, buildState: 'operational' };
    l.roads['rd_2'] = { id: 'rd_2', from: 'rn_c', to: 'rn_d', name: '', roadClass: 'public', oneWay: false, buildState: 'operational' };
    const iss = analyzeLayout(l).issues.find((i) => i.code === 'ROAD_CROSSING_NO_JUNCTION');
    expect(iss).toBeDefined();
    expect(iss!.targets).toEqual(expect.arrayContaining(['rd_1', 'rd_2']));
  });

  it('ROAD_LAYER_CONNECTION_INVALID: 道路区間の能力値が不正', () => {
    const l = must(addRoadPath(emptyLayout(), [{ x: 10, y: 10 }, { x: 20, y: 10 }])).layout;
    const e = Object.values(l.roads)[0]!;
    l.roads[e.id] = { ...e, capacityPerHour: -1 };
    expect(codesFor(l, e.id)).toContain('ROAD_LAYER_CONNECTION_INVALID');
  });
});

describe('地上支援施設の不足', () => {
  it('NO_GSE_BASE: スポットがあるのに GSE 基地がない', () => {
    expect(codes(minimalAirport())).toContain('NO_GSE_BASE');
  });

  it('NO_FUEL_FARM: スポットがあるのに燃料施設がない', () => {
    expect(codes(minimalAirport())).toContain('NO_FUEL_FARM');
  });

  it('NO_MAINTENANCE: スポットがあるのに整備施設がない', () => {
    expect(codes(minimalAirport())).toContain('NO_MAINTENANCE');
  });

  it('NO_BAGGAGE_SORT: チェックインがあるのに手荷物仕分け場がない', () => {
    const l = createSampleAirport();
    const sort = Object.values(l.facilities).find((f) => f.kind === 'baggageSort')!;
    delete l.facilities[sort.id];
    expect(codes(l)).toContain('NO_BAGGAGE_SORT');
  });

  it('PARKING_NO_ROAD: 道路に接していない駐車場', () => {
    const r = must(placeFacility(emptyLayout(), 'parking', { x: 30, y: 30 }));
    expect(codesFor(r.layout, r.created[0]!)).toContain('PARKING_NO_ROAD');
  });
});

describe('ターミナルの必須エリアとゲート', () => {
  it('TERMINAL_NO_ENTRANCE: 入口エリアのないターミナル', () => {
    const { layout, terminalId } = bareTerminal();
    expect(codesFor(layout, terminalId)).toContain('TERMINAL_NO_ENTRANCE');
  });

  it('TERMINAL_NO_EXIT: 出口エリアのないターミナル', () => {
    const { layout, terminalId } = bareTerminal();
    expect(codesFor(layout, terminalId)).toContain('TERMINAL_NO_EXIT');
  });

  it('TERMINAL_NO_CHECKIN: チェックインエリアのないターミナル', () => {
    const { layout, terminalId } = bareTerminal();
    expect(codesFor(layout, terminalId)).toContain('TERMINAL_NO_CHECKIN');
  });

  it('TERMINAL_NO_SECURITY: 保安検査エリアのないターミナル', () => {
    const { layout, terminalId } = bareTerminal();
    expect(codesFor(layout, terminalId)).toContain('TERMINAL_NO_SECURITY');
  });

  it('TERMINAL_NO_BAGGAGE_CLAIM: 手荷物受取エリアのないターミナル', () => {
    const { layout, terminalId } = bareTerminal();
    expect(codesFor(layout, terminalId)).toContain('TERMINAL_NO_BAGGAGE_CLAIM');
  });

  it('TERMINAL_NO_GATE: 隣接ゲートのないターミナル', () => {
    const { layout, terminalId } = bareTerminal();
    expect(codesFor(layout, terminalId)).toContain('TERMINAL_NO_GATE');
  });

  it('SECURITY_NOT_CONNECTED: 保安検査場が一般区域・出発区域のどちらにも接していない', () => {
    const { layout, terminalId } = bareTerminal();
    const r = must(placeTerminalArea(layout, terminalId, 0, 'security', { x: 32, y: 32 }, { w: 4, h: 2, props: { lanes: 2 } }));
    expect(codesFor(r.layout, r.created[0]!)).toContain('SECURITY_NOT_CONNECTED');
  });

  it('TERMINAL_AREA_OUTSIDE: ターミナルの敷地からはみ出したエリア', () => {
    const l = createSampleAirport();
    const a = Object.values(l.terminalAreas).find((x) => x.kind === 'arrivalCorridor')!;
    a.origin = { x: 0, y: 0 };
    expect(codesFor(l, a.id)).toContain('TERMINAL_AREA_OUTSIDE');
  });

  it('TERMINAL_AREA_OVERLAP: 同じターミナル・同じ階で重なるエリア', () => {
    const l = createSampleAirport();
    const w = Object.values(l.terminalAreas).find((x) => x.kind === 'waiting')!;
    l.terminalAreas['ta_dup'] = { ...w, id: 'ta_dup' };
    const iss = analyzeLayout(l).issues.find((i) => i.code === 'TERMINAL_AREA_OVERLAP');
    expect(iss).toBeDefined();
    expect(iss!.targets).toEqual(expect.arrayContaining([w.id, 'ta_dup']));
  });

  it('TERMINAL_LINK_CLEARANCE: 高架連絡通路の桁下・標高が不足', () => {
    let l = emptyLayout(80, 60);
    const step = (r: OpResult) => (l = must(r).layout);
    step(placeFacility(l, 'terminal', { x: 2, y: 2 }, { name: 'Terminal A' }));
    const fromTerminalId = Object.values(l.facilities).find((f) => f.name === 'Terminal A')!.id;
    step(placeFacility(l, 'terminal', { x: 35, y: 2 }, { name: 'Terminal B' }));
    const toTerminalId = Object.values(l.facilities).find((f) => f.name === 'Terminal B')!.id;
    step(placeTerminalArea(l, fromTerminalId, 0, 'departureLobby', { x: 2, y: 2 }));
    const fromAreaId = Object.values(l.terminalAreas).find((a) => a.terminalId === fromTerminalId)!.id;
    step(placeTerminalArea(l, toTerminalId, 0, 'departureLobby', { x: 35, y: 2 }));
    const toAreaId = Object.values(l.terminalAreas).find((a) => a.terminalId === toTerminalId)!.id;
    const r = addTerminalTransitLink(l, {
      kind: 'elevatedWalkway',
      fromAreaId,
      toAreaId,
      distanceM: 100,
      travelSec: 60,
      capacityPerHour: 100,
      elevationM: 45,
      aircraftClearanceM: 40,
      allowedZones: ['departure'],
    });
    const placed = must(r);
    l = placed.layout;
    const linkId = placed.created[0]!;
    // 配置操作では弾かれる不正な桁下（既存データ向けの検証）
    l.terminalLinks![linkId] = { ...l.terminalLinks![linkId]!, aircraftClearanceM: 1 };
    expect(codesFor(l, linkId)).toContain('TERMINAL_LINK_CLEARANCE');
  });

  it('GATE_NO_ARRIVAL_ACCESS: ゲートに接する到着側エリアがない', () => {
    const l = createSampleAirport();
    for (const a of Object.values(l.terminalAreas)) if (a.kind === 'arrivalCorridor') delete l.terminalAreas[a.id];
    const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
    expect(codesFor(l, gate.id)).toContain('GATE_NO_ARRIVAL_ACCESS');
  });

  it('GATE_ARRIVAL_NO_EXIT: 降機口から出口への経路がない', () => {
    const l = createSampleAirport();
    for (const a of Object.values(l.terminalAreas)) if (a.kind === 'exit') delete l.terminalAreas[a.id];
    const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
    expect(codesFor(l, gate.id)).toContain('GATE_ARRIVAL_NO_EXIT');
  });
});

describe('スポットとゲートの対応', () => {
  it('STAND_REMOTE: ゲートのないスポットはリモート扱い', () => {
    expect(codesFor(minimalAirport(), 'std_1')).toContain('STAND_REMOTE');
  });

  it('STAND_MULTIPLE_GATES: 1 つのスポットに 2 つのゲート', () => {
    let l = minimalAirport();
    const step = (r: OpResult) => (l = must(r).layout);
    step(placeFacility(l, 'gate', { x: 60, y: 50 }, { props: { standId: 'std_1' } }));
    step(placeFacility(l, 'gate', { x: 62, y: 50 }, { props: { standId: 'std_1' } }));
    const iss = analyzeLayout(l).issues.find((i) => i.code === 'STAND_MULTIPLE_GATES');
    expect(iss).toBeDefined();
    expect(iss!.targets[0]).toBe('std_1');
    expect(iss!.targets).toHaveLength(3);
  });

  it('STAND_BUS_NO_GATE: 複数ターミナルがあるのにバスゲートがないリモートスポット', () => {
    let l = minimalAirport();
    const step = (r: OpResult) => (l = must(r).layout);
    step(placeFacility(l, 'terminal', { x: 60, y: 40 }));
    step(placeFacility(l, 'terminal', { x: 55, y: 25 }));
    expect(codesFor(l, 'std_1')).toContain('STAND_BUS_NO_GATE');
  });
});

describe('空港アクセスの検証コード', () => {
  it('ACCESS_FAR_FROM_TERMINAL: ターミナルから歩ける距離を超えた交通施設', () => {
    let l = emptyLayout(120, 80);
    const step = (r: OpResult) => (l = must(r).layout);
    step(placeFacility(l, 'terminal', { x: 95, y: 60 }));
    const placed = must(placeFacility(l, 'hotel', { x: 5, y: 5 }));
    l = placed.layout;
    expect(codesFor(l, placed.created[0]!)).toContain('ACCESS_FAR_FROM_TERMINAL');
  });

  it('ACCESS_ROUTE_UNREACHABLE: 鉄道駅からターミナルへ歩行路がつながっていない', () => {
    let l = emptyLayout(100, 60);
    const step = (r: OpResult) => (l = must(r).layout);
    step(placeFacility(l, 'terminal', { x: 60, y: 40 }));
    const st = must(placeFacility(l, 'railStation', { x: 10, y: 10 }));
    l = st.layout;
    // 駅（y10〜12）に接する鉄道を敷地端まで引く
    step(addRoadPath(l, [{ x: 0, y: 13 }, { x: 30, y: 13 }], { roadClass: 'rail' }));
    // 歩行路はあるが駅・ターミナルのどちらにもつながっていない
    step(addRoadPath(l, [{ x: 50, y: 50 }, { x: 60, y: 50 }], { roadClass: 'walkway' }));
    expect(codesFor(l, st.created[0]!)).toContain('ACCESS_ROUTE_UNREACHABLE');
  });
});

describe('施設の階層', () => {
  it('FACILITY_INTERIOR_INVALID: 親施設が存在しない内部設備', () => {
    let l = must(placeFacility(emptyLayout(), 'terminal', { x: 30, y: 30 }, { props: { levels: 2 } })).layout;
    l = must(placeFacility(l, 'baggageSort', { x: 30, y: 30 }, { parentFacilityId: 'fac_1', floorIndex: 0 })).layout;
    const child = Object.values(l.facilities).find((f) => f.parentFacilityId)!;
    // 配置操作では作れない壊れた参照（既存データ向けの検証）
    child.parentFacilityId = 'fac_999';
    expect(codesFor(l, child.id)).toContain('FACILITY_INTERIOR_INVALID');
  });
});
