import { describe, expect, it } from 'vitest';
import { createCareerCompany } from '../../src/core/economy/company';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation } from '../../src/core/sim/simulation';
import { morningReadiness } from '../../src/core/sim/overnight';
import type { Aircraft, Flight } from '../../src/core/sim/types';

/**
 * F6-11 翌朝の出発可能機数（PO 承認 2026-11-19 の定義）:
 * 翌朝 06:00–10:00 の滞泊出発便を予定として数え、整備枠に入らなかった所属機と
 * スポット閉鎖中の機を「リスクあり」、それ以外を「確定可能」とする。
 * 故障の確率そのものは予測しない。
 */
function fixture() {
  const sim = createSimulation(createSampleAirport(), { company: createCareerCompany(), seed: 'readiness' });
  const now = sim.state.now;
  const addFlight = (id: string, offsetSec: number, extra: Record<string, unknown> = {}) => {
    sim.state.flights[id] = {
      id, direction: 'departure', overnight: true, status: 'scheduled', scheduled: now + offsetSec, ...extra,
    } as unknown as Flight;
  };
  const addAircraft = (id: string, standId: string, flightId: string) => {
    sim.state.aircraft[id] = { id, state: 'parked', standId, departureFlightId: flightId } as unknown as Aircraft;
  };
  addFlight('f_ok', 3600, { basedAircraftId: 'ba_ok' });
  addAircraft('ac_ok', 'std_1', 'f_ok');
  addFlight('f_risk', 2 * 3600, { basedAircraftId: 'ba_risk' });
  addAircraft('ac_risk', 'std_2', 'f_risk');
  addFlight('f_closed', 3 * 3600);
  addAircraft('ac_closed', 'std_3', 'f_closed');
  addFlight('f_late', 5 * 3600); // 窓（4 時間）の外
  addAircraft('ac_late', 'std_4', 'f_late');
  addFlight('f_day', 3600, { overnight: false }); // 滞泊便でない
  addAircraft('ac_day', 'std_5', 'f_day');
  sim.state.closures.stands.push('std_3');
  return sim;
}

describe('F6-11 翌朝の出発可能機数', () => {
  it('予定・確定可能・リスクありを定義どおりに数える', () => {
    const sim = fixture();
    const r = morningReadiness(sim, new Set(['ba_risk']));
    expect(r).toEqual({ scheduled: 3, ready: 1, atRisk: 2 });
  });

  it('整備リスクが無ければ、閉鎖中の 1 機だけがリスクになる', () => {
    const sim = fixture();
    const r = morningReadiness(sim, new Set());
    expect(r).toEqual({ scheduled: 3, ready: 2, atRisk: 1 });
  });
});
