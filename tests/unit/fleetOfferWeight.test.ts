import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../src/core/data/index';
import { BALANCE } from '../../src/core/economy/balance';
import {
  createCompany,
  createSandboxCompany,
  generateCargoOffers,
  generateOffers,
  offerFleetWeight,
  type CompanyState,
} from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { HOME_COUNTRY_ID, airlineDef } from '../../src/core/economy/registry';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';

/**
 * 提案確率への保有規模の反映（2026-11-21 ユーザー要望）。
 * - 指標は保有型式数（ゲーム内データに型式ごとの機数は無いため、その会社のフリート一覧の件数で代理する）
 * - 倍率 = 1 + BALANCE.offers.fleetWeightPerType × (型式数 − 1)。1 型式は 1 倍（従来どおり）、
 *   カタログ最大の ANA（14 型式）でも 1.52 倍に留まることを固定する
 * - 適用範囲は旅客の通常提案（generateOffers の確率段）だけ。貨物・Phase4 提案には掛けない
 */

const OPERABLE = Object.keys(AIRCRAFT_TYPES);
const typeCountOf = (id: string): number => airlineDef(id).fleet.length;

describe('offerFleetWeight: 重み関数', () => {
  it('1 型式の会社は倍率 1（従来どおり）、0 以下でも 1', () => {
    expect(offerFleetWeight(1)).toBe(1);
    expect(offerFleetWeight(0)).toBe(1);
  });

  it('型式数が増えるほど単調に増える', () => {
    for (let n = 1; n < 20; n++) expect(offerFleetWeight(n + 1)).toBeGreaterThan(offerFleetWeight(n));
  });

  it('定数は BALANCE.offers.fleetWeightPerType の 1 箇所だけ（式と一致する）', () => {
    const k = BALANCE.offers.fleetWeightPerType;
    for (const n of [1, 2, 5, 10, 14]) expect(offerFleetWeight(n)).toBeCloseTo(1 + k * (n - 1), 10);
  });

  it('較正値: NH 1.52 / JL 1.36 / SQ（中堅 5 型式）1.16 / トキエア 1.04 / 最小規模 1.00', () => {
    expect(typeCountOf('NH')).toBe(14);
    expect(typeCountOf('JL')).toBe(10);
    expect(typeCountOf('SQ')).toBe(5);
    expect(typeCountOf('BV')).toBe(2); // トキエア
    expect(typeCountOf('MZ')).toBe(1); // 天草エアライン（最小規模）
    expect(offerFleetWeight(typeCountOf('NH'))).toBeCloseTo(1.52, 10);
    expect(offerFleetWeight(typeCountOf('JL'))).toBeCloseTo(1.36, 10);
    expect(offerFleetWeight(typeCountOf('SQ'))).toBeCloseTo(1.16, 10);
    expect(offerFleetWeight(typeCountOf('BV'))).toBeCloseTo(1.04, 10);
    expect(offerFleetWeight(typeCountOf('MZ'))).toBe(1);
  });

  it('カタログ全社で倍率は 1 以上 1.6 未満（最大でも最小の 2 倍に届かない）', () => {
    let max = 0;
    for (const a of CATALOG.airlines) {
      const w = offerFleetWeight(a.fleet.length);
      expect(w, a.id).toBeGreaterThanOrEqual(1);
      expect(w, a.id).toBeLessThan(1.6);
      max = Math.max(max, w);
    }
    expect(max).toBeCloseTo(1.52, 10); // 最大は ANA
  });
});

/** 市場モード・評価 100 で全社が適格な会社。上限（maxOpen）を外して確率段だけを測る */
function distributionCompany(seed: string): CompanyState {
  const c = createCompany('career', seed);
  c.rating = 100;
  c.market = { version: 1, routes: {} };
  c.city = defaultCity();
  return c;
}

function countOffers(c: CompanyState, rounds: number): Map<string, number> {
  const counts = new Map<string, number>();
  // 計測専用: 同時提案の上限を外して確率段だけを見る（BALANCE は as const のため書ける別名経由で戻す）
  const offersMutable = BALANCE.offers as unknown as { maxOpen: number };
  const savedMax = offersMutable.maxOpen;
  offersMutable.maxOpen = 100000;
  try {
    for (let i = 0; i < rounds; i++) {
      c.day = i;
      for (const k of generateOffers(c, OPERABLE, HOME_COUNTRY_ID, true)) {
        if (k.kind === undefined) counts.set(k.airlineId, (counts.get(k.airlineId) ?? 0) + 1);
      }
      for (const k of Object.values(c.contracts)) if (k.status === 'offered') delete c.contracts[k.id];
    }
  } finally {
    offersMutable.maxOpen = savedMax;
  }
  return counts;
}

describe('提案の出現分布（シード固定）', () => {
  it('大手が少しだけ出やすく、小規模も消えない（NH > JL > トキエア、最小規模も従来水準）', () => {
    const rounds = 300;
    const counts = countOffers(distributionCompany('fleet-measure-1'), rounds);
    const perDay = (id: string): number => (counts.get(id) ?? 0) / rounds;
    // 基礎確率（評価 100・満足度 60）は全社 0.42。変更後の期待値: NH 0.42×1.52≒0.64 / JL ≒0.57 / BV ≒0.44 / MZ 0.42
    expect(perDay('NH')).toBeGreaterThan(0.52);
    expect(perDay('NH')).toBeLessThan(0.76);
    expect(perDay('JL')).toBeGreaterThan(0.46);
    expect(perDay('JL')).toBeLessThan(0.68);
    expect(perDay('BV')).toBeGreaterThan(0.35);
    expect(perDay('BV')).toBeLessThan(0.53);
    // 順序と比率: NH はトキエアの 1.1〜1.9 倍（期待 ≒1.46）。大手ばかりにも小規模だらけにもならない
    expect(counts.get('NH')!).toBeGreaterThan(counts.get('JL')!);
    expect(counts.get('JL')!).toBeGreaterThan(counts.get('BV')!);
    const ratio = counts.get('NH')! / counts.get('BV')!;
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan(1.9);
    // 最小規模（倍率 1）は従来水準のまま届く
    expect(perDay('MZ')).toBeGreaterThan(0.33);
    expect(perDay('MZ')).toBeLessThan(0.51);
  }, 120000);
});

describe('適用範囲: 貨物提案には重みを掛けない', () => {
  it('貨物提案は従来どおり適格な会社から出る（確率段を持たないため対象外）', () => {
    const c = createSandboxCompany('fleet-weight-cargo');
    c.city = defaultCity('regional');
    c.rating = 80;
    c.features = { cargo: true };
    let cargoOffers = 0;
    for (let d = 0; d < 8; d++) {
      c.day = d;
      for (const k of generateCargoOffers(c, OPERABLE)) {
        cargoOffers++;
        k.status = 'expired';
      }
    }
    expect(cargoOffers).toBeGreaterThan(0);
  });
});
