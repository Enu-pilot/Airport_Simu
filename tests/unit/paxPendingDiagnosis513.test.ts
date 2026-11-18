import { describe, expect, it } from 'vitest';
import { addTerminalTransitLink, placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import type { AirportLayout, BuildState } from '../../src/core/model/types';
import { analyzeLayout } from '../../src/core/validation/validate';
import { emptyLayout, must } from './helpers';

/**
 * 5-13 T6: 検証診断で旅客接続の3状態を区別する。
 * 現在は未接続でも、建設中リンクが完成すれば出発経路が成立する場合は
 * TERMINAL_DEPARTURE_ROUTE（警告）ではなく TERMINAL_DEPARTURE_ROUTE_PENDING（情報）を出す。
 * planned リンクは完成待ちに含めない。
 *
 * 構成: ターミナルAの入口→チェックインは隣接。保安検査はA内で孤立させ、
 * A(一般区域ホール) → B(一般区域ホール同士) → A(保安検査に隣接する一般区域ホール) の
 * 迂回が2本のターミナル間リンク経由でのみ成立するようにする。
 * （未クリア旅客はゴールの保安検査以外から出発区域へ入れないため、迂回は一般区域で構成する）
 */
function setup(linkState: BuildState) {
  let l: AirportLayout = emptyLayout(120, 60);
  const term = (x: number, name: string) => {
    const p = must(placeFacility(l, 'terminal', { x, y: 2 }, { name }));
    l = p.layout;
    return p.created[0]!;
  };
  const area = (t: string, kind: Parameters<typeof placeTerminalArea>[3], x: number, y: number, w: number) => {
    const p = must(placeTerminalArea(l, t, 0, kind, { x, y }, { w, h: 2 }));
    l = p.layout;
    return p.created[0]!;
  };
  const a = term(2, 'A');
  area(a, 'entrance', 2, 2, 4);
  area(a, 'checkIn', 6, 2, 8);
  const hallA = area(a, 'hall', 14, 2, 4);
  area(a, 'security', 16, 7, 4);
  const hallA2 = area(a, 'hall', 12, 7, 4);
  const b = term(35, 'B');
  const hallB1 = area(b, 'hall', 35, 2, 4);
  const hallB2 = area(b, 'hall', 39, 2, 4);
  const link = (fromAreaId: string, toAreaId: string) => {
    l = must(addTerminalTransitLink(l, {
      kind: 'walkway', fromAreaId, toAreaId, distanceM: 100, travelSec: 60,
      bidirectional: true, allowedZones: ['landside'], buildState: linkState,
    })).layout;
  };
  link(hallA, hallB1);
  link(hallB2, hallA2);
  return l;
}

const codes = (l: AirportLayout) => analyzeLayout(l).issues.map((i) => i.code);

describe('5-13 T6 検証診断の完成待ち区別', () => {
  it('建設中リンクで成立する出発経路は PENDING（情報）になり、未接続警告は出ない', () => {
    const cs = codes(setup('underConstruction'));
    expect(cs).toContain('TERMINAL_DEPARTURE_ROUTE_PENDING');
    expect(cs).not.toContain('TERMINAL_DEPARTURE_ROUTE');
    const pending = analyzeLayout(setup('underConstruction')).issues.find((i) => i.code === 'TERMINAL_DEPARTURE_ROUTE_PENDING');
    expect(pending?.severity).toBe('info');
  });
  it('リンクが運用中なら PENDING も未接続警告も出ない', () => {
    const cs = codes(setup('operational'));
    expect(cs).not.toContain('TERMINAL_DEPARTURE_ROUTE_PENDING');
    expect(cs).not.toContain('TERMINAL_DEPARTURE_ROUTE');
  });
  it('planned リンクは完成待ちにせず、従来の未接続警告のまま', () => {
    const cs = codes(setup('planned'));
    expect(cs).toContain('TERMINAL_DEPARTURE_ROUTE');
    expect(cs).not.toContain('TERMINAL_DEPARTURE_ROUTE_PENDING');
  });
});
