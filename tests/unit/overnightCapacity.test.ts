import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany } from '../../src/core/economy/company';
import { overnightCapacity, overnightFeasible, overnightRequired, previewContractCapacity } from '../../src/core/economy/capacity';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext } from '../../src/core/sim/context';

describe('overnightCapacity: 滞泊の能力（4B-3 / §3.4）', () => {
  const layout = createSampleAirport();
  const ctx = createContext(layout);

  it('サンプル空港は M が 8・L が 1 で、能力は大きさ別に数える', () => {
    expect(overnightCapacity(ctx)).toEqual({ L: 1, M: 9, S: 9 });
  });

  it('ちょうど満杯は収まり、1 機超えると収まらない', () => {
    expect(overnightFeasible(ctx, { M: 9 })).toBe(true);
    expect(overnightFeasible(ctx, { M: 10 })).toBe(false);
    expect(overnightFeasible(ctx, { L: 1, M: 8 })).toBe(true);
    expect(overnightFeasible(ctx, { L: 1, M: 9 })).toBe(false);
    expect(overnightFeasible(ctx, { L: 2 })).toBe(false);
    expect(overnightFeasible(ctx, { S: 9 })).toBe(true);
  });

  it('閉鎖したスポットは能力から外れる', () => {
    const lStand = Object.values(layout.stands).find((s) => s.size === 'L')!;
    expect(overnightFeasible(ctx, { L: 1 }, [lStand.id])).toBe(false);
    expect(overnightCapacity(ctx, [lStand.id])).toEqual({ L: 0, M: 8, S: 8 });
  });

  it('必要数は有効な overnight・based 契約だけから数える', () => {
    const c = createSandboxCompany('ovn-cap');
    addContract(c, {
      airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 2, window: 'evening',
      feeDiscount: 0.1, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, kind: 'overnight',
    });
    addContract(c, {
      airlineId: 'NP', destinationId: 'TWN', typeId: 'A320neo', perDay: 4, window: 'any',
      feeDiscount: 0.25, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, kind: 'based', basedAircraft: 3,
    });
    addContract(c, {
      airlineId: 'RJ', destinationId: 'YKH', typeId: 'A350-900', perDay: 5, window: 'evening',
      feeDiscount: 0.1, startDay: 0, endDay: 999, status: 'withdrawn', offerExpiresDay: 0, kind: 'overnight',
    });
    expect(overnightRequired(c, ctx, 0)).toEqual({ M: 5 });
  });

  it('previewContractCapacity は滞泊の能力を超える overnight 契約を受け入れ不可にする', () => {
    const c = createSandboxCompany('ovn-cap2');
    const over = previewContractCapacity(c, ctx, { airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 10, window: 'evening', kind: 'overnight' });
    expect(over.result).toBe('unacceptable');
    expect(over.newIssues.some((i) => i.code === 'OVERNIGHT_CAPACITY_EXCEEDED')).toBe(true);
    const within = previewContractCapacity(c, ctx, { airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 2, window: 'evening', kind: 'overnight' });
    expect(within.newIssues.some((i) => i.code === 'OVERNIGHT_CAPACITY_EXCEEDED')).toBe(false);
  });
});
