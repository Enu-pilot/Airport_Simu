import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany } from '../../src/core/economy/company';
import { analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { planDayWithDemand, type DayPlan, type PlannedFlight } from '../../src/core/economy/planning';
import { routeCapabilitiesForAirport } from '../../src/core/economy/registry';
import { createContext } from '../../src/core/sim/context';
import { connectionPairRows } from '../../src/ui/HubPanel';
import { domTransferAirport } from './transferLayout';

/**
 * UIデザイン更新 第3段階・§6-2: 接続ペア表示（表示専用の読み取り）。
 * 計画に付けられた connections を写すだけで、合計が能力スナップショットの
 * 乗継旅客数と一致すること、二重適用で増えないことを担保する。
 */

const MCT = {
  DD: { max: 45, median: 40 },
  DI: { max: null, median: null },
  ID: { max: null, median: null },
  II: { max: null, median: null },
} as const;

function flight(partial: Partial<PlannedFlight> & { key: string }): PlannedFlight {
  return {
    contractId: 'k1', airlineId: 'HB', destinationId: 'TYO', typeId: 'B737-800',
    arrNumber: 'HB100', depNumber: 'HB101', arrivalAt: 8 * 3600, departureAt: 9 * 3600,
    arrPax: 100, depPax: 100, seats: 180, inboundDelaySec: 0,
    ...partial,
  };
}

describe('connectionPairRows: 接続ペアの写し', () => {
  it('connections をペア行に変換し、接続時間・MCT・余裕・品質を出す', () => {
    const plan: DayPlan = {
      day: 0,
      flights: [
        flight({ key: 'a1', arrNumber: 'HB200', destinationId: 'KTA', arrivalAt: 8 * 3600, connections: [{ depKey: 'd1', pax: 12, kind: 'DD' }] }),
        flight({ key: 'd1', depNumber: 'HB300', destinationId: 'OSA', departureAt: 9 * 3600 + 30 * 60 }),
      ],
    } as DayPlan;
    const rows = connectionPairRows(plan, MCT);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.fromName).toBeTruthy();
    expect(r.pax).toBe(12);
    expect(r.gapMin).toBe(90);
    expect(r.mctMin).toBe(45);
    expect(r.marginMin).toBe(45);
    expect(r.quality).not.toBeNull();
    expect(r.quality!).toBeGreaterThan(0);
    expect(r.quality!).toBeLessThanOrEqual(1);
  });

  it('人数の降順に並び、存在しない出発便は落とす', () => {
    const plan: DayPlan = {
      day: 0,
      flights: [
        flight({ key: 'a1', connections: [{ depKey: 'd1', pax: 3, kind: 'DD' }, { depKey: 'gone', pax: 99, kind: 'DD' }] }),
        flight({ key: 'a2', connections: [{ depKey: 'd1', pax: 20, kind: 'DD' }] }),
        flight({ key: 'd1' }),
      ],
    } as DayPlan;
    const rows = connectionPairRows(plan, MCT);
    expect(rows.map((r) => r.pax)).toEqual([20, 3]);
  });

  it('connections がなければ空', () => {
    const plan: DayPlan = { day: 0, flights: [flight({ key: 'a1' })] } as DayPlan;
    expect(connectionPairRows(plan, MCT)).toEqual([]);
  });
});

describe('connectionPairRows: 実計画との整合', () => {
  it('合計人数が能力スナップショットの乗継旅客数と一致し、二重適用で増えない', () => {
    const c = createSandboxCompany('phase3-hub');
    c.features = { hub: true };
    const base = { feeDiscount: 0, startDay: 0, endDay: 999, status: 'active' as const, offerExpiresDay: 0, window: 'any' as const };
    addContract(c, { ...base, airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 3, transferShare: 0.4 });
    addContract(c, { ...base, airlineId: 'HB', destinationId: 'TYO', typeId: 'B737-800', perDay: 3, transferShare: 0.4 });
    addContract(c, { ...base, airlineId: 'HB', destinationId: 'OSA', typeId: 'B737-800', perDay: 3, transferShare: 0.4 });
    const layout = domTransferAirport();
    const ctx = createContext(layout);
    const plan = planDayWithDemand(c, c.day, 1, ctx.types, routeCapabilitiesForAirport(layout.countryId));
    const snapshot = analyzeAirportCapacity(c, ctx, [], plan);
    expect(snapshot.hub.transferPaxPerDay).toBeGreaterThan(0);
    const rows = connectionPairRows(snapshot.plan, snapshot.hub.mctMin);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((s, r) => s + r.pax, 0)).toBe(snapshot.hub.transferPaxPerDay);
    // 同じ計画へ analyzeAirportCapacity をもう一度かけても connections は増えない（planConnections の二重適用ガード）
    const again = analyzeAirportCapacity(c, ctx, [], plan);
    expect(again.hub.transferPaxPerDay).toBe(snapshot.hub.transferPaxPerDay);
    expect(connectionPairRows(again.plan, again.hub.mctMin).reduce((s, r) => s + r.pax, 0)).toBe(snapshot.hub.transferPaxPerDay);
  });
});
