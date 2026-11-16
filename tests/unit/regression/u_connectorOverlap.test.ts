/**
 * V-2（docs/39 §10、修正済み 1-02）: 同じ位置にある地上と地下 1 階の通路ノードを、プロパティの「階層接続設備」
 * （connectRoadLevels）で階段としてつなぐと、つないだ直後に配置チェックが「道路 と stairs が重なっています」（OVERLAP）
 * のエラーを出す。期待: 仕様どおりの階層接続（docs/34「エレベーター/階段/エスカレーターは平面距離 25 m 以内」）は
 * エラーにならない。画面での再現: 道路・交通網ツールで地上と地下 1 に通路を引き、端のノードを選んで「接続設備を建設」。
 */
import { expect, it } from 'vitest';
import { addRoadPath, connectRoadLevels } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { emptyLayout, must } from '../helpers';

const nodeAt = (l: AirportLayout, level: number, x: number, y: number): string =>
  Object.values(l.roadNodes).find((n) => (n.level ?? 0) === level && n.pos.x === x && n.pos.y === y)!.id;

for (const kind of ['stairs', 'escalator', 'elevator'] as const) {
  it(`同じ位置の地上/地下 1 の通路ノードを ${kind} でつないでも重なりのエラーにならない`, () => {
    let l = emptyLayout(60, 60);
    l = must(addRoadPath(l, [{ x: 10, y: 10 }, { x: 20, y: 10 }], { roadClass: 'walkway', level: 0, capacityPerHour: 600 })).layout;
    l = must(addRoadPath(l, [{ x: 20, y: 10 }, { x: 30, y: 10 }], { roadClass: 'walkway', level: -1, capacityPerHour: 600 })).layout;
    expect(analyzeLayout(l).issues.filter((i) => i.code === 'OVERLAP'), '接続前').toEqual([]);
    l = must(connectRoadLevels(l, nodeAt(l, -1, 20, 10), nodeAt(l, 0, 20, 10), { roadClass: 'walkway', connectorKind: kind })).layout;
    expect(analyzeLayout(l).issues.filter((i) => i.code === 'OVERLAP').map((i) => i.targets), '接続後').toEqual([]);
  });
}

it('同じ階で 2 本の通路が交差 → OVERLAP のまま（回帰）', () => {
  let l = emptyLayout(60, 60);
  l = must(addRoadPath(l, [{ x: 10, y: 10 }, { x: 30, y: 10 }], { roadClass: 'walkway', level: 0, capacityPerHour: 600 })).layout;
  l = must(addRoadPath(l, [{ x: 20, y: 5 }, { x: 20, y: 15 }], { roadClass: 'walkway', level: 0, capacityPerHour: 600 })).layout;
  expect(analyzeLayout(l).issues.filter((i) => i.code === 'OVERLAP').length).toBeGreaterThan(0);
});

it('接続設備の端点タイルに、無関係な第 3 の通路が通る → OVERLAP', () => {
  let l = emptyLayout(60, 60);
  l = must(addRoadPath(l, [{ x: 10, y: 10 }, { x: 20, y: 10 }], { roadClass: 'walkway', level: 0, capacityPerHour: 600 })).layout;
  l = must(addRoadPath(l, [{ x: 20, y: 10 }, { x: 30, y: 10 }], { roadClass: 'walkway', level: -1, capacityPerHour: 600 })).layout;
  l = must(connectRoadLevels(l, nodeAt(l, -1, 20, 10), nodeAt(l, 0, 20, 10), { roadClass: 'walkway', connectorKind: 'stairs' })).layout;
  const connector = Object.values(l.roads).find((e) => e.connectorKind === 'stairs')!;
  // 地上の第 3 の通路が接続設備の端点タイルを横切る（端点ノードは共有しない。addRoadPath はノードで分割するので直接追加する）
  l = structuredClone(l);
  l.roadNodes['rn_x1'] = { id: 'rn_x1', name: '', holdShort: false, pos: { x: 20, y: 5 } };
  l.roadNodes['rn_x2'] = { id: 'rn_x2', name: '', holdShort: false, pos: { x: 20, y: 15 } };
  l.roads['rd_x'] = { id: 'rd_x', from: 'rn_x1', to: 'rn_x2', name: '', roadClass: 'walkway', oneWay: false, buildState: 'operational', capacityPerHour: 600 };
  const overlaps = analyzeLayout(l).issues.filter((i) => i.code === 'OVERLAP');
  expect(overlaps.some((i) => i.targets.includes(connector.id))).toBe(true);
});

it('スロープ（端点の距離 > 0）の端点はエラーにならない', () => {
  let l = emptyLayout(60, 60);
  l = must(addRoadPath(l, [{ x: 10, y: 10 }, { x: 20, y: 10 }], { roadClass: 'service', level: 0, capacityPerHour: 600 })).layout;
  l = must(addRoadPath(l, [{ x: 30, y: 10 }, { x: 40, y: 10 }], { roadClass: 'service', level: -1, capacityPerHour: 600 })).layout;
  // 勾配 1:12 以上の長さが必要（階の高さ差 × 12 以上の水平距離）
  const r = connectRoadLevels(l, nodeAt(l, -1, 30, 10), nodeAt(l, 0, 20, 10), { roadClass: 'service', connectorKind: 'ramp' });
  if (!r.ok) throw new Error(`ramp failed: ${r.reason}`);
  expect(analyzeLayout(r.layout).issues.filter((i) => i.code === 'OVERLAP').map((i) => i.targets)).toEqual([]);
});
