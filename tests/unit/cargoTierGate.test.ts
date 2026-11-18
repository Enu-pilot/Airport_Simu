import { describe, expect, it } from 'vitest';
import { createCompany, generateCargoOffers, generateOffers, type CompanyState, type Contract } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { defaultGame } from '../../src/core/economy/game';
import { initialGoals, type Tier } from '../../src/core/economy/goals';
import { routeCargoDemandM3 } from '../../src/core/economy/cargo';
import { airlineDef, destinationDef, routeAvailability } from '../../src/core/economy/registry';
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

  it('格 4: 同じ会社構成で国際貨物提案が実際に出現する', () => {
    const offers = sweepCargoOffers(4);
    const intl = offers.filter(isIntl);
    expect(offers.length).toBeGreaterThanOrEqual(60);
    expect(intl.length).toBeGreaterThanOrEqual(5);
    expect(intl.every((o) => o.airlineId === 'NP')).toBe(true);
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
    for (const tier of [3, 4] as Tier[]) {
      let cargoTotal = 0;
      let cargoIntl = 0;
      for (let s = 0; s < 3; s++) {
        const c = cargoCareer(tier, `cargo-gate-full-${tier}-${s}`);
        for (let d = 0; d < DAYS; d++) {
          c.day = d;
          for (const o of generateOffers(c, OPERABLE, 'JP', true)) {
            if (o.kind === 'cargo') {
              cargoTotal++;
              if (isIntl(o)) cargoIntl++;
            }
            o.status = 'expired';
          }
        }
      }
      expect(cargoTotal).toBeGreaterThan(0);
      if (tier === 3) expect(cargoIntl).toBe(0);
      else expect(cargoIntl).toBeGreaterThanOrEqual(3);
    }
  });
});
