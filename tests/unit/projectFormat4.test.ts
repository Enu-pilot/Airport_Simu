import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../src/core/economy/company';
import { defaultCity, defaultCityNightOps, isCityNightOps } from '../../src/core/economy/city';
import {
  PROJECT_FORMAT_MAX_READABLE,
  PROJECT_FORMAT_VERSION,
  PROJECT_FORMAT_VERSION_3,
  PROJECT_FORMAT_VERSION_4,
  buildProject,
  formatVersionOf,
  serializeProject,
  validateProject,
} from '../../src/core/io/project';
import { updateEntity, updateLayoutSettings } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addRoadPath } from '../../src/core/layout/operations';
import { must } from './helpers';

const NOW = '2026-11-17T00:00:00Z';
const opts = { fallbackCompany: createSandboxCompany() };
const build = (layout = createSampleAirport(), company = createSandboxCompany()) =>
  buildProject({ name: 't', savedAt: NOW, layout, company, pin: null, scenarios: [], sim: null });
const cityCompany = (nightOps = true) => {
  const c = createSandboxCompany();
  c.city = defaultCity('core');
  if (nightOps) c.city.nightOps = defaultCityNightOps();
  return c;
};
/** 版 3 までしか知らない読み手（フェーズ 2 より前のアプリ）の判定 */
const legacyReaderAccepts = (fv: number) => fv >= 1 && fv <= 3;

describe('フェーズ 2: 保存形式 4 は新しい項目を使うときだけ', () => {
  it('新しい設定を使わない保存は従来の版のまま（1 と 3）で、バイト列が変わらない', () => {
    const plain = build();
    expect(plain.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(JSON.stringify(plain)).not.toContain('taxiMode');
    const withCityNoNight = build(createSampleAirport(), cityCompany(false));
    expect(withCityNoNight.formatVersion).toBe(2);
    const v3 = build(must(addRoadPath(createSampleAirport(), [{ x: 12, y: 12 }, { x: 18, y: 12 }], { roadClass: 'walkway', level: -1, capacityPerHour: 500 })).layout);
    expect(v3.formatVersion).toBe(PROJECT_FORMAT_VERSION_3);
    for (const p of [plain, withCityNoNight, v3]) expect(legacyReaderAccepts(p.formatVersion)).toBe(true);
  });

  it('taxiMode block・city.nightOps のどちらかがあると 4。戻す（キーを消す）と元の版に戻る', () => {
    let l = createSampleAirport();
    l = must(updateLayoutSettings(l, { taxiMode: 'block' })).layout;
    expect(build(l).formatVersion).toBe(PROJECT_FORMAT_VERSION_4);
    expect(build(createSampleAirport(), cityCompany(true)).formatVersion).toBe(PROJECT_FORMAT_VERSION_4);
    l = must(updateLayoutSettings(l, { taxiMode: 'full' })).layout;
    expect(build(l).formatVersion).toBe(PROJECT_FORMAT_VERSION);
  });

  it('taxiBlockTiles だけ・blockMaxAircraft だけでは従来方式の運航に影響しないので版は上がらない', () => {
    let l = must(updateLayoutSettings(createSampleAirport(), { taxiBlockTiles: 20 })).layout;
    expect(build(l).formatVersion).toBe(PROJECT_FORMAT_VERSION);
    l = must(updateEntity(l, Object.keys(l.taxiways).sort()[0]!, { blockMaxAircraft: 2 })).layout;
    expect(build(l).formatVersion).toBe(PROJECT_FORMAT_VERSION);
  });

  it('運航状態の taxiBlocks・便の nightHold・運航中の会社の nightOps・シナリオも 4 にする', () => {
    const p = build();
    const state = { flights: {} } as never;
    const sim = (s: Record<string, unknown>, company: ReturnType<typeof createSandboxCompany> | null = null) =>
      ({ layout: p.layout, company: p.company, scenarios: [], sim: { state: { flights: {}, ...s } as never, company } });
    expect(formatVersionOf(sim({}))).toBe(PROJECT_FORMAT_VERSION);
    void state;
    expect(formatVersionOf(sim({ taxiBlocks: { occ: {}, locks: {}, stats: { resolutions: 0, reroutes: 0, overruns: 0, unresolved: 0, nightStranded: 0 } } }))).toBe(PROJECT_FORMAT_VERSION_4);
    expect(formatVersionOf(sim({ flights: { f1: { id: 'f1', nightHold: { kind: 'stand', decidedAt: 1, releaseAt: 2 } } } }))).toBe(PROJECT_FORMAT_VERSION_4);
    expect(formatVersionOf(sim({}, cityCompany(true)))).toBe(PROJECT_FORMAT_VERSION_4);
    const sc = { id: 's', name: 's', layout: createSampleAirport(), company: cityCompany(true) } as never;
    expect(formatVersionOf({ ...p, scenarios: [sc] })).toBe(PROJECT_FORMAT_VERSION_4);
  });

  it('版 4 のファイルは今のアプリで往復でき、版 3 までしか読めない読み手には拒否される', () => {
    const l = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block', taxiBlockTiles: 14 })).layout;
    const p = build(l, cityCompany(true));
    expect(p.formatVersion).toBe(4);
    expect(p.versions.format).toBe(4);
    expect(legacyReaderAccepts(p.formatVersion)).toBe(false);
    expect(PROJECT_FORMAT_MAX_READABLE).toBe(9); // 保存形式 9（搭乗橋 PBB、機能H）の項目まで読める
    const r = validateProject(serializeProject(p), opts);
    expect(r.errors).toEqual([]);
    expect(r.project!.formatVersion).toBe(4);
    expect(r.project!.layout.taxiMode).toBe('block');
    expect(r.project!.company.city!.nightOps).toEqual(defaultCityNightOps());
    // 再保存しても版 4 のまま、設定は変わらない
    const again = buildProject({ name: 't', savedAt: NOW, layout: r.project!.layout, company: r.project!.company, pin: null, scenarios: [], sim: null });
    expect(again.formatVersion).toBe(4);
    expect(again.layout).toEqual(p.layout);
    expect(again.company.city).toEqual(p.company.city);
  });

  it('読める最大の版より新しい版は拒否する。版 1〜3 を名乗るのに版 4 の項目があるファイルも拒否する（日本語のメッセージ）', () => {
    const l = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block' })).layout;
    const p4 = build(l);
    // 読める最大の版 + 1 で確かめる（projectFormat2 と同じ流儀。版が上がっても意図は変わらない）
    const tooNew = validateProject(JSON.stringify({ ...p4, formatVersion: PROJECT_FORMAT_MAX_READABLE + 1 }), opts);
    expect(tooNew.ok).toBe(false);
    expect(tooNew.errors.join('\n')).toMatch(/新しい版/);
    for (const fv of [1, 2, 3]) {
      const r = validateProject(JSON.stringify({ ...p4, formatVersion: fv, versions: { ...p4.versions, format: fv } }), opts);
      expect(r.ok).toBe(false);
      expect(r.errors.join('\n')).toMatch(/版 4/);
    }
    const night = build(createSampleAirport(), cityCompany(true));
    const r = validateProject(JSON.stringify({ ...night, formatVersion: 3, versions: { ...night.versions, format: 3 } }), opts);
    expect(r.ok).toBe(false);
  });

  it('版 4 を名乗るが新しい項目を使わないファイルは、再保存で従来の版に戻る', () => {
    const p = build();
    const r = validateProject(JSON.stringify({ ...p, formatVersion: 4, versions: { ...p.versions, format: 4 } }), opts);
    expect(r.errors).toEqual([]);
    expect(r.project!.formatVersion).toBe(PROJECT_FORMAT_VERSION);
  });
});

describe('フェーズ 2: nightOps と taxi 設定の読み込み検証', () => {
  it('isCityNightOps: 既定値は有効。範囲の端は有効、外・小数・型違いは無効', () => {
    const d = defaultCityNightOps();
    expect(isCityNightOps(d)).toBe(true);
    for (const [k, vals] of [['departureCutoffMin', [1200, 1305]], ['airborneHoldMaxMin', [0, 120]], ['warnLeadMin', [0, 120]]] as const) {
      for (const v of vals) expect(isCityNightOps({ ...d, [k]: v })).toBe(true);
    }
    for (const [k, vals] of [['departureCutoffMin', [1199, 1306, 1275.5, '1275']], ['airborneHoldMaxMin', [-1, 121]], ['warnLeadMin', [-1, 121, Number.NaN]]] as const) {
      for (const v of vals) expect(isCityNightOps({ ...d, [k]: v })).toBe(false);
    }
    expect(isCityNightOps({ ...d, inboundPolicy: 'divert' })).toBe(false);
    expect(isCityNightOps({ ...d, prioritizeAtRisk: 'no' })).toBe(false);
    expect(isCityNightOps({ ...d, version: 2 })).toBe(false);
    expect(isCityNightOps(null)).toBe(false);
    expect(isCityNightOps([])).toBe(false);
  });

  it('不正な nightOps を持つファイルは読み込みエラー（今のプロジェクトは変えない）', () => {
    const p = build(createSampleAirport(), cityCompany(true));
    const bad = structuredClone(p);
    bad.company.city!.nightOps!.departureCutoffMin = 1000;
    const r = validateProject(JSON.stringify(bad), opts);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/nightOps/);
    expect(r.project).toBeNull();
  });

  it('不正な taxiMode・taxiBlockTiles・blockMaxAircraft を持つファイルは読み込みエラー', () => {
    const l = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block' })).layout;
    const id = Object.keys(l.taxiways).sort()[0]!;
    for (const mutate of [
      (x: typeof l) => { (x as unknown as Record<string, unknown>).taxiMode = 'full'; },
      (x: typeof l) => { x.taxiBlockTiles = 41; },
      (x: typeof l) => { x.taxiways[id]!.blockMaxAircraft = 11; },
    ]) {
      const bad = structuredClone(build(l));
      mutate(bad.layout);
      const r = validateProject(JSON.stringify(bad), opts);
      expect(r.ok).toBe(false);
      expect(r.errors.join('\n')).toMatch(/taxiMode|taxiBlockTiles|blockMaxAircraft/);
    }
  });
});
