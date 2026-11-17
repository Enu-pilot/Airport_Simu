import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState } from '../../src/core/economy/company';
import { emptyFlightPax } from '../../src/core/sim/passengers';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation, type Simulation } from '../../src/core/sim/simulation';
import { maintenanceSlots, settlePhase4 } from '../../src/core/sim/overnight';
import type { Aircraft, Flight } from '../../src/core/sim/types';
import type { AirportLayout } from '../../src/core/model/types';

/** 在泊している所属機 1 機を sim に置く */
function parkBased(sim: Simulation, c: CompanyState, contractId: string, basedId: string, typeId: string): void {
  const { state } = sim;
  const standId = Object.values(sim.ctx.stands).find((s) => s.operational)!.id;
  const arr: Flight = {
    id: 'fl_arr', number: 'SK100', direction: 'arrival', aircraftId: 'ac_1',
    scheduled: state.now - 3600, estimated: state.now - 3600, actual: state.now - 3600, block: state.now - 3600,
    status: 'completed', runwayId: null, standId, delayCauses: [], pax: { ...emptyFlightPax(), generated: true },
    readyAt: null, criticalTask: null, airlineId: 'SK', contractId, destinationId: 'KTA', plannedPax: 0, plannedStandId: standId,
  };
  const dep: Flight = {
    id: 'fl_dep', number: 'SK101', direction: 'departure', aircraftId: 'ac_1',
    scheduled: state.now + 8 * 3600, estimated: state.now + 8 * 3600, actual: null, block: null,
    status: 'scheduled', runwayId: null, standId, delayCauses: [], pax: emptyFlightPax(),
    readyAt: null, criticalTask: null, airlineId: 'SK', contractId, destinationId: 'KTA', plannedPax: 100,
    plannedStandId: standId, overnight: true, basedAircraftId: basedId,
  };
  state.flights[arr.id] = arr;
  state.flights[dep.id] = dep;
  const ac: Aircraft = {
    id: 'ac_1', typeId, callsign: 'SK100', arrivalFlightId: arr.id, departureFlightId: dep.id,
    state: 'parked', stateSince: state.now, runwayId: null, standId,
    route: null, dist: 0, speed: 0, x: 0, y: 0, heading: 0, px: 0, py: 0, pheading: 0,
    holdReason: null, waitSince: null, eta: null, timerUntil: null, queuedSince: null, retryAt: 0,
    taxiStartedAt: null, crossing: null, history: [],
  };
  state.aircraft[ac.id] = ac;
  state.standAssignments[standId] = ac.id;
}

function setup(seed: string, typeId: string, cycles: number, layout: AirportLayout = createSampleAirport()): { c: CompanyState; sim: Simulation } {
  const c = createSandboxCompany(seed);
  c.features = { based: true, overnight: true };
  const k = addContract(c, {
    airlineId: 'SK', destinationId: 'KTA', typeId, perDay: 1, window: 'any',
    feeDiscount: 0.25, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, kind: 'based', basedAircraft: 1,
  });
  c.basedFleet = { ba_1: { id: 'ba_1', airlineId: 'SK', contractId: k.id, typeId, cycles, lastCheckDay: null } };
  const sim = createSimulation(layout, { company: c, seed });
  parkBased(sim, c, k.id, 'ba_1', typeId);
  return { c, sim };
}

describe('maintenance: 整備の周期と枠（4B-4 / §3.6）', () => {
  it('周期を超えた在泊機は枠があれば整備され、運航回数が戻る', () => {
    const { c, sim } = setup('mnt-1', 'B737-800', 12);
    const r = settlePhase4(sim, 0);
    expect(r.maintenance).toEqual({ checked: 1, overdue: 0, faults: 0, techCancelled: 0 });
    expect(c.basedFleet!['ba_1']!.cycles).toBe(0);
    expect(c.basedFleet!['ba_1']!.lastCheckDay).toBe(c.day);
  });

  it('格納庫が M までなら L の所属機は整備できず、格納庫を L にすると整備できる', () => {
    const small = setup('mnt-2', 'A350-900', 12);
    const r1 = settlePhase4(small.sim, 0);
    expect(r1.maintenance?.checked).toBe(0);
    expect(r1.maintenance?.overdue).toBe(1);
    expect(small.c.basedFleet!['ba_1']!.cycles).toBe(12);

    const layout = createSampleAirport();
    for (const f of Object.values(layout.facilities)) if (f.kind === 'hangar') f.props.maxSize = 'L';
    const big = setup('mnt-2', 'A350-900', 12, layout);
    const r2 = settlePhase4(big.sim, 0);
    expect(r2.maintenance?.checked).toBe(1);
    expect(big.c.basedFleet!['ba_1']!.cycles).toBe(0);
  });

  it('整備施設の端数は maintenanceCredit に繰り越される（bays 3 = 1.5 機/晩）', () => {
    const layout = createSampleAirport();
    for (const f of Object.values(layout.facilities)) {
      if (f.kind === 'hangar') f.buildState = 'planned';
      if (f.kind === 'maintenance') f.props.bays = 3;
    }
    const { c, sim } = setup('mnt-3', 'B737-800', 0, layout);
    const fid = Object.values(layout.facilities).find((f) => f.kind === 'maintenance')!.id;
    expect(maintenanceSlots(sim)).toHaveLength(1);
    expect(c.maintenanceCredit?.[fid]).toBe(0.5);
    expect(maintenanceSlots(sim)).toHaveLength(2);
    expect(c.maintenanceCredit?.[fid]).toBe(0);
  });

  it('不具合の判定は種で決定的（同じ状態からは同じ結果）', () => {
    // 整備の枠がない空港では、周期超過の所属機は整備されず不具合の抽選に入る
    const noSlots = (): AirportLayout => {
      const layout = createSampleAirport();
      for (const f of Object.values(layout.facilities)) {
        if (f.kind === 'hangar' || f.kind === 'maintenance') f.buildState = 'planned';
      }
      return layout;
    };
    const a = setup('mnt-4', 'B737-800', 30, noSlots());
    const ra = settlePhase4(a.sim, 0);
    const b = setup('mnt-4', 'B737-800', 30, noSlots());
    const rb = settlePhase4(b.sim, 0);
    expect(ra.maintenance?.checked).toBe(0);
    expect(ra.maintenance?.overdue).toBe(1);
    expect(ra.maintenance).toEqual(rb.maintenance);
    const depA = a.sim.state.flights['fl_dep']!;
    const depB = b.sim.state.flights['fl_dep']!;
    expect(depA.techHoldUntil).toBe(depB.techHoldUntil);
    expect(depA.status).toBe(depB.status);
    // 持ち越しの記録に書かれる不具合も同じ
    expect(a.c.carryOver?.aircraft[0]?.techDelaySec).toBe(b.c.carryOver?.aircraft[0]?.techDelaySec);
    expect(a.c.carryOver?.aircraft[0]?.techCancel).toBe(b.c.carryOver?.aircraft[0]?.techCancel);
  });
});
