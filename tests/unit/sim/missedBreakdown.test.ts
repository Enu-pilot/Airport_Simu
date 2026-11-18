import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { moveEntity, placeTerminalArea, updateEntity } from '../../../src/core/layout/operations';
import { addTurnaround, createSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { peekMissBreakdown, takeMissBreakdown } from '../../../src/core/sim/missBreakdown';
import { summarizeMissedBreakdown } from '../../../src/core/analytics/review';
import type { AirportLayout, TerminalAreaKind } from '../../../src/core/model/types';
import type { Aircraft } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { runUntil } from './helpers';

const manual = { autoSchedule: false };
const areaId = (l: AirportLayout, kind: TerminalAreaKind) => Object.values(l.terminalAreas).find((a) => a.kind === kind)!.id;
const departed = (ac: Aircraft) => () => ac.state === 'departed';
const totalOf = (sim: Simulation) => peekMissBreakdown(sim.state).reduce((s, e) => s + e.count, 0);

/** 到着後に折り返して出発する1機（passengers.test.ts と同じ組み立て） */
function oneTurnaround(layout: AirportLayout, seed = 'miss') {
  const sim = createSimulation(layout, { seed, settings: manual });
  const t = sim.state.now + 20 * 60;
  const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
  return { sim, ac, dep: sim.state.flights[ac.departureFlightId]! };
}

describe('乗り遅れの内訳（詰まり箇所の記録）', () => {
  it('保安検査が詰まると、内訳に保安検査待ちとして件数とエリアが入り、合計が乗り遅れ人数と一致する', () => {
    let l = createSampleAirport();
    const sec = areaId(l, 'security');
    // 保安検査を 1 レーン・1人120秒（30人/時）に絞ると、締切までに処理しきれず行列で乗り遅れる
    l = must(updateEntity(l, sec, { props: { lanes: 1, serviceSecPerPax: 120 } })).layout;
    const { sim, ac, dep } = oneTurnaround(l, 'miss-security');
    runUntil(sim, departed(ac), 6 * 3600);
    expect(dep.pax.missed).toBeGreaterThan(0);
    // 内訳の合計は、便の乗り遅れ人数と一致する（記録漏れ・二重計上がない）
    expect(totalOf(sim)).toBe(dep.pax.missed);
    const entries = peekMissBreakdown(sim.state);
    const security = entries.find((e) => e.category === 'security');
    expect(security).toBeDefined();
    expect(security!.spotId).toBe(sec);
    expect(security!.count).toBeGreaterThan(0);
    // 分類ごとの集約でも保安検査が最多（ボトルネック）になる
    const summary = summarizeMissedBreakdown(entries);
    expect(summary[0]!.category).toBe('security');
    expect(summary[0]!.topSpotId).toBe(sec);
    // 締め用に取り出すと記録は消え、日報へ移る前提が保たれる
    const taken = takeMissBreakdown(sim.state);
    expect(taken?.reduce((s, e) => s + e.count, 0)).toBe(dep.pax.missed);
    expect(peekMissBreakdown(sim.state)).toEqual([]);
  });

  it('到達不能なゲートでは、内訳が到達不能に分類される（保安検査とは別分類）', () => {
    let l = createSampleAirport();
    const lobby = areaId(l, 'departureLobby');
    // 出発ロビーを東側だけにし、ゲート1の前には保安検査とつながらない待合を置く（passengers.test.ts の到達不能シナリオ）
    l = must(updateEntity(l, lobby, { w: 34 })).layout;
    l = must(moveEntity(l, lobby, { x: 14, y: 0 })).layout;
    const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!.id;
    l = must(placeTerminalArea(l, terminal, 1, 'waiting', { x: 46, y: 49 }, { w: 6, h: 2 })).layout;
    const { sim, ac, dep } = oneTurnaround(l, 'miss-unreachable');
    runUntil(sim, departed(ac), 6 * 3600);
    expect(dep.pax.missed).toBeGreaterThan(0);
    expect(dep.pax.missed).toBe(dep.pax.booked);
    const entries = peekMissBreakdown(sim.state);
    expect(totalOf(sim)).toBe(dep.pax.missed);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.category === 'unreachable')).toBe(true);
  });

  it('乗り遅れがなければ内訳は空で、締め用取り出しは undefined', () => {
    const { sim, ac, dep } = oneTurnaround(createSampleAirport(), 'miss-none');
    runUntil(sim, departed(ac), 6 * 3600);
    expect(dep.pax.missed).toBe(0);
    expect(peekMissBreakdown(sim.state)).toEqual([]);
    expect(takeMissBreakdown(sim.state)).toBeUndefined();
  });
});

describe('乗り遅れ内訳の集約（summarizeMissedBreakdown）', () => {
  it('分類ごとに合計し、その分類で最も多いスポットを代表にする', () => {
    const summary = summarizeMissedBreakdown([
      { category: 'security', spotId: 'ta_8', count: 10 },
      { category: 'security', spotId: 'ta_99', count: 25 },
      { category: 'checkIn', spotId: 'ta_10', count: 12 },
      { category: 'walking', spotId: null, count: 4 },
    ]);
    expect(summary.map((s) => [s.category, s.count])).toEqual([
      ['security', 35],
      ['checkIn', 12],
      ['walking', 4],
    ]);
    expect(summary[0]!.topSpotId).toBe('ta_99');
    expect(summary[0]!.topSpotCount).toBe(25);
    expect(summary[2]!.topSpotId).toBeNull();
  });
});
