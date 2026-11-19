import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_RAW, validateCatalog } from '../../src/core/data/index';
import { addContract, contractsOf, createCompany, generateOffers, reassignOutOfScopeContracts, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { routeDemand } from '../../src/core/economy/demand';
import { airlineDef, airlineNetworkAllows, destinationDef, routeAvailability, routeCapabilitiesForAirport } from '../../src/core/economy/registry';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';

/**
 * 海外編: 日本へ就航する外国会社の網羅追加＋就航範囲（路線網）制限（2026-11-19 ユーザー依頼）。
 * - 成田・関空を中心に就航する外国会社と、その相手先都市（各社ハブ等）を追加
 * - 海外各社には networkDestinations（許可集合）を付け、提案生成だけに効かせる（国内編と同一の仕組み）
 */

describe('airlineNetworkForeign: 追加した海外データ', () => {
  it('カタログ検証が issue 0 件で、会社 105 社・目的地 171 都市', () => {
    expect(validateCatalog(CATALOG_RAW)).toEqual([]);
    expect(CATALOG.airlines.length).toBe(115);
    expect(CATALOG.destinations.length).toBe(178); // 国内編 107 + 海外編 64 + 子会社編 7
  });

  it('追加した海外都市が需要モデルで正の需要を持つ', () => {
    const c = createCompany('career', 'foreign-demand');
    c.city = defaultCity('metropolitan');
    c.market = { version: 1, routes: {} };
    c.rating = 95;
    for (const id of ['DOH', 'AUH', 'HEL', 'AMS', 'AKL', 'GUM', 'ORD', 'MEX', 'CJU', 'KHH', 'CNS', 'UBN']) {
      expect(routeDemand(c, destinationDef(id), 1) ?? 0, id).toBeGreaterThan(0);
    }
  });
});

describe('airlineNetworkForeign: 就航範囲の判定', () => {
  it('単一ハブ会社: エミレーツはドバイのみ、カタール航空はドーハのみ', () => {
    const ek = airlineDef('EK');
    expect(airlineNetworkAllows(ek, destinationDef('DXB'))).toBe(true);
    for (const id of ['SIN', 'LHR', 'DOH', 'AUH', 'BKK']) {
      expect(airlineNetworkAllows(ek, destinationDef(id)), id).toBe(false);
    }
    const qr = airlineDef('QR');
    expect(airlineNetworkAllows(qr, destinationDef('DOH'))).toBe(true);
    expect(airlineNetworkAllows(qr, destinationDef('DXB'))).toBe(false);
  });

  it('複数都市型: ユナイテッドは自社ハブと太平洋路線は可、他社ハブは不可', () => {
    const ua = airlineDef('UA');
    for (const id of ['SFO', 'ORD', 'EWR', 'GUM', 'SPN', 'KHH', 'CEB', 'UBN']) {
      expect(airlineNetworkAllows(ua, destinationDef(id)), id).toBe(true);
    }
    for (const id of ['LHR', 'FRA', 'DOH', 'SIN']) {
      expect(airlineNetworkAllows(ua, destinationDef(id)), id).toBe(false);
    }
  });

  it('新規会社: チェジュ航空は韓国側都市のみ、スターラックスは台北のみ', () => {
    const jj = airlineDef('JJ');
    for (const id of ['SEL', 'PUS', 'CJU']) expect(airlineNetworkAllows(jj, destinationDef(id)), id).toBe(true);
    expect(airlineNetworkAllows(jj, destinationDef('TPE'))).toBe(false);
    const jx = airlineDef('JX');
    expect(airlineNetworkAllows(jx, destinationDef('TPE'))).toBe(true);
    expect(airlineNetworkAllows(jx, destinationDef('HKG'))).toBe(false);
  });

  it('無制限の会社 (NH と legacy の SK) は従来どおり全目的地が可', () => {
    for (const aid of ['NH', 'SK']) {
      const a = airlineDef(aid);
      expect(a.networkDestinations, aid).toBeUndefined();
      expect(airlineNetworkAllows(a, destinationDef('DOH'))).toBe(true);
      expect(airlineNetworkAllows(a, destinationDef('HEL'))).toBe(true);
    }
  });

  it('制限は routeAvailability 本体に入らない（既存契約の grandfathering）', () => {
    const caps = routeCapabilitiesForAirport('JP', { international: true });
    expect(routeAvailability(airlineDef('EK'), destinationDef('SIN'), caps)).toBe('available');
    expect(airlineNetworkAllows(airlineDef('EK'), destinationDef('SIN'))).toBe(false);
  });
});

describe('airlineNetworkForeign: 提案生成への組み込み', () => {
  it('制限付き会社には範囲外の国際線提案が出ず、範囲内の提案は出る', () => {
    const c: CompanyState = createCompany('career', 'foreign-offers');
    c.city = defaultCity('metropolitan');
    c.market = { version: 1, routes: {} };
    c.rating = 95;
    // generateOffers はカタログ定義順に走査し open 枠 (maxOpen) が埋まると打ち切るため、
    // 定義順の後方にある EK (37 番目) には通常の状態では到達しない (到達範囲は TG 付近まで)。
    // EK の提案そのものを検証するため、他社の満足度を 0 に落として提案確率を下げ、
    // 走査が EK まで届く会社状態にする (EK 自身の条件・範囲判定は一切変えていない)。
    for (const a of CATALOG.airlines) {
      if (a.id !== 'EK') c.airlines[a.id] = { satisfaction: 0, lowDays: 0 };
    }
    const operable = Object.keys(AIRCRAFT_TYPES);
    const seen = new Map<string, Set<string>>();
    for (let round = 0; round < 80; round++) {
      generateOffers(c, operable, 'JP', true);
      for (const k of contractsOf(c, 'offered')) {
        const set = seen.get(k.airlineId) ?? new Set<string>();
        set.add(k.destinationId);
        seen.set(k.airlineId, set);
        k.status = 'expired';
      }
      c.day += 1;
    }
    const ekDests = seen.get('EK') ?? new Set<string>();
    expect(ekDests.size, 'EK の提案が 1 件以上出る').toBeGreaterThan(0);
    for (const d of ekDests) expect(d, `EK→${d}`).toBe('DXB');
    const keDests = seen.get('KE') ?? new Set<string>();
    expect(keDests.size, 'KE の提案が 1 件以上出る').toBeGreaterThan(0);
    for (const d of keDests) expect(['SEL', 'PUS', 'CJU'], `KE→${d}`).toContain(d);
    const qrDests = seen.get('QR') ?? new Set<string>();
    for (const d of qrDests) expect(d, `QR→${d}`).toBe('DOH');
    const jjDests = seen.get('JJ') ?? new Set<string>();
    for (const d of jjDests) expect(['SEL', 'PUS', 'CJU'], `JJ→${d}`).toContain(d);
    const uaDests = seen.get('UA') ?? new Set<string>();
    for (const d of uaDests) expect(airlineDef('UA').networkDestinations, `UA→${d}`).toContain(d);
  }, 60000); // 統合後は走査対象が 171 都市 × 105 社に増えるため国内編テストと同じ 60 秒に延長
});

describe('airlineNetworkForeign: 既存契約の付け替え（国内編の仕組みが外国会社にも効く）', () => {
  const base = { perDay: 2, window: 'any' as const, feeDiscount: 0, startDay: 0, endDay: 99, status: 'active' as const, offerExpiresDay: 0 };

  it('範囲外の外国会社契約（EK→SIN）は、路線を保ったまま範囲内の会社へ付け替わる', () => {
    const c = createCompany('career', 'foreign-reassign');
    c.rating = 95;
    // EK はドバイ (DXB) のみ。SIN あての有効契約は範囲外
    const k = addContract(c, { ...base, airlineId: 'EK', destinationId: 'SIN', typeId: 'B777-300ER' });
    const changes = reassignOutOfScopeContracts(c);
    expect(changes).toEqual([{ contractId: k.id, destinationId: 'SIN', fromAirlineId: 'EK', toAirlineId: k.airlineId }]);
    expect(k.airlineId).not.toBe('EK');
    expect(airlineNetworkAllows(airlineDef(k.airlineId), destinationDef('SIN'))).toBe(true);
    // 路線（目的地・頻度・機種）は維持される
    expect(k.destinationId).toBe('SIN');
    expect(k.perDay).toBe(2);
    expect(k.typeId).toBe('B777-300ER');
    // 冪等: 2 回目は変わらない
    expect(reassignOutOfScopeContracts(c)).toEqual([]);
  });

  it('範囲内の外国会社契約（EK→DXB）は不変', () => {
    const c = createCompany('career', 'foreign-reassign-keep');
    c.rating = 95;
    const k = addContract(c, { ...base, airlineId: 'EK', destinationId: 'DXB', typeId: 'B777-300ER' });
    expect(reassignOutOfScopeContracts(c)).toEqual([]);
    expect(k.airlineId).toBe('EK');
  });
});
