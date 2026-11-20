import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_RAW, validateCatalog } from '../../src/core/data/index';
import { addContract, contractsOf, createCompany, generateOffers, importCompany, reassignOutOfScopeContracts, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { routeDemand } from '../../src/core/economy/demand';
import { AIRLINES, airlineDef, airlineNetworkAllows, destinationDef } from '../../src/core/economy/registry';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';

/**
 * 系列子会社・地域航空の追加（2026-11-19 ユーザー依頼）。
 * - JAL/ANA グループの地域運航会社（ジェイエア・ANAウイングス・JAC・JTA・RAC・HAC）と
 *   独立系の地域航空（IBEX・ORC・天草エアライン・トキエア）を独立した会社項目として追加
 * - 各社に実路線網に基づく networkDestinations を付け、提案生成と既存契約の付け替えで検証する
 */

const SUBSIDIARIES = ['XM', 'EH', 'FW', 'JC', 'NU', 'RA', 'HC', 'OC', 'MZ', 'BV'];

describe('airlineNetworkSubsidiaries: 追加した会社と目的地', () => {
  it('カタログ検証が issue 0 件で、会社 119 社・目的地 178 件', () => {
    expect(validateCatalog(CATALOG_RAW)).toEqual([]);
    expect(CATALOG.airlines.length).toBe(119); // 115 社＋日本貨物航空（KZ）＋外国籍貨物専業 3 社（FX/UP/CV。2026-11-20）
    expect(CATALOG.destinations.length).toBe(178);
    for (const id of SUBSIDIARIES) {
      const a = airlineDef(id);
      expect(a.legacy, id).toBe(false);
      expect(a.services, id).toEqual(['domesticPassenger']);
      expect(a.networkDestinations, id).toBeDefined();
    }
    // 機材は実在構成（機種表にある型のみ）
    expect(airlineDef('XM').fleet.map((e) => e.typeId)).toEqual(['E170', 'E190']);
    expect(airlineDef('EH').fleet.map((e) => e.typeId)).toEqual(['DHC8-Q400', 'B737-800']);
    expect(airlineDef('JC').fleet.map((e) => e.typeId)).toEqual(['ATR42-600', 'ATR72-600']);
    expect(airlineDef('NU').fleet.map((e) => e.typeId)).toEqual(['B737-800', 'B737-700']);
    expect(airlineDef('BV').fleet.map((e) => e.typeId)).toEqual(['ATR72-600', 'ATR42-600']);
  });

  it('追加した目的地が需要モデルで正の需要を持つ', () => {
    const c = createCompany('career', 'subsidiary-demand');
    c.city = defaultCity('metropolitan');
    c.market = { version: 1, routes: {} };
    c.rating = 80;
    for (const id of ['TSJ', 'IKI', 'FUJ', 'OKK', 'AGJ', 'KXJ', 'AXJ']) {
      expect(routeDemand(c, destinationDef(id), 1) ?? 0, id).toBeGreaterThan(0);
    }
  });
});

describe('airlineNetworkSubsidiaries: 就航範囲の判定', () => {
  it('琉球エアコミューター (RA) は沖縄離島のみ: 本州・九州は不可', () => {
    const ra = airlineDef('RA');
    for (const id of ['OKA', 'ISG', 'MMY', 'UEO', 'TRA', 'OGN', 'KTD', 'MMD', 'AGJ']) {
      expect(airlineNetworkAllows(ra, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['TYO', 'OSA', 'FUK', 'KOJ', 'SPK']) {
      expect(airlineNetworkAllows(ra, destinationDef(id)), id).toBe(false);
    }
  });

  it('北海道エアシステム (HC) は道内＋三沢・秋田のみ: 九州・本州太平洋側は不可', () => {
    const hc = airlineDef('HC');
    for (const id of ['SPK', 'HKD', 'KUH', 'MMB', 'RIS', 'OKK', 'MSJ', 'AXT']) {
      expect(airlineNetworkAllows(hc, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['FUK', 'KOJ', 'TYO', 'OKA', 'SDJ']) {
      expect(airlineNetworkAllows(hc, destinationDef(id)), id).toBe(false);
    }
  });

  it('日本エアコミューター (JC) は鹿児島・奄美群島＋大阪/福岡の接続のみ', () => {
    const jc = airlineDef('JC');
    for (const id of ['KOJ', 'ASJ', 'KXJ', 'TKN', 'OKE', 'RNJ', 'KUM', 'TNE', 'OSA', 'FUK']) {
      expect(airlineNetworkAllows(jc, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['TYO', 'SPK', 'OKA', 'ISG', 'KMJ']) {
      expect(airlineNetworkAllows(jc, destinationDef(id)), id).toBe(false);
    }
  });

  it('オリエンタルエアブリッジ (OC) は長崎離島＋福岡のみ、天草エアライン (MZ) は天草・熊本・福岡・大阪のみ', () => {
    const oc = airlineDef('OC');
    for (const id of ['NGS', 'FUJ', 'IKI', 'TSJ', 'FUK']) {
      expect(airlineNetworkAllows(oc, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['TYO', 'OSA', 'KOJ', 'KMJ']) {
      expect(airlineNetworkAllows(oc, destinationDef(id)), id).toBe(false);
    }
    const mz = airlineDef('MZ');
    for (const id of ['AXJ', 'KMJ', 'FUK', 'OSA']) {
      expect(airlineNetworkAllows(mz, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['TYO', 'NGO', 'OKA', 'KOJ']) {
      expect(airlineNetworkAllows(mz, destinationDef(id)), id).toBe(false);
    }
  });

  it('ジェイエア (XM) は伊丹拠点の地域路線＋羽田の一部、IBEX (FW) は仙台・伊丹・中部・福岡の地方路線、トキエア (BV) は新潟発のみ', () => {
    const xm = airlineDef('XM');
    for (const id of ['OSA', 'TYO', 'MSJ', 'IZO', 'KOJ', 'FUK', 'MYJ']) {
      expect(airlineNetworkAllows(xm, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['OKA', 'ISG', 'KUH', 'WKJ', 'NGO']) {
      expect(airlineNetworkAllows(xm, destinationDef(id)), id).toBe(false);
    }
    const fw = airlineDef('FW');
    for (const id of ['SDJ', 'OSA', 'NGO', 'FUK', 'KIJ', 'KOJ']) {
      expect(airlineNetworkAllows(fw, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['TYO', 'OKA', 'KUH', 'ISG']) {
      expect(airlineNetworkAllows(fw, destinationDef(id)), id).toBe(false);
    }
    const bv = airlineDef('BV');
    for (const id of ['KIJ', 'SPK', 'SDJ', 'NGO', 'UKB']) {
      expect(airlineNetworkAllows(bv, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['TYO', 'OSA', 'FUK', 'HKD']) {
      expect(airlineNetworkAllows(bv, destinationDef(id)), id).toBe(false);
    }
  });

  it('ANAウイングス (EH) は地方フィーダー全般だが、他グループの離島専用空港には入らない。JTA (NU) は沖縄＋本土接続のみ', () => {
    const eh = airlineDef('EH');
    for (const id of ['TYO', 'OSA', 'FUK', 'HKD', 'TSJ', 'FUJ', 'MYJ', 'IZO', 'KMQ']) {
      expect(airlineNetworkAllows(eh, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['RIS', 'OKK', 'AGJ', 'KTD', 'MMD', 'TRA', 'OGN', 'KXJ', 'ASJ']) {
      expect(airlineNetworkAllows(eh, destinationDef(id)), id).toBe(false);
    }
    const nu = airlineDef('NU');
    for (const id of ['OKA', 'ISG', 'MMY', 'UEO', 'SHI', 'OGN', 'TYO', 'OSA', 'FUK']) {
      expect(airlineNetworkAllows(nu, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['SPK', 'SDJ', 'KOJ', 'KMJ', 'AGJ', 'TRA']) {
      expect(airlineNetworkAllows(nu, destinationDef(id)), id).toBe(false);
    }
  });
});

describe('airlineNetworkSubsidiaries: 提案生成への組み込み', () => {
  it('追加会社には範囲外の提案が出ず、範囲内の提案は出る', () => {
    const c: CompanyState = createCompany('career', 'subsidiary-offers');
    c.city = defaultCity('metropolitan');
    c.market = { version: 1, routes: {} };
    c.rating = 95;
    // 末尾に追加した会社まで走査が届くよう、追加会社以外の保有機材を空にする
    // （generateOffers は機材ゼロの会社を提案せずに次へ進むため、追加会社だけが提案源になる）
    for (const a of AIRLINES) {
      if (!SUBSIDIARIES.includes(a.id)) c.fleets[a.id] = [];
    }
    const operable = Object.keys(AIRCRAFT_TYPES);
    const seen = new Map<string, Set<string>>();
    for (let round = 0; round < 80; round++) {
      generateOffers(c, operable, 'JP', false);
      for (const k of contractsOf(c, 'offered')) {
        const set = seen.get(k.airlineId) ?? new Set<string>();
        set.add(k.destinationId);
        seen.set(k.airlineId, set);
        k.status = 'expired';
      }
      c.day += 1;
    }
    // 提案は追加会社からのみ出ている
    expect(seen.size).toBeGreaterThan(0);
    for (const aid of seen.keys()) expect(SUBSIDIARIES, aid).toContain(aid);
    // 範囲外は 1 件も出ない（全社分を各社の許可集合と照合）
    for (const [aid, dests] of seen) {
      const allowed = new Set(airlineDef(aid).networkDestinations);
      for (const d of dests) expect(allowed.has(d), `${aid}→${d}`).toBe(true);
    }
    // 代表例: RAC は本州に出ない、HAC は九州に出ない
    for (const d of seen.get('RA') ?? []) expect(['TYO', 'OSA', 'FUK']).not.toContain(d);
    for (const d of seen.get('HC') ?? []) expect(['FUK', 'KOJ', 'OKA']).not.toContain(d);
    // 範囲内の提案が実際に出ている会社が複数ある（全て止まっているのではない）
    expect([...seen.values()].filter((s) => s.size > 0).length).toBeGreaterThanOrEqual(4);
  }, 60000);
});

describe('airlineNetworkSubsidiaries: 既存契約の付け替え候補', () => {
  const base = { perDay: 2, window: 'any' as const, feeDiscount: 0, startDay: 0, endDay: 99, status: 'active' as const, offerExpiresDay: 0 };

  it('範囲外の契約が、追加した子会社へ付け替わる（奥尻 → HAC）', () => {
    const c = createCompany('career', 'subsidiary-reassign-hac');
    c.market = { version: 1, routes: {} }; // 付け替えの候補プールは market 有効時の全社
    c.rating = 95;
    // SN（九州方面のみ）に奥尻 OKK の契約がある状態。OKK を範囲に持ち ATR42-600 を運航するのは HC と JL で、
    // 契約機種そのものを持つ会社が優先され、同点は会社 ID 順で HC が先に来る
    const k = addContract(c, { ...base, airlineId: 'SN', destinationId: 'OKK', typeId: 'ATR42-600' });
    const changes = reassignOutOfScopeContracts(c);
    expect(changes).toEqual([{ contractId: k.id, destinationId: 'OKK', fromAirlineId: 'SN', toAirlineId: 'HC' }]);
    expect(k.airlineId).toBe('HC');
    expect(k.destinationId).toBe('OKK');
    expect(reassignOutOfScopeContracts(c)).toEqual([]); // 冪等
  });

  it('評価が本系の要件に届かない場合は、子会社が付け替え先になる（粟国 → RAC）', () => {
    const c = createCompany('career', 'subsidiary-reassign-rac');
    c.market = { version: 1, routes: {} };
    c.rating = 50; // NH/JL の最低評価 60 に届かないため、候補から外れる
    const k = addContract(c, { ...base, airlineId: 'SN', destinationId: 'AGJ', typeId: 'DHC8-Q400' });
    const changes = reassignOutOfScopeContracts(c);
    expect(changes).toEqual([{ contractId: k.id, destinationId: 'AGJ', fromAirlineId: 'SN', toAirlineId: 'RA' }]);
    expect(k.airlineId).toBe('RA');
  });

  it('実セーブ (1412) が読み込め、既存契約が壊れない（付け替えは国内編の 7 件のまま）', () => {
    const path = '/home/hatch/workspace/user/files/skyport-mainplay1-20261119-1412.skyport.json';
    if (!existsSync(path)) return;
    const save = JSON.parse(readFileSync(path, 'utf8')) as { company: unknown };
    const before = (save.company as CompanyState).contracts;
    const imported = importCompany(JSON.stringify(save.company));
    expect(imported).not.toBeNull();
    const after = imported!.contracts;
    expect(Object.keys(after).length).toBe(Object.keys(before).length);
    let moved = 0;
    for (const [id, k] of Object.entries(after)) {
      const b = before[id]!;
      expect(k.destinationId).toBe(b.destinationId);
      expect(k.perDay).toBe(b.perDay);
      expect(k.typeId).toBe(b.typeId);
      if (k.airlineId !== b.airlineId) {
        moved += 1;
        expect(airlineDef(b.airlineId).networkDestinations).toBeDefined();
        expect(airlineNetworkAllows(airlineDef(b.airlineId), destinationDef(b.destinationId))).toBe(false);
        expect(airlineNetworkAllows(airlineDef(k.airlineId), destinationDef(k.destinationId))).toBe(true);
      }
    }
    // 追加した子会社は既存契約の付け替え結果を変えない（1412 の付け替えは国内編時点の 7 件と同一）
    expect(moved).toBe(7);
  });
});
