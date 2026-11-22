import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIRCRAFT_MODELS, CATALOG_VERSION, sizeClassOf } from '../../src/core/aircraft/catalog';
import { CATALOG, CATALOG_RAW, validateCatalog } from '../../src/core/data/index';
import { airlineDef } from '../../src/core/economy/registry';
import {
  addContract,
  changeContractAircraft,
  createCompany,
  createSandboxCompany,
  generateOffers,
  removeFleetEntry,
  seatsFor,
  setFleetEntry,
  type CompanyState,
} from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { HOME_COUNTRY_ID } from '../../src/core/economy/registry';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';
import { editorStore, setOpsPrefs } from '../../src/editor/store';
import { AIRCRAFT_TYPE_CODES, aircraftTypeCode, formatFleetEntry, formatTypeWithSpec, typeShortName } from '../../src/ui/aircraftLabel';
import { resolveType } from '../../src/core/sim/aircraftTypes';

/**
 * 2026-FLEET（機材・航空会社カタログの拡充とフリート精査）と 2026-CODE（略号表示モード）。
 * - CRJ700 の新規収録と IBEX（FW）の実機化
 * - JAL・ANA の国内線／国際線仕様バリアント（spec）と座席数の伝播（フリート→契約→座席数）
 * - 精査による修正（JTA の 737-700 削除、ORC の ATR42-600 化、天草は ATR のみで適合）
 * - 略号フォーマッタと表示設定（表示のみで、保存・SIM に影響しない）
 */

describe('2026-FLEET: CRJ700 と IBEX', () => {
  it('CRJ700 が機種カタログに収録され、カタログ版は 2026.11.4', () => {
    const m = AIRCRAFT_MODELS.find((x) => x.id === 'CRJ700');
    expect(m).toBeDefined();
    expect(m!.manufacturer).toBe('Bombardier');
    expect(m!.icao).toBe('CRJ7');
    expect(m!.defaultSeats).toBe(70);
    expect(m!.lengthM.value).toBe(32.51);
    expect(m!.wingspanM.value).toBe(23.2);
    expect(m!.maxPax.value).toBe(78);
    // 翼幅 23.2 m はコード B → サイズ区分 S（汎用 regional70 と同じ区分）
    expect(sizeClassOf(m!).size).toBe('S');
    expect(CATALOG_VERSION).toBe('2026.11.4');
    expect(AIRCRAFT_TYPES['CRJ700']).toBeDefined();
  });

  it('IBEX（FW）の機材は CRJ700（70 席）で、汎用 regional70 は使わない', () => {
    expect(airlineDef('FW').fleet).toEqual([{ typeId: 'CRJ700', seats: 70 }]);
  });
});

describe('2026-FLEET: JAL・ANA の仕様バリアント（公式シートマップの座席数）', () => {
  const entriesOf = (airline: string, typeId: string) => airlineDef(airline).fleet.filter((e) => e.typeId === typeId);

  it('ANA 787-8 は国内線 335 席／国際線 240 席（旧値 244 は存在しない）', () => {
    expect(entriesOf('NH', 'B787-8')).toEqual([
      { typeId: 'B787-8', seats: 335, spec: 'domestic' },
      { typeId: 'B787-8', seats: 240, spec: 'international' },
    ]);
  });

  it('ANA 787-9／787-10／767-300ER にも両仕様がある', () => {
    expect(entriesOf('NH', 'B787-9')).toEqual([
      { typeId: 'B787-9', seats: 375, spec: 'domestic' },
      { typeId: 'B787-9', seats: 246, spec: 'international' },
    ]);
    expect(entriesOf('NH', 'B787-10')).toEqual([
      { typeId: 'B787-10', seats: 429, spec: 'domestic' },
      { typeId: 'B787-10', seats: 294, spec: 'international' },
    ]);
    expect(entriesOf('NH', 'B767-300ER')).toEqual([
      { typeId: 'B767-300ER', seats: 270, spec: 'domestic' },
      { typeId: 'B767-300ER', seats: 202, spec: 'international' },
    ]);
  });

  it('JAL は 787-8／767-300ER／737-800 に両仕様がある', () => {
    expect(entriesOf('JL', 'B787-8')).toEqual([
      { typeId: 'B787-8', seats: 291, spec: 'domestic' },
      { typeId: 'B787-8', seats: 186, spec: 'international' },
    ]);
    expect(entriesOf('JL', 'B767-300ER')).toEqual([
      { typeId: 'B767-300ER', seats: 261, spec: 'domestic' },
      { typeId: 'B767-300ER', seats: 199, spec: 'international' },
    ]);
    expect(entriesOf('JL', 'B737-800')).toEqual([
      { typeId: 'B737-800', seats: 165, spec: 'domestic' },
      { typeId: 'B737-800', seats: 144, spec: 'international' },
    ]);
  });

  it('片方の仕様しかない型式はバリアント化しない（ANA 737-800、JAL A350-900 など）', () => {
    expect(entriesOf('NH', 'B737-800')).toEqual([{ typeId: 'B737-800', seats: 166 }]);
    expect(entriesOf('JL', 'A350-900')).toEqual([{ typeId: 'A350-900', seats: 369 }]);
    expect(entriesOf('JL', 'B787-9')).toEqual([{ typeId: 'B787-9', seats: 239 }]);
  });

  it('全社で (typeId, spec) は一意で、カタログ検証が issue 0 件', () => {
    for (const a of CATALOG.airlines) {
      const keys = a.fleet.map((e) => `${e.typeId}:${e.spec ?? ''}`);
      expect(new Set(keys).size, a.id).toBe(keys.length);
    }
    expect(validateCatalog(CATALOG_RAW)).toEqual([]);
  });
});

describe('2026-FLEET: 精査による修正', () => {
  it('JTA（NU）に 737-700 はない（737-800 のみ）', () => {
    expect(airlineDef('NU').fleet).toEqual([{ typeId: 'B737-800', seats: 165 }]);
  });

  it('ORC（OC）は現行機材 ATR42-600（48 席）', () => {
    expect(airlineDef('OC').fleet).toEqual([{ typeId: 'ATR42-600', seats: 48 }]);
  });

  it('天草エアライン（MZ）は ATR42-600 のみで A320 の紐付けはない', () => {
    expect(airlineDef('MZ').fleet).toEqual([{ typeId: 'ATR42-600', seats: 48 }]);
    for (const a of CATALOG.airlines) {
      if (a.id === 'MZ') expect(a.fleet.some((e) => e.typeId.startsWith('A320'))).toBe(false);
    }
  });
});

describe('2026-FLEET: spec の伝播（フリート→契約→座席数）', () => {
  function nhCompany(): CompanyState {
    const c = createSandboxCompany('spec-test');
    c.airlines['NH'] ??= { satisfaction: 60, lowDays: 0 };
    c.fleets['NH'] = airlineDef('NH').fleet.map((e) => ({ ...e }));
    return c;
  }

  it('seatsFor は spec 指定で仕様の座席数を返し、無指定は従来どおり先頭一致', () => {
    const c = nhCompany();
    expect(seatsFor(c, 'NH', 'B787-8', AIRCRAFT_TYPES, 'domestic')).toBe(335);
    expect(seatsFor(c, 'NH', 'B787-8', AIRCRAFT_TYPES, 'international')).toBe(240);
    expect(seatsFor(c, 'NH', 'B787-8')).toBe(335); // 先頭（国内線仕様）
    // 仕様のない型式は spec を渡しても従来どおり
    expect(seatsFor(c, 'NH', 'B737-800', AIRCRAFT_TYPES, 'domestic')).toBe(166);
  });

  it('契約に spec を保持でき、changeContractAircraft で仕様ごと切り替わる', () => {
    const c = nhCompany();
    const k = addContract(c, {
      airlineId: 'NH', destinationId: 'TYO', typeId: 'B787-8', spec: 'international',
      perDay: 1, window: 'any', feeDiscount: 0, startDay: 0, endDay: 30, status: 'active', offerExpiresDay: 0,
    });
    expect(k.spec).toBe('international');
    expect(seatsFor(c, k.airlineId, k.typeId, AIRCRAFT_TYPES, k.spec)).toBe(240);
    expect(changeContractAircraft(c, k.id, 'B787-8', 'domestic')).toEqual({ ok: true });
    expect(k.spec).toBe('domestic');
    expect(seatsFor(c, k.airlineId, k.typeId, AIRCRAFT_TYPES, k.spec)).toBe(335);
    // 仕様のない型式へ変えると spec は消える
    expect(changeContractAircraft(c, k.id, 'B737-800')).toEqual({ ok: true });
    expect(k.spec).toBeUndefined();
  });

  it('setFleetEntry / removeFleetEntry は (typeId, spec) 単位で扱う', () => {
    const c = nhCompany();
    expect(setFleetEntry(c, 'NH', 'B787-9', 380, AIRCRAFT_TYPES, 'domestic')).toEqual({ ok: true });
    expect(seatsFor(c, 'NH', 'B787-9', AIRCRAFT_TYPES, 'domestic')).toBe(380);
    expect(seatsFor(c, 'NH', 'B787-9', AIRCRAFT_TYPES, 'international')).toBe(246); // 国際線は不変
    expect(removeFleetEntry(c, 'NH', 'B787-9', 'domestic')).toEqual({ ok: true });
    expect(seatsFor(c, 'NH', 'B787-9', AIRCRAFT_TYPES, 'domestic')).toBe(246); // 先頭一致へフォールバック
    expect(c.fleets['NH']!.filter((e) => e.typeId === 'B787-9')).toEqual([{ typeId: 'B787-9', seats: 246, spec: 'international' }]);
  });

  it('提案生成で ANA の契約に仕様が付く（シード固定・300 日分）', () => {
    const c = createCompany('career', 'spec-offer-1');
    c.rating = 100;
    c.market = { version: 1, routes: {} };
    c.city = defaultCity();
    const specs = new Set<string>();
    for (let d = 0; d < 300 && specs.size < 2; d++) {
      c.day = d;
      for (const k of generateOffers(c, Object.keys(AIRCRAFT_TYPES), HOME_COUNTRY_ID, true)) {
        if (k.airlineId === 'NH' && k.typeId === 'B787-8' && k.spec) specs.add(k.spec);
      }
      for (const k of Object.values(c.contracts)) if (k.status === 'offered') delete c.contracts[k.id];
    }
    expect(specs.size).toBeGreaterThanOrEqual(1);
    for (const s of specs) expect(['domestic', 'international']).toContain(s);
  }, 120000);
});

describe('2026-CODE: 略号フォーマッタ', () => {
  it('PO 指定の 2 例: 787-8 → 788、A350-1000 → A35X', () => {
    expect(aircraftTypeCode('B787-8')).toBe('788');
    expect(aircraftTypeCode('A350-1000')).toBe('A35X');
  });

  it('代表型式のコード（FR24 系）', () => {
    expect(aircraftTypeCode('B787-9')).toBe('789');
    expect(aircraftTypeCode('B787-10')).toBe('78X');
    expect(aircraftTypeCode('A350-900')).toBe('A359');
    expect(aircraftTypeCode('B777-300ER')).toBe('77W');
    expect(aircraftTypeCode('B737-800')).toBe('738');
    expect(aircraftTypeCode('A321neo')).toBe('A21N');
    expect(aircraftTypeCode('CRJ700')).toBe('CRJ7');
    expect(aircraftTypeCode('ATR42-600')).toBe('AT46');
    expect(aircraftTypeCode('DHC8-Q400')).toBe('DH8D');
    expect(aircraftTypeCode('B747-400F')).toBe('74F');
  });

  it('カタログの全型式にコードが割り当てられている', () => {
    for (const m of AIRCRAFT_MODELS) {
      expect(AIRCRAFT_TYPE_CODES[m.id], m.id).toBeTruthy();
      expect(aircraftTypeCode(m.id), m.id).toBe(AIRCRAFT_TYPE_CODES[m.id]);
    }
  });

  it('フリート項目の全文表記は「787-8（335席/国内線機材）」形式', () => {
    expect(formatFleetEntry({ typeId: 'B787-8', seats: 335, spec: 'domestic' }, 'full')).toBe('787-8（335席/国内線機材）');
    expect(formatFleetEntry({ typeId: 'B787-8', seats: 186, spec: 'international' }, 'full')).toBe('787-8（186席/国際線機材）');
    expect(formatFleetEntry({ typeId: 'B737-800', seats: 165 }, 'full')).toBe('737-800（165席）');
    expect(formatFleetEntry({ typeId: 'A350-1000', seats: 239, spec: 'international' }, 'full')).toBe('A350-1000（239席/国際線機材）');
  });

  it('フリート項目の略号表記は「788（内）」「A35X（際）」、仕様なしはコードのみ', () => {
    expect(formatFleetEntry({ typeId: 'B787-8', seats: 335, spec: 'domestic' }, 'code')).toBe('788（内）');
    expect(formatFleetEntry({ typeId: 'A350-1000', seats: 239, spec: 'international' }, 'code')).toBe('A35X（際）');
    expect(formatFleetEntry({ typeId: 'B787-9', seats: 246 }, 'code')).toBe('789');
  });

  it('型式＋仕様の表記（座席数なし）と短縮名', () => {
    expect(formatTypeWithSpec('B787-8', 'domestic', 'full')).toBe('787-8（国内線機材）');
    expect(formatTypeWithSpec('B787-8', 'international', 'code')).toBe('788（際）');
    expect(formatTypeWithSpec('B787-8', undefined, 'full')).toBe('Boeing 787-8');
    expect(typeShortName(resolveType(AIRCRAFT_TYPES, 'B767-300ER'))).toBe('767-300ER');
    expect(typeShortName(resolveType(AIRCRAFT_TYPES, 'A321neo'))).toBe('A321neo');
  });

  it('フォーマッタは入力を書き換えない（表示のみ）', () => {
    const e = { typeId: 'B787-8', seats: 335, spec: 'domestic' as const };
    formatFleetEntry(e, 'full');
    formatFleetEntry(e, 'code');
    expect(e).toEqual({ typeId: 'B787-8', seats: 335, spec: 'domestic' });
  });
});

describe('2026-CODE: 表示設定（OpsPrefs.typeLabelMode）', () => {
  const KEY = 'skyport.opsPrefs.v1';
  let original: Storage | undefined;
  let backing: Map<string, string>;

  beforeEach(() => {
    backing = new Map();
    original = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
      key: (i: number) => [...backing.keys()][i] ?? null,
      get length() {
        return backing.size;
      },
    } as Storage;
    setOpsPrefs({ typeLabelMode: 'full' });
  });

  afterEach(() => {
    setOpsPrefs({ typeLabelMode: 'full' });
    globalThis.localStorage = original as Storage;
  });

  it('既定は全文（full）で、切替が store と localStorage に保存される', () => {
    expect(editorStore.getState().opsPrefs.typeLabelMode).toBe('full');
    setOpsPrefs({ typeLabelMode: 'code' });
    expect(editorStore.getState().opsPrefs.typeLabelMode).toBe('code');
    expect((JSON.parse(backing.get(KEY)!) as Record<string, unknown>).typeLabelMode).toBe('code');
  });

  it('切替は会社状態（保存データ）に影響しない', () => {
    const before = editorStore.getState().company;
    setOpsPrefs({ typeLabelMode: 'code' });
    expect(editorStore.getState().company).toBe(before);
    setOpsPrefs({ typeLabelMode: 'full' });
    expect(editorStore.getState().company).toBe(before);
  });
});
