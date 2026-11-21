import { describe, expect, it } from 'vitest';
import { addRoadPath, connectRoadLevels, placeFacility, updateEntity } from '../../src/core/layout/operations';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { analyzeAccess } from '../../src/core/access/model';
import { buildLandsideNetwork } from '../../src/core/access/landside';
import { analyzeSegments, railEdgeCapacity } from '../../src/core/access/segments';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { accessDeparture } from '../../src/core/access/runtime';
import { createSandboxCompany } from '../../src/core/economy/company';
import { createSimulation } from '../../src/core/sim/simulation';
import type { PaxGroup } from '../../src/core/sim/types';
import type { AirportLayout, RoadEdge } from '../../src/core/model/types';
import { must } from './helpers';

const seg = (l: AirportLayout): AirportLayout => ({ ...l, accessCapacityModel: 'segment' });

/** 条件に合う道路の辺を探す（パスは途中のノードで分割されるので座標の完全一致では探さない） */
function edgeWhere(l: AirportLayout, pred: (e: AirportLayout['roads'][string], a: { x: number; y: number }, b: { x: number; y: number }) => boolean): string {
  return Object.values(l.roads).find((e) => pred(e, l.roadNodes[e.from]!.pos, l.roadNodes[e.to]!.pos))!.id;
}
/** y=57 の横方向の一般道路（ターミナル前の車寄せの区間） */
const horizontalRoad = (l: AirportLayout): string => edgeWhere(l, (e, a, b) => e.roadClass === 'public' && a.y === 57 && b.y === 57);
/** x=76 の縦方向の一般道路（出入口の区間） */
const entranceRoad = (l: AirportLayout): string => edgeWhere(l, (e, a, b) => e.roadClass === 'public' && a.x === 76 && b.x === 76);
/** 鉄道の区間 */
const railRoad = (l: AirportLayout): string => edgeWhere(l, (e) => e.roadClass === 'rail');

function withParking(l: AirportLayout): AirportLayout {
  return must(placeFacility(l, 'parking', { x: 60, y: 58 }, { props: { spaces: 100 } })).layout;
}
function withRail(l: AirportLayout, stationProps: Record<string, number> = { trainsPerHour: 10, platforms: 3 }): AirportLayout {
  let out = must(addRoadPath(l, [{ x: 70, y: 61 }, { x: 70, y: 105 }], { roadClass: 'rail', name: '空港線' })).layout;
  out = must(placeFacility(out, 'railStation', { x: 68, y: 58 }, { props: stationProps })).layout;
  return out;
}

describe('accessSegments: 区間能力の解析（4E / §6.2）', () => {
  it('設定がなければ区間解析は付かず、集約の値は従来どおり', () => {
    const a = analyzeAccess(withRail(createStarterAirfield()));
    expect(a.segments).toBeUndefined();
    expect(a.trainsPerHour).toBe(10);
    expect(a.roadCapacityPerHour).toBe(900);
  });

  it('最も細い区間が車寄せの上限になる', () => {
    const base = createStarterAirfield();
    const a = analyzeAccess(seg(base));
    expect(a.segments).toBeDefined();
    // 出入口 1 本・全区間 1 車線（900 台/時）→ 車寄せ 900
    expect(a.segments!.curbCapacity).toBe(900);
    const horizontal = horizontalRoad(base);
    const narrowed = must(updateEntity(base, horizontal, { capacityPerHour: 300 })).layout;
    const a2 = analyzeAccess(seg(narrowed));
    expect(a2.segments!.curbCapacity).toBe(300);
    expect(a2.segments!.bottleneckEdgeId).toBe(horizontal);
    // 集約の値は比較用に残る
    expect(a2.roadCapacityPerHour).toBe(900);
  });

  it('車線を増やすとその区間の能力が上がる（別の区間が細ければそちらが上限）', () => {
    const base = createStarterAirfield();
    const entrance = entranceRoad(base);
    const widened = must(updateEntity(base, entrance, { lanes: 2 })).layout;
    const a = analyzeAccess(seg(widened));
    expect(a.segments!.edges[entrance]!.capacity).toBe(1800);
    expect(a.segments!.curbCapacity).toBe(900); // 横の区間（900）が上限のまま
  });

  it('駐車場の能力も経路のボトルネックで決まる', () => {
    const base = withParking(createStarterAirfield());
    const a = analyzeAccess(seg(base));
    expect(a.segments!.parkingCapacity).toBe(900);
    expect(Object.keys(a.segments!.parkingPaths)).toHaveLength(1);
  });

  it('鉄道: 単線 < 複線、ホーム数が上限になる', () => {
    const base = withRail(createStarterAirfield());
    const railEdge = railRoad(base);
    // 単線（4 本/時）が宣言 10 本・ホーム 3 × 6 = 18 本より細い
    expect(analyzeAccess(seg(base)).trainsPerHour).toBe(4);
    const double = must(updateEntity(base, railEdge, { tracks: 2 })).layout;
    expect(analyzeAccess(seg(double)).trainsPerHour).toBe(10);
    // ホーム 1 つ（6 本/時）にするとそちらが上限
    const onePlatform = withRail(createStarterAirfield(), { trainsPerHour: 10, platforms: 1 });
    const dbl = must(updateEntity(onePlatform, railRoad(onePlatform), { tracks: 2 })).layout;
    const a = analyzeAccess(seg(dbl));
    expect(a.segments!.railPlatformCapacity).toBe(6);
    expect(a.trainsPerHour).toBe(6);
  });
});

describe('accessSegments: 鉄道の複々線（2026-QT）', () => {
  const edge = (patch: Partial<RoadEdge>): RoadEdge => ({ id: 'e', from: 'a', to: 'b', name: '', roadClass: 'rail', oneWay: false, buildState: 'operational', ...patch });

  it('railEdgeCapacity: 単線 4・複線 12・複々線 24、明示能力が最優先', () => {
    expect(railEdgeCapacity(edge({}))).toBe(4);
    expect(railEdgeCapacity(edge({ tracks: 1 }))).toBe(4);
    expect(railEdgeCapacity(edge({ tracks: 2 }))).toBe(12);
    expect(railEdgeCapacity(edge({ tracks: 4 }))).toBe(24);
    expect(railEdgeCapacity(edge({ tracks: 4, capacityPerHour: 30 }))).toBe(30);
    expect(railEdgeCapacity(edge({ tracks: 1, capacityPerHour: 9 }))).toBe(9);
  });

  it('線路数は 4 を受理し、3 を拒否する', () => {
    const base = withRail(createStarterAirfield());
    const railEdge = railRoad(base);
    const quad = must(updateEntity(base, railEdge, { tracks: 4 })).layout;
    expect(quad.roads[railEdge]!.tracks).toBe(4);
    expect(updateEntity(base, railEdge, { tracks: 3 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  /** 駅 2 つ（宣言 20 ずつ・ホームは引数）を同じ 1 本の線路に付けたレイアウト */
  function withTwoStations(platforms: number): AirportLayout {
    let layout = withRail(createStarterAirfield(), { trainsPerHour: 20, platforms });
    layout = must(placeFacility(layout, 'railStation', { x: 71, y: 75 }, { props: { trainsPerHour: 20, platforms } })).layout;
    return layout;
  }

  it('区間モデル: 複々線の入口ボトルネックは 24 本/時（複線は 12 で頭打ち）', () => {
    const base = withTwoStations(4); // 宣言 40・ホーム能力 48 で線路側だけを律速にする
    const railEdge = railRoad(base);
    const dbl = must(updateEntity(base, railEdge, { tracks: 2 })).layout;
    expect(analyzeSegments(dbl, buildLandsideNetwork(dbl)).railTrainsPerHour).toBe(12);
    const quad = must(updateEntity(base, railEdge, { tracks: 4 })).layout;
    const segs = analyzeSegments(quad, buildLandsideNetwork(quad));
    expect(segs.railDeclaredTrainsPerHour).toBe(40);
    expect(segs.railPlatformCapacity).toBe(48);
    expect(segs.railTrainsPerHour).toBe(24);
  });

  it('区間モデル: ホームが細ければ複々線でも駅側が頭打ちになる', () => {
    const base = withTwoStations(1); // ホーム能力 6 × 2 駅 = 12
    const quad = must(updateEntity(base, railRoad(base), { tracks: 4 })).layout;
    const segs = analyzeSegments(quad, buildLandsideNetwork(quad));
    expect(segs.railPlatformCapacity).toBe(12);
    expect(segs.railTrainsPerHour).toBe(12);
  });

  it('集約モデルでは線路数は効かず、宣言の合算のまま', () => {
    const base = withRail(createStarterAirfield());
    const quad = must(updateEntity(base, railRoad(base), { tracks: 4 })).layout;
    expect(analyzeAccess(quad).trainsPerHour).toBe(10);
    // 区間モデルでも宣言 10 が複々線 24 より細ければ宣言が上限のまま
    expect(analyzeAccess(seg(quad)).trainsPerHour).toBe(10);
  });

  it('tracks = 4 は保存/読込で往復する', () => {
    const base = withRail(createStarterAirfield());
    const railEdge = railRoad(base);
    const quad = must(updateEntity(base, railEdge, { tracks: 4 })).layout;
    const restored = importLayout(exportLayout(quad));
    expect(restored.roads[railEdge]!.tracks).toBe(4);
    expect(railEdgeCapacity(restored.roads[railEdge]!)).toBe(24);
  });
});

describe('accessSegments: 運航中の区間の遅れ（4E / §6.3）', () => {
  it('区間の交通量が増えると送迎の遅れが増え、辺ごとの台数が記録される', () => {
    const layout = seg(createStarterAirfield());
    const sim = createSimulation(layout, { company: createSandboxCompany('seg-run'), seed: 'seg-run' });
    const acc = sim.state.access!;
    expect(acc.segments).toBeDefined();
    for (const m of Object.keys(acc.shares) as (keyof typeof acc.shares)[]) acc.shares[m] = m === 'dropoff' ? 1 : 0;
    const group = (id: string): PaxGroup => ({ id, count: 2, walkSec: 0 }) as unknown as PaxGroup;
    const first = accessDeparture(sim, group('g0'));
    let last = first;
    for (let i = 1; i <= 700; i++) last = accessDeparture(sim, group(`g${i}`));
    expect(last).toBeGreaterThan(first);
    expect(Object.keys(acc.hourly).some((k) => k.startsWith('seg:'))).toBe(true);
  });

  it('4-12: 区間モデルのとき、連絡通路の能力が鉄道の受け入れ上限になる', () => {
    const endpoint = (l: AirportLayout, level: number, x: number, y: number) =>
      Object.values(l.roadNodes).find((n) => (n.level ?? 0) === level && n.pos.x === x && n.pos.y === y)!.id;
    let layout = createStarterAirfield();
    layout = must(placeFacility(layout, 'railStation', { x: 68, y: 58 }, { name: '地下駅', props: { level: -1, trainsPerHour: 10 } })).layout;
    layout = must(addRoadPath(layout, [{ x: 70, y: 60 }, { x: 70, y: 105 }], { roadClass: 'rail', level: -1 })).layout;
    layout = must(addRoadPath(layout, [{ x: 66, y: 56 }, { x: 70, y: 56 }, { x: 70, y: 58 }], { roadClass: 'walkway', level: 0, capacityPerHour: 100 })).layout;
    layout = must(addRoadPath(layout, [{ x: 70, y: 58 }, { x: 70, y: 60 }], { roadClass: 'walkway', level: -1, capacityPerHour: 100 })).layout;
    layout = must(connectRoadLevels(layout, endpoint(layout, 0, 70, 58), endpoint(layout, -1, 70, 58), { roadClass: 'walkway', connectorKind: 'elevator', capacityPerHour: 100 })).layout;
    expect(analyzeAccess(layout).railWalkCapacityPerHour).toBe(100);

    const simSeg = createSimulation(seg(layout), { company: createSandboxCompany('seg-rail'), seed: 'seg-rail' });
    expect(simSeg.state.access!.railCapPerHour).toBe(100);
    const simAgg = createSimulation(layout, { company: createSandboxCompany('seg-rail'), seed: 'seg-rail' });
    expect(simAgg.state.access!.railCapPerHour).toBeUndefined();
  });
});
