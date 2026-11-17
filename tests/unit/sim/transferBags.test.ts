import { describe, expect, it } from 'vitest';
import { addTurnaround, createSimulation } from '../../../src/core/sim/simulation';
import { checkPhase4Invariants } from '../../../src/core/sim/invariants4';
import type { Bag } from '../../../src/core/sim/types';
import { domTransferAirport } from '../transferLayout';
import { runUntil } from './helpers';

const manual = { autoSchedule: false };

describe('乗継手荷物（フェーズ 4 §5.5）', () => {
  it('搬送の完了時に出発便へ付け替わり、付け替えは 1 回だけ。総数が保存される', () => {
    const sim = createSimulation(domTransferAirport(), { seed: 'xfer-bag', settings: manual });
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

    const bags = Object.values(sim.state.bags) as Bag[];
    const retagged = bags.filter((x) => x.transferFromFlightId === arrF.id);
    expect(retagged.length).toBeGreaterThan(0);
    for (const x of retagged) {
      expect(x.flightId).toBe(depF.id);
      expect(x.direction).toBe('departure');
      expect(x.transferToFlightId).toBeUndefined();
      expect(x.history.filter((h) => h.location.startsWith('transfer:'))).toHaveLength(1);
      expect(sim.state.flightBags[depF.id]).toContain(x.id);
      expect(sim.state.flightBags[arrF.id] ?? []).not.toContain(x.id);
      expect(x.state).toBe('loaded'); // 搭乗できた乗継客の手荷物は出発便に積まれる
    }
    // 手荷物の総数はグループの申告と一致する（増えも減りもしない）
    const declared = Object.values(sim.state.paxGroups).reduce((s, g) => s + g.bags, 0);
    expect(bags.length).toBe(declared);
    // 到着機に残ったままの手荷物はない
    expect(bags.filter((x) => x.state === 'onAircraft')).toHaveLength(0);
    expect(checkPhase4Invariants(sim, true)).toEqual([]);
  });

  it('乗り遅れた乗継客の手荷物は出発便に積まれない', () => {
    const sim = createSimulation(domTransferAirport(), { seed: 'xfer-bag-miss', settings: manual });
    const now = sim.state.now;
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

    const bags = Object.values(sim.state.bags) as Bag[];
    const retagged = bags.filter((x) => x.transferFromFlightId === arrF.id);
    expect(retagged.length).toBeGreaterThan(0);
    for (const x of retagged) {
      expect(x.flightId).toBe(depF.id);
      expect(x.state).not.toBe('loaded');
      expect(x.loadedOn).toBeNull();
    }
    expect(checkPhase4Invariants(sim, true)).toEqual([]);
  });
});
