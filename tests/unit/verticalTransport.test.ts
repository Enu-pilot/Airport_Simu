import { describe, expect, it } from 'vitest';
import { findPedestrianRoute } from '../../src/core/access/verticalWalk';
import { connectRoadLevels, addRoadPath, placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import { importLayout, exportLayout } from '../../src/core/io/serialize';
import { constructionCost } from '../../src/core/economy/construction';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { analyzeAccess } from '../../src/core/access/model';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { findPaxRoute } from '../../src/core/terminal/route';
import type { AirportLayout, Facility } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

function endpoint(layout: AirportLayout, level: number, x = 10, y = 10): string {
  return Object.values(layout.roadNodes).find((n) => (n.level ?? 0) === level && n.pos.x === x && n.pos.y === y)!.id;
}

function facility(id: string, kind: Facility['kind'], level: number): Facility {
  return { id, kind, name: id, origin: { x: 10, y: 10 }, w: 1, h: 1, rotation: 0, buildState: 'operational', props: { level } };
}

describe('階層交通ネットワーク', () => {
  it('ターミナルの階段は上下階の旅客経路を接続し、保存・復元後も利用できる', () => {
    let layout = emptyLayout(30, 30);
    layout = must(placeFacility(layout, 'terminal', { x: 2, y: 2 }, { w: 12, h: 8, props: { levels: 2 } })).layout;
    const terminalId = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
    layout = must(placeTerminalArea(layout, terminalId, 0, 'hall', { x: 5, y: 5 }, { w: 1, h: 1 })).layout;
    layout = must(placeTerminalArea(layout, terminalId, 1, 'hall', { x: 6, y: 5 }, { w: 1, h: 1 })).layout;
    const lower = Object.values(layout.terminalAreas).find((area) => area.level === 0)!.id;
    const upper = Object.values(layout.terminalAreas).find((area) => area.level === 1)!.id;
    expect(findPaxRoute(buildTerminalModel(layout), { from: lower, goals: new Map([[upper, 0]]) })).toBeNull();

    layout = must(placeTerminalArea(layout, terminalId, 0, 'stairs', { x: 6, y: 5 }, { w: 1, h: 1 })).layout;
    const stairs = Object.values(layout.terminalAreas).find((area) => area.kind === 'stairs')!.id;
    const restored = importLayout(exportLayout(layout));
    expect(restored.terminalAreas[stairs]?.kind).toBe('stairs');
    expect(findPaxRoute(buildTerminalModel(restored), { from: lower, goals: new Map([[upper, 0]]) })?.areas).toEqual([lower, stairs, upper]);
  });

  it('エレベーターの時間当たり能力と所要時間を上下階の経路に載せる', () => {
    let layout = emptyLayout(30, 30);
    layout = must(placeFacility(layout, 'terminal', { x: 2, y: 2 }, { w: 12, h: 8, props: { levels: 2 } })).layout;
    const terminalId = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
    layout = must(placeTerminalArea(layout, terminalId, 0, 'hall', { x: 5, y: 5 }, { w: 1, h: 1 })).layout;
    layout = must(placeTerminalArea(layout, terminalId, 1, 'hall', { x: 6, y: 5 }, { w: 1, h: 1 })).layout;
    layout = must(placeTerminalArea(layout, terminalId, 0, 'elevator', { x: 6, y: 5 }, {
      w: 1,
      h: 1,
      props: { travelSec: 25, capacityPerHour: 90 },
    })).layout;
    const areas = Object.values(layout.terminalAreas);
    const lower = areas.find((area) => area.kind === 'hall' && area.level === 0)!.id;
    const upper = areas.find((area) => area.kind === 'hall' && area.level === 1)!.id;
    const elevator = areas.find((area) => area.kind === 'elevator')!.id;
    const model = buildTerminalModel(layout);
    expect(findPaxRoute(model, { from: lower, goals: new Map([[upper, 0]]) })?.areas).toEqual([lower, elevator, upper]);
    expect(model.links[elevator]!.find((link) => link.to === upper)).toMatchObject({
      verticalTransportId: elevator,
      capacityPerHour: 90,
      travelSec: 25,
    });
  });

  it('段差のない経路では階段を避け、エレベーターを選択する', () => {
    let layout = emptyLayout(30, 30);
    layout = must(placeFacility(layout, 'terminal', { x: 2, y: 2 }, { w: 12, h: 8, props: { levels: 2 } })).layout;
    const terminalId = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
    layout = must(placeTerminalArea(layout, terminalId, 0, 'hall', { x: 4, y: 5 }, { w: 1, h: 1 })).layout;
    layout = must(placeTerminalArea(layout, terminalId, 0, 'hall', { x: 5, y: 5 }, { w: 2, h: 2 })).layout;
    layout = must(placeTerminalArea(layout, terminalId, 0, 'stairs', { x: 7, y: 5 }, {
      w: 1,
      h: 1,
      props: { travelSec: 5 },
    })).layout;
    layout = must(placeTerminalArea(layout, terminalId, 0, 'elevator', { x: 7, y: 6 }, {
      w: 1,
      h: 1,
      props: { travelSec: 80 },
    })).layout;
    layout = must(placeTerminalArea(layout, terminalId, 1, 'hall', { x: 7, y: 5 }, { w: 1, h: 2 })).layout;
    const areas = Object.values(layout.terminalAreas);
    const from = areas.find((area) => area.kind === 'hall' && area.level === 0 && area.origin.x === 4)!.id;
    const to = areas.find((area) => area.kind === 'hall' && area.level === 1)!.id;
    const model = buildTerminalModel(layout);

    expect(findPaxRoute(model, { from, goals: new Map([[to, 0]]) })?.areas).toContain(areas.find((area) => area.kind === 'stairs')!.id);
    expect(findPaxRoute(model, { from, goals: new Map([[to, 0]]), stepFree: true })?.areas).toContain(areas.find((area) => area.kind === 'elevator')!.id);
    expect(findPaxRoute(model, { from, goals: new Map([[to, 0]]), stepFree: true })?.areas).not.toContain(areas.find((area) => area.kind === 'stairs')!.id);
  });

  it('同じ平面座標でも地上・地下ノードを分離し、垂直接続の有無を歩行経路に反映する', () => {
    let layout = emptyLayout(30, 30);
    layout = must(addRoadPath(layout, [{ x: 10, y: 10 }, { x: 10, y: 20 }], { roadClass: 'walkway', level: 0, capacityPerHour: 500 })).layout;
    layout = must(addRoadPath(layout, [{ x: 10, y: 10 }, { x: 10, y: 20 }], { roadClass: 'walkway', level: -1, capacityPerHour: 500 })).layout;
    const undergroundStation = facility('station', 'railStation', -1);
    const groundTerminal = facility('terminal', 'terminal', 0);

    expect(endpoint(layout, 0)).not.toBe(endpoint(layout, -1));
    expect(findPedestrianRoute(layout, undergroundStation, groundTerminal)).toBeNull();

    layout = must(connectRoadLevels(layout, endpoint(layout, -1), endpoint(layout, 0), {
      roadClass: 'walkway', connectorKind: 'elevator', capacityPerHour: 300,
    })).layout;
    expect(findPedestrianRoute(layout, undergroundStation, groundTerminal)).toMatchObject({ minutes: 1, capacityPerHour: 300 });
  });

  it('移動手段に合わない階層接続と短すぎるランプを拒否する', () => {
    let layout = emptyLayout(30, 30);
    layout = must(addRoadPath(layout, [{ x: 10, y: 10 }, { x: 10, y: 20 }], { roadClass: 'public', level: 0 })).layout;
    layout = must(addRoadPath(layout, [{ x: 10, y: 10 }, { x: 10, y: 20 }], { roadClass: 'public', level: -1 })).layout;
    const ground = endpoint(layout, 0);
    const underground = endpoint(layout, -1);
    expect(connectRoadLevels(layout, ground, underground, { roadClass: 'public', connectorKind: 'elevator' })).toEqual({ ok: false, reason: 'INVALID_CONNECTOR' });
    expect(connectRoadLevels(layout, ground, underground, { roadClass: 'public', connectorKind: 'ramp' })).toEqual({ ok: false, reason: 'INVALID_CONNECTOR' });
  });

  it('旧 v3 保存データは地上として読み込み、新しい階層データは往復保存する', () => {
    let layout = emptyLayout(30, 30);
    layout = must(addRoadPath(layout, [{ x: 10, y: 10 }, { x: 10, y: 20 }], { roadClass: 'walkway', level: -1, capacityPerHour: 420 })).layout;
    const restored = importLayout(exportLayout(layout));
    expect(Object.values(restored.roadNodes).some((n) => n.level === -1)).toBe(true);
    expect(Object.values(restored.roads).some((e) => e.capacityPerHour === 420)).toBe(true);

    const legacy = JSON.parse(exportLayout(emptyLayout(30, 30))) as { schemaVersion: number; layout: AirportLayout };
    legacy.schemaVersion = 3;
    legacy.layout.schemaVersion = 3;
    expect(importLayout(JSON.stringify(legacy)).schemaVersion).toBe(3);
  });

  it('地下・高架の建設費が階層に応じた係数を使う', () => {
    const base = emptyLayout(30, 30);
    const ground = must(addRoadPath(base, [{ x: 5, y: 5 }, { x: 15, y: 5 }], { roadClass: 'public', level: 0 })).layout;
    const underground = must(addRoadPath(base, [{ x: 5, y: 5 }, { x: 15, y: 5 }], { roadClass: 'public', level: -1 })).layout;
    const elevated = must(addRoadPath(base, [{ x: 5, y: 5 }, { x: 15, y: 5 }], { roadClass: 'public', level: 1 })).layout;
    expect(constructionCost(base, underground)).toBeGreaterThan(constructionCost(base, ground));
    expect(constructionCost(base, elevated)).toBeGreaterThan(constructionCost(base, ground));
  });

  it('地下駅は階層間の歩行路が接続されたときだけアクセス鉄道として使える', () => {
    let layout = createStarterAirfield();
    layout = must(placeFacility(layout, 'railStation', { x: 68, y: 58 }, { name: '地下駅', props: { level: -1 } })).layout;
    layout = must(addRoadPath(layout, [{ x: 70, y: 60 }, { x: 70, y: 105 }], { roadClass: 'rail', level: -1 })).layout;
    layout = must(addRoadPath(layout, [{ x: 66, y: 56 }, { x: 70, y: 56 }, { x: 70, y: 58 }], { roadClass: 'walkway', level: 0, capacityPerHour: 800 })).layout;
    layout = must(addRoadPath(layout, [{ x: 70, y: 58 }, { x: 70, y: 60 }], { roadClass: 'walkway', level: -1, capacityPerHour: 800 })).layout;
    const ground = endpoint(layout, 0, 70, 58);
    const underground = endpoint(layout, -1, 70, 58);
    expect(analyzeAccess(layout).modes.rail.available).toBe(false);

    layout = must(connectRoadLevels(layout, ground, underground, { roadClass: 'walkway', connectorKind: 'elevator', capacityPerHour: 800 })).layout;
    expect(analyzeAccess(layout).modes.rail.available).toBe(true);
    expect(analyzeAccess(layout).railWalkCapacityPerHour).toBe(800);
  });
});
