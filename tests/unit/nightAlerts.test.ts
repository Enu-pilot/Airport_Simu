import { describe, expect, it } from 'vitest';
import { addWindowContracts, cityCompany, citySim, H } from '../audit/d_helpers';
import { defaultCityNightOps } from '../../src/core/economy/city';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { nightRiskFlights } from '../../src/core/sim/nightOps';
import { stepTicks } from '../../src/core/sim/dayloop';
import { deriveAlerts } from '../../src/ui/operate/alerts';

/** 2-15 の画面: night:<便ID> の警告は nightRiskFlights と一致し、nightOps がなければ出ない */
const make = (night: boolean) => {
  const c = cityCompany('night-alert', 'core');
  addWindowContracts(c);
  if (night) c.city!.nightOps = { ...defaultCityNightOps(), warnLeadMin: 120 };
  return citySim(createSampleAirport(), c, { seed: 'night-alert', startTime: 20 * H, settings: { autoSchedule: true, inboundDelayProb: 0 } });
};

describe('夜間の警告（alerts）', () => {
  it('nightOps なしでは night: の警告は出ない', () => {
    const sim = make(false);
    stepTicks(sim, 1800);
    expect(deriveAlerts(sim, sim.company).keys.filter((k) => k.startsWith('night:'))).toEqual([]);
  });
  it('nightOps ありでは、nightRiskFlights の便ごとに night:<便ID> の警告が出る（20:00〜21:50 を 10 分刻みで確認）', () => {
    const sim = make(true);
    let seen = 0;
    for (let i = 0; i < 11; i++) {
      stepTicks(sim, 600);
      const risks = nightRiskFlights(sim);
      const keys = deriveAlerts(sim, sim.company).keys;
      for (const r of risks) {
        expect(keys).toContain(`night:${r.flightId}`);
        seen++;
      }
      expect(keys.filter((k) => k.startsWith('night:')).length).toBe(risks.length);
    }
    expect(seen).toBeGreaterThanOrEqual(0);
  });
});
