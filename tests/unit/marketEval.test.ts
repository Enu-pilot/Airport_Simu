import { describe, expect, it } from 'vitest';
import type { FlightRecord } from '../../src/core/analytics/records';
import { addContract, createCompany, updateContracts, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { stepMarket } from '../../src/core/economy/market';
import { airlineScorecard } from '../../src/core/economy/airlineScore';
import { EVAL_WEIGHTS_V2 } from '../../src/core/economy/airlineEval';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext } from '../../src/core/sim/context';
import { planDayWithDemand } from '../../src/core/economy/planning';
import { analyzeDayPlan } from '../../src/core/economy/planning';

const base = { feeDiscount: 0, startDay: 0, endDay: 999, status: 'active' as const, offerExpiresDay: 0, window: 'any' as const };

function marketCompany(): CompanyState {
  const c = createCompany('career', 'market-test');
  c.city = defaultCity('regional');
  c.market = { version: 1, routes: {} };
  return c;
}

let seq = 0;
function record(contractId: string, airlineId: string, seats: number, lf: number): FlightRecord {
  seq += 1;
  return {
    aircraftId: `ac${seq}`, arrNumber: `A${seq}`, depNumber: `D${seq}`, airlineId, contractId, typeId: 'regional70',
    result: 'completed', causes: [], arrRunway: null, depRunway: null, standId: null, gateId: null,
    arrScheduled: 0, landedAt: 0, blockIn: 0, readyAt: 0, blockOut: 0, depScheduled: 0, takeoffAt: 0,
    airborneHoldSec: 0, taxiInSec: 0, taxiOutSec: 0, groundDistM: 0, groundStopSec: 0,
    seats, paxBooked: Math.round(seats * lf), paxBoarded: Math.round(seats * lf), paxMissed: 0, paxArrived: Math.round(seats * lf),
    bagsLoaded: 0, bagsLeft: 0, taskSec: {}, taskBlockedSec: 0, revenue: 0, disruptions: [],
  };
}

describe('marketEval: 採算評価と市場の日次更新（3-06 / 3-08）', () => {
  it('EVAL_WEIGHTS_V2 の各行の合計は 1', () => {
    for (const w of Object.values(EVAL_WEIGHTS_V2)) expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('需要の要素: 搭乗率 = 基準でスコア 60', () => {
    const c = marketCompany();
    const layout = createSampleAirport();
    const ctx = createContext(layout);
    const plan = planDayWithDemand(c, 0, 1, ctx.types);
    const cards = airlineScorecard({ company: c, ctx, records: [record('x', 'SK', 100, 0.78)], plan, analysis: analyzeDayPlan(plan, ctx) });
    const sk = cards.find((x) => x.airlineId === 'SK')!;
    const demand = sk.components.find((x) => x.key === 'demand')!;
    expect(demand.score).toBe(60); // SK の基準搭乗率 0.78 と一致
  });

  it('market なしの会社には需要の要素が出ない', () => {
    const c = createCompany('career', 'market-none');
    const layout = createSampleAirport();
    const ctx = createContext(layout);
    const plan = planDayWithDemand(c, 0, 1, ctx.types);
    const cards = airlineScorecard({ company: c, ctx, records: [], plan, analysis: analyzeDayPlan(plan, ctx) });
    expect(cards.every((x) => x.components.every((k) => k.key !== 'demand'))).toBe(true);
  });

  it('低迷 5 日で減便、perDay 1 で 10 日続けば撤退', () => {
    const c = marketCompany();
    const k = addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 2 });
    const low = () => [record(k.id, 'RJ', 70, 0.3)]; // RJ の基準 0.7 − 0.2 = 0.5 を下回る
    for (let d = 0; d < 5; d++) stepMarket(c, low());
    expect(k.perDay).toBe(1);
    expect(k.status).toBe('active');
    for (let d = 0; d < 10; d++) stepMarket(c, low());
    expect(k.status).toBe('withdrawn');
  });

  it('好調 5 日で増便の要望が立ち、更新時に増便する。要望がなければ増便しない', () => {
    const c = marketCompany();
    const k = addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 1, endDay: 20 });
    c.airlines['RJ']!.satisfaction = 95;
    const high = () => [record(k.id, 'RJ', 70, 0.97)];
    const routeLf = new Map([['KTA', 1.2]]);
    // 要望なしで満了 → 増便せず更新
    c.day = 20;
    updateContracts(c, {}, undefined, []);
    expect(k.perDay).toBe(1);
    expect(k.endDay).toBeGreaterThan(20);
    // 好調を 5 日続ける → signal
    for (let d = 0; d < 5; d++) stepMarket(c, high(), routeLf);
    expect(c.market!.routes[k.id]!.signal).toBe('grow');
    // 次の満了で増便し、signal は消費される
    c.day = k.endDay;
    updateContracts(c, {}, undefined, []);
    expect(k.perDay).toBe(2);
    expect(c.market!.routes[k.id]?.signal).toBeUndefined();
  });
});
