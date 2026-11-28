import { describe, expect, it } from 'vitest';
import type { FlightRecord } from '../../src/core/analytics/records';
import { addContract, createCompany, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { previewLoadFactor, trafficByAirline, trafficByRoute } from '../../src/core/economy/traffic';

let seq = 0;
function record(partial: Partial<FlightRecord>): FlightRecord {
  seq += 1;
  return {
    aircraftId: `ac${seq}`, arrNumber: `A${seq}`, depNumber: `D${seq}`, airlineId: 'SK', contractId: 'K_1', typeId: 'B787-9',
    result: 'completed', causes: [], arrRunway: null, depRunway: null, standId: null, gateId: null,
    arrScheduled: 0, landedAt: 0, blockIn: 0, readyAt: 0, blockOut: 0, depScheduled: 0, takeoffAt: 0,
    airborneHoldSec: 0, taxiInSec: 0, taxiOutSec: 0, groundDistM: 0, groundStopSec: 0,
    seats: 100, paxBooked: 80, paxBoarded: 80, paxMissed: 0, paxArrived: 70,
    bagsLoaded: 0, bagsLeft: 0, taskSec: {}, taskBlockedSec: 0, revenue: 0, disruptions: [],
    ...partial,
  };
}

describe('traffic: 旅客実績の集計と見込み（フェーズ 3 §5）', () => {
  it('航空会社ごと・路線ごとに集計する（欠航は数えない）', () => {
    const records = [
      record({}),
      record({ airlineId: 'SK', contractId: 'K_2' }),
      record({ result: 'cancelled' }),
      record({ airlineId: 'RJ', contractId: 'K_3', seats: 70, paxBooked: 35, paxArrived: 35 }),
    ];
    const byAirline = trafficByAirline(records);
    expect(byAirline.get('SK')!.flights).toBe(2);
    expect(byAirline.get('SK')!.loadFactor).toBeCloseTo(0.75, 10); // (80+70)*2 / (100*2*2)
    expect(byAirline.get('RJ')!.loadFactor).toBeCloseTo(0.5, 10);
    const destOf = (id: string) => ({ K_1: 'TYO', K_2: 'TYO', K_3: 'KTA' })[id as 'K_1'];
    const byRoute = trafficByRoute(records, destOf);
    expect(byRoute.get('TYO')!.flights).toBe(2);
    expect(byRoute.get('KTA')!.pax).toBe(70);
  });

  // 航空会社は国内線を運航できる NH（ANA）を使う。SK は PR #67 の航空会社整理でスカンジナビア航空（国際線のみ）になり、
  // 国内の就航先は範囲外（airline-unsupported）として見込みを出さないのが正しい挙動のため
  it('見込み搭乗率: market のない会社は null、ある会社は路線需要から出す', () => {
    const plain = createCompany('career', 'traffic-plain');
    expect(previewLoadFactor(plain, { airlineId: 'NH', destinationId: 'TYO', typeId: 'B787-9', perDay: 1 }, 0)).toBeNull();
    const c: CompanyState = createCompany('career', 'traffic-market');
    c.city = defaultCity('regional');
    c.market = { version: 1, routes: {} };
    c.rating = 50;
    const p = previewLoadFactor(c, { airlineId: 'NH', destinationId: 'TYO', typeId: 'B787-9', perDay: 1 }, 0);
    expect(p).not.toBeNull();
    expect(p!.lf).toBeGreaterThan(0);
    expect(p!.lf).toBeLessThanOrEqual(0.98);
    expect(p!.seats).toBe(580); // NH の B787-9（既定 290 席）× 1 便 × 往復
  });

  it('既存の契約がある路線では、便を足すと見込みが下がる', () => {
    const c: CompanyState = createCompany('career', 'traffic-market2');
    c.city = defaultCity('regional');
    c.market = { version: 1, routes: {} };
    c.rating = 50;
    const one = previewLoadFactor(c, { airlineId: 'NH', destinationId: 'TYO', typeId: 'B787-9', perDay: 4 }, 0)!;
    addContract(c, { airlineId: 'NP', destinationId: 'TYO', typeId: 'A350-900', perDay: 4, window: 'any', feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0 });
    const after = previewLoadFactor(c, { airlineId: 'NH', destinationId: 'TYO', typeId: 'B787-9', perDay: 4 }, 0)!;
    expect(after.lf).toBeLessThan(one.lf);
  });
});
