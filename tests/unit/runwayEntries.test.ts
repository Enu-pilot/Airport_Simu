import { describe, expect, it } from 'vitest';
import {
  addTaxiwayPath,
  placeFacility,
  placeRunway,
  placeStand,
  type OpResult,
} from '../../src/core/layout/operations';
import { buildAirsideNetwork } from '../../src/core/airside/network';
import { departureReachableRunwayNodes, runwayEntryInfos } from '../../src/core/airside/runwayEntries';
import { analyzeLayout, type Issue } from '../../src/core/validation/validate';
import { checkRunway } from '../../src/core/aircraft/compat';
import { AIRCRAFT_TYPES, takeoffDistanceM } from '../../src/core/sim/aircraftTypes';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import type { AirportLayout, Runway } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/** その滑走路を使える機種の離陸滑走距離の最大（期待値の算出用。診断側と同じ公開関数の組み合わせ） */
function expectedNeed(r: Runway): number {
  let best = 0;
  for (const t of Object.values(AIRCRAFT_TYPES)) {
    if (checkRunway(t, r).status !== 'ok') continue;
    best = Math.max(best, takeoffDistanceM(t));
  }
  return best;
}

const newIssues = (l: AirportLayout): Issue[] =>
  analyzeLayout(l).issues.filter((i) => i.code === 'RUNWAY_ENTRY_ALL_SHORT' || i.code === 'STAND_NO_DEPARTURE_ENTRY');

/** 2875m・幅 60m の滑走路に、中央付近の入口 1 件だけでつながる L スポットを置いた構成 */
function midEntryOnlyAirport(): AirportLayout {
  let l: AirportLayout = emptyLayout(160, 60);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeRunway(l, { x: 10, y: 10 }, 90, 115, { surfaceWidthM: 60 }));
  step(addTaxiwayPath(l, [{ x: 67, y: 10 }, { x: 67, y: 20 }, { x: 90, y: 20 }], { widthClass: 'L' }));
  step(placeFacility(l, 'apron', { x: 75, y: 21 }, { w: 14, h: 9 }));
  step(placeStand(l, { x: 79, y: 21 }, 'L', 180));
  return l;
}

describe('runwayEntryInfos（入口ごとの方向別残り長さ）', () => {
  it('スターター空港: 両端と中央の入口で残り長さが方向ごとに入れ替わる', () => {
    const net = buildAirsideNetwork(createStarterAirfield());
    const infos = runwayEntryInfos(net, 'rwy_1');
    expect(infos.map((i) => i.distFromStartM)).toEqual([0, 1050, 2100]);
    expect(infos.map((i) => i.remainingForwardM)).toEqual([2100, 1050, 0]);
    expect(infos.map((i) => i.remainingReverseM)).toEqual([0, 1050, 2100]);
    expect(infos.every((i) => i.hasTaxiwayLink)).toBe(true);
    expect(infos.every((i) => i.lengthM === 2100)).toBe(true);
  });

  it('誘導路が付かない滑走路ノードは hasTaxiwayLink が false', () => {
    const l = midEntryOnlyAirport();
    const net = buildAirsideNetwork(l);
    const infos = runwayEntryInfos(net, 'rwy_1');
    // 合成スレッショルド 2 件 + 中央入口 1 件
    expect(infos).toHaveLength(3);
    expect(infos.filter((i) => i.hasTaxiwayLink)).toHaveLength(1);
    const mid = infos.find((i) => i.hasTaxiwayLink)!;
    expect(mid.remainingForwardM).toBe(1450);
    expect(mid.remainingReverseM).toBe(1425);
  });
});

describe('departureReachableRunwayNodes（スポットから到達できる滑走路ノード）', () => {
  it('中央入口だけにつながるスポットは、その入口ノードへ到達できる', () => {
    const l = midEntryOnlyAirport();
    const net = buildAirsideNetwork(l);
    const stand = Object.values(l.stands)[0]!;
    const reach = departureReachableRunwayNodes(net, stand.id, stand.size, false);
    const mid = runwayEntryInfos(net, 'rwy_1').find((i) => i.hasTaxiwayLink)!;
    expect([...reach]).toEqual([mid.nodeId]);
  });

  it('誘導路につながっていないスポットは空集合', () => {
    let l: AirportLayout = emptyLayout(80, 60);
    l = must(placeStand(l, { x: 10, y: 10 }, 'S', 0)).layout;
    const net = buildAirsideNetwork(l);
    const stand = Object.values(l.stands)[0]!;
    expect(departureReachableRunwayNodes(net, stand.id, 'S', false).size).toBe(0);
  });
});

describe('離陸入口の残り長さ診断（第 1 段）', () => {
  it('スターター空港・サンプル空港では出ない（途中入口が最大級に使えないだけの構成は通常運用）', () => {
    // どちらの空港も中央入口の残りは最大級の離陸滑走距離に足りないが、全長を使える入口があり、
    // どのスポットからも到達できる。検証ゴールデンの基準レイアウトでもあるため、診断は出さない。
    expect(newIssues(createStarterAirfield())).toEqual([]);
    expect(newIssues(createSampleAirport())).toEqual([]);
  });

  it('中央入口しかない滑走路: 両方向とも ALL_SHORT（warning）で、スポットも出発不可になる', () => {
    const l = midEntryOnlyAirport();
    const rwy = Object.values(l.runways)[0]!;
    const need = expectedNeed(rwy);
    const issues = newIssues(l);
    const allShort = issues.filter((i) => i.code === 'RUNWAY_ENTRY_ALL_SHORT');
    expect(allShort).toHaveLength(2);
    expect(allShort.map((i) => i.params.direction).sort()).toEqual(['forward', 'reverse']);
    for (const i of allShort) {
      expect(i.severity).toBe('warning');
      expect(i.params.requiredM).toBe(Math.round(need));
    }
    const stand = issues.filter((i) => i.code === 'STAND_NO_DEPARTURE_ENTRY');
    expect(stand).toHaveLength(1);
    expect(stand[0]!.severity).toBe('warning');
    expect(stand[0]!.params).toMatchObject({ size: 'L', requiredM: Math.round(need) });
  });

  it('始点寄りの入口もつながれば、スポットは出発可能になり ALL_SHORT は終点方向だけに残る', () => {
    let l = midEntryOnlyAirport();
    l = must(
      addTaxiwayPath(l, [{ x: 90, y: 20 }, { x: 12, y: 20 }, { x: 12, y: 10 }], { widthClass: 'L' }),
    ).layout;
    const issues = newIssues(l);
    expect(issues.some((i) => i.code === 'STAND_NO_DEPARTURE_ENTRY')).toBe(false);
    const allShort = issues.filter((i) => i.code === 'RUNWAY_ENTRY_ALL_SHORT');
    // 逆方向（終点→始点）では、始点寄り入口の残りがわずかで、使える入口が依然として無い
    expect(allShort).toHaveLength(1);
    expect(allShort[0]!.params.direction).toBe('reverse');
    expect(issues).toHaveLength(1);
  });

  it('残りが十分な方向には出ない（片方向だけ入口が端寄りの構成）', () => {
    // validation.test.ts の minimalAirport と同じ構成: 入口は始点から 250m、全長 2000m
    let l: AirportLayout = emptyLayout(100, 60);
    const step = (r: OpResult) => (l = must(r).layout);
    step(placeRunway(l, { x: 10, y: 10 }, 90, 80, { surfaceWidthM: 45 }));
    step(addTaxiwayPath(l, [{ x: 20, y: 10 }, { x: 20, y: 20 }, { x: 40, y: 20 }], { widthClass: 'M' }));
    step(placeFacility(l, 'apron', { x: 25, y: 21 }, { w: 12, h: 8 }));
    step(placeStand(l, { x: 29, y: 21 }, 'M', 180));
    const issues = newIssues(l);
    // forward は残り 1750m で最大級（離陸滑走 1178m）が離陸できるので診断なし。
    // reverse は残り 250m しかなく ALL_SHORT。スポットは forward で出発できるので対象外。
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('RUNWAY_ENTRY_ALL_SHORT');
    expect(issues[0]!.params).toMatchObject({ direction: 'reverse', maxRemainingM: 250 });
  });
});
