import { describe, expect, it } from 'vitest';
import { findPaxRoute } from '../../src/core/terminal/route';
import type { TerminalModel } from '../../src/core/terminal/model';

/**
 * R-07（docs/10）: 他の建物群を経由する旅客経路の禁止。
 * 建物群（サービス複合体）は complexOf（ターミナル → 代表 ID）で与える。出発の建物群 O を出た後は、
 * 入った建物群 X の中だけを進める（X→Y の通り抜け、X→O の戻りは不可）。建物群の中の建物間の移動は自由。
 */

/** エリア（すべて一般区域の hall）と双方向リンク（長さ m）から最小のモデルを作る */
function model(areas: Record<string, string>, links: [string, string, number][]): TerminalModel {
  const a: Record<string, unknown> = {};
  for (const [id, terminalId] of Object.entries(areas)) a[id] = { id, terminalId, kind: 'hall', zone: 'landside' };
  const l: Record<string, unknown[]> = {};
  for (const [x, y, len] of links) {
    (l[x] ??= []).push({ to: y, lengthM: len, travelSec: 0 });
    (l[y] ??= []).push({ to: x, lengthM: len, travelSec: 0 });
  }
  return { areas: a, links: l } as unknown as TerminalModel;
}

// 建物 A1・A2 は同じ建物群 A（連絡でつながる）。B・C は別の建物群
const complexOf = new Map([
  ['A1', 'A'],
  ['A2', 'A'],
  ['B', 'B'],
  ['C', 'C'],
]);

describe('findPaxRoute の建物群の制約（R-07）', () => {
  it('同じ建物群の中の建物間（A1→A2）は通れる', () => {
    const m = model({ a1: 'A1', a2: 'A2' }, [['a1', 'a2', 100]]);
    expect(findPaxRoute(m, { from: 'a1', goals: new Map([['a2', 0]]), complexOf })?.areas).toEqual(['a1', 'a2']);
  });

  it('第三の建物群を通り抜ける経路（A→B→C）は使わない。制約なしなら使う', () => {
    const m = model({ a: 'A1', b: 'B', c: 'C' }, [['a', 'b', 10], ['b', 'c', 10]]);
    expect(findPaxRoute(m, { from: 'a', goals: new Map([['c', 0]]) })?.areas).toEqual(['a', 'b', 'c']);
    expect(findPaxRoute(m, { from: 'a', goals: new Map([['c', 0]]), complexOf })).toBeNull();
  });

  it('通り抜けが短くても、直結の経路があればそちらを選ぶ', () => {
    const m = model({ a: 'A1', b: 'B', c: 'C' }, [['a', 'b', 10], ['b', 'c', 10], ['a', 'c', 500]]);
    expect(findPaxRoute(m, { from: 'a', goals: new Map([['c', 0]]), complexOf })?.areas).toEqual(['a', 'c']);
  });

  it('別の建物群へ出て出発の建物群へ戻る経路（A→B→A）は使わない', () => {
    const m = model({ a1: 'A1', b: 'B', a2: 'A2' }, [['a1', 'b', 10], ['b', 'a2', 10]]);
    expect(findPaxRoute(m, { from: 'a1', goals: new Map([['a2', 0]]), complexOf })).toBeNull();
  });

  it('目的の建物群の中では建物をまたいで進める（出発が B、A1→A2 の順に進む）', () => {
    const m = model({ b: 'B', a1: 'A1', a2: 'A2' }, [['b', 'a1', 10], ['a1', 'a2', 10]]);
    expect(findPaxRoute(m, { from: 'b', goals: new Map([['a2', 0]]), complexOf })?.areas).toEqual(['b', 'a1', 'a2']);
  });

  it('complexOf に無いターミナルは単独の建物群として扱う', () => {
    const m = model({ x: 'X', y: 'Y', z: 'Z' }, [['x', 'y', 10], ['y', 'z', 10]]);
    expect(findPaxRoute(m, { from: 'x', goals: new Map([['z', 0]]), complexOf })).toBeNull();
    expect(findPaxRoute(m, { from: 'x', goals: new Map([['y', 0]]), complexOf })?.areas).toEqual(['x', 'y']);
  });
});
