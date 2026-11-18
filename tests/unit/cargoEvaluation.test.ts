import { describe, expect, it } from 'vitest';
import { metricsOf } from '../../src/core/analytics/kpi';
import { stepAnalytics, type FlightRecord } from '../../src/core/analytics/records';
import { airlineScorecard } from '../../src/core/economy/airlineScore';
import { addContract, createCompany, createSandboxCompany } from '../../src/core/economy/company';
import { computeKpi } from '../../src/core/economy/ops';
import type { PlanAnalysis } from '../../src/core/economy/planning';
import { airlineDef } from '../../src/core/economy/registry';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addTurnaround, createSimulation } from '../../src/core/sim/simulation';

/**
 * 貨物は旅客評価とは別軸（5-12）: 貨物便のレコードが航空会社の評価要素（折り返し・定時性・旅客・需要・スポット・枠）と
 * 折り返し系 KPI（平均折り返し時間・平均地上作業時間）に入らないことの検証。
 * レコードへの cargo 旗は overnightStay と同じ流儀（貨物便のレコードにだけキーを付ける）。
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

describe('FlightRecord の貨物フラグ（buildRecord）', () => {
  it('貨物便のレコードにだけ cargo が付く', () => {
    const sim = makeSim();
    const t0 = sim.state.now + 600;
    const acPax = addTurnaround(sim, 'B737-800W', t0);
    const acCargo = addTurnaround(sim, 'B777F', t0, {
      plan: { contractId: 'ct_x', destinationId: 'TWN', arrPax: 0, depPax: 0, standId: null, cargo: { volumeM3: 10 } },
    });
    sim.state.aircraft[acPax.id]!.state = 'departed';
    sim.state.aircraft[acCargo.id]!.state = 'departed';
    stepAnalytics(sim);
    const recs = sim.state.analytics.records;
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.aircraftId === acCargo.id)!.cargo).toBe(true);
    expect(recs.find((r) => r.aircraftId === acPax.id)!.cargo).toBeUndefined();
  });
});

describe('航空会社の評価要素（貨物便の分離）', () => {
  const sim = makeSim();
  const std = sim.ctx.types['B737-800W']!.turnaroundSec;
  const componentOf = (records: FlightRecord[], key: string, company = sim.company!) =>
    airlineScorecard({ company, ctx: sim.ctx, records, plan: { day: 0, flights: [], dropped: [] }, analysis })
      .find((s) => s.airlineId === 'SK')!.components.find((c) => c.key === key)!;

  it('折り返し: 地上10時間の貨物便があっても通常の折り返しだけが評価される', () => {
    const normal = record({ blockIn: 0, readyAt: std });
    const cargoLong = record({ arrNumber: 'SK900', depNumber: 'SK901', blockIn: 0, readyAt: 10 * 3600, cargo: true });
    const c = componentOf([normal, cargoLong], 'turnaround');
    expect(c.level).toBe('good');
    expect(c.score).toBe(100);
    expect(c.facts.n).toBe(1);
    expect(c.facts.flightNumbers).toBeUndefined();
  });

  it('対照: 同じ10時間の滞在でも貨物でなければ大きく減点される（旗が効いていることの確認）', () => {
    const normal = record({ blockIn: 0, readyAt: std });
    const c = componentOf([normal, record({ blockIn: 0, readyAt: 10 * 3600 })], 'turnaround');
    expect(c.level).toBe('bad');
    expect(c.score).toBeLessThan(100);
  });

  it('折り返し: 全件が貨物便なら n/a', () => {
    const c = componentOf([record({ blockIn: 0, readyAt: 10 * 3600, cargo: true })], 'turnaround');
    expect(c.level).toBe('n/a');
    expect(c.score).toBeNull();
  });

  it('定時性: 大幅に遅れた貨物便は定時率に入らない', () => {
    const onTime = record({ arrScheduled: 0, landedAt: 0, depScheduled: 3600, blockOut: 3600 });
    const cargoLate = record({ arrNumber: 'SK900', depNumber: 'SK901', arrScheduled: 0, landedAt: 3 * 3600, depScheduled: 4 * 3600, blockOut: 7 * 3600, cargo: true });
    const c = componentOf([onTime, cargoLate], 'otp');
    expect(c.level).toBe('good');
    expect(c.facts.value).toBe(1);
    expect(c.facts.n).toBe(2);
    expect(c.facts.lateCount).toBe(0);
    // 対照: 貨物でない同じ遅れは定時率を下げる
    const { cargo: _drop, ...lateNoFlag } = cargoLate;
    const contrast = componentOf([onTime, record(lateNoFlag)], 'otp');
    expect(contrast.facts.value).toBeLessThan(1);
  });

  it('旅客: 貨物レコードの乗り遅れ・積み残しは数えない', () => {
    const clean = record({ paxBooked: 100, paxBoarded: 100, paxMissed: 0, bagsLoaded: 0, bagsLeft: 0 });
    const cargoDirty = record({ arrNumber: 'SK900', depNumber: 'SK901', paxBooked: 100, paxMissed: 100, bagsLoaded: 50, bagsLeft: 50, cargo: true });
    const c = componentOf([clean, cargoDirty], 'pax');
    expect(c.level).toBe('good');
    expect(c.facts.missedCount).toBe(0);
    expect(c.facts.leftCount).toBe(0);
    expect(c.facts.n).toBe(1);
    // 貨物レコードだけなら n/a
    expect(componentOf([cargoDirty], 'pax').level).toBe('n/a');
  });

  it('スポット: 貨物便のスポットなし（noStand）は旅客側の不満にしない', () => {
    expect(componentOf([record({ causes: ['noStand'], cargo: true })], 'stand').level).toBe('n/a');
    const c = componentOf([record({ causes: ['noStand'] })], 'stand');
    expect(c.level).toBe('warn');
    expect(c.facts.n).toBe(1);
  });

  it('需要: 貨物便の座席は搭乗率に入らない（market 有効時）', () => {
    const c = createCompany('career', 'cargo-eval-demand');
    c.market = { version: 1, routes: {} };
    const baseLf = airlineDef('SK').baseLoadFactor;
    const paxRec = record({ contractId: 'ct_p', seats: 1000, paxBooked: Math.round(1000 * baseLf), paxBoarded: Math.round(1000 * baseLf), paxArrived: Math.round(1000 * baseLf) });
    const cargoRec = record({ arrNumber: 'SK900', depNumber: 'SK901', contractId: 'ct_c', seats: 300, paxBooked: 0, paxBoarded: 0, paxArrived: 0, cargo: true });
    const d = componentOf([paxRec, cargoRec], 'demand', c);
    expect(d.score).toBe(60); // 基準搭乗率と一致
    expect(d.facts.value).toBeCloseTo(baseLf, 10);
    expect(d.facts.n).toBe(1);
    // 対照: 貨物でない同じレコード（旅客0・座席300）は搭乗率を引き下げる
    const { cargo: _drop, ...cargoNoFlag } = cargoRec;
    const contrast = componentOf([paxRec, record(cargoNoFlag)], 'demand', c);
    expect(contrast.score).toBeLessThan(60);
  });

  it('枠: 落選した貨物契約は数えず、旅客契約の落選は数える', () => {
    const c = createSandboxCompany('cargo-eval-slots');
    const cargoK = addContract(c, { airlineId: 'SK', destinationId: 'TWN', typeId: 'B747-400F', perDay: 1, window: 'any', feeDiscount: 0, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo' });
    const paxK = addContract(c, { airlineId: 'SK', destinationId: 'TWN', typeId: 'A321neo', perDay: 1, window: 'any', feeDiscount: 0, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0 });
    const slotsOf = (dropped: string[]) =>
      airlineScorecard({ company: c, ctx: sim.ctx, records: [], plan: { day: 0, flights: [], dropped }, analysis })
        .find((s) => s.airlineId === 'SK')!.components.find((x) => x.key === 'slots')!;
    const cargoOnly = slotsOf([cargoK.id]);
    expect(cargoOnly.level).toBe('good');
    expect(cargoOnly.facts.n).toBe(0);
    const paxDropped = slotsOf([paxK.id]);
    expect(paxDropped.level).toBe('bad');
    expect(paxDropped.facts.n).toBe(1);
  });
});

describe('分析 KPI の平均折り返し時間（貨物便の分離）', () => {
  it('avgTurnMin は貨物便を除き、avgStandMin（駐機時間）は貨物便も数える', () => {
    const sim = makeSim();
    const std = sim.ctx.types['B737-800W']!.turnaroundSec;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const g = metricsOf('SK', [
      record({ blockIn: 0, readyAt: std, blockOut: std + 900 }),
      record({ arrNumber: 'SK900', depNumber: 'SK901', blockIn: 0, readyAt: 10 * 3600, blockOut: 10 * 3600 + 900, cargo: true }),
    ], sim.ctx.types);
    expect(g.avgTurnMin).toBe(r1(std / 60));
    expect(g.avgStandMin).toBe(r1(((std + 900) + (10 * 3600 + 900)) / 2 / 60));
  });
});

describe('日次 KPI の平均地上作業時間（貨物便の分離）', () => {
  it('地上10時間の貨物便は平均に入らない', () => {
    const sim = makeSim();
    const std = sim.ctx.types['B737-800W']!.turnaroundSec;
    const t0 = sim.state.now + 600;
    const ac1 = addTurnaround(sim, 'B737-800W', t0);
    const arr1 = sim.state.flights[ac1.arrivalFlightId]!;
    const dep1 = sim.state.flights[ac1.departureFlightId]!;
    arr1.block = t0 + 1800;
    dep1.readyAt = arr1.block + std;
    const ac2 = addTurnaround(sim, 'B777F', t0, {
      plan: { contractId: 'ct_x', destinationId: 'TWN', arrPax: 0, depPax: 0, standId: null, cargo: { volumeM3: 10 } },
    });
    const arr2 = sim.state.flights[ac2.arrivalFlightId]!;
    const dep2 = sim.state.flights[ac2.departureFlightId]!;
    arr2.block = t0 + 1800;
    dep2.readyAt = arr2.block + 10 * 3600;
    sim.state.now = arr2.block + 10 * 3600 + 60;
    const kpi = computeKpi(sim, sim.company!).kpi;
    expect(kpi.avgGroundMin).toBe(Math.round((std / 60) * 10) / 10);
  });
});
