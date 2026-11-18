import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext } from '../../src/core/sim/context';
import { createSimulation, addTurnaround, stepSimulation } from '../../src/core/sim/simulation';
import { turnaroundCapacity } from '../../src/core/economy/planning';

/**
 * 5-02: 折り返し能力の式の当て直し（実測との照合）。
 * サンプル空港・narrow180 の同時到着で、資源待ち（車両・作業員・整備士不足）が出ない同時機数を測り、
 * 式の値と一致することを確認する。2026-11-18 の実測: 旧式の値 3 では同時 3 機で 1 機あたり約 790 秒の
 * 資源待ちが出たため、実効同時処理率（TURNAROUND_DUTY）で当て直して 2 になった。
 */
function resourceWaitPerTurnaround(k: number): number {
  const sim = createSimulation(createSampleAirport(), { seed: 'fit', settings: { autoSchedule: false } });
  const t = sim.state.now + 10 * 60;
  const acs = [];
  for (let i = 0; i < k; i++) {
    acs.push(addTurnaround(sim, 'narrow180', t + i * 120, { departureAt: t + 5 * 3600, plan: { contractId: 'k', destinationId: 'TYO', arrPax: 0, depPax: 0, standId: null } }));
  }
  const ids = new Set(acs.map((a) => a.id));
  const end = t + 6 * 3600;
  while (sim.state.now < end) {
    stepSimulation(sim);
    if ([...ids].every((id) => sim.state.aircraft[id]?.state === 'departed')) break;
  }
  const b = sim.state.groundStats.blockedSec;
  return ((b.noVehicle ?? 0) + (b.noStaff ?? 0) + (b.noEngineer ?? 0)) / k;
}

describe('折り返し能力の実測照合（5-02）', () => {
  it('式の値は、実測で資源待ちが出ない同時機数と一致する', { timeout: 300_000 }, () => {
    const capacity = turnaroundCapacity(createContext(createSampleAirport()));
    expect(capacity).toBe(2);
    expect(resourceWaitPerTurnaround(capacity)).toBe(0);
    expect(resourceWaitPerTurnaround(capacity + 1)).toBeGreaterThan(0);
  });
});
