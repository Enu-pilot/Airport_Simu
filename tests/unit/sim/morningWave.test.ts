import { describe, expect, it } from 'vitest';
import { createSimulation } from '../../../src/core/sim/simulation';
import { morningWave } from '../../../src/core/sim/overnight';
import type { Flight } from '../../../src/core/sim/types';
import { linearLayout, manual } from '../../audit/d_helpers';

const dep = (id: string, actual: number | null, overnight = true): Flight =>
  ({ id, direction: 'departure', overnight, actual, status: actual === null ? 'scheduled' : 'completed' }) as unknown as Flight;

describe('morningWave: 朝の始発の波（4B-3 / §3.4）', () => {
  it('滞泊の出発便の離陸だけから波を集計する', () => {
    const sim = createSimulation(linearLayout({ stands: 4 }), { seed: 'wave-1', settings: manual });
    const t0 = 86400 + 23400; // 翌日 06:30
    sim.state.flights = {
      f1: dep('f1', t0),
      f2: dep('f2', t0 + 600),
      f3: dep('f3', t0 + 1500),
      f4: dep('f4', t0 + 300, false), // 滞泊でない出発は数えない
      f5: dep('f5', null), // 未離陸は数えない
      f6: { ...dep('f6', t0 + 60), direction: 'arrival' }, // 到着は数えない
    };
    const wave = morningWave(sim, 86400, 2 * 86400);
    expect(wave).toEqual({ departures: 3, firstTakeoff: t0, lastTakeoff: t0 + 1500, intervalsSec: [600, 900] });
  });

  it('滞泊の出発がなければ null', () => {
    const sim = createSimulation(linearLayout({ stands: 4 }), { seed: 'wave-2', settings: manual });
    expect(morningWave(sim, 0, 86400)).toBeNull();
  });
});
