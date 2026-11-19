import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_RAW, validateCatalog } from '../../src/core/data/index';
import { addContract, contractsOf, createCompany, generateOffers, importCompany, reassignOutOfScopeContracts, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { routeDemand } from '../../src/core/economy/demand';
import { AIRLINES, airlineDef, airlineNetworkAllows, destinationDef, routeAvailability, routeCapabilitiesForAirport } from '../../src/core/economy/registry';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';

/**
 * 国内網の網羅追加＋就航範囲（路線網）制限（2026-11-19 ユーザー依頼）。
 * - 那覇・大阪（伊丹/関西）・羽田・新千歳から就航のある実在国内空港を目的地に追加
 * - 地域系・LCC の実在各社には networkDestinations（許可集合）を付け、提案生成に効かせる
 * - 既存の有効契約が範囲外の場合は、読み込み時に路線を保ったまま範囲内へ付け替える（ユーザー決定で追加）
 */

const HOKKAIDO = ['SPK', 'HKD', 'AKJ', 'KUH', 'OBO', 'MMB', 'WKJ', 'SHB', 'MBE', 'RIS'];
const KYUSHU = ['FUK', 'KKJ', 'HSG', 'NGS', 'KMJ', 'OIT', 'KMI', 'KOJ', 'ASJ', 'KUM', 'TNE'];

describe('airlineNetwork: 追加した国内目的地', () => {
  it('カタログ検証が issue 0 件で、目的地は 107 件（うち実在国内 68 件）', () => {
    expect(validateCatalog(CATALOG_RAW)).toEqual([]);
    expect(CATALOG.destinations.length).toBe(107);
    const realDomestic = CATALOG.destinations.filter((d) => d.countryId === 'JP' && !['KTA', 'TWN', 'MSK', 'YKH', 'KRG', 'AOS', 'NSH', 'HSM'].includes(d.id));
    expect(realDomestic.length).toBe(68);
  });

  it('追加都市が需要モデルで正の需要を持つ', () => {
    const c = createCompany('career', 'network-demand');
    c.city = defaultCity('metropolitan');
    c.market = { version: 1, routes: {} };
    c.rating = 80;
    for (const id of ['KUH', 'KCZ', 'SHI', 'UKB', 'FSZ', 'MSJ', 'ASJ', 'HHC']) {
      expect(routeDemand(c, destinationDef(id), 1) ?? 0, id).toBeGreaterThan(0);
    }
  });
});

describe('airlineNetwork: 就航範囲の判定', () => {
  it('ソラシドエア (SN) は九州方面のみ: 北海道・四国は不可、九州と拠点は可', () => {
    const sn = airlineDef('SN');
    for (const id of ['KOJ', 'KMJ', 'KMI', 'NGS', 'OIT', 'FUK', 'OKA', 'TYO', 'NGO', 'UKB', 'ISG', 'MMY']) {
      expect(airlineNetworkAllows(sn, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['SPK', 'KUH', 'HKD', 'KCZ', 'SDJ', 'KIJ']) {
      expect(airlineNetworkAllows(sn, destinationDef(id)), id).toBe(false);
    }
  });

  it('エアドゥー (HD) は北海道関連のみ: 九州・沖縄は不可、北海道と本州の就航先は可', () => {
    const hd = airlineDef('HD');
    for (const id of [...HOKKAIDO, 'TYO', 'SDJ', 'NGO', 'UKB', 'HIJ', 'OKJ', 'TOY', 'KMQ']) {
      expect(airlineNetworkAllows(hd, destinationDef(id)), id).toBe(true);
    }
    for (const id of [...KYUSHU, 'OKA', 'ISG', 'MYJ']) {
      expect(airlineNetworkAllows(hd, destinationDef(id)), id).toBe(false);
    }
  });

  it('無制限の会社 (NH/JL と架空会社) は従来どおり全目的地が可', () => {
    for (const aid of ['NH', 'JL', 'NP', 'RJ']) {
      const a = airlineDef(aid);
      expect(a.networkDestinations).toBeUndefined();
      expect(airlineNetworkAllows(a, destinationDef('KUH'))).toBe(true);
      expect(airlineNetworkAllows(a, destinationDef('KOJ'))).toBe(true);
    }
  });

  it('制限は routeAvailability 本体に入らない（既存契約の grandfathering）', () => {
    // 締結済み契約は範囲外でも運航・集計を続ける仕様。判定は提案生成だけに掛ける
    const caps = routeCapabilitiesForAirport('JP', {});
    expect(routeAvailability(airlineDef('SN'), destinationDef('SPK'), caps)).toBe('available');
    expect(routeAvailability(airlineDef('HD'), destinationDef('KOJ'), caps)).toBe('available');
  });
});

describe('airlineNetwork: 提案生成への組み込み', () => {
  it('制限付き会社には範囲外の提案が出ず、範囲内の提案は出る。無制限会社には範囲外相当も出る', () => {
    const c: CompanyState = createCompany('career', 'network-offers');
    c.city = defaultCity('metropolitan');
    c.market = { version: 1, routes: {} };
    c.rating = 95;
    const operable = Object.keys(AIRCRAFT_TYPES);
    const seen = new Map<string, Set<string>>();
    for (let round = 0; round < 80; round++) {
      generateOffers(c, operable, 'JP', false);
      for (const k of contractsOf(c, 'offered')) {
        const set = seen.get(k.airlineId) ?? new Set<string>();
        set.add(k.destinationId);
        seen.set(k.airlineId, set);
        k.status = 'expired'; // 枠と served を空けて次の周回で再提案させる
      }
      c.day += 1;
    }
    const snDests = seen.get('SN') ?? new Set<string>();
    const hdDests = seen.get('HD') ?? new Set<string>();
    // 範囲内の提案は実際に出ている（全て止まっているのではない）
    expect(snDests.size).toBeGreaterThan(0);
    expect(hdDests.size).toBeGreaterThan(0);
    // 範囲外は 1 件も出ない
    for (const d of snDests) expect(HOKKAIDO, `SN→${d}`).not.toContain(d);
    for (const d of hdDests) expect(KYUSHU, `HD→${d}`).not.toContain(d);
    for (const d of hdDests) expect(d, `HD→${d}`).not.toBe('OKA');
    // 無制限会社の提案には、SN の範囲外（北海道）や HD の範囲外（九州）が混ざり得る
    const nhDests = seen.get('NH') ?? new Set<string>();
    expect([...nhDests].some((d) => HOKKAIDO.includes(d) || KYUSHU.includes(d))).toBe(true);
  }, 60000);
});

describe('airlineNetwork: 既存契約の付け替え（読み込み時）', () => {
  const base = { perDay: 2, window: 'any' as const, feeDiscount: 0, startDay: 0, endDay: 99, status: 'active' as const, offerExpiresDay: 0 };

  it('範囲外の有効契約は、路線を保ったまま範囲内の会社へ付け替わる', () => {
    const c = createCompany('career', 'network-reassign');
    c.rating = 95;
    // SN（九州方面のみ）に北海道 SPK の契約がある状態（旧セーブの再現）
    const k = addContract(c, { ...base, airlineId: 'SN', destinationId: 'SPK', typeId: 'A320neo' });
    const changes = reassignOutOfScopeContracts(c);
    expect(changes).toEqual([{ contractId: k.id, destinationId: 'SPK', fromAirlineId: 'SN', toAirlineId: k.airlineId }]);
    expect(k.airlineId).not.toBe('SN');
    expect(airlineNetworkAllows(airlineDef(k.airlineId), destinationDef('SPK'))).toBe(true);
    // 路線（目的地・頻度・機種）は維持される
    expect(k.destinationId).toBe('SPK');
    expect(k.perDay).toBe(2);
    expect(k.typeId).toBe('A320neo');
    // 冪等: 2 回目は変わらない
    expect(reassignOutOfScopeContracts(c)).toEqual([]);
  });

  it('エアドゥー (HD) の九州契約も付け替わる', () => {
    const c = createCompany('career', 'network-reassign-hd');
    c.rating = 95;
    const k = addContract(c, { ...base, airlineId: 'HD', destinationId: 'KOJ', typeId: 'A320neo' });
    const changes = reassignOutOfScopeContracts(c);
    expect(changes.length).toBe(1);
    expect(k.airlineId).not.toBe('HD');
    expect(airlineNetworkAllows(airlineDef(k.airlineId), destinationDef('KOJ'))).toBe(true);
  });

  it('範囲内の契約と無制限会社の契約は不変', () => {
    const c = createCompany('career', 'network-reassign-keep');
    c.rating = 95;
    const inScope = addContract(c, { ...base, airlineId: 'SN', destinationId: 'KOJ', typeId: 'A320neo' });
    const free = addContract(c, { ...base, airlineId: 'NH', destinationId: 'SPK', typeId: 'A320neo' });
    expect(reassignOutOfScopeContracts(c)).toEqual([]);
    expect(inScope.airlineId).toBe('SN');
    expect(free.airlineId).toBe('NH');
  });

  it('候補が存在しない場合は元の会社のまま維持される（契約は破棄しない）', () => {
    const c = createCompany('career', 'network-reassign-none');
    c.rating = 95;
    // 全会社の保有機材を空にすると、サイズ互換の候補が誰もいなくなる
    for (const a of AIRLINES) c.fleets[a.id] = [];
    const k = addContract(c, { ...base, airlineId: 'SN', destinationId: 'SPK', typeId: 'A320neo' });
    expect(reassignOutOfScopeContracts(c)).toEqual([]);
    expect(k.airlineId).toBe('SN');
    expect(k.status).toBe('active');
  });

  it('importCompany 経由でも付け替わり、再読み込みしても安定する', () => {
    const c = createCompany('career', 'network-reassign-import');
    c.rating = 95;
    const k = addContract(c, { ...base, airlineId: 'SN', destinationId: 'SPK', typeId: 'A320neo' });
    const imported = importCompany(JSON.stringify(c));
    expect(imported).not.toBeNull();
    const moved = contractsOf(imported!, 'active').find((x) => x.id === k.id)!;
    expect(moved.airlineId).not.toBe('SN');
    const again = importCompany(JSON.stringify(imported));
    expect(contractsOf(again!, 'active').find((x) => x.id === k.id)!.airlineId).toBe(moved.airlineId);
  });

  it('実セーブ (1412) が読み込め、既存契約が壊れない（付け替えは範囲外の制限会社分だけ）', () => {
    const path = '/home/hatch/workspace/user/files/skyport-mainplay1-20261119-1412.skyport.json';
    if (!existsSync(path)) return; // 実セーブのない環境ではスキップ
    const save = JSON.parse(readFileSync(path, 'utf8')) as { company: unknown };
    const before = (save.company as CompanyState).contracts;
    const imported = importCompany(JSON.stringify(save.company));
    expect(imported).not.toBeNull();
    const after = imported!.contracts;
    // 契約の総数・ID・路線は不変。変わるのは一部の airlineId だけ
    expect(Object.keys(after).length).toBe(Object.keys(before).length);
    for (const [id, k] of Object.entries(after)) {
      const b = before[id]!;
      expect(k.destinationId).toBe(b.destinationId);
      expect(k.perDay).toBe(b.perDay);
      expect(k.typeId).toBe(b.typeId);
      if (k.airlineId !== b.airlineId) {
        // 付け替えは「制限会社の範囲外」→「範囲内」の方向だけに起きる
        expect(airlineDef(b.airlineId).networkDestinations).toBeDefined();
        expect(airlineNetworkAllows(airlineDef(b.airlineId), destinationDef(b.destinationId))).toBe(false);
        expect(airlineNetworkAllows(airlineDef(k.airlineId), destinationDef(k.destinationId))).toBe(true);
      }
    }
  });
});
