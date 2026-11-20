import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany, generateCargoOffers, generateOffers, type CompanyState, type Contract } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { airlineCargoEligible, cargoHoldM3, isLargeFreighter } from '../../src/core/economy/cargo';
import { airlineDef, destinationDef, routeAvailability } from '../../src/core/economy/registry';
import { createSimulation } from '../../src/core/sim/simulation';
import { operableTypes } from '../../src/core/sim/context';
import { CATALOG } from '../../src/core/aircraft/catalog';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';

/**
 * 国内貨物専用機の実装（2026-11-20 ユーザー依頼）:
 * - スプリング・ジャパン（IJ）: ヤマト運輸の A321P2F 貨物専用機を 2024-04 から運航
 *   （成田・羽田－新千歳／北九州、成田－那覇、那覇－北九州）。旅客 LCC に貨物サービスと専用機を追加した。
 * - 日本貨物航空（KZ）: 成田拠点の貨物専業会社（自社運航は国際線のみ、747-8F 8 機＋747-400F ウェットリース）。
 *   旅客サービスを持たないため、貨物提案の路線判定は貨物サービスで行う（generateCargoOffers の切替）。
 * - A321P2F: 新規機種（Airbus / EFW 公開諸元ベース。容積 208 m³ は EFW 資料のコンテナ容積）。
 */

function cargoSandbox(seed: string): CompanyState {
  const c = createSandboxCompany(seed);
  c.city = defaultCity('metropolitan');
  c.rating = 90;
  c.features = { cargo: true };
  c.market = { version: 1, routes: {} }; // 全カタログを対象にする
  return c;
}

describe('貨物航空会社の追加データ', () => {
  it('A321P2F が機種カタログに貨物専用機として収録されている', () => {
    const m = CATALOG['A321P2F']!;
    expect(m).toBeDefined();
    expect(m.defaultSeats).toBe(0);
    expect(m.maxPax.value).toBeNull();
    expect(cargoHoldM3('A321P2F')).toBe(208); // EFW 公開値（コンテナ容積）
    expect(AIRCRAFT_TYPES['A321P2F']!.size).toBe('M'); // 翼幅 35.8 m → コード C
    expect(isLargeFreighter('A321P2F')).toBe(false); // 600 m³ 未満なので格 5 ゲート対象外
  });

  it('スプリング・ジャパン（IJ）は A321P2F で貨物サービスを持ち、北九州・那覇が就航範囲に入る', () => {
    const ij = airlineDef('IJ');
    expect(ij.services).toContain('cargo');
    expect(ij.cargoFleet).toEqual(['A321P2F']);
    expect(ij.networkDestinations).toEqual(expect.arrayContaining(['TYO', 'SPK', 'KKJ', 'OKA']));
    expect(ij.fictional).toBeFalsy(); // 実在会社
    expect(airlineCargoEligible('IJ')).toBe(true);
  });

  it('日本貨物航空（KZ）は実在の貨物専業会社として収録されている', () => {
    const kz = airlineDef('KZ');
    expect(kz.name).toBe('日本貨物航空（NCA）');
    expect(kz.services).toEqual(['cargo']); // 旅客サービスなし（専業）
    expect(kz.fictional).toBeFalsy(); // 実在会社
    expect(kz.fleet.map((e) => e.typeId)).toEqual(['B747-8F']);
    expect(kz.cargoFleet).toEqual(['B747-400F']);
    expect(kz.networkDestinations).toEqual(['ORD', 'LAX', 'JFK', 'DFW', 'SHA', 'HKG', 'SIN', 'BKK', 'TPE', 'AMS']);
    expect(airlineCargoEligible('KZ')).toBe(true);
  });

  it('貨物専業会社は旅客判定では全路線不可・貨物判定では就航可になる', () => {
    const kz = airlineDef('KZ');
    const caps = { originCountryId: 'JP', internationalPassengerProcessing: true };
    expect(routeAvailability(kz, destinationDef('ORD'), caps)).toBe('airline-unsupported');
    expect(routeAvailability(kz, destinationDef('ORD'), caps, 'cargo')).toBe('available');
  });
});

describe('貨物提案の生成（追加会社）', () => {
  it('IJ の貨物提案が A321P2F で出る（国内貨物）', () => {
    const c = cargoSandbox('cargo-airlines-ij');
    const sim = createSimulation(createSampleAirport(), { company: c });
    void sim;
    // 運用可能機種を A321P2F だけに絞ると、貨物提案を出せるのは IJ だけになる
    const offers = generateCargoOffers(c, ['A321P2F'], 'JP', true);
    expect(offers.length).toBeGreaterThan(0);
    for (const k of offers) {
      expect(k.kind).toBe('cargo');
      expect(k.airlineId).toBe('IJ');
      expect(k.typeId).toBe('A321P2F');
      expect(airlineDef('IJ').networkDestinations).toContain(k.destinationId);
    }
  });

  it('KZ の貨物提案が 747-8F で出る（国際貨物・貨物専業）', () => {
    const c = cargoSandbox('cargo-airlines-kz');
    const sim = createSimulation(createSampleAirport(), { company: c });
    const operable = operableTypes(sim.ctx).filter((t) => t === 'B747-8F' || t === 'B747-400F');
    let kzOffer: Contract | undefined;
    // 747F 系を持つ他社（KE/OZ/CI/CX/SQ）が就航範囲を使い切るまで日を進め、KZ の番を待つ
    for (let day = 0; day < 40 && !kzOffer; day++) {
      c.day = day;
      const offers = generateCargoOffers(c, operable, 'JP', true);
      kzOffer = offers.find((k) => k.airlineId === 'KZ');
      for (const k of Object.values(c.contracts)) if (k.status === 'offered') k.status = 'active';
    }
    expect(kzOffer).toBeDefined();
    expect(kzOffer!.kind).toBe('cargo');
    // 保有フレーターのうち運用可能な最大容積の機種が選ばれる（サンプル空港でコード F が運用不可だと 747-400F になる）
    expect(['B747-8F', 'B747-400F']).toContain(kzOffer!.typeId);
    expect(airlineDef('KZ').networkDestinations).toContain(kzOffer!.destinationId);
  });

  it('IJ・KZ は旅客提案には混ざらない', () => {
    const kz = airlineDef('KZ');
    expect(kz.services.some((s) => s !== 'cargo')).toBe(false);
    const ij = airlineDef('IJ');
    // IJ の旅客フリートに貨物専用機は入っていない（検証でも担保される）
    expect(ij.fleet.some((e) => ij.cargoFleet!.includes(e.typeId))).toBe(false);
  });
});

/**
 * 国際貨物の拡張（2026-11-20 ユーザー追加指示）:
 * - 拡張1: NH（777F・767-300F）と JL（767-300BCF→ゲーム内 767-300F）の国際貨物ネットワークは
 *   実態として成田からアジア・北米・欧州へ広がっており、両社とも就航範囲の制限がないため
 *   ゲーム内でも国際貨物提案が出る状態であることを監査で確認した（データ変更は不要だった）。
 * - 拡張2: 外国籍の貨物専業キャリア FX（フェデックス）・UP（UPS、実コード 5X）・CV（カーゴルックス）を追加。
 *   カボタージュ規制により国内線は運航できないため、就航範囲は外国都市のみに限定し、
 *   国内の貨物・旅客提案が一切出ないことをテストで固定する。実運航で国内区間を含む経由便
 *   （FX/UP の成田－関空、CV の小松就航）は就航範囲に入れないことで担保する。
 */

/** 日を進めながら貨物提案を集める（offered は active にして枠を空ける） */
function sweepCargo(c: CompanyState, operable: string[], days: number): Contract[] {
  const all: Contract[] = [];
  for (let day = 0; day < days; day++) {
    c.day = day;
    all.push(...generateCargoOffers(c, operable, 'JP', true));
    for (const k of Object.values(c.contracts)) if (k.status === 'offered') k.status = 'active';
  }
  return all;
}

/**
 * カボタージュ担保の共通断言: 外国籍の会社からは国内貨物提案が 1 件も出ていないこと。
 * なお AirlineDef は countryId を保持しない（buildAirline で落とされる）ため、外国籍かどうかは
 * 会社 ID の明示リストで判定する。ゲーム内で外国会社を国内に出さない担保は、各社の
 * networkDestinations が外国都市のみで構成されること（データ側の断言と併せて固定する）。
 */
const FOREIGN_CARGO_IDS = ['FX', 'UP', 'CV', 'KE', 'CI', 'BR', 'CX', 'SQ', 'LH', 'OZ'];
function expectNoForeignDomestic(offers: Contract[]): void {
  const bad = offers.filter(
    (k) => FOREIGN_CARGO_IDS.includes(k.airlineId) && destinationDef(k.destinationId).countryId === 'JP',
  );
  expect(bad).toEqual([]);
}

describe('国際貨物の拡張データ', () => {
  it('MD-11F が機種カタログに貨物専用機として収録されている', () => {
    const m = CATALOG['MD-11F']!;
    expect(m).toBeDefined();
    expect(m.defaultSeats).toBe(0);
    expect(m.maxPax.value).toBeNull();
    expect(cargoHoldM3('MD-11F')).toBe(610); // 主甲板＋下部の合計 21,530 cu ft = 609.7 m³
    expect(AIRCRAFT_TYPES['MD-11F']!.size).toBe('L'); // 翼幅 51.97 m → コード D
    expect(isLargeFreighter('MD-11F')).toBe(true); // 600 m³ 以上なので格 5 ゲート対象
  });

  it('FX・UP・CV は実在の貨物専業会社として、就航範囲が外国都市のみで収録されている', () => {
    const fx = airlineDef('FX');
    expect(fx.services).toEqual(['cargo']);
    expect(fx.fleet.map((e) => e.typeId)).toEqual(['B777F']);
    expect(fx.cargoFleet).toEqual(['MD-11F', 'B767-300F']);
    expect(fx.networkDestinations).toEqual(['SEL', 'SHA', 'PEK', 'TPE', 'SIN']);
    const ups = airlineDef('UP');
    expect(ups.services).toEqual(['cargo']);
    expect(ups.fleet.map((e) => e.typeId)).toEqual(['B747-8F']);
    expect(ups.cargoFleet).toEqual(['B747-400F', 'B767-300F']);
    expect(ups.networkDestinations).toEqual(['SHA', 'HKG', 'SZX']);
    const cv = airlineDef('CV');
    expect(cv.services).toEqual(['cargo']);
    expect(cv.fleet.map((e) => e.typeId)).toEqual(['B747-8F']);
    expect(cv.cargoFleet).toEqual(['B747-400F']);
    expect(cv.networkDestinations).toEqual(['SHA', 'PEK', 'XMN', 'HKG', 'TPE', 'SEL']);
    for (const a of [fx, ups, cv]) {
      expect(a.fictional).toBeFalsy(); // 実在会社
      expect(airlineCargoEligible(a.id)).toBe(true);
      // 就航範囲はすべて実在の外国都市（カボタージュ担保の第一層）
      for (const d of a.networkDestinations!) {
        expect(destinationDef(d).countryId).not.toBe('JP');
      }
    }
  });

  it('既存の外国籍貨物会社（KE/CI/BR/CX/SQ/LH）も就航範囲は外国都市のみ', () => {
    for (const id of ['KE', 'CI', 'BR', 'CX', 'SQ', 'LH']) {
      const a = airlineDef(id);
      expect(a.services).toContain('cargo');
      expect(a.cargoFleet!.length).toBeGreaterThan(0);
      for (const d of a.networkDestinations!) {
        expect(destinationDef(d).countryId).not.toBe('JP');
      }
    }
  });

  it('NH・JL の貨物機材は実態どおりで、国際路線の判定が通る（拡張1の監査）', () => {
    const nh = airlineDef('NH');
    expect(nh.cargoFleet).toEqual(['B777F', 'B767-300F']); // 777F 2 機＋767-300F/BCF
    expect(nh.networkDestinations).toBeUndefined(); // 就航範囲の制限なし（旅客と共通のため絞らない）
    const jl = airlineDef('JL');
    expect(jl.cargoFleet).toEqual(['B767-300F']); // 実機は 767-300BCF（ゲーム内は 767-300F で代表）
    expect(jl.networkDestinations).toBeUndefined();
    const caps = { originCountryId: 'JP', internationalPassengerProcessing: true };
    // NH: 成田－シカゴ（777F）・JL: 成田－台北（767-300BCF）はいずれも実在路線
    expect(routeAvailability(nh, destinationDef('ORD'), caps)).toBe('available');
    expect(routeAvailability(jl, destinationDef('TPE'), caps)).toBe('available');
  });
});

describe('国際貨物提案の出現とカボタージュ担保', () => {
  it('NH の国際貨物提案が 777F で実際に出る', () => {
    const c = cargoSandbox('cargo-intl-nh');
    createSimulation(createSampleAirport(), { company: c });
    const offers = sweepCargo(c, ['B777F'], 120);
    const nhIntl = offers.filter((k) => k.airlineId === 'NH' && destinationDef(k.destinationId).countryId !== 'JP');
    expect(nhIntl.length).toBeGreaterThan(0);
    expect(nhIntl.every((k) => k.kind === 'cargo' && k.typeId === 'B777F')).toBe(true);
    expectNoForeignDomestic(offers); // 同じ掃引に出た外国籍会社（KE/BR/LH/FX 等）も国内には出ていない
  });

  it('JL の国際貨物提案が 767-300F で実際に出る', () => {
    const c = cargoSandbox('cargo-intl-jl');
    createSimulation(createSampleAirport(), { company: c });
    const offers = sweepCargo(c, ['B767-300F'], 120);
    const jlIntl = offers.filter((k) => k.airlineId === 'JL' && destinationDef(k.destinationId).countryId !== 'JP');
    expect(jlIntl.length).toBeGreaterThan(0);
    expect(jlIntl.every((k) => k.kind === 'cargo' && k.typeId === 'B767-300F')).toBe(true);
    expectNoForeignDomestic(offers);
  });

  it('FX の貨物提案は国際線のみ（MD-11F に絞った掃引）', () => {
    const c = cargoSandbox('cargo-intl-fx');
    createSimulation(createSampleAirport(), { company: c });
    // MD-11F を貨物プールに持つのは FX だけなので、FX の提案だけが集まる
    const offers = sweepCargo(c, ['MD-11F'], 60);
    expect(offers.length).toBeGreaterThan(0); // 空振りでないこと
    expect(offers.every((k) => k.airlineId === 'FX' && k.kind === 'cargo' && k.typeId === 'MD-11F')).toBe(true);
    expect(offers.every((k) => destinationDef(k.destinationId).countryId !== 'JP')).toBe(true);
    for (const k of offers) expect(airlineDef('FX').networkDestinations).toContain(k.destinationId);
  });

  it('UP・CV の貨物提案は国際線のみで、国内貨物提案は 1 件も出ない（747F に絞った掃引）', () => {
    const c = cargoSandbox('cargo-intl-foreign');
    createSimulation(createSampleAirport(), { company: c });
    // 747F 系に絞ると NH/JL（747 フレイターを持たない）が外れ、747F 保有会社だけが競合する
    const offers = sweepCargo(c, ['B747-8F', 'B747-400F'], 150);
    for (const id of ['UP', 'CV']) {
      const mine = offers.filter((k) => k.airlineId === id);
      expect(mine.length).toBeGreaterThan(0); // 空振りでないこと
      expect(mine.every((k) => k.kind === 'cargo')).toBe(true);
      expect(mine.every((k) => destinationDef(k.destinationId).countryId !== 'JP')).toBe(true);
      for (const k of mine) expect(airlineDef(id).networkDestinations).toContain(k.destinationId);
    }
    // 同じ掃引に出た他の外国籍会社（KE/CI/CX/SQ）からも国内貨物提案は出ていない
    expectNoForeignDomestic(offers);
  });

  it('貨物専業会社（FX・UP・CV・KZ）は旅客提案に一切出ない', () => {
    const c = cargoSandbox('cargo-intl-nopax');
    createSimulation(createSampleAirport(), { company: c });
    const all: Contract[] = [];
    for (let day = 0; day < 30; day++) {
      c.day = day;
      all.push(...generateOffers(c, Object.keys(AIRCRAFT_TYPES), 'JP', true));
      for (const k of Object.values(c.contracts)) if (k.status === 'offered') k.status = 'active';
    }
    expect(all.length).toBeGreaterThan(0); // 旅客提案自体は出ている
    expect(all.filter((k) => ['FX', 'UP', 'CV', 'KZ'].includes(k.airlineId))).toEqual([]);
  });
});
