import { describe, expect, it } from 'vitest';
import { metricsOf } from '../../src/core/analytics/kpi';
import type { FlightRecord } from '../../src/core/analytics/records';
import { createSandboxCompany } from '../../src/core/economy/company';
import { airlineScorecard } from '../../src/core/economy/airlineScore';
import { computeKpi } from '../../src/core/economy/ops';
import type { PlanAnalysis } from '../../src/core/economy/planning';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addTurnaround, createSimulation } from '../../src/core/sim/simulation';
import { isOvernightStay, type Flight } from '../../src/core/sim/types';

/**
 * 夜間滞泊は折り返しではない: 折り返し時間の集計（航空会社の折り返し要素・平均折り返し時間・平均地上作業時間）から
 * 滞泊レコードを除くことの検証。滞泊の判定は明示的な信号（overnight / nightHold: stand / carryOver）だけに基づく。
 */

const analysis = { assignments: {}, issues: [], hourly: { movements: [], depPax: [] }, capacity: { movementsPerHour: 0, securityPerHour: 0, checkInPerHour: 0, turnarounds: 0, totalStands: 0, contactStands: 0, remoteStands: 0, simultaneousPushbacks: null, taxiwayMovementsPerHour: null, dailyMovements: null, busPaxPerHour: null }, terminalCapacity: {}, hourlyByTerminal: {}, peakTurnarounds: 0 } as unknown as PlanAnalysis;

function makeSim() {
  return createSimulation(createSampleAirport(), { company: createSandboxCompany(), settings: { autoSchedule: false, flightsPerDay: 0 } });
}

const record = (overrides: Partial<FlightRecord>): FlightRecord => ({
  aircraftId: 'ac', arrNumber: 'SK100', depNumber: 'SK101', airlineId: 'SK', contractId: null,
  typeId: 'B737-800W', result: 'completed', causes: [], arrRunway: null, depRunway: null, standId: null, gateId: null,
  arrScheduled: 0, landedAt: null, blockIn: null, readyAt: null, blockOut: null,
  depScheduled: 0, takeoffAt: null,
  airborneHoldSec: 0, taxiInSec: 0, taxiOutSec: 0, groundDistM: 0, groundStopSec: 0,
  seats: 100, paxBooked: 100, paxBoarded: 100, paxMissed: 0, paxArrived: 100, bagsLoaded: 0, bagsLeft: 0,
  taskSec: {}, taskBlockedSec: 0, revenue: 0, disruptions: [],
  ...overrides,
});

const fl = (overrides: Partial<Flight>): Flight => overrides as Flight;

describe('isOvernightStay（夜間滞泊の判定根拠）', () => {
  it('明示的な信号がある組だけを滞泊とし、滞在時間の長さでは判定しない', () => {
    const plain = fl({});
    expect(isOvernightStay(plain, plain)).toBe(false);
    expect(isOvernightStay(fl({ overnight: true }), plain)).toBe(true);
    expect(isOvernightStay(plain, fl({ overnight: true }))).toBe(true);
    expect(isOvernightStay(fl({ carryOver: true }), plain)).toBe(true);
    expect(isOvernightStay(plain, fl({ nightHold: { kind: 'stand', decidedAt: 0, releaseAt: 1 } }))).toBe(true);
    // 出発地待機（origin）は到着側の話で、この滞在自体は通常の折り返し
    expect(isOvernightStay(fl({ nightHold: { kind: 'origin', decidedAt: 0, releaseAt: 1 } }), plain)).toBe(false);
    expect(isOvernightStay(plain, fl({ nightHold: { kind: 'airborne', decidedAt: 0, releaseAt: 1 } }))).toBe(false);
  });
});

describe('航空会社の折り返し要素（夜間滞泊の除外）', () => {
  const sim = makeSim();
  const std = sim.ctx.types['B737-800W']!.turnaroundSec;
  const turnaroundOf = (records: FlightRecord[]) =>
    airlineScorecard({ company: sim.company!, ctx: sim.ctx, records, plan: { day: 0, flights: [], dropped: [] }, analysis })
      .find((s) => s.airlineId === 'SK')!.components.find((c) => c.key === 'turnaround')!;

  const normal = record({ blockIn: 0, readyAt: std });
  const overnight = record({ arrNumber: 'SK300', depNumber: 'SK301', blockIn: 0, readyAt: 10 * 3600, overnightStay: true });

  it('滞在10時間の夜間滞泊があっても、通常の折り返しだけが評価される', () => {
    const c = turnaroundOf([normal, overnight]);
    expect(c.level).toBe('good');
    expect(c.score).toBe(100);
    expect(c.facts.n).toBe(1);
    expect(c.facts.flightNumbers).toBeUndefined();
  });

  it('対照: 同じ10時間の滞在でも滞泊でなければ大きく減点される（旗が効いていることの確認）', () => {
    const c = turnaroundOf([normal, record({ blockIn: 0, readyAt: 10 * 3600 })]);
    expect(c.level).toBe('bad');
    expect(c.score).toBeLessThan(100);
  });

  it('通常の遅い折り返しは従来どおり減点され、超過便の列挙から滞泊は除かれる', () => {
    const slow = record({ arrNumber: 'SK200', depNumber: 'SK201', blockIn: 0, readyAt: std + 600 });
    const c = turnaroundOf([slow, overnight]);
    expect(c.level).toBe('warn');
    expect(c.score).toBe(60);
    expect(c.facts.flightNumbers).toEqual(['SK200', 'SK201']);
  });

  it('全件が夜間滞泊なら折り返し要素は n/a', () => {
    const c = turnaroundOf([overnight]);
    expect(c.level).toBe('n/a');
    expect(c.score).toBeNull();
  });
});

describe('分析 KPI の平均折り返し時間（夜間滞泊の除外）', () => {
  it('avgTurnMin は滞泊を除き、avgStandMin（駐機時間）は滞泊も数える', () => {
    const sim = makeSim();
    const std = sim.ctx.types['B737-800W']!.turnaroundSec;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const g = metricsOf('SK', [
      record({ blockIn: 0, readyAt: std, blockOut: std + 900 }),
      record({ blockIn: 0, readyAt: 10 * 3600, blockOut: 10 * 3600 + 900, overnightStay: true }),
    ], sim.ctx.types);
    expect(g.avgTurnMin).toBe(r1(std / 60));
    expect(g.avgStandMin).toBe(r1(((std + 900) + (10 * 3600 + 900)) / 2 / 60));
  });
});

describe('日次 KPI の平均地上作業時間（夜間滞泊の除外）', () => {
  it('夜間滞泊の出発便（準備完了が翌朝）は平均に入らない', () => {
    const sim = makeSim();
    const std = sim.ctx.types['B737-800W']!.turnaroundSec;
    const t0 = sim.state.now + 600;
    const ac1 = addTurnaround(sim, 'B737-800W', t0);
    const arr1 = sim.state.flights[ac1.arrivalFlightId]!;
    const dep1 = sim.state.flights[ac1.departureFlightId]!;
    arr1.block = t0 + 1800;
    dep1.readyAt = arr1.block + std;
    const ac2 = addTurnaround(sim, 'B737-800W', t0);
    const arr2 = sim.state.flights[ac2.arrivalFlightId]!;
    const dep2 = sim.state.flights[ac2.departureFlightId]!;
    arr2.block = t0 + 1800;
    dep2.overnight = true;
    dep2.readyAt = arr2.block + 10 * 3600;
    sim.state.now = arr2.block + 10 * 3600 + 60;
    const kpi = computeKpi(sim, sim.company!).kpi;
    expect(kpi.avgGroundMin).toBe(Math.round((std / 60) * 10) / 10);
  });
});
