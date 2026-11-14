import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core/model/types';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany, createCareerCompany } from '../../src/core/economy/company';
import { exportLayout } from '../../src/core/io/serialize';
import {
  buildProject,
  effectiveModels,
  restoreSimulation,
  serializeProject,
  validateProject,
  PROJECT_FORMAT_VERSION,
  PROJECT_FORMAT_VERSION_3,
  type ProjectFile,
} from '../../src/core/io/project';
import { CATALOG, CATALOG_VERSION } from '../../src/core/aircraft/catalog';
import { addTurnaround, createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { addDepartureGroup } from '../../src/core/sim/passengers';
import { checkInvariants } from '../../src/core/sim/invariants';
import { createScenario, catalogDiff, SIM_MODEL_VERSION } from '../../src/core/scenario/scenario';
import { buildTypeTable } from '../../src/core/sim/aircraftTypes';
import { placeFacility } from '../../src/core/layout/operations';

const NOW = '2026-11-10T00:00:00Z';
const opts = { fallbackCompany: createSandboxCompany() };

function baseProject(extra: Partial<Parameters<typeof buildProject>[0]> = {}): ProjectFile {
  return buildProject({ name: 'テスト', savedAt: NOW, layout: createSampleAirport(), company: createSandboxCompany(), pin: null, scenarios: [], sim: null, ...extra });
}

describe('プロジェクトの保存形式', () => {
  it('段差なし経路設定を運航セーブで保存・復元し、不正な値を拒否する', () => {
    const sim = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    const standId = Object.keys(sim.ctx.layout.stands).sort()[0]!;
    const aircraft = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, {
      departureAt: sim.state.now + 3 * 3600,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 100, depPax: 100, standId, seats: 180 },
    });
    const departure = sim.state.flights[aircraft.departureFlightId]!;
    const group = addDepartureGroup(sim, departure.id, 2, sim.state.now, 0, { stepFree: true })!;
    const project = buildProject({
      name: 'step-free', savedAt: NOW, layout: sim.ctx.layout, company: createSandboxCompany(), pin: null, scenarios: [], sim,
    });

    const restored = validateProject(serializeProject(project), opts);
    expect(restored.errors).toEqual([]);
    const simulation = restoreSimulation(
      restored.project!.layout,
      restored.project!.sim!,
      effectiveModels(restored.project!.catalog),
    ).sim;
    expect(simulation.state.paxGroups[group.id]?.stepFree).toBe(true);

    const malformed = JSON.parse(serializeProject(project)) as {
      sim: { state: { paxGroups: Record<string, Record<string, unknown>> } };
    };
    malformed.sim.state.paxGroups[group.id]!.stepFree = 'yes';
    expect(validateProject(JSON.stringify(malformed), opts).errors).toContain(
      `運航状態: 旅客グループ ${group.id} の段差なし経路設定が不正です`,
    );
    malformed.sim.state.paxGroups[group.id]!.stepFree = true;
    malformed.sim.state.paxGroups[group.id]!.terminalLinkReservedHour = -1;
    expect(validateProject(JSON.stringify(malformed), opts).errors).toContain(
      `運航状態: 旅客グループ ${group.id} の連絡設備予約時刻が不正です`,
    );
  });

  it('建物内設備の親・階情報を保存して復元する', () => {
    const layout = createSampleAirport();
    const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!;
    const placed = placeFacility(layout, 'baggageSort', terminal.origin, { parentFacilityId: terminal.id, floorIndex: -1 });
    expect(placed.ok).toBe(true);
    if (!placed.ok) throw new Error('建物内施設を配置できませんでした');
    const p = baseProject({ layout: placed.layout });
    expect(p.formatVersion).toBe(PROJECT_FORMAT_VERSION_3);
    const restored = validateProject(serializeProject(p), opts);
    expect(restored.ok).toBe(true);
    const facility = Object.values(restored.project!.layout.facilities).find((f) => f.parentFacilityId === terminal.id);
    expect(facility).toMatchObject({ kind: 'baggageSort', parentFacilityId: terminal.id, floorIndex: -1 });

    const legacy = JSON.parse(serializeProject(p)) as ProjectFile;
    legacy.formatVersion = PROJECT_FORMAT_VERSION;
    legacy.versions.format = PROJECT_FORMAT_VERSION;
    const migrated = validateProject(serializeProject(legacy), opts);
    expect(migrated.ok).toBe(true);
    expect(migrated.project?.formatVersion).toBe(PROJECT_FORMAT_VERSION_3);
    expect(migrated.warnings.some((warning) => warning.includes('版 3 に移行'))).toBe(true);

    const withLevelledRoad = structuredClone(legacy);
    const roadNode = Object.values(withLevelledRoad.layout.roadNodes)[0]!;
    roadNode.level = 0;
    expect(validateProject(serializeProject(withLevelledRoad), opts).errors.some((error) => error.includes('版 3'))).toBe(true);
  });

  it('独立した階層施設も保存形式 3 として扱う', () => {
    const layout = createSampleAirport();
    const maintenance = Object.values(layout.facilities).find((f) => f.kind === 'maintenance')!;
    maintenance.mapLevel = -1;
    expect(baseProject({ layout }).formatVersion).toBe(PROJECT_FORMAT_VERSION_3);
  });

  it('保存 → 読み込みで同じ内容に戻り、4 つの版（保存形式・カタログ・アセット・シミュレーション）を別々に持つ', () => {
    const p = baseProject({ scenarios: [createScenario({ id: 'sc_1', name: '基準', createdAt: NOW, layout: createSampleAirport(), company: createSandboxCompany(), seed: 's', durationHours: 2 })] });
    expect(p.versions).toEqual({ format: PROJECT_FORMAT_VERSION, layoutSchema: SCHEMA_VERSION, catalog: CATALOG_VERSION, assets: expect.any(String), simModel: SIM_MODEL_VERSION });
    // 使っている機種だけを保存時の値で持つ
    expect(Object.keys(p.catalog.models)).toContain('B777-300ER');
    expect(p.assets.refs['B777-300ER']).toBe('proc-wide-777');
    const r = validateProject(serializeProject(p), opts);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.project!.layout).toEqual(p.layout);
    expect(r.project!.company).toEqual(p.company);
    expect(r.project!.scenarios).toHaveLength(1);
    // 保存 → 読み込み → 保存 を繰り返しても変わらない
    let json = serializeProject(p);
    for (let i = 0; i < 5; i++) json = serializeProject(validateProject(json, opts).project!);
    expect(JSON.parse(json)).toEqual(JSON.parse(serializeProject(r.project!)));
  });

  it('運航中の状態を保存して復元し、続きを進めると、中断しなかった場合と同じ結果になる', { timeout: 120_000 }, () => {
    const a = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    for (let i = 0; i < 3 * 3600; i++) stepSimulation(a);
    const p = buildProject({ name: 'x', savedAt: NOW, layout: a.ctx.layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: a });
    const r = validateProject(serializeProject(p), opts);
    expect(r.errors).toEqual([]);
    const { sim: b, violations } = restoreSimulation(r.project!.layout, r.project!.sim!, effectiveModels(r.project!.catalog));
    expect(violations).toEqual([]);
    expect(b.state.now).toBe(a.state.now);
    for (let i = 0; i < 2 * 3600; i++) {
      stepSimulation(a);
      stepSimulation(b);
    }
    expect(checkInvariants(b)).toEqual([]);
    expect(b.state.stats).toEqual(a.state.stats);
    expect(b.state.analytics.records).toEqual(a.state.analytics.records);
    expect(b.company!.cash).toBe(a.company!.cash);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });

  it('保存時の機種データで動き、カタログが変わっても黙って変わらない。最新カタログとの差分を出せる', () => {
    const p = baseProject();
    p.catalog.models['B777-300ER']!.defaultSeats = 290;
    p.catalog.version = '2025.01.0';
    const r = validateProject(serializeProject(p), opts);
    expect(r.ok).toBe(true);
    expect(r.project!.catalog.version).toBe('2025.01.0');
    expect(r.warnings.some((w) => w.includes('2025.01.0'))).toBe(true);
    const types = buildTypeTable(effectiveModels(r.project!.catalog));
    expect(types['B777-300ER']!.seats).toBe(290);
    expect(CATALOG['B777-300ER']!.defaultSeats).toBe(370);
    expect(catalogDiff(r.project!.catalog.models).some((d) => d.id === 'B777-300ER' && d.field === 'defaultSeats')).toBe(true);
  });

  it('旧形式のレイアウトファイルを移行する（会社は現在のもの、汎用機材は汎用のまま）', () => {
    const career = createCareerCompany();
    const r = validateProject(exportLayout(createSampleAirport()), { fallbackCompany: career });
    expect(r.ok).toBe(true);
    expect(r.migratedFrom).toBe('skyport-layout');
    expect(r.project!.company.cash).toBe(career.cash);
    // 旧 v1 レイアウト（ターミナル内部なし）も移行できる
    const v1 = JSON.parse(exportLayout(createSampleAirport()));
    v1.schemaVersion = 1;
    delete v1.layout.terminalAreas;
    v1.layout.schemaVersion = 1;
    expect(validateProject(JSON.stringify(v1), opts).project!.layout.terminalAreas).toEqual({});
  });

  it('旧版の会社データ（保有機材の設定なし・汎用機材の契約）は汎用機材のまま移行する', () => {
    const p = baseProject();
    const c = p.company as unknown as Record<string, unknown>;
    delete c.fleets;
    const k = Object.values(p.company.contracts)[0]!;
    k.typeId = 'narrow180';
    const r = validateProject(serializeProject(p), opts);
    expect(r.ok).toBe(true);
    expect(r.project!.company.contracts[k.id]!.typeId).toBe('narrow180');
    expect(r.project!.company.fleets[k.airlineId]!.some((e) => e.typeId === 'narrow180')).toBe(true);
  });

  it('不明な機種 ID は警告し、未解決の機種として読み込む', () => {
    const p = baseProject();
    Object.values(p.company.contracts)[0]!.typeId = 'XX-999';
    const r = validateProject(serializeProject(p), opts);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('XX-999'))).toBe(true);
  });
});

describe('壊れたファイル・不正なファイルは読み込まない（エラーの内容を返す）', () => {
  const good = () => JSON.parse(serializeProject(baseProject())) as Record<string, unknown> & ProjectFile;
  const cases: [string, (d: ReturnType<typeof good>) => unknown, RegExp][] = [
    ['JSON でない', () => '{ broken', /JSON/],
    ['別形式', (d) => ({ ...d, format: 'other' }), /format/],
    ['新しい版', (d) => ({ ...d, formatVersion: 99 }), /新しい版/],
    ['名前なし', (d) => ({ ...d, name: 3 }), /name/],
    ['レイアウトなし', (d) => ({ ...d, layout: null }), /レイアウト/],
    ['敷地が不正', (d) => ({ ...d, layout: { ...d.layout, site: { ...d.layout.site, terrain: [1, 2] } } }), /敷地/],
    ['ID の不一致', (d) => {
      const id = Object.keys(d.layout.stands)[0]!;
      d.layout.stands[id]!.id = 'std_x';
      return d;
    }, /ID が一致/],
    ['ID の重複', (d) => {
      const [id, st] = Object.entries(d.layout.stands)[0]!;
      (d.layout.facilities as Record<string, unknown>)[id] = { ...st, kind: 'hangar' };
      return d;
    }, /重複/],
    ['参照切れ（誘導路の端点）', (d) => {
      Object.values(d.layout.taxiways)[0]!.from = 'tn_missing';
      return d;
    }, /端点/],
    ['会社の型が不正', (d) => ({ ...d, company: { ...d.company, cash: 'many' } }), /会社/],
    ['機種データが不正', (d) => {
      (d.catalog.models['B777-300ER'] as unknown as Record<string, unknown>).lengthM = 'long';
      return d;
    }, /機種データ/],
    ['シナリオの ID 重複', (d) => {
      const sc = createScenario({ id: 'sc_1', name: 'a', createdAt: NOW, layout: createSampleAirport(), company: createSandboxCompany(), seed: 's', durationHours: 1 });
      return { ...d, scenarios: [sc, { ...sc }] };
    }, /重複/],
  ];
  for (const [name, mutate, re] of cases) {
    it(name, () => {
      const m = mutate(good());
      const r = validateProject(typeof m === 'string' ? m : JSON.stringify(m), opts);
      expect(r.ok).toBe(false);
      expect(r.project).toBeNull();
      expect(r.errors.join('\n')).toMatch(re);
    });
  }

  it('運航状態の不整合（存在しないスポット・同じスポットに 2 機）は読み込まない', { timeout: 60_000 }, () => {
    const a = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    for (let i = 0; i < 4 * 3600; i++) stepSimulation(a);
    const p = JSON.parse(serializeProject(buildProject({ name: 'x', savedAt: NOW, layout: a.ctx.layout, company: a.company!, pin: null, scenarios: [], sim: a }))) as ProjectFile;
    const parked = Object.values(p.sim!.state.aircraft).find((x) => x.standId);
    expect(parked).toBeDefined();
    const bad1 = structuredClone(p);
    bad1.sim!.state.aircraft[parked!.id]!.standId = 'std_missing';
    expect(validateProject(JSON.stringify(bad1), opts).errors.join()).toMatch(/スポット/);
    const bad2 = structuredClone(p);
    const others = Object.values(bad2.sim!.state.aircraft).filter((x) => x.id !== parked!.id && x.state === 'parked');
    if (others[0]) {
      others[0].standId = parked!.standId;
      const r = validateProject(JSON.stringify(bad2), opts);
      expect(r.ok).toBe(false);
    }
  });

  it('シミュレーションの版が違う運航状態は復元せず、建設モードで開く（警告）', () => {
    const a = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    for (let i = 0; i < 600; i++) stepSimulation(a);
    const p = JSON.parse(serializeProject(buildProject({ name: 'x', savedAt: NOW, layout: a.ctx.layout, company: a.company!, pin: null, scenarios: [], sim: a }))) as ProjectFile;
    p.versions.simModel = 'skyport-sim-0.1';
    const r = validateProject(JSON.stringify(p), opts);
    expect(r.ok).toBe(true);
    expect(r.project!.sim).toBeNull();
    expect(r.warnings.join()).toMatch(/シミュレーションの版/);
  });
});
