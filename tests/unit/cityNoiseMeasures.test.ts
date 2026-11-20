import { beforeEach, describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/core/economy/balance';
import {
  applyCityNoiseImpact,
  applyNoiseContribution,
  applySoundproofPurchase,
  canMakeNoiseContribution,
  defaultCity,
  isCityConfig,
  nextSoundproofCost,
  noiseImpactDelta,
  noiseMitigationFactor,
  offshoreNoiseFactor,
  residentFacilityBonus,
  soundproofLevelOf,
  soundproofNoiseFactor,
  type CityConfig,
} from '../../src/core/economy/city';
import { createCareerCompany, importCompany, type CompanyState } from '../../src/core/economy/company';
import { landingFee } from '../../src/core/economy/ops';
import type { Facility, FacilityKind } from '../../src/core/model/types';
import { contributeNoiseFund, editorStore, purchaseSoundproofing } from '../../src/editor/store';
import { emptyLayout } from './helpers';

/**
 * 機能E（住民満足度の積極施策）:
 * 防音工事助成（段階制・即時回復・騒音ポイント緩和、夜間運航の効きは緩和しない）、
 * 夜間着陸料 ×1.3、防音レベルの旧セーブ互換と購入ガード。
 */

const cityWith = (patch: Partial<CityConfig>): CityConfig => ({ ...defaultCity(), residents: 70, ...patch });

describe('防音工事: 日次騒音影響の緩和', () => {
  it('Lv0（未設定=旧セーブ）は従来どおり: 騒音100点で −0.01', () => {
    const city = cityWith({});
    expect(soundproofLevelOf(city)).toBe(0);
    expect(applyCityNoiseImpact(city, 100, 0)).toBe(-0.01);
    expect(city.residents).toBeCloseTo(69.99);
  });

  it('Lv3 は騒音ポイントの効きが半分になる: 騒音100点で +0.01', () => {
    const city = cityWith({ soundproofLevel: 3 });
    expect(soundproofNoiseFactor(3)).toBe(0.5);
    expect(applyCityNoiseImpact(city, 100, 0)).toBe(0.01);
    expect(city.residents).toBeCloseTo(70.01);
  });

  it('Lv1 は ×0.85: 騒音100点で満足度が −0.004 下がる（戻り値は小数2桁に丸められる）', () => {
    const city = cityWith({ soundproofLevel: 1 });
    applyCityNoiseImpact(city, 100, 0);
    expect(city.residents).toBeCloseTo(69.996);
  });

  it('夜間運航 1 件の −0.15 は最大レベルでも緩和されない', () => {
    const city = cityWith({ soundproofLevel: 3 });
    expect(applyCityNoiseImpact(city, 0, 1)).toBe(-0.12);
  });

  it('実測較正ケース（騒音 2,704 点/日・夜間 0 件）: Lv0 は下限クランプ −1、Lv3 でも −0.51 でプラスには転じない', () => {
    // mainplay1 98日目の実測: 満足度 28.44、前日から −1/日で低下中（生の変化量 −1.0516 が下限に張り付く）
    expect(noiseImpactDelta(cityWith({}), 2704, 0)).toBe(-1);
    expect(noiseImpactDelta(cityWith({ soundproofLevel: 1 }), 2704, 0)).toBeCloseTo(-0.8894, 3);
    expect(noiseImpactDelta(cityWith({ soundproofLevel: 2 }), 2704, 0)).toBeCloseTo(-0.7271, 3);
    expect(noiseImpactDelta(cityWith({ soundproofLevel: 3 }), 2704, 0)).toBeCloseTo(-0.5108, 3);
  });
});

describe('防音工事: 購入の状態変更（純関数）', () => {
  it('レベルが上がり満足度が即時回復する。費用はレベル順', () => {
    const city = cityWith({ residents: 60 });
    expect(nextSoundproofCost(city)).toBe(BALANCE.noise.soundproof.cost[0]);
    expect(applySoundproofPurchase(city)).toEqual({ level: 1, recovery: BALANCE.noise.soundproof.recovery[0] });
    expect(city.soundproofLevel).toBe(1);
    expect(city.residents).toBe(60 + BALANCE.noise.soundproof.recovery[0]!);
    expect(nextSoundproofCost(city)).toBe(BALANCE.noise.soundproof.cost[1]);
  });

  it('回復は 100 で頭打ち。最大レベルでは何もしない', () => {
    const city = cityWith({ residents: 99, soundproofLevel: 2 });
    applySoundproofPurchase(city);
    expect(city.residents).toBe(100);
    expect(city.soundproofLevel).toBe(3);
    expect(nextSoundproofCost(city)).toBeNull();
    expect(applySoundproofPurchase(city)).toBeNull();
    expect(city.residents).toBe(100);
  });
});

describe('防音レベル: 検証と旧セーブ互換', () => {
  it('isCityConfig: 欠落は可、0〜3 は可、範囲外・小数は不可', () => {
    expect(isCityConfig(defaultCity())).toBe(true);
    expect(isCityConfig(cityWith({ soundproofLevel: 2 }))).toBe(true);
    expect(isCityConfig(cityWith({ soundproofLevel: 4 }))).toBe(false);
    expect(isCityConfig(cityWith({ soundproofLevel: 1.5 }))).toBe(false);
  });

  it('フィールドの無い旧セーブの会社を読み込んでも city が残り Lv0 扱いになる', () => {
    const company = createCareerCompany();
    company.city = defaultCity();
    delete company.city.soundproofLevel;
    const loaded = importCompany(JSON.stringify(company));
    expect(loaded).not.toBeNull();
    expect(loaded!.city).toBeDefined();
    expect(soundproofLevelOf(loaded!.city!)).toBe(0);
  });
});

describe('夜間割増: 着陸料 ×1.3（22時〜6時）', () => {
  const ac = { typeId: 'narrow180' as const };
  it('昼間は従来どおり、ピーク割増は昼のピークだけに付く', () => {
    const c = createCareerCompany();
    expect(landingFee(c, ac, 12 * 3600, 1)).toBe(78 * 150);
    expect(landingFee(c, ac, 8 * 3600, 1)).toBe(78 * 150 * 1.25);
  });

  it('夜間は ×1.3（22時台・深夜・6時直前）', () => {
    const c = createCareerCompany();
    expect(landingFee(c, ac, 23 * 3600, 1)).toBeCloseTo(78 * 150 * 1.3);
    expect(landingFee(c, ac, 3 * 3600, 1)).toBeCloseTo(78 * 150 * 1.3);
    expect(landingFee(c, ac, 5 * 3600 + 59 * 60, 1)).toBeCloseTo(78 * 150 * 1.3);
  });

  it('境界: 22:00 から夜間、6:00 から昼間', () => {
    const c = createCareerCompany();
    expect(landingFee(c, ac, 22 * 3600, 1)).toBeCloseTo(78 * 150 * 1.3);
    expect(landingFee(c, ac, 6 * 3600, 1)).toBe(78 * 150);
    expect(landingFee(c, ac, 21 * 3600 + 59 * 60, 1)).toBe(78 * 150);
  });
});

describe('防音工事: ストアの購入ガード', () => {
  const companyWith = (cash: number, city: CityConfig): CompanyState => {
    const company = createCareerCompany();
    company.cash = cash;
    company.city = city;
    return company;
  };

  beforeEach(() => {
    editorStore.setState({ mode: 'build', company: companyWith(10_000_000, cityWith({ residents: 60 })) });
  });

  it('購入できる: 現金が減り、レベルと満足度が上がる', () => {
    purchaseSoundproofing();
    const c = editorStore.getState().company;
    expect(c.cash).toBe(10_000_000 - BALANCE.noise.soundproof.cost[0]!);
    expect(c.city!.soundproofLevel).toBe(1);
    expect(c.city!.residents).toBe(60 + BALANCE.noise.soundproof.recovery[0]!);
  });

  it('資金不足では何も変わらない', () => {
    editorStore.setState({ company: companyWith(100, cityWith({})) });
    purchaseSoundproofing();
    const c = editorStore.getState().company;
    expect(c.cash).toBe(100);
    expect(soundproofLevelOf(c.city!)).toBe(0);
  });

  it('最大レベルでは何も変わらない', () => {
    editorStore.setState({ company: companyWith(10_000_000, cityWith({ soundproofLevel: 3 })) });
    purchaseSoundproofing();
    const c = editorStore.getState().company;
    expect(c.cash).toBe(10_000_000);
    expect(c.city!.soundproofLevel).toBe(3);
  });

  it('運航中は購入できない', () => {
    editorStore.setState({ mode: 'operate' });
    purchaseSoundproofing();
    const c = editorStore.getState().company;
    expect(soundproofLevelOf(c.city!)).toBe(0);
    expect(c.cash).toBe(10_000_000);
  });
});

describe('海上移転係数（機能E拡張1）: 格連動の騒音軽減', () => {
  it('係数表: 格0〜3 は ×1.0、格4 ×0.75、格5 ×0.5、格6 ×0.3、格7 ×0.15', () => {
    expect([0, 1, 2, 3].map(offshoreNoiseFactor)).toEqual([1, 1, 1, 1]);
    expect(offshoreNoiseFactor(4)).toBe(0.75);
    expect(offshoreNoiseFactor(5)).toBe(0.5);
    expect(offshoreNoiseFactor(6)).toBe(0.3);
    expect(offshoreNoiseFactor(7)).toBe(0.15);
  });

  it('opts なし（goals の無い会社）は従来どおり係数 ×1.0', () => {
    const city = cityWith({});
    expect(noiseImpactDelta(city, 100, 0)).toBe(noiseImpactDelta(city, 100, 0, { tier: 0 }));
    expect(noiseImpactDelta(city, 100, 0, {})).toBeCloseTo(-0.01);
  });

  it('防音工事と乗算で合成される: 格5 × Lv3 で最終係数 ×0.25、騒音100点で +0.02', () => {
    const city = cityWith({ soundproofLevel: 3 });
    expect(noiseMitigationFactor(city, 5)).toBe(0.25);
    expect(noiseImpactDelta(city, 100, 0, { tier: 5 })).toBeCloseTo(0.02);
    expect(applyCityNoiseImpact(city, 100, 0, { tier: 5 })).toBe(0.02);
    expect(city.residents).toBeCloseTo(70.02);
  });

  it('夜間運航 1 件の −0.15 は格7 でも緩和されない', () => {
    const city = cityWith({ soundproofLevel: 3 });
    expect(applyCityNoiseImpact(city, 0, 1, { tier: 7 })).toBe(-0.12);
  });

  it('実測較正ケース（騒音 2,704 点/日・夜間 0 件）: 格が上がるほど低下が緩む', () => {
    expect(noiseImpactDelta(cityWith({}), 2704, 0, { tier: 4 })).toBeCloseTo(-0.7812, 3);
    expect(noiseImpactDelta(cityWith({ soundproofLevel: 3 }), 2704, 0, { tier: 5 })).toBeCloseTo(-0.2404, 3);
    expect(noiseImpactDelta(cityWith({ soundproofLevel: 3 }), 2704, 0, { tier: 7 })).toBeCloseTo(-0.0511, 3);
  });
});

const facility = (id: string, kind: FacilityKind, buildState: Facility['buildState'] = 'operational'): Facility => ({
  id, kind, name: '', origin: { x: 0, y: 0 }, w: 2, h: 2, rotation: 0, buildState, props: {},
});

const layoutWith = (...facilities: Facility[]) => {
  const layout = emptyLayout();
  for (const f of facilities) layout.facilities[f.id] = f;
  return layout;
};

describe('住民向け施設（機能E拡張2）: 日次プラスの集計と上限', () => {
  it('施設がなければ 0、対象外の施設（ホテル等）は数えない', () => {
    expect(residentFacilityBonus(layoutWith())).toBe(0);
    expect(residentFacilityBonus(layoutWith(facility('h1', 'hotel')))).toBe(0);
  });

  it('運用中 1 棟ごと: モール +0.03、文化ホール +0.02、公園 +0.01', () => {
    expect(residentFacilityBonus(layoutWith(facility('m1', 'shoppingMall')))).toBeCloseTo(0.03);
    expect(residentFacilityBonus(layoutWith(
      facility('m1', 'shoppingMall'), facility('c1', 'culturalHall'), facility('p1', 'park'),
    ))).toBeCloseTo(0.06);
  });

  it('計画中・建設中の施設は数えない', () => {
    expect(residentFacilityBonus(layoutWith(facility('m1', 'shoppingMall', 'planned')))).toBe(0);
    expect(residentFacilityBonus(layoutWith(facility('m1', 'shoppingMall', 'underConstruction')))).toBe(0);
  });

  it('合計は上限 +0.10/日 で頭打ち（モール 4 棟 = 0.12 → 0.10）', () => {
    const layout = layoutWith(
      facility('m1', 'shoppingMall'), facility('m2', 'shoppingMall'),
      facility('m3', 'shoppingMall'), facility('m4', 'shoppingMall'),
    );
    expect(residentFacilityBonus(layout)).toBe(BALANCE.noise.residentFacilities.dailyCap);
  });

  it('プラスは日次変化の回復側に加算され、上限クランプ +0.05 の内側で効く', () => {
    const city = cityWith({});
    // 騒音なし + 施設フル: 0.03 + 0.10 = 0.13 → 上限 +0.05
    expect(noiseImpactDelta(city, 0, 0, { facilityBonus: 0.1 })).toBe(0.05);
    // 騒音 100 点 + 施設 +0.03: 0.03 + 0.03 − 0.04 = +0.02
    expect(noiseImpactDelta(city, 100, 0, { facilityBonus: 0.03 })).toBeCloseTo(0.02);
    // opts 側に上限を超える値を渡しても dailyCap で守る
    expect(noiseImpactDelta(city, 0, 0, { facilityBonus: 99 })).toBe(0.05);
  });

  it('実測較正ケース: 格7 + 防音Lv3 + 施設フル設置でプラスに転じる（+0.0489）', () => {
    const city = cityWith({ soundproofLevel: 3 });
    expect(noiseImpactDelta(city, 2704, 0, { tier: 7, facilityBonus: 0.1 })).toBeCloseTo(0.0489, 3);
    // 現在の格3 のままでは施設フルでも −0.4108（延命に留まる）
    expect(noiseImpactDelta(city, 2704, 0, { tier: 3, facilityBonus: 0.1 })).toBeCloseTo(-0.4108, 3);
  });
});

describe('騒音対策費の拠出（機能E拡張2）', () => {
  it('拠出で満足度が即時回復し、同日 2 回目は不可、翌日は再び可能', () => {
    const city = cityWith({ residents: 50 });
    expect(canMakeNoiseContribution(city, 10)).toBe(true);
    expect(applyNoiseContribution(city, 10)).toBe(true);
    expect(city.residents).toBe(50 + BALANCE.noise.contribution.recovery);
    expect(city.lastNoiseContributionDay).toBe(10);
    expect(canMakeNoiseContribution(city, 10)).toBe(false);
    expect(applyNoiseContribution(city, 10)).toBe(false);
    expect(city.residents).toBe(50 + BALANCE.noise.contribution.recovery);
    expect(applyNoiseContribution(city, 11)).toBe(true);
    expect(city.residents).toBe(50 + BALANCE.noise.contribution.recovery * 2);
  });

  it('回復は 100 で頭打ち', () => {
    const city = cityWith({ residents: 99.5 });
    expect(applyNoiseContribution(city, 3)).toBe(true);
    expect(city.residents).toBe(100);
  });

  it('isCityConfig: 最終拠出日は欠落可、0 以上整数は可、負数・小数は不可', () => {
    expect(isCityConfig(cityWith({}))).toBe(true);
    expect(isCityConfig(cityWith({ lastNoiseContributionDay: 12 }))).toBe(true);
    expect(isCityConfig(cityWith({ lastNoiseContributionDay: -1 }))).toBe(false);
    expect(isCityConfig(cityWith({ lastNoiseContributionDay: 1.5 }))).toBe(false);
  });

  it('フィールドの無い旧セーブの会社を読み込んでも city が残り、拠出可能な状態になる', () => {
    const company = createCareerCompany();
    company.city = defaultCity();
    delete company.city.lastNoiseContributionDay;
    const loaded = importCompany(JSON.stringify(company));
    expect(loaded).not.toBeNull();
    expect(loaded!.city).toBeDefined();
    expect(canMakeNoiseContribution(loaded!.city!, loaded!.day)).toBe(true);
  });
});

describe('騒音対策費の拠出: ストアのガード', () => {
  const companyWith = (cash: number, city: CityConfig): CompanyState => {
    const company = createCareerCompany();
    company.cash = cash;
    company.city = city;
    return company;
  };

  beforeEach(() => {
    editorStore.setState({ mode: 'build', company: companyWith(10_000_000, cityWith({ residents: 60 })) });
  });

  it('拠出できる: 現金が減り、満足度が上がり、最終拠出日が記録される', () => {
    contributeNoiseFund();
    const c = editorStore.getState().company;
    expect(c.cash).toBe(10_000_000 - BALANCE.noise.contribution.cost);
    expect(c.city!.residents).toBe(60 + BALANCE.noise.contribution.recovery);
    expect(c.city!.lastNoiseContributionDay).toBe(c.day);
  });

  it('同日 2 回目は現金も満足度も変わらない', () => {
    contributeNoiseFund();
    contributeNoiseFund();
    const c = editorStore.getState().company;
    expect(c.cash).toBe(10_000_000 - BALANCE.noise.contribution.cost);
    expect(c.city!.residents).toBe(60 + BALANCE.noise.contribution.recovery);
  });

  it('資金不足では何も変わらない', () => {
    editorStore.setState({ company: companyWith(100, cityWith({})) });
    contributeNoiseFund();
    const c = editorStore.getState().company;
    expect(c.cash).toBe(100);
    expect(c.city!.lastNoiseContributionDay).toBeUndefined();
  });

  it('運航中は拠出できない', () => {
    editorStore.setState({ mode: 'operate' });
    contributeNoiseFund();
    const c = editorStore.getState().company;
    expect(c.cash).toBe(10_000_000);
    expect(c.city!.lastNoiseContributionDay).toBeUndefined();
  });
});
