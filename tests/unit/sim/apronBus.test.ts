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

// ---------------------------------------------------------------- A6: 到着・故障・救援

import { addDisruption, moveUnitToBase } from '../../../src/core/sim/disruptions';

function stepUntil(sim: Simulation, pred: () => boolean, maxSec: number): boolean {
  for (let i = 0; i < maxSec; i++) {
    stepSimulation(sim);
    if (pred()) return true;
  }
  return false;
}
const tripIn = (sim: Simulation, phase: string, dir?: 'dep' | 'arr') => Object.values(sim.state.bus!.trips).find((t) => t.phase === phase && (!dir || t.dir === dir));

describe('バス搭乗（到着）', () => {
  it('到着旅客はスポットでバスに乗り、降機口から手荷物受取所・出口へ着く（到達不能にならない）', { timeout: 300_000 }, () => {
    const sim = run(busLayout({ buses: 3 }), 6);
    const arr = busFlights(sim).filter((f) => f.direction === 'arrival');
    expect(arr.length).toBeGreaterThan(2);
    const exited = arr.reduce((s, f) => s + f.pax.exited, 0);
    expect(exited).toBeGreaterThan(0);
    for (const f of arr) expect(f.pax.gateId).toBe('fac_6');
    const stranded = Object.values(sim.state.paxGroups).filter((g) => g.state === 'stranded' && arr.some((f) => f.id === g.flightId));
    expect(stranded.length).toBe(0);
    // 手荷物のある旅客は受取所へ着き、荷物を受け取れる
    expect(sim.state.groundStats.bagsCollected).toBeGreaterThan(0);
    expect(Object.values(sim.state.bus!.trips).some((t) => t.dir === 'arr' && t.phase === 'done')).toBe(true);
  });
});

describe('バスの故障・救援・保護', () => {
  it('走行中のバスが故障すると運行は stalled になり、別のバスの救援で目的地へ着く。不変条件を保つ', { timeout: 300_000 }, () => {
    const sim = createSimulation(busLayout({ buses: 3 }), { seed: 'bus-a', settings: { flightsPerDay: 160 } });
    expect(stepUntil(sim, () => !!tripIn(sim, 'driving'), 8 * 3600)).toBe(true);
    const t = tripIn(sim, 'driving')!;
    const busId = t.busId!;
    addDisruption(sim, { kind: 'vehicleFailure', targetId: busId, end: sim.state.now + 3600 });
    stepSimulation(sim);
    expect(sim.state.bus!.trips[t.id]!.phase).toBe('stalled');
    expect(checkInvariants(sim)).toEqual([]);
    expect(stepUntil(sim, () => sim.state.bus!.trips[t.id]!.phase === 'done', 3600)).toBe(true);
    expect(sim.state.bus!.stats.rescues).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 600; i++) stepSimulation(sim);
    expect(checkInvariants(sim)).toEqual([]);
  });

  it('乗車中のバスが故障すると、旅客は乗車待ちに戻り、別のバスで運ばれる', { timeout: 300_000 }, () => {
    const sim = createSimulation(busLayout({ buses: 3 }), { seed: 'bus-a', settings: { flightsPerDay: 160 } });
    expect(stepUntil(sim, () => !!tripIn(sim, 'loading', 'dep') && tripIn(sim, 'loading', 'dep')!.pax > 0, 8 * 3600)).toBe(true);
    const t = tripIn(sim, 'loading', 'dep')!;
    const groups = [...t.groups];
    const oldBus = t.busId!;
    addDisruption(sim, { kind: 'vehicleFailure', targetId: oldBus, end: sim.state.now + 3 * 3600 });
    stepSimulation(sim);
    const after = sim.state.bus!.trips[t.id]!;
    // 故障したバスの運行は未配車に戻り、同じティックに別のバスが空いていれば配車し直される
    expect(['waiting', 'toPickup']).toContain(after.phase);
    expect(after.busId).not.toBe(oldBus);
    expect(after.groups).toEqual([]);
    for (const id of groups) expect(sim.state.paxGroups[id]!.state).toBe('waitingBus');
    expect(checkInvariants(sim)).toEqual([]);
    expect(stepUntil(sim, () => groups.every((id) => ['onBus', 'boarded', 'missed'].includes(sim.state.paxGroups[id]!.state)), 1800)).toBe(true);
  });

  it('運行中のバスは配置換えできない（OCCUPIED）', { timeout: 300_000 }, () => {
    const sim = createSimulation(busLayout({ buses: 3 }), { seed: 'bus-a', settings: { flightsPerDay: 160 } });
    expect(stepUntil(sim, () => !!tripIn(sim, 'toPickup') || !!tripIn(sim, 'loading'), 8 * 3600)).toBe(true);
    const t = tripIn(sim, 'toPickup') ?? tripIn(sim, 'loading')!;
    const base = sim.ctx.bases[0]!.id;
    expect(moveUnitToBase(sim, t.busId!, base)).toEqual({ ok: false, reason: 'OCCUPIED' });
  });
});

// ---------------------------------------------------------------- A7: 分析

import { airportKpis } from '../../../src/core/analytics/kpi';

describe('分析（ランプバス）', () => {
  it('バス扱いの便の記録に boarding・busWaitSec が付き、KPI に apronBus が出る。従来の運航にはキーがない', { timeout: 300_000 }, () => {
    const sim = run(busLayout({ buses: 3 }), 6);
    const recs = sim.state.analytics.records.filter((r) => r.boarding === 'bus');
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) expect(typeof r.busWaitSec).toBe('number');
    const k = airportKpis(sim);
    expect(k.apronBus!.trips).toBe(sim.state.bus!.stats.trips);
    expect(k.apronBus!.pax).toBeGreaterThan(0);
    expect(k.unitUtil.apronBus).toBeGreaterThan(0);
    const legacy = createSimulation(busLayout({ gate: 'none', buses: 0 }), { seed: 'bus-c', settings: { flightsPerDay: 100 } });
    for (let i = 0; i < 3 * 3600; i++) stepSimulation(legacy);
    expect(airportKpis(legacy).apronBus).toBeUndefined();
    expect(JSON.stringify(legacy.state.analytics.records)).not.toContain('"boarding":"bus"');
  });
});

describe('バス 0 台・全台故障のときの到着旅客（12B-3a 監査の指摘）', () => {
  /** 到着旅客がバス待ちのまま 1 時間を超えて残っていないこと（機体が出発したあとも含む） */
  function expectNoStaleWaiters(sim: Simulation): number {
    const stale = Object.values(sim.state.paxGroups).filter((g) => g.direction === 'arrival' && g.state === 'waitingBus' && !g.busTrip && sim.state.now - g.appearAt > 3600 + 60);
    expect(stale.map((g) => `${g.id}@${g.appearAt}`)).toEqual([]);
    return Object.values(sim.state.paxGroups).filter((g) => g.direction === 'arrival' && g.state === 'stranded' && g.reason === 'unreachable').length;
  }

  it('バスのユニットが 0 台でも、到着旅客は 1 時間で stranded（unreachable）になり waitingBus に残らない', { timeout: 300_000 }, () => {
    const sim = run(busLayout({ buses: 0 }), 4, 's8');
    expect(Object.values(sim.state.units).some((u) => u.kind === 'apronBus')).toBe(false);
    expect(expectNoStaleWaiters(sim)).toBeGreaterThan(0);
  });

  it('全台が故障していても、到着旅客は 1 時間で stranded になる', { timeout: 300_000 }, () => {
    const sim = createSimulation(busLayout({ buses: 2 }), { seed: 's8', settings: { flightsPerDay: 160 } });
    stepSimulation(sim);
    expect(Object.values(sim.state.units).filter((u) => u.kind === 'apronBus')).toHaveLength(2);
    for (const u of Object.values(sim.state.units)) if (u.kind === 'apronBus') addDisruption(sim, { kind: 'vehicleFailure', targetId: u.id, end: sim.state.now + 5 * 3600 });
    stepSimulation(sim);
    expect(Object.values(sim.state.units).filter((u) => u.kind === 'apronBus').every((u) => u.status === 'broken')).toBe(true);
    for (let i = 0; i < 4 * 3600; i++) stepSimulation(sim);
    expect(Object.values(sim.state.units).filter((u) => u.kind === 'apronBus').every((u) => u.status === 'broken')).toBe(true);
    expect(expectNoStaleWaiters(sim)).toBeGreaterThan(0);
    expect(checkInvariants(sim)).toEqual([]);
  });
});
