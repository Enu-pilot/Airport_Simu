/**
 * 回帰（計画 1-21 S-3）: 航空会社の評価（game.airlineEval）の運航で、その日の便が全て欠航した航空会社にも欠航のペナルティを引く。
 * 旧: ペナルティの条件が `r.flights > 0` で、全便欠航の日は flights が 0（欠航は flights に数えない）のため引かれなかった。
 */
import { describe, expect, it } from 'vitest';
import { addContract, createCareerCompany, updateContracts, type AirlineDayResult, type CompanyState } from '../../../src/core/economy/company';

function companyWithAQ(): CompanyState {
  const c = createCareerCompany();
  addContract(c, { airlineId: 'AQ', destinationId: 'KTA', typeId: 'narrow180', perDay: 2, window: 'any', feeDiscount: 0, startDay: 0, endDay: 29, status: 'active', offerExpiresDay: 0 });
  c.airlines.AQ = { satisfaction: 60, lowDays: 0 };
  return c;
}
const result = (p: Partial<AirlineDayResult>): AirlineDayResult => ({ flights: 0, onTime: 0, paxBoarded: 0, missedPax: 0, leftBags: 0, cancelled: 0, ...p });
const ev = { deltas: { AQ: 0 }, bonus: {} };
const after = (r: AirlineDayResult): number => {
  const c = companyWithAQ();
  updateContracts(c, { AQ: r }, ev);
  return c.airlines.AQ!.satisfaction;
};

describe('1-21 S-3 全便欠航の罰則（評価あり）', () => {
  it('全便が欠航（flights 0・cancelled 3）: 1 便 5 のペナルティが引かれる（再現テスト）', () => {
    expect(after(result({ cancelled: 3 }))).toBe(60 - 15);
  });

  it('一部だけ欠航した日は従来どおり', () => {
    expect(after(result({ flights: 4, onTime: 4, cancelled: 2 }))).toBe(60 - 10);
  });

  it('天候による欠航は 1/4、先行欠航は 1/10 の重み（全便欠航でも同じ式）', () => {
    expect(after(result({ cancelled: 4, weatherCancelled: 4 }))).toBeCloseTo(60 - 4 * 0.25 * 5, 10);
    expect(after(result({ cancelled: 10, earlyCancelled: 10 }))).toBeCloseTo(60 - 10 * 0.1 * 5, 10);
  });

  it('欠航も運航もない日（結果なし・全て 0）は変化なし', () => {
    expect(after(result({}))).toBe(60);
    const c = companyWithAQ();
    updateContracts(c, {}, ev);
    expect(c.airlines.AQ!.satisfaction).toBe(60);
  });

  it('下限 0 に収まり、決定的', () => {
    expect(after(result({ cancelled: 100 }))).toBe(0);
    expect(after(result({ cancelled: 3 }))).toBe(after(result({ cancelled: 3 })));
  });
});
