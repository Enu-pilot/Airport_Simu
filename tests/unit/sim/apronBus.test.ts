import { describe, expect, it } from 'vitest';
import { createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { APRON_BUS_CAPACITY } from '../../../src/core/sim/busRules';
import type { AirportLayout } from '../../../src/core/model/types';
import { busLayout } from './busHelpers';

/** 12B-3a A5: ランプバスによる出発旅客のバス搭乗（リモートスポット） */
function run(layout: AirportLayout, hours: number, seed = 'bus-a'): Simulation {
  const sim = createSimulation(layout, { seed, settings: { flightsPerDay: 160 } });
  for (let i = 0; i < hours * 3600; i++) {
    stepSimulation(sim);
    if (i % 120 === 0) {
      const v = checkInvariants(sim);
      expect(v, `t=${i}`).toEqual([]);
    }
    if (sim.state.bus) for (const t of Object.values(sim.state.bus.trips)) expect(t.pax).toBeLessThanOrEqual(APRON_BUS_CAPACITY);
  }
  return sim;
}
const busFlights = (sim: Simulation) => Object.values(sim.state.flights).filter((f) => f.pax.bus);

describe('バス搭乗（出発）', () => {
  it('リモートスポットの出発便がバスで搭乗でき（全員が乗り遅れにならない）、不変条件を保ち、定員を超えない', { timeout: 300_000 }, () => {
    const sim = run(busLayout({ buses: 3 }), 6);
    const dep = busFlights(sim).filter((f) => f.direction === 'departure' && f.pax.boarding === 'closed');
    expect(dep.length).toBeGreaterThan(2);
    const boarded = dep.reduce((s, f) => s + f.pax.boarded, 0);
    const missed = dep.reduce((s, f) => s + f.pax.missed, 0);
    expect(boarded).toBeGreaterThan(0);
    expect(boarded).toBeGreaterThan(missed);
    // 1 便が複数の運行（定員 60 の 180 席機）で搭乗する
    const trips = Object.values(sim.state.bus!.trips).filter((t) => t.dir === 'dep' && t.phase === 'done');
    expect(trips.some((t) => dep.some((f) => f.id === t.flightId && trips.filter((x) => x.flightId === f.id).length >= 2))).toBe(true);
    expect(sim.state.bus!.stats.pax).toBeGreaterThan(0);
    // 搭乗済みのグループは自便のバスゲートを通っている（P2）
    for (const g of Object.values(sim.state.paxGroups)) if (g.state === 'boarded' && busFlights(sim).some((f) => f.id === g.flightId)) expect(g.boardedGate).toBe('fac_6');
  });

  it('バスが 0 台なら、リモートスポットの出発旅客は noBus で乗り遅れる（従来の noGate ではない）', { timeout: 300_000 }, () => {
    const sim = run(busLayout({ buses: 0 }), 5);
    const reasons: Record<string, number> = {};
    for (const g of Object.values(sim.state.paxGroups)) if (g.state === 'missed') reasons[g.reason!] = (reasons[g.reason!] ?? 0) + g.count;
    expect(reasons.noBus ?? 0).toBeGreaterThan(0);
    expect(reasons.noGate ?? 0).toBe(0);
  });

  it('バスが少ないと搭乗が遅れ、ランプバス待ちが遅延の理由に出る', { timeout: 300_000 }, () => {
    const sim = run(busLayout({ buses: 1 }), 6);
    const delayed = busFlights(sim).filter((f) => f.delayCauses.includes('apronBus'));
    expect(sim.state.bus!.stats.shortageSec + delayed.length).toBeGreaterThan(0);
  });
});

describe('従来のデータでは新しいコードに入らない', () => {
  it('バスゲートのないレイアウト: state.bus・ランプバスのユニット・p.bus・ctx.busGates がない', { timeout: 300_000 }, () => {
    const sim = createSimulation(busLayout({ gate: 'none', buses: 0 }), { seed: 'bus-b', settings: { flightsPerDay: 100 } });
    for (let i = 0; i < 2 * 3600; i++) stepSimulation(sim);
    expect(sim.ctx.busGates).toEqual([]);
    expect(sim.state.bus).toBeUndefined();
    expect('bus' in sim.state).toBe(false);
    expect(Object.values(sim.state.units).some((u) => u.kind === 'apronBus')).toBe(false);
    expect(JSON.stringify(sim.state)).not.toContain('"bus"');
    expect(JSON.stringify(sim.state)).not.toContain('waitingBus');
  });

  it('同じシードなら 2 回の運航の状態が一致する（決定的）', { timeout: 300_000 }, () => {
    const a = run(busLayout(), 3, 'bus-det');
    const b = run(busLayout(), 3, 'bus-det');
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });
});
