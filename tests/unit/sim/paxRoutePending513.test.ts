import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addTerminalTransitLink, moveEntity, placeFacility, placeTerminalArea, updateEntity } from '../../../src/core/layout/operations';
import { addTurnaround, createSimulation } from '../../../src/core/sim/simulation';
import { peekMissBreakdown } from '../../../src/core/sim/missBreakdown';
import { findPaxRoute } from '../../../src/core/terminal/route';
import type { AirportLayout, BuildState, TerminalAreaKind } from '../../../src/core/model/types';
import type { Aircraft } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { runUntil } from './helpers';

const manual = { autoSchedule: false };
const areaId = (l: AirportLayout, kind: TerminalAreaKind) => Object.values(l.terminalAreas).find((a) => a.kind === kind)!.id;
const departed = (ac: Aircraft) => () => ac.state === 'departed';

/**
 * 5-13 T5: 建設中リンクが完成すれば到達できる動線で乗り遅れた場合、理由（MissReason）は
 * 従来どおり到達不能のままだが、乗り遅れ内訳だけが「連絡通路の完成待ち」に区別される。
 * 実旅客は建設中リンクを歩かない（完成は翌日の運航から効く）。
 *
 * シナリオは missedBreakdown の到達不能ケース（ゲート前の待合が孤立）を土台に、
 * 第2ターミナルの出発ロビーを経由する2本のリンクでだけ将来つながるようにする。
 */
function scenario(linkState: BuildState) {
  let l = createSampleAirport();
  const lobby = areaId(l, 'departureLobby');
  l = must(updateEntity(l, lobby, { w: 34 })).layout;
  l = must(moveEntity(l, lobby, { x: 14, y: 0 })).layout;
  const terminalA = Object.values(l.facilities).find((f) => f.kind === 'terminal')!.id;
  const isolated = must(placeTerminalArea(l, terminalA, 1, 'waiting', { x: 46, y: 49 }, { w: 6, h: 2 }));
  l = isolated.layout;
  const termB = must(placeFacility(l, 'terminal', { x: 120, y: 85 }, { name: 'B' }));
  l = termB.layout;
  const lobbyB = must(placeTerminalArea(l, termB.created[0]!, 0, 'departureLobby', { x: 120, y: 85 }));
  l = lobbyB.layout;
  const link = (fromAreaId: string, toAreaId: string) => {
    l = must(addTerminalTransitLink(l, {
      kind: 'walkway', fromAreaId, toAreaId, distanceM: 100, travelSec: 60,
      bidirectional: true, allowedZones: ['departure'], buildState: linkState,
    })).layout;
  };
  link(lobby, lobbyB.created[0]!);
  link(lobbyB.created[0]!, isolated.created[0]!);
  return l;
}

function run(linkState: BuildState) {
  const sim = createSimulation(scenario(linkState), { seed: 'pending513', settings: manual });
  const t = sim.state.now + 20 * 60;
  const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
  const dep = sim.state.flights[ac.departureFlightId]!;
  runUntil(sim, departed(ac), 6 * 3600);
  return { sim, dep };
}

describe('5-13 T5 乗り遅れ内訳の完成待ち区別', () => {
  it('建設中リンクでのみ届くゲート: 理由は到達不能のまま、内訳は routePending になる', () => {
    const { sim, dep } = run('underConstruction');
    expect(sim.ctx.terminalFuture).toBeDefined();
    expect(dep.pax.missed).toBeGreaterThan(0);
    expect(dep.pax.missed).toBe(dep.pax.booked);
    const entries = peekMissBreakdown(sim.state);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.category === 'routePending')).toBe(true);
    // 理由の内訳（MissReason 由来の集計）は従来どおり: 全員 stranded 由来
    const groups = Object.values(sim.state.paxGroups).filter((g) => g.flightId === dep.id);
    expect(groups.every((g) => g.reason === 'unreachable' || g.state === 'missed')).toBe(true);
  });

  it('planned リンクでは完成待ちにせず、内訳は従来の到達不能', () => {
    const { sim, dep } = run('planned');
    expect(sim.ctx.terminalFuture).toBeUndefined();
    expect(dep.pax.missed).toBe(dep.pax.booked);
    const entries = peekMissBreakdown(sim.state);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.category === 'unreachable')).toBe(true);
  });

  it('リンクが運用中なら現在モデルで経路が成立する（モデル水準の回帰）', () => {
    // 注: 出発グループが他ターミナルを「迂回」する歩行は不変条件 P6（割当てターミナル外の
    // 経路禁止。targetTerminalId を持つ乗継等が対象）により運航では使われないため、
    // ここでは経路の成立だけを確認する。迂回の許可は 5-16 側の課題として計画書に記録した。
    const l = scenario('operational');
    const sim = createSimulation(l, { seed: 'pending513-op', settings: manual });
    expect(sim.ctx.terminalFuture).toBeUndefined();
    const lobby = areaId(l, 'departureLobby');
    const isolated = Object.values(l.terminalAreas).find((a) => a.kind === 'waiting')!.id;
    expect(findPaxRoute(sim.ctx.terminal, { from: lobby, goals: new Map([[isolated, 0]]) })).not.toBeNull();
  });
});
