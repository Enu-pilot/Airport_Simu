import { describe, expect, it } from 'vitest';
import { addTurnaround, createSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { checkPhase4Invariants } from '../../../src/core/sim/invariants4';
import type { PaxGroup } from '../../../src/core/sim/types';
import { domTransferAirport, transferAirport } from '../transferLayout';
import { runUntil } from './helpers';

const manual = { autoSchedule: false };
const groups = (sim: Simulation, flightId: string): PaxGroup[] => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);
const xferGroups = (sim: Simulation, depFlightId: string): PaxGroup[] => groups(sim, depFlightId).filter((g) => g.transfer);

describe('乗継旅客（フェーズ 4 §5.4）', () => {
  it('DD: 到着便から出発便へ乗り継ぎ、人数が保存される', () => {
    const sim = createSimulation(domTransferAirport(), { seed: 'xfer-dd', settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'narrow180', t, {
      departureAt: t + 300 * 60,
      plan: { contractId: 'k-arr', destinationId: 'TYO', arrPax: 120, depPax: 0, standId: null },
    });
    const b = addTurnaround(sim, 'narrow180', t + 30 * 60, {
      departureAt: t + 150 * 60,
      plan: { contractId: 'k-dep', destinationId: 'OSA', arrPax: 0, depPax: 50, standId: null },
    });
    const arrF = sim.state.flights[a.arrivalFlightId]!;
    const depF = sim.state.flights[b.departureFlightId]!;
    arrF.transferPlan = [{ depFlightId: depF.id, pax: 40, kind: 'DD' }];
    depF.plannedTransferIn = 40;
    runUntil(sim, () => b.state === 'departed', 8 * 3600);

    // 降機の内訳: 地元客 80 人は退出、乗継 40 人は出発便へ
    expect(arrF.pax.deplaned).toBe(120);
    expect(arrF.pax.exited).toBe(80);
    expect(arrF.pax.transferOut).toBe(40);
    // 出発便: 予約は地元 50 + 乗継 40、全員搭乗
    expect(depF.pax.transferIn).toBe(40);
    expect(depF.pax.booked).toBe(90);
    expect(depF.pax.boarded).toBe(90);
    const xg = xferGroups(sim, depF.id);
    expect(xg.reduce((s, g) => s + g.count, 0)).toBe(40);
    expect(xg.every((g) => g.state === 'boarded')).toBe(true);
    expect(xg.every((g) => g.accessDone === true)).toBe(true);
    expect(xg.every((g) => g.steps[0] === 'transferSecurity')).toBe(true);
    // 統計: 発生 40・接続 40・失敗 0
    expect(sim.state.hubStats?.spawned).toBe(40);
    expect(sim.state.hubStats?.connected).toBe(40);
    expect(sim.state.hubStats?.missed).toBe(0);
    expect(checkPhase4Invariants(sim, true)).toEqual([]);
  });

  it('DD: 出発便の締切後に降機した乗継は乗り遅れ、補償は乗継用になる', () => {
    const sim = createSimulation(domTransferAirport(), { seed: 'xfer-miss', settings: manual });
    const now = sim.state.now;
    // 出発便は到着便より先に出る（締切は到着便の降機前に終わっている）
    const b = addTurnaround(sim, 'narrow180', now + 2 * 60, {
      departureAt: now + 25 * 60,
      plan: { contractId: 'k-dep', destinationId: 'OSA', arrPax: 0, depPax: 0, standId: null },
    });
    const a = addTurnaround(sim, 'narrow180', now + 40 * 60, {
      departureAt: now + 300 * 60,
      plan: { contractId: 'k-arr', destinationId: 'TYO', arrPax: 120, depPax: 0, standId: null },
    });
    const arrF = sim.state.flights[a.arrivalFlightId]!;
    const depF = sim.state.flights[b.departureFlightId]!;
    arrF.transferPlan = [{ depFlightId: depF.id, pax: 40, kind: 'DD' }];
    depF.plannedTransferIn = 40;
    runUntil(sim, () => a.state === 'departed', 10 * 3600);

    expect(arrF.pax.transferOut).toBe(40);
    expect(depF.pax.boarded).toBe(0);
    expect(depF.pax.missed).toBe(40);
    expect(sim.state.hubStats?.spawned).toBe(40);
    expect(sim.state.hubStats?.connected).toBe(0);
    expect(sim.state.hubStats?.missed).toBe(40);
    expect(xferGroups(sim, depF.id).every((g) => g.state === 'missed')).toBe(true);
    expect(checkPhase4Invariants(sim, true)).toEqual([]);
  });

  it('DI: 国内着 → 国際発は乗継保安検査と出国審査を通る', () => {
    const sim = createSimulation(transferAirport(), { seed: 'xfer-di', settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'narrow180', t, {
      departureAt: t + 300 * 60,
      plan: { contractId: 'k-arr', destinationId: 'TYO', arrPax: 100, depPax: 0, standId: null },
    });
    const b = addTurnaround(sim, 'narrow180', t + 30 * 60, {
      departureAt: t + 210 * 60,
      plan: { contractId: 'k-dep', destinationId: 'SEL', arrPax: 0, depPax: 40, standId: 'std_8', routeType: 'international' },
    });
    const arrF = sim.state.flights[a.arrivalFlightId]!;
    const depF = sim.state.flights[b.departureFlightId]!;
    arrF.transferPlan = [{ depFlightId: depF.id, pax: 30, kind: 'DI' }];
    depF.plannedTransferIn = 30;
    runUntil(sim, () => b.state === 'departed', 10 * 3600);

    expect(arrF.pax.transferOut).toBe(30);
    expect(depF.pax.boarded).toBe(70);
    const xg = xferGroups(sim, depF.id);
    expect(xg.reduce((s, g) => s + g.count, 0)).toBe(30);
    expect(xg.every((g) => g.state === 'boarded')).toBe(true);
    expect(xg.every((g) => g.steps.includes('transferSecurity') && g.steps.includes('emigration'))).toBe(true);
    expect(xg.every((g) => g.ciq?.emigration)).toBe(true);
    expect(sim.state.hubStats?.connected).toBe(30);
    expect(checkPhase4Invariants(sim, true)).toEqual([]);
  });

  it('ID: 国際着 → 国内発は入国審査と乗継保安検査を通る', () => {
    const sim = createSimulation(transferAirport(), { seed: 'xfer-id', settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'narrow180', t, {
      departureAt: t + 300 * 60,
      plan: { contractId: 'k-arr', destinationId: 'SEL', arrPax: 100, depPax: 0, standId: 'std_8', routeType: 'international' },
    });
    const b = addTurnaround(sim, 'narrow180', t + 30 * 60, {
      departureAt: t + 180 * 60,
      plan: { contractId: 'k-dep', destinationId: 'TYO', arrPax: 0, depPax: 40, standId: null },
    });
    const arrF = sim.state.flights[a.arrivalFlightId]!;
    const depF = sim.state.flights[b.departureFlightId]!;
    arrF.transferPlan = [{ depFlightId: depF.id, pax: 30, kind: 'ID' }];
    depF.plannedTransferIn = 30;
    runUntil(sim, () => b.state === 'departed', 10 * 3600);

    expect(arrF.pax.transferOut).toBe(30);
    expect(arrF.pax.exited).toBe(70); // 地元客だけが退出する
    expect(depF.pax.boarded).toBe(70);
    const xg = xferGroups(sim, depF.id);
    expect(xg.reduce((s, g) => s + g.count, 0)).toBe(30);
    expect(xg.every((g) => g.state === 'boarded')).toBe(true);
    expect(xg.every((g) => g.steps.includes('immigration') && g.steps.includes('transferSecurity'))).toBe(true);
    expect(xg.every((g) => g.ciq?.immigration)).toBe(true);
    expect(sim.state.hubStats?.connected).toBe(30);
    expect(checkPhase4Invariants(sim, true)).toEqual([]);
  });

  it('乗継の計画が無ければ乗継は発生しない（従来どおり）', () => {
    const sim = createSimulation(domTransferAirport(), { seed: 'xfer-none', settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'narrow180', t, {
      departureAt: t + 150 * 60,
      plan: { contractId: 'k-arr', destinationId: 'TYO', arrPax: 60, depPax: 60, standId: null },
    });
    runUntil(sim, () => a.state === 'departed', 8 * 3600);
    const arrF = sim.state.flights[a.arrivalFlightId]!;
    expect(arrF.pax.exited).toBe(60);
    expect(arrF.pax.transferOut).toBeUndefined();
    expect(sim.state.hubStats).toBeUndefined();
    expect(checkPhase4Invariants(sim, true)).toEqual([]);
  });
});
