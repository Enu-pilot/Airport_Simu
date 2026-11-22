import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { updateEntity } from '../../src/core/layout/operations';
import type { AirportLayout } from '../../src/core/model/types';
import { AIRCRAFT_MODELS, CATALOG, DATA_SOURCES, codeLetterOf, sizeClassOf } from '../../src/core/aircraft/catalog';
import { checkAirport, checkStand } from '../../src/core/aircraft/compat';
import { AIRCRAFT_TYPES, buildTypeTable, resolveType } from '../../src/core/sim/aircraftTypes';
import { buildAirsideNetwork } from '../../src/core/airside/network';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { operableTypes } from '../../src/core/sim/context';
import { checkInvariants } from '../../src/core/sim/invariants';
import { addDisruption, reassignStand, resolveDisruption, prioritize } from '../../src/core/sim/disruptions';
import { tasksOf } from '../../src/core/sim/ground';
import { addDepartureGroup } from '../../src/core/sim/passengers';
import {
  addContract,
  changeContractAircraft,
  createCareerCompany,
  createCompany,
  importCompany,
  maxSeatsOf,
  seatsFor,
  setFleetEntry,
  type CompanyState,
} from '../../src/core/economy/company';
import { landingFee } from '../../src/core/economy/ops';
import { planDay } from '../../src/core/economy/planning';
import { must } from './helpers';

const manual = { autoSchedule: false };

function run(sim: Simulation, cond: () => boolean, maxTicks: number): void {
  for (let i = 0; i < maxTicks && !cond(); i++) {
    stepSimulation(sim);
    const v = checkInvariants(sim);
    if (v.length) throw new Error(`t=${sim.state.now}: ${v.join(' / ')}`);
  }
  if (!cond()) throw new Error(`condition not met (t=${sim.state.now})`);
}

/** サンプル空港をコード F 対応にする（L スポット・すべての誘導路。滑走路は幅 60 m） */
function codeFAirport(): AirportLayout {
  let l = createSampleAirport();
  for (const s of Object.values(l.stands)) if (s.size === 'L') l = must(updateEntity(l, s.id, { codeF: true })).layout;
  for (const e of Object.values(l.taxiways)) l = must(updateEntity(l, e.id, { widthClass: 'F' })).layout;
  return l;
}

// ---------------------------------------------------------------- カタログ

describe('機種カタログ', () => {
  it('派生型を別の機種IDで保持する（777-300 と 777-300ER、737-800 とウィングレット付き）', () => {
    expect(CATALOG['B777-300']).toBeDefined();
    expect(CATALOG['B777-300ER']).toBeDefined();
    expect(CATALOG['B777-300']!.icao).toBe('B773');
    expect(CATALOG['B777-300ER']!.icao).toBe('B77W');
    expect(CATALOG['B777-300']!.wingspanM.value).toBe(60.93);
    expect(CATALOG['B777-300ER']!.wingspanM.value).toBe(64.8);
    expect(CATALOG['B737-800']!.wingspanM.value).not.toBe(CATALOG['B737-800W']!.wingspanM.value);
    expect(new Set(AIRCRAFT_MODELS.map((m) => m.id)).size).toBe(AIRCRAFT_MODELS.length);
  });

  it('公式値には出典（URL・参照日）と定義があり、未設定の値は null で推定しない', () => {
    for (const m of AIRCRAFT_MODELS) {
      for (const v of [m.lengthM, m.wingspanM, m.heightM, m.mtowKg, m.maxPax, m.typicalSeats, m.cargoM3, m.fuelL]) {
        if (v.status === 'official') {
          expect(v.value).not.toBeNull();
          expect(DATA_SOURCES[v.source!]?.url).toMatch(/^https:\/\//);
          expect(DATA_SOURCES[v.source!]?.accessed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(v.note).toBeTruthy();
        }
        if (v.status === 'unset') expect(v.value).toBeNull();
      }
      // 実在の機種の寸法は公式値、汎用機材は実機データを持たない
      if (!m.generic) expect(m.wingspanM.status).toBe('official');
      else expect(m.wingspanM.status).toBe('game');
    }
  });

  it('翼幅からコード文字・サイズ区分を決める（A380 はコード F）', () => {
    expect(codeLetterOf(35.8)).toBe('C');
    expect(codeLetterOf(64.8)).toBe('E');
    expect(codeLetterOf(79.8)).toBe('F');
    expect(sizeClassOf(CATALOG['A320neo']!)).toEqual({ size: 'M', codeF: false });
    expect(sizeClassOf(CATALOG['B777-300ER']!)).toEqual({ size: 'L', codeF: false });
    expect(sizeClassOf(CATALOG['A380-800']!)).toEqual({ size: 'L', codeF: true });
    expect(sizeClassOf(CATALOG.narrow180!)).toEqual({ size: 'M', codeF: false });
  });

  it('カタログにない機種IDは「未解決」として代替値で扱い、データは保持する', () => {
    const t = resolveType(AIRCRAFT_TYPES, 'B747-8I');
    expect(t.unresolved).toBe(true);
    expect(t.id).toBe('B747-8I');
    const net = buildAirsideNetwork(createSampleAirport());
    expect(checkAirport(t, createSampleAirport(), net).status).toBe('unknown');
  });
});

// ---------------------------------------------------------------- 適合性

describe('機種と施設の適合性', () => {
  const sample = createSampleAirport();
  const net = buildAirsideNetwork(sample);

  it('小さな飛行場（M級滑走路・Mスポット）では 777-300ER は運航できず、理由が示される', () => {
    const starter = createStarterAirfield();
    const r = checkAirport(AIRCRAFT_TYPES['B777-300ER']!, starter, buildAirsideNetwork(starter));
    expect(r.status).toBe('ng');
    expect(r.reasons).toContain('RUNWAY_CLASS');
    expect(r.reasons).toContain('STAND_CLASS');
    expect(checkAirport(AIRCRAFT_TYPES['A320neo']!, starter, buildAirsideNetwork(starter)).status).toBe('ok');
  });

  it('サンプル空港: 777-300 と 777-300ER は L スポットで運航できるが、A380 はコード F の施設がないため運航できない', () => {
    expect(checkAirport(AIRCRAFT_TYPES['B777-300']!, sample, net).status).toBe('ok');
    expect(checkAirport(AIRCRAFT_TYPES['B777-300ER']!, sample, net).status).toBe('ok');
    const a380 = checkAirport(AIRCRAFT_TYPES['A380-800']!, sample, net);
    expect(a380.status).toBe('ng');
    expect(a380.reasons).toContain('STAND_CODE_F');
    expect(a380.taxiwaysNg.some((c) => c.reasons.includes('TAXIWAY_CODE_F'))).toBe(true);
    // ゲートは紐付いたスポットの適合性で判定する（判定を重複して持たない）
    expect(a380.gates.every((g) => g.status === 'ng' && g.reasons.includes('GATE_STAND_NG'))).toBe(true);
  });

  it('コード F を指定すると A380 が運航可能になり、2階建て機の上階の搭乗橋は情報として示す', () => {
    const l = codeFAirport();
    const r = checkAirport(AIRCRAFT_TYPES['A380-800']!, l, buildAirsideNetwork(l));
    expect(r.status).toBe('ok');
    const lGate = r.gates.find((g) => g.status === 'ok');
    expect(lGate?.reasons).toContain('GATE_UPPER_DECK');
  });

  it('地上支援: 必要な車両が1台もなければ運航不可、少なければ遅れるが運航可', () => {
    let l = createSampleAirport();
    const gse = Object.values(l.facilities).find((f) => f.kind === 'gseBase')!;
    l = structuredClone(l);
    l.facilities[gse.id]!.props.beltLoaders = 1;
    const fewer = checkAirport(AIRCRAFT_TYPES['B777-300ER']!, l, buildAirsideNetwork(l));
    expect(fewer.status).toBe('ok');
    expect(fewer.ground.reasons).toContain('GSE_FEWER');
    l.facilities[gse.id]!.props.beltLoaders = 0;
    const none = checkAirport(AIRCRAFT_TYPES['B777-300ER']!, l, buildAirsideNetwork(l));
    expect(none.status).toBe('ng');
    expect(none.ground.detail).toContain('beltLoader');
  });

  it('運航可能な機種の一覧に、適合しない機種は含まれない', () => {
    const sim = createSimulation(sample, { settings: manual });
    const ops = operableTypes(sim.ctx);
    expect(ops).toContain('B777-300ER');
    expect(ops).not.toContain('A380-800');
  });

  it('適合しない施設には割り当てない: A380 は空きスポットがあってもコード F でなければ待機してダイバートする', () => {
    const sim = createSimulation(sample, { settings: manual });
    const ac = addTurnaround(sim, 'A380-800', sim.state.now + 20 * 60);
    run(sim, () => ac.state === 'diverted', 3 * 3600);
    expect(ac.history.some((h) => h.state === 'parked')).toBe(false);
    expect(sim.state.flights[ac.arrivalFlightId]!.status).toBe('diverted');
  });

  it('コード F の空港では A380 が L スポットに駐機する', () => {
    const l = codeFAirport();
    const sim = createSimulation(l, { settings: manual });
    const ac = addTurnaround(sim, 'A380-800', sim.state.now + 20 * 60);
    run(sim, () => ac.state === 'parked', 3 * 3600);
    expect(l.stands[ac.standId!]!.size).toBe('L');
    expect(checkStand(AIRCRAFT_TYPES['A380-800']!, l.stands[ac.standId!]!).status).toBe('ok');
  });
});

// ---------------------------------------------------------------- 機種の特性がシミュレーションに反映される

describe('機種の特性とシミュレーション', { timeout: 120_000 }, () => {
  function oneFlight(typeId: string): { sim: Simulation; c: CompanyState } {
    const c = createCompany('sandbox', 'm');
    addContract(c, { airlineId: 'NP', destinationId: 'AOS', typeId, perDay: 1, window: 'daytime', feeDiscount: 0, startDay: 0, endDay: 9, status: 'active', offerExpiresDay: 0 });
    const sim = createSimulation(createSampleAirport(), { company: c });
    run(sim, () => Object.values(sim.state.aircraft).length > 0 && Object.values(sim.state.aircraft).every((a) => a.state === 'departed'), 86400);
    return { sim, c };
  }

  it('777-300 と 777-300ER で座席数・地上作業時間・着陸料（重量）・記録の機種IDが変わる', () => {
    const a = oneFlight('B777-300');
    const b = oneFlight('B777-300ER');
    const ra = a.sim.state.analytics.records[0]!;
    const rb = b.sim.state.analytics.records[0]!;
    expect(ra.typeId).toBe('B777-300');
    expect(rb.typeId).toBe('B777-300ER');
    // 座席: NP は 777-300 を 400 席で保有（航空会社の座席構成）、777-300ER は保有していないので機種の既定値
    expect(ra.seats).toBe(400);
    expect(rb.seats).toBe(AIRCRAFT_TYPES['B777-300ER']!.seats);
    const clean = (s: Simulation) => tasksOf(s.state, Object.keys(s.state.aircraft)[0]!).find((t) => t.kind === 'clean')!.workSec;
    expect(clean(a.sim)).not.toBe(clean(b.sim));
    // 着陸料は最大離陸重量（公式値）に比例
    const fa = landingFee(a.c, { typeId: 'B777-300' }, 12 * 3600, 1);
    const fb = landingFee(a.c, { typeId: 'B777-300ER' }, 12 * 3600, 1);
    expect(fb / fa).toBeCloseTo(352 / 299, 3);
    // 機材が大きいほど地上作業の必要ユニットが多い（双通路機は荷下ろしにベルトローダー2台）
    const unload = tasksOf(b.sim.state, Object.keys(b.sim.state.aircraft)[0]!).find((t) => t.kind === 'unload')!;
    expect(unload.needs.beltLoader).toBe(2);
  });

  it('航空会社ごとに同じ機種でも座席数が違い、最大旅客定員を超える座席構成は拒否する', () => {
    const c = createCompany('sandbox');
    expect(setFleetEntry(c, 'AQ', 'A320neo', 194)).toEqual({ ok: true });
    expect(setFleetEntry(c, 'AQ', 'A320neo', 195)).toEqual({ ok: false, reason: 'OVER_MAX_PAX' });
    expect(setFleetEntry(c, 'NP', 'A320neo', 150)).toEqual({ ok: true });
    expect(seatsFor(c, 'AQ', 'A320neo')).toBe(194);
    expect(seatsFor(c, 'NP', 'A320neo')).toBe(150);
    // 最大定員が資料で確認できない機種はゲーム上の上限（推定）として扱う
    expect(maxSeatsOf('B777-300ER')).toEqual({ max: Math.round(370 * 1.25), official: false });
    expect(maxSeatsOf('A380-800')).toEqual({ max: 853, official: true });
  });

  it('機材変更: 保有機材の機種にだけ変えられ、旅客定員が計画に反映される', () => {
    const c = createCareerCompany();
    const k = Object.values(c.contracts).find((x) => x.airlineId === 'HB')!;
    expect(changeContractAircraft(c, k.id, 'A380-800')).toEqual({ ok: false, reason: 'NOT_IN_FLEET' });
    const before = planDay(c, 0).flights.find((f) => f.contractId === k.id)!.seats;
    expect(changeContractAircraft(c, k.id, 'regional70')).toEqual({ ok: true });
    const after = planDay(c, 0).flights.find((f) => f.contractId === k.id)!.seats;
    expect(before).toBe(184);
    expect(after).toBe(70);
  });

  it('旧形式の保存データ（保有機材なし）は汎用機材のまま読み込み、実機種に置き換えない', () => {
    const old = createCompany('career', 'old') as Partial<CompanyState> & Record<string, unknown>;
    addContract(old as CompanyState, { airlineId: 'SK', destinationId: 'TWN', typeId: 'narrow180', perDay: 2, window: 'any', feeDiscount: 0, startDay: 0, endDay: 9, status: 'active', offerExpiresDay: 0 });
    delete old.fleets;
    const c = importCompany(JSON.stringify(old))!;
    expect(Object.values(c.contracts)[0]!.typeId).toBe('narrow180');
    expect(c.fleets.SK!.some((e) => e.typeId === 'narrow180')).toBe(true);
  });

  it('保存時の機種データ（スナップショット）で機種テーブルを作れる（カタログの更新に影響されない）', () => {
    const snap = structuredClone(CATALOG);
    snap['B777-300ER']!.defaultSeats = 999;
    const pinned = buildTypeTable(snap);
    expect(pinned['B777-300ER']!.seats).toBe(999);
    expect(AIRCRAFT_TYPES['B777-300ER']!.seats).toBe(370);
  });
});

// ---------------------------------------------------------------- 天候・障害

describe('天候・障害と対応', { timeout: 120_000 }, () => {
  const sample = createSampleAirport();
  const lStand = Object.values(sample.stands).find((s) => s.size === 'L')!.id;

  it('スポットの閉鎖: 割り当て済みの到着機は別のスポットに割り当て直され、閉鎖中のスポットには入らない', () => {
    const sim = createSimulation(sample, { settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60);
    run(sim, () => ac.standId !== null, 3600);
    const first = ac.standId!;
    const d = addDisruption(sim, { kind: 'standClosed', targetId: first, end: null });
    expect(ac.standId).toBeNull();
    run(sim, () => ac.state === 'parked', 3 * 3600);
    expect(ac.standId).not.toBe(first);
    expect(d.affected.flights).toContain(ac.arrivalFlightId);
  });

  it('滑走路の一時閉鎖: 閉鎖中は着陸せず待機し、復旧後に着陸する', () => {
    const sim = createSimulation(sample, { settings: manual });
    const rwy = Object.keys(sample.runways)[0]!;
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60);
    const d = addDisruption(sim, { kind: 'runwayClosed', targetId: rwy, end: sim.state.now + 30 * 60 });
    expect(sim.state.runwayConfig[rwy]!.mode).toBe('closed');
    run(sim, () => ac.state === 'parked', 3 * 3600);
    expect(sim.state.flights[ac.arrivalFlightId]!.actual!).toBeGreaterThanOrEqual(d.end!);
    expect(sim.state.runwayConfig[rwy]!.mode).toBe('mixed');
  });

  it('作業員の欠勤: 作業は「作業員不足」で止まり、修理（復帰）すると再開して出発する。費用が計上される', () => {
    const c = createCompany('sandbox');
    const sim = createSimulation(sample, { settings: manual, company: c });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60);
    run(sim, () => ac.state === 'parked', 3600);
    const staff = Object.values(sim.state.units).filter((u) => u.kind === 'staff').length;
    const d = addDisruption(sim, { kind: 'staffAbsence', targetId: null, amount: staff, end: null });
    run(sim, () => tasksOf(sim.state, ac.id).some((t) => t.blockedReason === 'noStaff'), 3600);
    expect(ac.state).not.toBe('departed');
    const cash = c.cash;
    expect(resolveDisruption(sim, d.id)).toBe(true);
    expect(c.cash).toBeLessThan(cash);
    expect(c.today.disruption).toBeLessThan(0);
    run(sim, () => ac.state === 'departed', 6 * 3600);
  });

  it('搭乗ゲートの故障: 故障中のゲートでは搭乗できず、締切で乗り遅れになる', () => {
    const sim = createSimulation(sample, { settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { departureAt: sim.state.now + 3 * 3600 });
    run(sim, () => ac.state === 'parked', 3600);
    const dep = sim.state.flights[ac.departureFlightId]!;
    addDepartureGroup(sim, dep.id, 4, sim.state.now + 60);
    const gate = sim.ctx.standGate[ac.standId!]!;
    addDisruption(sim, { kind: 'gateFailure', targetId: gate, end: null });
    run(sim, () => dep.pax.boarding === 'closed', 6 * 3600);
    // 自動で生成された予約客と追加した4人の全員が乗れない
    expect(dep.pax.boarded).toBe(0);
    expect(dep.pax.missed).toBe(dep.pax.booked);
    expect(dep.pax.booked).toBeGreaterThanOrEqual(4);
  });

  it('霧: 離着陸の間隔が広がり、連続する到着の着陸間隔が長くなる', () => {
    const gap = (weather: boolean) => {
      const sim = createSimulation(sample, { settings: manual });
      if (weather) addDisruption(sim, { kind: 'weather', targetId: null, weather: 'fog', end: null });
      const a = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60);
      const b = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60 + 30);
      const landed = (x: typeof a) => sim.state.flights[x.arrivalFlightId]!.actual !== null;
      run(sim, () => landed(a) && landed(b), 3 * 3600);
      return Math.abs(sim.state.flights[b.arrivalFlightId]!.actual! - sim.state.flights[a.arrivalFlightId]!.actual!);
    };
    expect(gap(true)).toBeGreaterThan(gap(false));
  });

  it('代替スポットへの変更: 適合しない・閉鎖中のスポットには変えられず、適合するスポットには変えられる', () => {
    const sim = createSimulation(sample, { settings: manual });
    const a380 = addTurnaround(sim, 'A380-800', sim.state.now + 30 * 60);
    expect(reassignStand(sim, a380.id, lStand)).toEqual({ ok: false, reason: 'INCOMPATIBLE' });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 30 * 60);
    addDisruption(sim, { kind: 'standClosed', targetId: lStand, end: null });
    expect(reassignStand(sim, ac.id, lStand)).toEqual({ ok: false, reason: 'CLOSED' });
    const m = Object.values(sample.stands).find((s) => s.size === 'M')!.id;
    expect(reassignStand(sim, ac.id, m)).toEqual({ ok: true });
    run(sim, () => ac.state === 'parked', 3 * 3600);
    expect(ac.standId).toBe(m);
    expect(prioritize(sim, ac.id, true)).toEqual({ ok: true });
  });

  it('需要の急増: 予約数が増える（座席数が上限）', () => {
    const booked = (surge: boolean) => {
      const sim = createSimulation(sample, { settings: manual });
      if (surge) addDisruption(sim, { kind: 'demandSurge', targetId: null, amount: 1.5, end: null });
      const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { departureAt: sim.state.now + 3.5 * 3600 });
      const dep = sim.state.flights[ac.departureFlightId]!;
      run(sim, () => dep.pax.generated, 3 * 3600);
      return dep.pax.booked;
    };
    const base = booked(false);
    const surged = booked(true);
    expect(surged).toBeGreaterThan(base);
    expect(surged).toBeLessThanOrEqual(180);
  });
});

describe('機種カタログの拡充（2026.11.0）', () => {
  it('日本で運航されている主な機種を、派生型を区別して収録している', () => {
    for (const id of ['B737-8', 'B767-300', 'B767-300ER', 'B777-200', 'B777-200ER', 'B787-8', 'B787-9', 'B787-10', 'A321-200', 'A321neo', 'A350-900', 'A350-1000', 'E175', 'E190', 'ATR42-600', 'ATR72-600']) {
      expect(CATALOG[id], id).toBeDefined();
      expect(CATALOG[id]!.generic).toBe(false);
    }
    // 名前が似た派生型は別の機種で、値も異なる
    expect(CATALOG['B787-8']!.lengthM.value).not.toBe(CATALOG['B787-10']!.lengthM.value);
    expect(CATALOG['B767-300']!.mtowKg.value).not.toBe(CATALOG['B767-300ER']!.mtowKg.value);
    expect(CATALOG['A350-900']!.maxPax.value).not.toBe(CATALOG['A350-1000']!.maxPax.value);
  });

  it('追加した機種の公式値にはすべて出典があり、確認できなかった値は未設定のまま', () => {
    for (const m of AIRCRAFT_MODELS.filter((x) => x.updated === '2026-11-10')) {
      for (const v of [m.lengthM, m.wingspanM, m.heightM, m.mtowKg, m.maxPax, m.typicalSeats, m.cargoM3, m.fuelL]) {
        if (v.status === 'official') expect(DATA_SOURCES[v.source!], `${m.id}`).toBeDefined();
        if (v.status === 'unset') expect(v.value).toBeNull();
      }
      expect(m.lengthM.status).toBe('official');
      expect(m.wingspanM.status).toBe('official');
    }
    expect(CATALOG['ATR72-600']!.heightM.status).toBe('unset');
  });

  it('翼幅からゲームの区分が決まる: ターボプロップ・リージョナルジェットは M、767・787 は L（コード F ではない）', () => {
    const t = buildTypeTable();
    for (const id of ['ATR42-600', 'ATR72-600', 'E175', 'E190', 'A321neo', 'B737-8']) expect(t[id]!.size, id).toBe('M');
    for (const id of ['B767-300ER', 'B787-8', 'B787-10', 'B777-200', 'A350-1000']) {
      expect(t[id]!.size, id).toBe('L');
      expect(t[id]!.codeF, id).toBe(false);
    }
  });
});
