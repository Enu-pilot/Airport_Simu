import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_RAW, FICTIONAL_AIRLINE_IDS, FICTIONAL_DESTINATION_IDS, validateCatalog, type CatalogRaw } from '../../src/core/data/index';
import {
  addContract,
  applyAirlineReassignment,
  contractsOf,
  createCompany,
  fictionalActiveContractCount,
  fictionalReassignmentCandidates,
  fictionalRestrictionActive,
  generateCargoOffers,
  generateOffers,
  generatePhase4Offers,
  importCompany,
  type CompanyState,
  type Contract,
} from '../../src/core/economy/company';
import { defaultGame } from '../../src/core/economy/game';
import { initialGoals, type Tier } from '../../src/core/economy/goals';
import { defaultCity } from '../../src/core/economy/city';
import { airlineDef, destinationDef, airlineFictionalAllows, FICTIONAL_RESTRICTION_TIER, HOME_COUNTRY_ID } from '../../src/core/economy/registry';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';

/**
 * 機能F: 架空会社の就航制限＋実在会社への持ち替え。
 * - fictional フラグはカタログ（コード側データ）の属性で、固定リストと集合一致を検証する
 * - 格（goals.tier）が閾値 3 以上のとき、架空会社の新規提案は架空の目的地だけ（提案生成の3経路）
 * - 既存契約は不変。契約パネル相当の付け替えは airlineId だけを変え、条件はすべて不変
 */

const OPERABLE = Object.keys(AIRCRAFT_TYPES);
const raw = (): CatalogRaw => JSON.parse(JSON.stringify(CATALOG_RAW)) as CatalogRaw;
const errors = (r: CatalogRaw) => validateCatalog(r).filter((i) => i.level === 'error');

describe('fictional: カタログのフラグと検証', () => {
  it('架空会社は固定リストの10社、架空目的地は固定リストの11件と一致する', () => {
    expect(new Set(CATALOG.airlines.filter((a) => a.fictional).map((a) => a.id))).toEqual(new Set(FICTIONAL_AIRLINE_IDS));
    expect(new Set(CATALOG.destinations.filter((d) => d.fictional).map((d) => d.id))).toEqual(new Set(FICTIONAL_DESTINATION_IDS));
    expect(FICTIONAL_AIRLINE_IDS).toHaveLength(10);
    expect(FICTIONAL_DESTINATION_IDS).toHaveLength(11);
  });

  it('全 Def に fictional（boolean）が正規化されている', () => {
    for (const a of CATALOG.airlines) expect(typeof a.fictional, a.id).toBe('boolean');
    for (const d of CATALOG.destinations) expect(typeof d.fictional, d.id).toBe('boolean');
  });

  it('SK は legacy だが実在（fictional ではない）', () => {
    const sk = airlineDef('SK');
    expect(sk.legacy).toBe(true);
    expect(sk.fictional).toBe(false);
  });

  it('架空会社から fictional を外すと検証エラーになる', () => {
    const r = raw();
    delete r.airlines.find((a) => a.id === 'NP')!.fictional;
    expect(errors(r).some((e) => e.field === 'fictional')).toBe(true);
  });

  it('実在会社へ fictional を付けると検証エラーになる', () => {
    const r = raw();
    r.airlines.find((a) => a.id === 'NH')!.fictional = true;
    expect(errors(r).some((e) => e.field === 'fictional')).toBe(true);
  });

  it('架空の国（ND）の目的地から fictional を外すと検証エラーになる', () => {
    const r = raw();
    delete r.destinations.find((d) => d.id === 'NDB')!.fictional;
    expect(errors(r).some((e) => e.field === 'fictional' && e.id === 'NDB')).toBe(true);
  });
});

describe('fictional: airlineFictionalAllows の真理表', () => {
  const np = airlineDef('NP'); // 架空
  const nh = airlineDef('NH'); // 実在
  const tyo = destinationDef('TYO'); // 実在
  const kta = destinationDef('KTA'); // 架空

  it('閾値は格 3', () => {
    expect(FICTIONAL_RESTRICTION_TIER).toBe(3);
  });

  it('架空×実在都市は格未満でのみ可、格以上では不可', () => {
    expect(airlineFictionalAllows(np, tyo, 0)).toBe(true);
    expect(airlineFictionalAllows(np, tyo, 2)).toBe(true);
    expect(airlineFictionalAllows(np, tyo, 3)).toBe(false);
    expect(airlineFictionalAllows(np, tyo, 7)).toBe(false);
  });

  it('架空×架空都市は常時可、実在会社は常時可', () => {
    expect(airlineFictionalAllows(np, kta, 3)).toBe(true);
    expect(airlineFictionalAllows(np, kta, 7)).toBe(true);
    expect(airlineFictionalAllows(nh, tyo, 3)).toBe(true);
    expect(airlineFictionalAllows(nh, tyo, 7)).toBe(true);
  });
});

/** 目標（goals）有効で格を指定した会社。評価は全目的地・全会社が対象になる 100 にする */
function goalsCompany(seed: string, tier: Tier): CompanyState {
  const c = createCompany('career', seed);
  c.game = defaultGame();
  c.goals = { ...initialGoals(), tier };
  c.rating = 100;
  return c;
}

function clearOffered(c: CompanyState): void {
  for (const k of Object.values(c.contracts)) if (k.status === 'offered') delete c.contracts[k.id];
}

function collectOffers(c: CompanyState, rounds: number): Contract[] {
  const all: Contract[] = [];
  for (let i = 0; i < rounds; i++) {
    c.day = i;
    all.push(...generateOffers(c, OPERABLE, HOME_COUNTRY_ID, true));
    clearOffered(c);
  }
  return all;
}

const isFictionalAirline = (k: Contract) => airlineDef(k.airlineId).fictional;
const isFictionalDest = (k: Contract) => destinationDef(k.destinationId).fictional;

describe('fictional: 提案生成の制限（generateOffers）', () => {
  it('格 2 では架空会社→実在都市の提案が出る', () => {
    const offers = collectOffers(goalsCompany('fictional-gen-t2', 2), 60);
    expect(offers.some((k) => isFictionalAirline(k) && !isFictionalDest(k))).toBe(true);
  });

  it('格 3 では架空会社→実在都市の提案は出ず、架空都市あては出る', () => {
    const offers = collectOffers(goalsCompany('fictional-gen-t3', 3), 60);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.filter((k) => isFictionalAirline(k) && !isFictionalDest(k))).toEqual([]);
    expect(offers.some((k) => isFictionalAirline(k) && isFictionalDest(k))).toBe(true);
  });

  it('格 4 では実在の SK（SAS）が実在都市へ提案する（実在会社は制限されない）', () => {
    const offers = collectOffers(goalsCompany('fictional-gen-t4', 4), 60);
    const sk = offers.filter((k) => k.airlineId === 'SK');
    expect(sk.length).toBeGreaterThan(0);
    expect(sk.some((k) => !isFictionalDest(k))).toBe(true);
    expect(offers.filter((k) => isFictionalAirline(k) && !isFictionalDest(k))).toEqual([]);
  });

  it('目標のない会社では格の概念がなく制限は掛からない', () => {
    const c = createCompany('career', 'fictional-gen-nogoals');
    c.rating = 100;
    expect(fictionalRestrictionActive(c)).toBe(false);
    const offers = collectOffers(c, 60);
    expect(offers.some((k) => isFictionalAirline(k) && !isFictionalDest(k))).toBe(true);
  });

  it('既存の有効契約は制限が効いてもそのまま残る', () => {
    const c = goalsCompany('fictional-gen-keep', 3);
    const k = addContract(c, {
      airlineId: 'NP', destinationId: 'TYO', typeId: 'A320neo', perDay: 2, window: 'any',
      feeDiscount: 0.1, startDay: 0, endDay: 29, status: 'active', offerExpiresDay: 0,
    });
    collectOffers(c, 10);
    expect(c.contracts[k.id]!.status).toBe('active');
    expect(c.contracts[k.id]!.airlineId).toBe('NP');
  });
});

describe('fictional: 提案生成の制限（Phase4・貨物）', () => {
  function collectPhase4(c: CompanyState, rounds: number): Contract[] {
    const all: Contract[] = [];
    for (let i = 0; i < rounds; i++) {
      c.day = i;
      all.push(...generatePhase4Offers(c, OPERABLE, HOME_COUNTRY_ID, true));
      clearOffered(c);
    }
    return all;
  }

  it('格 3 の夜間滞泊提案は、架空会社からは架空都市だけに出る', () => {
    const c = goalsCompany('fictional-p4-t3', 3);
    c.features = { overnight: true };
    const offers = collectPhase4(c, 40);
    expect(offers.some((k) => isFictionalAirline(k))).toBe(true);
    expect(offers.filter((k) => isFictionalAirline(k) && !isFictionalDest(k))).toEqual([]);
  });

  it('格 2 の夜間滞泊提案は、架空会社から実在都市にも出る', () => {
    const c = goalsCompany('fictional-p4-t2', 2);
    c.features = { overnight: true };
    const offers = collectPhase4(c, 40);
    expect(offers.some((k) => isFictionalAirline(k) && !isFictionalDest(k))).toBe(true);
  });

  it('格 3 の貨物提案は、架空会社（NP）からは架空都市だけに出る', () => {
    const c = goalsCompany('fictional-cargo-t3', 3);
    c.city = defaultCity('regional');
    c.features = { cargo: true };
    const all: Contract[] = [];
    for (let d = 0; d < 20; d++) {
      c.day = d;
      all.push(...generateCargoOffers(c, OPERABLE, HOME_COUNTRY_ID, true));
      clearOffered(c);
    }
    const np = all.filter((k) => k.airlineId === 'NP');
    expect(np.length).toBeGreaterThan(0);
    expect(np.filter((k) => !isFictionalDest(k))).toEqual([]);
  });
});

/** market 有効（候補プールが全会社になる）で格と評価を指定した会社 */
function reassignCompany(seed: string, tier: Tier, rating = 90): CompanyState {
  const c = goalsCompany(seed, tier);
  c.market = { version: 1, routes: {} };
  c.rating = rating;
  return c;
}

const baseContract = {
  perDay: 2, window: 'any' as const, feeDiscount: 0.1, startDay: 0, endDay: 29, status: 'active' as const, offerExpiresDay: 0,
};

describe('fictional: 実在会社への持ち替え', () => {
  it('候補は実在会社だけ・決定的で、契約機種を持つ会社が優先される', () => {
    const c = reassignCompany('fictional-reassign-basic', 3);
    const k = addContract(c, { ...baseContract, airlineId: 'NP', destinationId: 'TYO', typeId: 'A320neo' });
    const first = fictionalReassignmentCandidates(c, k);
    const second = fictionalReassignmentCandidates(c, structuredClone(k));
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((a) => !a.fictional)).toBe(true);
    expect(first.map((a) => a.id)).toEqual(second.map((a) => a.id));
    // 契約機種（A320neo）そのものを持つ会社が先頭グループに来る
    expect(first[0]!.fleet.some((e) => e.typeId === 'A320neo')).toBe(true);
    const jlIdx = first.findIndex((a) => a.id === 'JL'); // JL は A320neo を持たない（サイズ区分のみ一致）
    if (jlIdx >= 0) {
      const lastExact = first.map((a, i) => (a.fleet.some((e) => e.typeId === 'A320neo') ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
      expect(jlIdx).toBeGreaterThan(lastExact);
    }
  });

  it('就航範囲（networkDestinations）外の実在会社は候補にならない', () => {
    const c = reassignCompany('fictional-reassign-network', 3);
    const k = addContract(c, { ...baseContract, airlineId: 'HB', destinationId: 'SPK', typeId: 'B737-800' });
    const ids = fictionalReassignmentCandidates(c, k).map((a) => a.id);
    expect(ids).not.toContain('SN'); // SN の路線網は九州方面のみで SPK は範囲外
    expect(ids).toContain('HD'); // HD は北海道路線網で SPK が範囲内
  });

  it('付け替えで airlineId 以外の契約条件と、先方の保有機材は変わらない', () => {
    const c = reassignCompany('fictional-reassign-apply', 3);
    const k = addContract(c, { ...baseContract, airlineId: 'NP', destinationId: 'TYO', typeId: 'A320neo' });
    const candidates = fictionalReassignmentCandidates(c, k);
    const to = candidates[0]!;
    const before = structuredClone(k);
    const fleetsBefore = structuredClone(c.fleets);
    expect(applyAirlineReassignment(c, k.id, to.id)).toEqual({ ok: true });
    expect(c.contracts[k.id]).toEqual({ ...before, airlineId: to.id });
    // reassignOutOfScopeContracts と同じ扱い: 先方の fleets へ契約機種は補完しない
    expect(c.fleets).toEqual(fleetsBefore);
    // 付け替え後は再候補にならない（冪等）
    expect(fictionalReassignmentCandidates(c, c.contracts[k.id]!)).toEqual([]);
  });

  it('候補にない会社・架空会社へは付け替えできない', () => {
    const c = reassignCompany('fictional-reassign-invalid', 3);
    const k = addContract(c, { ...baseContract, airlineId: 'NP', destinationId: 'TYO', typeId: 'A320neo' });
    expect(applyAirlineReassignment(c, k.id, 'AS')).toEqual({ ok: false, reason: 'NOT_REASSIGNABLE' }); // 架空会社は候補外
    expect(applyAirlineReassignment(c, k.id, 'NP')).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect(applyAirlineReassignment(c, 'ct_999', 'NH')).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(c.contracts[k.id]!.airlineId).toBe('NP');
  });

  it('候補ゼロ（評価が低く実在会社の要件を満たさない）では付け替えできない', () => {
    const c = reassignCompany('fictional-reassign-none', 3, 30);
    const k = addContract(c, { ...baseContract, airlineId: 'NP', destinationId: 'TYO', typeId: 'A320neo' });
    expect(fictionalReassignmentCandidates(c, k)).toEqual([]);
    expect(applyAirlineReassignment(c, k.id, 'NH')).toEqual({ ok: false, reason: 'NOT_REASSIGNABLE' });
  });

  it('格未満・実在会社の契約・有効でない契約は持ち替え対象外', () => {
    const low = reassignCompany('fictional-reassign-t2', 2);
    const kLow = addContract(low, { ...baseContract, airlineId: 'NP', destinationId: 'TYO', typeId: 'A320neo' });
    expect(fictionalReassignmentCandidates(low, kLow)).toEqual([]);
    expect(fictionalActiveContractCount(low)).toBe(0);

    const c = reassignCompany('fictional-reassign-scope', 3);
    const real = addContract(c, { ...baseContract, airlineId: 'NH', destinationId: 'TYO', typeId: 'A320neo' });
    expect(fictionalReassignmentCandidates(c, real)).toEqual([]);
    const offered = addContract(c, { ...baseContract, airlineId: 'NP', destinationId: 'TYO', typeId: 'A320neo', status: 'offered' });
    expect(fictionalReassignmentCandidates(c, offered)).toEqual([]);
    expect(fictionalActiveContractCount(c)).toBe(0);
    const active = addContract(c, { ...baseContract, airlineId: 'NP', destinationId: 'KTA', typeId: 'A320neo' });
    expect(fictionalActiveContractCount(c)).toBe(1);
    expect(active.airlineId).toBe('NP');
  });

  it('保存往復: 付け替え後の契約が保持され、形式版は変わらない', () => {
    const c = reassignCompany('fictional-reassign-save', 3);
    const k = addContract(c, { ...baseContract, airlineId: 'NP', destinationId: 'TYO', typeId: 'A320neo' });
    const to = fictionalReassignmentCandidates(c, k)[0]!;
    expect(applyAirlineReassignment(c, k.id, to.id)).toEqual({ ok: true });
    const imported = importCompany(JSON.stringify(c));
    expect(imported).not.toBeNull();
    expect(imported!.version).toBe(1);
    expect(imported!.contracts[k.id]!.airlineId).toBe(to.id);
    expect(contractsOf(imported!, 'active').map((x) => x.id)).toContain(k.id);
  });
});
