import { describe, expect, it } from 'vitest';
import { addContract, createCompany, generateCargoOffers, generateOffers, type CompanyState, type Contract } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { defaultGame } from '../../src/core/economy/game';
import { initialGoals, type Tier } from '../../src/core/economy/goals';
import { isLargeFreighter, routeCargoDemandM3 } from '../../src/core/economy/cargo';
import { airlineDef, airlinesFor, destinationDef, destinationsFor, routeAvailability } from '../../src/core/economy/registry';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';

const OPERABLE = Object.keys(AIRCRAFT_TYPES);

/**
 * CARGO-08 の実検証: 国際貨物は格 4（国際空港）で初めて提案可能になる。
 * tiers520 の従来テストは格 4 側の断言が常に真（>= 0）で、実際に国際提案が
 * 出ることを検証できていなかった。ここでは seed × 日数を掃引して、
 * 格 3 で国際提案が 1 件も出ないこと・格 4 で実際に出ることを確認する。
 *
 * 評価 75 の構成が要: 格 4 で解放される SK（SAS、最低評価 80）が
 * 1 日 1 件の貨物枠を先に取るため、評価を 75 にすると同じ航空会社 NP
 * （貨物適格・国際旅客あり・最低評価なし）だけで格 3/4 を比較でき、
 * 「国ゲート」だけを切り分けて検証できる。
 *
 * 機能F（架空会社の就航制限）導入後の組み替え: NP は架空会社になり、
 * 格 3 以上では架空の目的地にしか飛べなくなった。架空の海外目的地
 * （NDB/BNH/LUM）は最低評価が 85/85/90 のため、評価 75 の構成では
 * NP の国際貨物自体が消え、「格 4 で国際が出る」側の断言が NP 前提では
 * 成立しない。そのため国際貨物の出現側の断言は、評価 90＋実在会社 SK
 * （格 4 解放・最低評価 80）基準に移した。格 3 で国際ゼロの検証は
 * CARGO-08 のゲートが格で閉じるため評価 90 でも効く（格 3・評価 90 でも
 * 国際貨物は 0 件であることを実入口のテストで併せて確認する）。
 */
function cargoCareer(tier: Tier, seed: string, rating = 75): CompanyState {
  const c = createCompany('career', seed);
  c.game = defaultGame();
  c.goals = { ...initialGoals(), tier };
  c.city = defaultCity('regional');
  c.rating = rating;
  c.features = { cargo: true };
  return c;
}

const SEEDS = 6;
const DAYS = 15;

/** seed × 日数を掃引して貨物提案を集める（提案は翌日に持ち越さないよう期限切れにする） */
function sweepCargoOffers(tier: Tier, rating = 75): Contract[] {
  const all: Contract[] = [];
  for (let s = 0; s < SEEDS; s++) {
    const c = cargoCareer(tier, `cargo-gate-${tier}-${s}`, rating);
    for (let d = 0; d < DAYS; d++) {
      c.day = d;
      for (const o of generateCargoOffers(c, OPERABLE, 'JP', true)) {
        all.push(o);
        o.status = 'expired';
      }
    }
  }
  return all;
}

const isIntl = (o: Contract) => destinationDef(o.destinationId).countryId !== 'JP';

describe('CARGO-08 国際貨物の格ゲート（実検証）', () => {
  it('前提: 格 3 でも国際目的地への需要と路線は存在する（欠けているのはゲートだけ）', () => {
    const c = cargoCareer(3, 'cargo-gate-pre');
    const sel = destinationDef('SEL');
    expect(sel.countryId).not.toBe('JP');
    expect(routeCargoDemandM3(c, sel) ?? 0).toBeGreaterThanOrEqual(20);
    expect(routeAvailability(airlineDef('NP'), sel, { originCountryId: 'JP', internationalPassengerProcessing: true })).toBe('available');
  });

  it('格 3: 掃引しても国際貨物提案は 1 件も出ない（国内貨物は出ている）', () => {
    const offers = sweepCargoOffers(3);
    // 空振りでないこと（国内貨物提案が実際に出ている）を確認したうえで国際ゼロを断言する
    expect(offers.length).toBeGreaterThanOrEqual(60);
    expect(offers.filter(isIntl)).toEqual([]);
    expect(offers.every((o) => o.airlineId === 'NP')).toBe(true);
  });

  it('格 4: 評価 90 では実在会社 SK から国際貨物提案が実際に出現する', () => {
    // 機能F以降、国際の出現側は NP（架空）でなく SK（実在）で検証する（冒頭コメント参照）
    const offers = sweepCargoOffers(4, 90);
    const intl = offers.filter(isIntl);
    expect(offers.length).toBeGreaterThanOrEqual(60);
    expect(intl.length).toBeGreaterThanOrEqual(5);
    expect(intl.filter((o) => o.airlineId === 'SK').length).toBeGreaterThanOrEqual(5);
    // 国内貨物も引き続き出る（格 4 で国内が消えていない）
    expect(offers.length - intl.length).toBeGreaterThanOrEqual(5);
  });

  it('格 4・評価 90: 格 4 解放の SK（SAS）からも国際貨物提案が出る', () => {
    const offers = sweepCargoOffers(4, 90);
    const intl = offers.filter(isIntl);
    expect(intl.length).toBeGreaterThanOrEqual(5);
    expect(intl.some((o) => o.airlineId === 'SK')).toBe(true);
  });

  it('実入口 generateOffers 経由でも、格 3 は国際貨物なし・格 4 は出現する', () => {
    // 評価 90 で掃引し、格 4 の出現は実在会社 SK の国際貨物でも裏付ける（機能F対応。冒頭コメント参照）
    for (const tier of [3, 4] as Tier[]) {
      let cargoTotal = 0;
      let cargoIntl = 0;
      let cargoIntlSK = 0;
      for (let s = 0; s < 3; s++) {
        const c = cargoCareer(tier, `cargo-gate-full-${tier}-${s}`, 90);
        for (let d = 0; d < DAYS; d++) {
          c.day = d;
          for (const o of generateOffers(c, OPERABLE, 'JP', true)) {
            if (o.kind === 'cargo') {
              cargoTotal++;
              if (isIntl(o)) {
                cargoIntl++;
                if (o.airlineId === 'SK') cargoIntlSK++;
              }
            }
            o.status = 'expired';
          }
        }
      }
      expect(cargoTotal).toBeGreaterThan(0);
      if (tier === 3) expect(cargoIntl).toBe(0);
      else {
        expect(cargoIntl).toBeGreaterThanOrEqual(3);
        expect(cargoIntlSK).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('CARGO-08 格 5「取扱規模拡張」: 大型貨物専用機の解放', () => {
  it('前提: 大型貨物機の判定は B747F / B777F 系だけを指し、B767-300F と旅客機は含まない', () => {
    expect(isLargeFreighter('B747-400F')).toBe(true);
    expect(isLargeFreighter('B747-8F')).toBe(true);
    expect(isLargeFreighter('B777F')).toBe(true);
    expect(isLargeFreighter('B767-300F')).toBe(false);
    expect(isLargeFreighter('B777-300ER')).toBe(false);
  });

  // 大型貨物機を持つ航空会社（NH / KE / CX 等）は market スコープ側にいるため、
  // この検証は market を有効にした会社で掃引する（legacy だけでは候補が存在しない）
  const sweepMarket = (tier: Tier): Contract[] => {
    const all: Contract[] = [];
    for (let s = 0; s < SEEDS; s++) {
      const c = cargoCareer(tier, `cargo-large-${tier}-${s}`, 80);
      c.market = { version: 1, routes: {} };
      // 提案枠は 1 日 2 件で、カタログ順で先行する貨物適格会社 SK・NP が埋めてしまう。
      // 次に貨物適格なのは NH（B777F / B767-300F を保有）なので、SK・NP だけに
      // 全目的地の有効契約を与えて「提案先なし」にし、NH の提案を観測する
      for (const a of airlinesFor(c)) {
        if (a.id !== 'SK' && a.id !== 'NP') continue;
        for (const d of destinationsFor(c)) {
          addContract(c, { airlineId: a.id, destinationId: d.id, typeId: 'B767-300F', perDay: 1, window: 'any', feeDiscount: 0, startDay: 0, endDay: 9999, status: 'active', kind: 'cargo', offerExpiresDay: 9999 });
        }
      }
      for (let d = 0; d < DAYS; d++) {
        c.day = d;
        for (const o of generateCargoOffers(c, OPERABLE, 'JP', true)) {
          all.push(o);
          o.status = 'expired';
        }
      }
    }
    return all;
  };

  it('格 4: 大型貨物専用機を使う提案は 1 件も出ない（market・評価 80 の掃引）', () => {
    const offers = sweepMarket(4);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.filter((o) => isLargeFreighter(o.typeId))).toEqual([]);
  });

  it('格 5: 大型貨物専用機を使う提案が実際に出る', () => {
    const offers = sweepMarket(5);
    expect(offers.filter((o) => isLargeFreighter(o.typeId)).length).toBeGreaterThanOrEqual(1);
  });
});

describe('F6-07 貨物の格境界（格 2 以下と格 5〜7）', () => {
  it('格 2: 貨物提案は国内・国際とも 1 件も出ない（格 3 未満は機能自体が未解放）', () => {
    const offers = sweepCargoOffers(2);
    expect(offers).toEqual([]);
  });

  it('格 5〜7: 国際貨物提案が引き続き出現する（上位格で後退しない）', () => {
    // 出現側は評価 90＋実在会社 SK 基準（機能F対応。冒頭コメント参照）
    for (const tier of [5, 6, 7] as Tier[]) {
      const offers = sweepCargoOffers(tier, 90);
      const intl = offers.filter(isIntl);
      expect(offers.length).toBeGreaterThanOrEqual(60);
      expect(intl.length).toBeGreaterThanOrEqual(5);
      expect(intl.filter((o) => o.airlineId === 'SK').length).toBeGreaterThanOrEqual(5);
    }
  });
});
