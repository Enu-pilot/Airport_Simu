import { describe, expect, it } from 'vitest';
import { emptyLayout, must as mustOp } from './helpers';
import { placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import {
  buildTerminalModel,
  linkCostSec,
  linkWalkLengthM,
  MOVING_WALKWAY_SPEED_MPS,
  WALK_SPEED_MPS,
} from '../../src/core/terminal/model';
import { findPaxRoute, linkBetween } from '../../src/core/terminal/route';

/**
 * 動く歩道（ターミナル内エリア、通路の拡張）:
 * 置いた区間だけ、歩行速度ではなく実効速度（歩行 1.3 + ベルト 0.5 = 1.8 m/s）で進む。
 * 経路コスト（route/hub/networkGraph）と歩行シミュレーションの所要時間が一致すること。
 */
const must = mustOp;

/** 横一列の 3 エリア（各 4x2 タイル）: entrance 相当 → 中間エリア → waiting。中間種別だけ差し替える */
function rowLayout(middleKind: 'hall' | 'movingWalkway') {
  let layout = emptyLayout(120, 60);
  layout = must(placeFacility(layout, 'terminal', { x: 10, y: 10 }, { w: 12, h: 6 })).layout!;
  const termId = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  layout = must(placeTerminalArea(layout, termId, 0, 'security', { x: 10, y: 10 }, { w: 4, h: 2, zone: 'departure' })).layout!;
  layout = must(placeTerminalArea(layout, termId, 0, middleKind, { x: 14, y: 10 }, { w: 4, h: 2, zone: 'departure' })).layout!;
  layout = must(placeTerminalArea(layout, termId, 0, 'waiting', { x: 18, y: 10 }, { w: 4, h: 2, zone: 'departure' })).layout!;
  const areas = Object.values(layout.terminalAreas);
  return {
    layout,
    from: areas.find((a) => a.kind === 'security')!.id,
    mid: areas.find((a) => a.kind === middleKind)!.id,
    to: areas.find((a) => a.kind === 'waiting')!.id,
  };
}

describe('動く歩道エリア', () => {
  it('速度定数: 実効速度 = 歩行 + ベルト 0.5 m/s', () => {
    expect(MOVING_WALKWAY_SPEED_MPS).toBeCloseTo(WALK_SPEED_MPS + 0.5, 10);
  });

  it('リンクの被覆長: 歩道エリアの中心〜境界ぶんだけが walkwayLengthM になる', () => {
    const { layout, from, mid, to } = rowLayout('movingWalkway');
    const model = buildTerminalModel(layout);
    const leg1 = linkBetween(model, from, mid)!;
    // 1 タイル = 25m。各レグは中心→境界→中心で 100m、うち歩道内は境界→中心の 50m
    expect(leg1.lengthM).toBeCloseTo(100, 6);
    expect(leg1.walkwayLengthM).toBeCloseTo(50, 6);
    const leg2 = linkBetween(model, mid, to)!;
    expect(leg2.walkwayLengthM).toBeCloseTo(50, 6);
    // 通常エリア同士のレグには付かない
    const plain = rowLayout('hall');
    const plainModel = buildTerminalModel(plain.layout);
    expect(linkBetween(plainModel, plain.from, plain.mid)!.walkwayLengthM).toBeUndefined();
  });

  it('経路コスト: 歩道ありは現実の実効速度どおり短縮され、歩道なしと差が出る', () => {
    const withW = rowLayout('movingWalkway');
    const routeW = findPaxRoute(buildTerminalModel(withW.layout), { from: withW.from, goals: new Map([[withW.to, 0]]) })!;
    // 2 レグ × (50m 歩行 + 50m 歩道) = 2 × (50/1.3 + 50/1.8)
    const expected = 2 * (50 / WALK_SPEED_MPS + 50 / MOVING_WALKWAY_SPEED_MPS);
    expect(routeW.cost).toBeCloseTo(expected, 4);

    const plain = rowLayout('hall');
    const routeP = findPaxRoute(buildTerminalModel(plain.layout), { from: plain.from, goals: new Map([[plain.to, 0]]) })!;
    expect(routeP.cost).toBeCloseTo(200 / WALK_SPEED_MPS, 4);
    expect(routeW.cost).toBeLessThan(routeP.cost);
  });

  it('歩行換算距離: シミュレーションの所要時間（換算距離 / 歩行速度）が経路コストと一致する', () => {
    const { layout, from, mid } = rowLayout('movingWalkway');
    const model = buildTerminalModel(layout);
    const leg = linkBetween(model, from, mid)!;
    expect(linkWalkLengthM(leg) / WALK_SPEED_MPS).toBeCloseTo(linkCostSec(leg), 8);
    const plain = rowLayout('hall');
    const plainLeg = linkBetween(buildTerminalModel(plain.layout), plain.from, plain.mid)!;
    expect(linkWalkLengthM(plainLeg)).toBeCloseTo(plainLeg.lengthM, 8);
  });
});
