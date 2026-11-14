import { describe, expect, it } from 'vitest';
import { metricsOf } from '../../src/core/analytics/kpi';
import type { FlightRecord } from '../../src/core/analytics/records';
import { createSandboxCompany } from '../../src/core/economy/company';
import { airlineScorecard } from '../../src/core/economy/airlineScore';
import { computeKpi } from '../../src/core/economy/ops';
import { evaluateDelayPair } from '../../src/core/economy/delayEvaluation';
import type { PlanAnalysis } from '../../src/core/economy/planning';
import { addTurnaround, createSimulation } from '../../src/core/sim/simulation';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';

const pair = (overrides: Partial<Parameters<typeof evaluateDelayPair>[0]> = {}) => evaluateDelayPair({
  arrScheduled: 1_000,
  arrActual: 2_800,
  depScheduled: 8_800,
  depBlockOut: 9_700,
  turnaroundSec: 5_000,
  arrivalExternalDelaySec: { weather: 600 },
  ...overrides,
});

describe('外部要因と折り返し猶予を含む遅延評価', () => {
  it('実際に記録された外部遅延秒だけを到着評価から控除する', () => {
    expect(pair()).toMatchObject({ actualArrivalSec: 1_800, arrivalExternalSec: 600, arrivalSec: 1_200 });
    expect(pair({ arrivalExternalDelaySec: undefined })).toMatchObject({ arrivalExternalSec: 0, arrivalSec: 1_800 });
  });

  it('外部要因の記録が実遅延を超えても評価値は0秒で止まる', () => {
    expect(pair({ arrivalExternalDelaySec: { weather: 9_000 } }).arrivalSec).toBe(0);
  });

  it('到着遅延が折返し余裕以内なら出発猶予を付けず、超えた部分だけを使う', () => {
    const within = pair({ arrActual: 2_500, depScheduled: 8_800, depBlockOut: 9_700, turnaroundBufferSec: 2_000 });
    expect(within.departureGraceSec).toBe(0);
    expect(within.departureSec).toBe(900);
    const beyond = pair({ arrActual: 4_000, depScheduled: 8_800, depBlockOut: 10_300, turnaroundBufferSec: 2_000 });
    expect(beyond.departureGraceSec).toBe(1_000);
    expect(beyond.departureSec).toBe(500);
    expect(beyond.arrivalSec).toBe(2_400);
  });

  it('OTP、平均遅延、航空会社スコアカードが共通の評価値を使い、実績遅延も別に保つ', () => {
    const sim = createSimulation(createSampleAirport(), { company: createSandboxCompany(), settings: { autoSchedule: false, flightsPerDay: 0 } });
    const ac = addTurnaround(sim, 'B737-800W', sim.state.now + 600);
    const arr = sim.state.flights[ac.arrivalFlightId]!;
    const dep = sim.state.flights[ac.departureFlightId]!;
    const turnaround = sim.ctx.types['B737-800W']!.turnaroundSec;
    dep.scheduled = arr.scheduled + turnaround + 1_200;
    arr.actual = arr.scheduled + 3_600;
    dep.block = dep.scheduled + 1_500;
    arr.externalDelaySec = { weather: 2_700 };
    sim.state.now = dep.block + 1;
    const daily = computeKpi(sim, sim.company!).kpi;
    expect(daily.otp).toBe(1);
    expect(daily.avgDelayMin).toBe(7.5);
    expect(daily.actualAvgDelayMin).toBe(42.5);

    const record: FlightRecord = {
      aircraftId: ac.id, arrNumber: arr.number, depNumber: dep.number, airlineId: 'SK', contractId: null,
      typeId: ac.typeId, result: 'completed', causes: [], arrRunway: null, depRunway: null, standId: null, gateId: null,
      arrScheduled: arr.scheduled, landedAt: arr.actual, blockIn: null, readyAt: null, blockOut: dep.block,
      depScheduled: dep.scheduled, takeoffAt: null, arrivalExternalDelaySec: arr.externalDelaySec,
      airborneHoldSec: 0, taxiInSec: 0, taxiOutSec: 0, groundDistM: 0, groundStopSec: 0,
      seats: 100, paxBooked: 100, paxBoarded: 100, paxMissed: 0, paxArrived: 100, bagsLoaded: 0, bagsLeft: 0,
      taskSec: {}, taskBlockedSec: 0, revenue: 0, disruptions: [],
    };
    const group = metricsOf('SK', [record], sim.ctx.types);
    expect(group.otp).toBe(1);
    expect(group.avgDepDelayMin).toBe(0);
    expect(group.avgActualDepDelayMin).toBe(25);
    const analysis = { assignments: {}, issues: [], hourly: { movements: [], depPax: [] }, capacity: { movementsPerHour: 0, securityPerHour: 0, checkInPerHour: 0, turnarounds: 0, totalStands: 0, contactStands: 0, remoteStands: 0, simultaneousPushbacks: null, taxiwayMovementsPerHour: null, dailyMovements: null, busPaxPerHour: null }, terminalCapacity: {}, hourlyByTerminal: {}, peakTurnarounds: 0 } as unknown as PlanAnalysis;
    const scorecard = airlineScorecard({ company: sim.company!, ctx: sim.ctx, records: [record], plan: { day: 0, flights: [], dropped: [] }, analysis });
    expect(scorecard.find((s) => s.airlineId === 'SK')!.components.find((c) => c.key === 'otp')!.facts.value).toBe(1);
    expect(evaluateDelayPair({ arrScheduled: arr.scheduled, arrActual: arr.actual, depScheduled: dep.scheduled, depBlockOut: dep.block, turnaroundSec: turnaround, arrivalExternalDelaySec: arr.externalDelaySec }).departureSec).toBe(0);
  });
});
