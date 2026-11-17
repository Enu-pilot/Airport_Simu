import { describe, expect, it } from 'vitest';
import { citySim } from '../audit/d_helpers';
import { addWindowContracts, cityCompany } from '../audit/d_helpers';
import { defaultCityNightOps } from '../../src/core/economy/city';
import { settleDay } from '../../src/core/economy/ops';
import { takeoffDelaySec } from '../../src/core/economy/takeoffDelay';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { nominalOutSec } from '../../src/core/sim/nightOps';
import { stepTicks } from '../../src/core/sim/dayloop';

/** 2-14: 離陸の遅れ（出発の実遅延とは別の指標）と日報の night（R15） */
const make = (night: boolean) => {
  const c = cityCompany('takeoff-delay', 'core');
  addWindowContracts(c);
  if (night) c.city!.nightOps = defaultCityNightOps();
  return citySim(createSampleAirport(), c, { seed: 'takeoff-delay', settings: { autoSchedule: true, inboundDelayProb: 0 } });
};
const firstDeparted = (sim: ReturnType<typeof make>) =>
  Object.values(sim.state.aircraft).find((a) => sim.state.flights[a.departureFlightId]!.actual !== null)!;

describe('takeoffDelaySec', () => {
  it('実離陸が 予定 + 標準の離陸までの秒数 のとき 0。8 時間遅らせた便は 480 分以上。早い便は 0 に丸める', () => {
    const sim = make(true);
    for (let i = 0; i < 20 && !Object.values(sim.state.aircraft).some((a) => sim.state.flights[a.departureFlightId]!.actual !== null); i++) stepTicks(sim, 3600);
    const ac = firstDeparted(sim);
    const dep = sim.state.flights[ac.departureFlightId]!;
    const nominal = nominalOutSec(sim, { ...ac, standId: dep.standId ?? ac.standId })!;
    expect(nominal).toBeGreaterThan(0);
    const saved = dep.actual;
    dep.actual = dep.scheduled + nominal;
    expect(takeoffDelaySec(sim, ac.id)).toBe(0);
    dep.actual = dep.scheduled + nominal + 8 * 3600;
    expect(takeoffDelaySec(sim, ac.id)!).toBeGreaterThanOrEqual(480 * 60);
    dep.actual = dep.scheduled - 100;
    expect(takeoffDelaySec(sim, ac.id)).toBe(0);
    dep.actual = null;
    expect(takeoffDelaySec(sim, ac.id)).toBeNull();
    dep.actual = saved;
    expect(takeoffDelaySec(sim, 'no-such')).toBeNull();
  });
});

describe('日報の night（R15）', () => {
  it('nightOps なしの日報には night がない。ありのときは lastDepartureDelayMin が便の記録から求めた値と一致する', { timeout: 120_000 }, () => {
    const plain = make(false);
    stepTicks(plain, 6 * 3600);
    expect('night' in settleDay(plain, true)!).toBe(false);

    const sim = make(true);
    stepTicks(sim, 6 * 3600);
    const from = sim.state.economy!.periodStart;
    const to = sim.state.now;
    const rep = settleDay(sim, true)!;
    expect(rep.night).toBeDefined();
    const n = rep.night!;
    for (const k of ['standHeld', 'originHeld', 'carriedOver', 'diverted', 'cancelled'] as const) {
      expect(Number.isInteger(n[k]) && n[k] >= 0).toBe(true);
    }
    // 最後に予定された出発
    const deps = Object.values(sim.state.aircraft)
      .map((a) => ({ a, f: sim.state.flights[a.departureFlightId]! }))
      .filter((x) => x.f.scheduled >= from && x.f.scheduled < to && x.f.status !== 'cancelled')
      .sort((p, q) => q.f.scheduled - p.f.scheduled || (q.a.id < p.a.id ? -1 : 1));
    if (deps.length === 0) {
      expect(n.lastDepartureDelayMin).toBeNull();
    } else if (deps[0]!.f.actual !== null) {
      expect(n.lastDepartureDelayMin).toBe(Math.round(takeoffDelaySec(sim, deps[0]!.a.id)! / 60));
    }
    expect(n.carriedOver).toBe(deps.filter((d) => d.f.actual === null).length);
  });
});
