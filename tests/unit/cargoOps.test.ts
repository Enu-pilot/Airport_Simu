import { describe, expect, it } from 'vitest';
import { placeFacility } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { addContract, createCareerCompany, createSandboxCompany, generateCargoOffers, generateOffers, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { cargoHoldM3, planCargoDay } from '../../src/core/economy/cargo';
import { airlineDef } from '../../src/core/economy/registry';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { checkInvariants } from '../../src/core/sim/invariants';
import { DAY_SEC } from '../../src/core/sim/rules';
import { createTurnaroundTasks, tasksOf } from '../../src/core/sim/ground';
import { cargoTaskSec } from '../../src/core/sim/tasks';
import { operableTypes } from '../../src/core/sim/context';
import { must } from './helpers';
import type { AirportLayout } from '../../src/core/model/types';

/**
 * 5-12 貨物の sim 実便化: 貨物便が通常の機体として運航し、貨物タスクで折り返して、
 * 実際に積み下ろしした量が日報の貨物収支（実績）に入る。貨物 OFF では何も生成されない。
 */

function layoutWithCargoTerminal(throughputM3PerHour = 60): AirportLayout {
  const layout = must(placeFacility(createSampleAirport(), 'cargoTerminal', { x: 100, y: 40 })).layout;
  if (throughputM3PerHour !== 60) {
    const f = Object.values(layout.facilities).find((x) => x.kind === 'cargoTerminal')!;
    f.props = { ...f.props, throughputM3PerHour };
  }
  return layout;
}

function cargoCompany(): CompanyState {
  const c = createSandboxCompany('cargo-ops');
  c.city = defaultCity('regional');
  c.rating = 80;
  c.features = { cargo: true };
  c.airlines['NH'] ??= { satisfaction: 60, lowDays: 0 };
  addContract(c, {
    airlineId: 'NH', destinationId: 'TWN', typeId: 'B777F', perDay: 1, window: 'any',
    feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo',
  });
  return c;
}

/** 次の 0:00 の日次締めまで進める（不変条件も確認） */
function runDay(sim: Simulation): void {
  const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
  while (sim.state.now <= target) {
    stepSimulation(sim);
    const v = checkInvariants(sim);
    if (v.length > 0) throw new Error(`t=${sim.state.now}: ${v.join(' / ')}`);
  }
}

describe('5-12 貨物の sim 実便化', () => {
  it('貨物便が1日運航でき、貨物タスクで折り返し、実績が日報の貨物収支に入る', () => {
    const c = cargoCompany();
    const sim = createSimulation(layoutWithCargoTerminal(), { company: c });
    const cargoFlights = Object.values(sim.state.flights).filter((f) => f.cargo);
    expect(cargoFlights.length).toBe(2); // 到着・出発の組
    const volume = cargoFlights[0]!.cargo!.volumeM3;
    expect(volume).toBeGreaterThan(0);
    expect(cargoFlights.every((f) => f.plannedPax === 0)).toBe(true);

    runDay(sim);

    const ac = Object.values(sim.state.aircraft).find((a) => sim.state.flights[a.arrivalFlightId]?.cargo)!;
    const arr = sim.state.flights[ac.arrivalFlightId]!;
    const dep = sim.state.flights[ac.departureFlightId]!;
    expect(dep.status).toBe('completed');
    // 貨物タスクだけが作られ、両方完了している（旅客タスクは作られない）
    const tasks = tasksOf(sim.state, ac.id);
    expect(tasks.map((t) => t.kind).sort()).toEqual(['cargoLoad', 'cargoUnload', 'pushback']);
    expect(tasks.filter((t) => t.kind !== 'pushback').every((t) => t.state === 'done')).toBe(true);
    // 旅客グループは生成されない
    expect(sim.state.flightPax[arr.id] ?? []).toHaveLength(0);
    expect(sim.state.flightPax[dep.id] ?? []).toHaveLength(0);
    expect(arr.pax.booked).toBe(0);
    expect(dep.pax.booked).toBe(0);

    // 日報の貨物収支は実績（運航した1組 × 片道量 × 往復）で入る
    const report = c.reports[c.reports.length - 1]!;
    expect(report.cargo).toBeDefined();
    expect(report.cargo!.carriedM3).toBeCloseTo(volume * 2, 0);
    expect(report.cargo!.revenue).toBe(Math.round(volume * 2 * 900));
    expect(report.cargo!.handlingCost).toBe(Math.round(volume * 2 * 120));
    expect(report.revenue.cargo).toBe(report.cargo!.revenue);
    expect(report.cost.cargoHandling).toBe(report.cargo!.handlingCost);
    const demand = planCargoDay(cargoCompany(), 0).demandM3;
    expect(report.cargo!.leftoverM3).toBeCloseTo(Math.max(0, demand - volume * 2), 0);
  });

  it('貨物タスクの所要時間は貨物上屋の処理能力で変わる', () => {
    const mk = (throughput: number) => {
      const sim = createSimulation(layoutWithCargoTerminal(throughput));
      const ac = addTurnaround(sim, 'B777F', sim.state.now + 3600, {
        airline: 'NH',
        plan: { contractId: 'ct_x', destinationId: 'TWN', arrPax: 0, depPax: 0, standId: null, cargo: { volumeM3: 125 } },
      });
      createTurnaroundTasks(sim, ac);
      return tasksOf(sim.state, ac.id);
    };
    const slow = mk(60);
    const fast = mk(600);
    expect(slow.map((t) => t.kind).sort()).toEqual(['cargoLoad', 'cargoUnload']);
    expect(slow.find((t) => t.kind === 'cargoUnload')!.workSec).toBe(cargoTaskSec(125, 60));
    expect(fast.find((t) => t.kind === 'cargoUnload')!.workSec).toBe(cargoTaskSec(125, 600));
    expect(slow[0]!.workSec).toBeGreaterThan(fast[0]!.workSec);
  });

  it('貨物 OFF では貨物便・貨物タスク・日報の貨物欄は生成されない', () => {
    const c = createCareerCompany('cargo-off');
    const sim = createSimulation(createStarterAirfield(), { company: c });
    runDay(sim);
    expect(Object.values(sim.state.flights).some((f) => f.cargo)).toBe(false);
    expect(Object.values(sim.state.tasks).some((t) => t.kind === 'cargoUnload' || t.kind === 'cargoLoad')).toBe(false);
    const report = c.reports[c.reports.length - 1]!;
    expect(report.cargo).toBeUndefined();
    expect(report.revenue.cargo).toBeUndefined();
    expect(report.cost.cargoHandling).toBeUndefined();
  });

  it('貨物オファーは1回の生成で上限の2件まで出る（二重数えの修正）', () => {
    const c = createSandboxCompany('cargo-offers2');
    c.city = defaultCity('metropolitan');
    c.rating = 90;
    c.features = { cargo: true };
    c.market = { version: 1, routes: {} }; // 全カタログを対象にする（レガシーだけだと候補が NP のみ）
    const sim = createSimulation(createSampleAirport(), { company: c });
    const offers = generateCargoOffers(c, operableTypes(sim.ctx));
    expect(offers).toHaveLength(2);
    expect(offers.every((k) => k.kind === 'cargo')).toBe(true);
    // 開いている貨物オファーが上限に達している間は新規に出ない
    expect(generateCargoOffers(c, operableTypes(sim.ctx))).toHaveLength(0);
  });

  it('貨物専用機はカタログに容積を持ち、貨物オファーで選ばれ、旅客オファーには混ざらない', () => {
    for (const t of ['B747-400F', 'B747-8F', 'B777F', 'B767-300F']) {
      expect(cargoHoldM3(t)).not.toBeNull();
      expect(cargoHoldM3(t)!).toBeGreaterThan(200);
    }
    const nh = airlineDef('NH');
    expect(nh.cargoFleet).toEqual(['B777F', 'B767-300F']);
    expect(nh.fleet.some((e) => nh.cargoFleet!.includes(e.typeId))).toBe(false);
    // 貨物オファー: NH は旅客フリート最大（B777-300ER 213.8）より大きいフレーターが選ばれる
    const c = createSandboxCompany('cargo-freighter');
    c.city = defaultCity('metropolitan');
    c.rating = 90;
    c.features = { cargo: true };
    c.market = { version: 1, routes: {} };
    const sim = createSimulation(createSampleAirport(), { company: c });
    const offers = generateCargoOffers(c, operableTypes(sim.ctx));
    const nhOffer = offers.find((k) => k.airlineId === 'NH');
    expect(nhOffer).toBeDefined();
    expect(nh.cargoFleet).toContain(nhOffer!.typeId);
    // 旅客オファーには貨物専用機が混ざらない（候補は旅客フリートだけ）
    const c3 = createSandboxCompany('cargo-freighter-pax');
    c3.city = defaultCity('metropolitan');
    c3.rating = 90;
    const paxOffers = generateOffers(c3, operableTypes(sim.ctx));
    const freighterIds = new Set(['B747-400F', 'B747-8F', 'B777F', 'B767-300F']);
    expect(paxOffers.every((k) => !freighterIds.has(k.typeId))).toBe(true);
  });
});
