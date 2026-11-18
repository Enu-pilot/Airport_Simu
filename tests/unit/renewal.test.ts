import { describe, expect, it } from 'vitest';
import { addContract, createCompany, type Contract } from '../../src/core/economy/company';
import { renewalOutlook } from '../../src/core/economy/renewal';
import { capacityDelta, analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { createContext } from '../../src/core/sim/context';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { placeRunway } from '../../src/core/layout/operations';
import { must } from './helpers';

/**
 * 5-04: 満足度の内訳（日報の kpi に内訳が残ることは economy の回帰で確認）、
 * 契約更新の先行き（D2）、投資効果のプレビュー（B4）の算出を確認する。
 */
describe('契約更新の先行き（5-04 / D2）', () => {
  const mk = (satisfaction: number, lowDays: number, endDay = 30): { company: ReturnType<typeof createCompany>; contract: Contract } => {
    const company = createCompany('career', 'renewal');
    addContract(company, { airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 2, feeDiscount: 0, startDay: 0, endDay, status: 'active', offerExpiresDay: 0, window: 'any' });
    company.airlines['RJ'] = { satisfaction, lowDays };
    return { company, contract: Object.values(company.contracts)[0]! };
  };

  it('満足度が高ければ更新見込み高、残り日数が出る', () => {
    const { company, contract } = mk(80, 0);
    const o = renewalOutlook(company, contract);
    expect(o.level).toBe('stable');
    expect(o.daysLeft).toBe(30);
  });

  it('満足度が低く不満が続くと撤退リスク', () => {
    const { company, contract } = mk(35, 3);
    expect(renewalOutlook(company, contract).level).toBe('risk');
  });

  it('中間は様子見', () => {
    const { company, contract } = mk(50, 0);
    expect(renewalOutlook(company, contract).level).toBe('watch');
  });
});

describe('投資効果のプレビュー（5-04 / B4）', () => {
  it('滑走路を足すと滑走路能力の差分が出る', () => {
    const company = createCompany('career', 'delta');
    const before = analyzeAirportCapacity(company, createContext(createStarterAirfield()));
    let layout = createStarterAirfield();
    // 既存滑走路と平行にもう 1 本（十分離す）
    layout = must(placeRunway(layout, { x: 20, y: 16 }, 90, 60)).layout;
    const after = analyzeAirportCapacity(company, createContext(layout));
    const deltas = capacityDelta(before, after);
    const runway = deltas.find((d) => d.name === '滑走路');
    expect(runway).toBeDefined();
    expect(runway!.delta).toBeGreaterThan(0);
    // 変わっていない指標は差分に出ない
    expect(deltas.some((d) => d.name === '消防区分')).toBe(false);
  });
});
