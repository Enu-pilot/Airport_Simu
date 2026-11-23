import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { addPortal, placeFacility } from '../../src/core/layout/operations';
import {
  areaNodeId, buildCompositeGraph, classifyFacilityConnection, facilityNodeId, findCompositeRoute, portalNodeId, verifyPortalAccess,
} from '../../src/core/terminal/networkGraph';
import { must } from './helpers';

/**
 * 5-16 T3/T4: 交通施設〜ポータル〜ターミナル内エリアの複合グラフと 3 状態分類。
 * ポータルがない交通施設は、ターミナルに近くても到達不能のまま。
 */
function setup(portalState?: 'underConstruction' | 'planned') {
  let l = createStarterAirfield();
  l = must(placeFacility(l, 'busTerminal', { x: 36, y: 58 })).layout;
  const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
  const entrance = Object.values(l.terminalAreas).find((a) => a.kind === 'entrance')!;
  const waiting = Object.values(l.terminalAreas).find((a) => a.kind === 'waiting')!;
  if (portalState !== undefined) {
    l = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id, buildState: portalState })).layout;
  } else if (portalState === undefined) {
    // 既定ケースは呼び出し側で追加する
  }
  return { l, bt, entrance, waiting };
}

describe('5-16 T3/T4 複合グラフと接続分類', () => {
  it('ポータル経由で交通施設から入口・待合エリアまで到達できる', () => {
    const s0 = setup();
    let l = s0.l;
    const { bt, entrance, waiting } = s0;
    l = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
    const c = classifyFacilityConnection(l, bt.id, entrance.id);
    expect(c.status).toBe('operational');
    expect(c.route!.nodes).toEqual([facilityNodeId(bt.id), portalNodeId(Object.keys(l.portals!)[0]!), areaNodeId(entrance.id)]);
    const toWaiting = classifyFacilityConnection(l, bt.id, waiting.id);
    expect(toWaiting.status).toBe('operational');
    expect(toWaiting.route!.nodes.at(-1)).toBe(areaNodeId(waiting.id));
    expect(toWaiting.route!.costSec).toBeGreaterThan(0);
  });

  it('ポータルがなければ近くても到達不能', () => {
    const { l, bt, entrance } = setup();
    const c = classifyFacilityConnection(l, bt.id, entrance.id);
    expect(c.status).toBe('unreachable');
    expect(c.route).toBeNull();
    expect(c.futureRoute).toBeNull();
  });

  it('建設中ポータルは underConstruction で、現在経路にはならない', () => {
    const { l, bt, entrance } = setup('underConstruction');
    const c = classifyFacilityConnection(l, bt.id, entrance.id);
    expect(c.status).toBe('underConstruction');
    expect(c.route).toBeNull();
    expect(c.futureRoute).not.toBeNull();
  });

  it('planned ポータルは完成待ちに含めない', () => {
    const { l, bt, entrance } = setup('planned');
    expect(classifyFacilityConnection(l, bt.id, entrance.id).status).toBe('unreachable');
  });

  it('ポータル施設ごとに往路（入口まで）・復路（出口から）の状態を検査できる', () => {
    const s0 = setup();
    let l = s0.l;
    const { bt, entrance } = s0;
    l = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
    const statuses = verifyPortalAccess(l);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.facilityId).toBe(bt.id);
    expect(statuses[0]!.toEntrance).toBe('operational');
    expect(statuses[0]!.fromExit).toBe('operational');
  });

  it('ポータルのない空港では検査対象が空', () => {
    const { l } = setup();
    expect(verifyPortalAccess(l)).toEqual([]);
  });

  it('グラフ構築は決定的で、エリア間リンクの費用がモデルと一致する', () => {
    const s0 = setup();
    let l = s0.l;
    const { bt, entrance } = s0;
    l = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
    const g1 = buildCompositeGraph(l);
    const g2 = buildCompositeGraph(l);
    expect(g1).toEqual(g2);
    const r = findCompositeRoute(g1, facilityNodeId(bt.id), areaNodeId(entrance.id));
    expect(r!.costSec).toBe(0);
  });
});
