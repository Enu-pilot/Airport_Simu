import { describe, expect, it } from 'vitest';
import { findPedestrianRoute } from '../../src/core/access/verticalWalk';
import { connectRoadLevels, addRoadPath, placeFacility } from '../../src/core/layout/operations';
import { importLayout, exportLayout } from '../../src/core/io/serialize';
import { constructionCost } from '../../src/core/economy/construction';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { analyzeAccess } from '../../src/core/access/model';
import type { AirportLayout, Facility } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

function endpoint(layout: AirportLayout, level: number, x = 10, y = 10): string {
  return Object.values(layout.roadNodes).find((n) => (n.level ?? 0) === level && n.pos.x === x && n.pos.y === y)!.id;
}

function facility(id: string, kind: Facility['kind'], level: number): Facility {
  return { id, kind, name: id, origin: { x: 10, y: 10 }, w: 1, h: 1, rotation: 0, buildState: 'operational', props: { level } };
}

describe('階層交通ネットワーク', () => {
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
