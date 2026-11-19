import { describe, expect, it } from 'vitest';
import { addContract, counterOffer, createCompany, setDedicatedStand } from '../../src/core/economy/company';
import { analyzeDayPlan, planDay } from '../../src/core/economy/planning';
import { createContext } from '../../src/core/sim/context';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';

const offer = (c: ReturnType<typeof createCompany>, satisfaction: number) => {
  c.airlines['RJ']!.satisfaction = satisfaction;
  return addContract(c, { airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 2, feeDiscount: 0.1, startDay: 0, endDay: 999, status: 'offered', offerExpiresDay: 5, window: 'daytime' });
};

/** 5-08: 契約の逆提案とスポットの専用化 */
describe('契約の逆提案（5-08）', () => {
  it('割引を増やす逆提案は満足度が高ければ受け入れられ、条件が変わる', () => {
    const c = createCompany('career');
    const k = offer(c, 80);
    const r = counterOffer(c, k.id, { feeDiscount: 0.2, window: 'morning' });
    expect(r.ok).toBe(true);
    expect(c.contracts[k.id]!.feeDiscount).toBe(0.2);
    expect(c.contracts[k.id]!.window).toBe('morning');
    expect(c.contracts[k.id]!.status).toBe('offered'); // 契約するかどうかは別途
  });

  it('無理な逆提案は断られ、満足度が下がり、当日は再提案できない', () => {
    const c = createCompany('career');
    const k = offer(c, 30);
    const r = counterOffer(c, k.id, { perDay: 6, feeDiscount: 0 });
    expect(r).toEqual({ ok: false, reason: 'AIRLINE_REFUSED' });
    expect(c.airlines['RJ']!.satisfaction).toBe(27);
    expect(c.contracts[k.id]!.perDay).toBe(2); // 条件は変わらない
    expect(counterOffer(c, k.id, { feeDiscount: 0.4 })).toEqual({ ok: false, reason: 'COUNTER_TOO_SOON' });
  });

  it('変更のない逆提案は NO_CHANGE', () => {
    const c = createCompany('career');
    const k = offer(c, 90);
    expect(counterOffer(c, k.id, { window: 'daytime' })).toEqual({ ok: false, reason: 'NO_CHANGE' });
  });
});

describe('スポットの専用化（5-08）', () => {
  it('専用スポットの設定・解除と、計画での優先・回避', () => {
    const c = createCompany('career');
    const mine = addContract(c, { airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 1, feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, window: 'daytime' });
    const other = addContract(c, { airlineId: 'HB', destinationId: 'TYO', typeId: 'B737-800', perDay: 1, feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, window: 'daytime' });
    expect(setDedicatedStand(c, mine.id, 'std_9').ok).toBe(true);
    expect(c.contracts[mine.id]!.dedicatedStandId).toBe('std_9');

    const ctx = createContext(createSampleAirport());
    const plan = planDay(c, 0);
    const analysis = analyzeDayPlan(plan, ctx);
    const myFlight = plan.flights.find((f) => f.contractId === mine.id)!;
    const otherFlight = plan.flights.find((f) => f.contractId === other.id)!;
    expect(analysis.assignments[myFlight.key]!.standId).toBe('std_9');
    expect(analysis.assignments[otherFlight.key]!.standId).not.toBe('std_9');

    expect(setDedicatedStand(c, mine.id, null).ok).toBe(true);
    expect(c.contracts[mine.id]!.dedicatedStandId).toBeUndefined();
  });
});
