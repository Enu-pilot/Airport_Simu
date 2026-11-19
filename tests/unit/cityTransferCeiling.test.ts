import { describe, expect, it } from 'vitest';
import { addContract, createCompany, type CompanyState } from '../../src/core/economy/company';
import { cityDemandCeiling, contractTransferShare, defaultCity, expectedLocalPassengers, expectedPassengers } from '../../src/core/economy/city';
import { routeDemandSummary } from '../../src/core/economy/demand';
import { planDayWithDemand } from '../../src/core/economy/planning';

/**
 * 5-20 T8 の PO 判断（2026-11-18）:
 * - 都市の設定人口を引き上げ、需要上限が上位の格の旅客要件に届くようにする
 * - 乗継旅客は地元需要ではないので、都市需要上限の係数は地元分にだけ効かせる
 *
 * 2026-11-19 docs/46 §7.1-3 で市場モードの上限配分・最終スケーリングは廃止した。
 * そのため市場モードの 2 テストは「上限で縮小されない」検証に置き換えた。
 * 上限そのもの（cityDemandCeiling）と非市場経路の係数（expectedLocalPassengers）は
 * 従来どおり残っており、このファイルの他のテストが引き続き固定する。
 */

const base = { feeDiscount: 0, startDay: 0, endDay: 999, status: 'active' as const, offerExpiresDay: 0, window: 'any' as const };

function hubCompany(seed: string, share: number): CompanyState {
  const c = createCompany('career', seed);
  c.features = { hub: true };
  addContract(c, { ...base, airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 3, transferShare: share });
  addContract(c, { ...base, airlineId: 'HB', destinationId: 'TYO', typeId: 'B737-800', perDay: 3, transferShare: share });
  addContract(c, { ...base, airlineId: 'HB', destinationId: 'OSA', typeId: 'B737-800', perDay: 3, transferShare: share });
  return c;
}

describe('都市の設定人口と需要上限（5-20 T8）', () => {
  it('設定人口は regional 60万・core 400万・metropolitan 2,000万', () => {
    expect(defaultCity('regional').population).toBe(600_000);
    expect(defaultCity('core').population).toBe(4_000_000);
    expect(defaultCity('metropolitan').population).toBe(20_000_000);
  });

  it('需要上限（アクセス正規化 1 = access 1.1）: regional ≈2,032・core ≈22,830・metropolitan ≈140,184 人/日', () => {
    expect(cityDemandCeiling(defaultCity('regional'), 1.1)).toBeCloseTo(2_032, -1);
    expect(cityDemandCeiling(defaultCity('core'), 1.1)).toBeCloseTo(22_830, -1);
    expect(cityDemandCeiling(defaultCity('metropolitan'), 1.1)).toBeCloseTo(140_184, -2);
    // 格の旅客要件との整合: metropolitan の地元上限だけでは格 7（180,000）に届かず、乗継分を要する
    expect(cityDemandCeiling(defaultCity('metropolitan'), 1.1)).toBeLessThan(180_000);
    expect(cityDemandCeiling(defaultCity('metropolitan'), 1.1)).toBeGreaterThan(120_000);
    // core は格 2（10,000）を地元だけで超え、格 3（30,000）には届かない
    expect(cityDemandCeiling(defaultCity('core'), 1.1)).toBeGreaterThan(10_000);
    expect(cityDemandCeiling(defaultCity('core'), 1.1)).toBeLessThan(30_000);
  });
});

describe('乗継旅客は都市需要上限の対象外（5-20 T8）', () => {
  it('contractTransferShare: ハブ有効時のみ契約の割合が効く', () => {
    const c = hubCompany('xfer-share', 0.4);
    const k = Object.values(c.contracts)[0]!;
    expect(contractTransferShare(c, k)).toBeCloseTo(0.4);
    delete c.features;
    expect(contractTransferShare(c, k)).toBe(0);
  });

  it('expectedLocalPassengers: 到着側の乗継分だけ差し引く（重み 2 → 2 − share）', () => {
    const c = hubCompany('xfer-expected', 0.5);
    const all = expectedPassengers(c, 0);
    const local = expectedLocalPassengers(c, 0);
    expect(all).toBeGreaterThan(0);
    expect(local).toBeCloseTo(all * 0.75, 6);
    // ハブ無効なら従来どおり全量が地元需要
    const off = hubCompany('xfer-expected-off', 0.5);
    delete off.features;
    expect(expectedLocalPassengers(off, 0)).toBeCloseTo(expectedPassengers(off, 0), 6);
  });

  it('routeDemandSummary（市場モード）: docs/46 で上限配分は廃止。乗継割合によらず潜在需要そのもの', () => {
    const mk = (share: number): CompanyState => {
      const c = createCompany('career', `xfer-summary-${share}`);
      c.city = defaultCity('regional');
      c.market = { version: 1, routes: {} };
      c.rating = 50;
      c.features = { hub: true };
      addContract(c, { ...base, airlineId: 'SK', destinationId: 'TYO', typeId: 'B787-9', perDay: 2, transferShare: share });
      addContract(c, { ...base, airlineId: 'NP', destinationId: 'OSA', typeId: 'A320neo', perDay: 3, transferShare: share });
      addContract(c, { ...base, airlineId: 'NP', destinationId: 'TWN', typeId: 'A320neo', perDay: 3, transferShare: share });
      addContract(c, { ...base, airlineId: 'NP', destinationId: 'SPK', typeId: 'A320neo', perDay: 2, transferShare: share });
      addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 3, transferShare: share });
      return c;
    };
    const ceiling = cityDemandCeiling(defaultCity('regional'), 1);
    const withShare = routeDemandSummary(mk(0.5), 0, 1)!;
    const totalShare = [...withShare.values()].reduce((s, x) => s + x.demand, 0);
    expect(totalShare).toBeGreaterThan(ceiling * 1.1); // 上限を超えても縮小されない
    // 乗継割合は市場モードの需要配分に影響しない（上限の見積もりは非市場経路側だけの話）
    const noShare = routeDemandSummary(mk(0), 0, 1)!;
    for (const [id, info] of withShare) expect(noShare.get(id)!.demand).toBeCloseTo(info.demand, 6);
  });

  it('planDayWithDemand（市場モデル）: docs/46 で最終スケーリングは廃止。計画旅客は上限で縮まない', () => {
    const mk = (share: number): CompanyState => {
      const c = createCompany('career', `xfer-plan-${share}`);
      c.city = defaultCity('regional');
      c.market = { version: 1, routes: {} };
      c.rating = 50;
      c.features = { hub: true };
      addContract(c, { ...base, airlineId: 'SK', destinationId: 'TYO', typeId: 'B787-9', perDay: 2, transferShare: share });
      addContract(c, { ...base, airlineId: 'NP', destinationId: 'OSA', typeId: 'A320neo', perDay: 3, transferShare: share });
      addContract(c, { ...base, airlineId: 'NP', destinationId: 'TWN', typeId: 'A320neo', perDay: 3, transferShare: share });
      addContract(c, { ...base, airlineId: 'NP', destinationId: 'SPK', typeId: 'A320neo', perDay: 2, transferShare: share });
      addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 3, transferShare: share });
      return c;
    };
    const ceiling = cityDemandCeiling(defaultCity('regional'), 1);
    const cShare = mk(0.5);
    const planShare = planDayWithDemand(cShare, 0, 1);
    const totalShare = planShare.flights.reduce((s, f) => s + f.arrPax + f.depPax, 0);
    expect(totalShare).toBeGreaterThan(ceiling * 1.1); // 旧最終保護があれば地元分は上限以下に縮む
    const cPlain = mk(0);
    const planPlain = planDayWithDemand(cPlain, 0, 1);
    const totalPlain = planPlain.flights.reduce((s, f) => s + f.arrPax + f.depPax, 0);
    expect(totalPlain).toBeGreaterThan(ceiling * 1.1); // 乗継なしでも縮小されない
  });

  it('planDayWithDemand（市場なし）: 係数の分母が地元分になるため、乗継契約があると計画旅客が増える', () => {
    const withShare = hubCompany('xfer-factor', 0.5);
    withShare.city = defaultCity('regional');
    withShare.rating = 50;
    const without = hubCompany('xfer-factor', 0);
    without.city = defaultCity('regional');
    without.rating = 50;
    const pax = (c: CompanyState) => planDayWithDemand(c, 0, 1).flights.reduce((s, f) => s + f.arrPax + f.depPax, 0);
    expect(pax(withShare)).toBeGreaterThan(pax(without));
  });
});
