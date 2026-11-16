/**
 * 既知の不具合 V-2 の再現（docs/39 §10）: 同じ位置にある地上と地下 1 階の通路ノードを、プロパティの「階層接続設備」
 * （connectRoadLevels）で階段としてつなぐと、つないだ直後に配置チェックが「道路 と stairs が重なっています」（OVERLAP）
 * のエラーを出す。期待: 仕様どおりの階層接続（docs/34「エレベーター/階段/エスカレーターは平面距離 25 m 以内」）は
 * エラーにならない。画面での再現: 道路・交通網ツールで地上と地下 1 に通路を引き、端のノードを選んで「接続設備を建設」。
 */
import { expect, it } from 'vitest';
import { addRoadPath, connectRoadLevels } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { emptyLayout, must } from '../../unit/helpers';

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
