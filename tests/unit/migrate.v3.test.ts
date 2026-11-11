import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany } from '../../src/core/economy/company';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { migrateLayout } from '../../src/core/io/migrate';
import { buildProject, serializeProject, validateProject, checkLayout, type ProjectFile } from '../../src/core/io/project';
import { SCHEMA_VERSION, type AirportLayout, type RunwayFree } from '../../src/core/model/types';

const opts = { fallbackCompany: createSandboxCompany() };

const freeRunway = (over: Partial<RunwayFree> = {}): RunwayFree => ({
  id: 'rwy_9',
  name: 'F',
  alignment: 'free',
  start: { x: 10.25, y: 20.5 },
  headingDeg: 37.5,
  lengthM: 2345.678,
  surfaceWidthM: 45,
  buildState: 'operational',
  dims: { shoulderWidthM: 7.5 },
  designatorSuffix: 'L',
  ...over,
});

const withFree = (over: Partial<RunwayFree> = {}): AirportLayout => {
  const l = createSampleAirport();
  l.runways.rwy_9 = freeRunway(over);
  l.magneticVariationDeg = -7.5;
  l.ruleSet = 'realistic';
  return l;
};

const projectJson = (l: AirportLayout): string => serializeProject(buildProject({ name: 'x', savedAt: '', layout: l, company: createSandboxCompany(), pin: null, scenarios: [], sim: null }));

describe('レイアウトの版 3（v2 → v3 は恒等）', () => {
  it('SCHEMA_VERSION は 3 で、新規レイアウトは 3 を書く', () => {
    expect(SCHEMA_VERSION).toBe(3);
    expect(createSampleAirport().schemaVersion).toBe(3);
  });

  it('migrateLayout は v2 を何も書き換えない（layout.schemaVersion も 2 のまま）', () => {
    const v2 = structuredClone(createSampleAirport()) as AirportLayout;
    v2.schemaVersion = 2;
    const before = structuredClone(v2);
    migrateLayout(v2, 2);
    expect(v2).toEqual(before);
    migrateLayout(v2, 3);
    expect(v2).toEqual(before);
  });

  it('v2 のレイアウトファイル・プロジェクトファイルが読め、内容が変わらない（旧データ → v3 は恒等）', () => {
    const v2 = createSampleAirport();
    v2.schemaVersion = 2;
    const file = JSON.stringify({ format: 'skyport-layout', schemaVersion: 2, layout: v2 });
    expect(importLayout(file)).toEqual(v2);
    const p = JSON.parse(projectJson(v2)) as ProjectFile;
    p.versions.layoutSchema = 2;
    const r = validateProject(JSON.stringify(p), opts);
    expect(r.errors).toEqual([]);
    expect(r.project!.layout).toEqual(v2);
  });

  it('新しい項目が未設定の従来レイアウトは、JSON に新しいキーを書かない（バイト列が増えない）', () => {
    const json = exportLayout(createSampleAirport());
    for (const k of ['alignment', 'headingDeg', 'lengthM', 'dims', 'designatorSuffix', 'magneticVariationDeg', 'ruleSet']) expect(json).not.toContain(`"${k}"`);
  });

  it('自由形入りレイアウトは v3 で往復でき、実数がそのまま戻る', () => {
    const l = withFree();
    expect(importLayout(exportLayout(l))).toEqual(l);
    const r = validateProject(projectJson(l), opts);
    expect(r.errors).toEqual([]);
    expect(r.project!.layout).toEqual(l);
    expect((r.project!.layout.runways.rwy_9 as RunwayFree).lengthM).toBe(2345.678);
  });

  it('旧アプリ向けの上限: レイアウトファイル・プロジェクトの版が SCHEMA_VERSION を超えると拒否する', () => {
    expect(() => importLayout(JSON.stringify({ format: 'skyport-layout', schemaVersion: 4, layout: createSampleAirport() }))).toThrow();
    const p = JSON.parse(projectJson(createSampleAirport())) as ProjectFile;
    p.versions.layoutSchema = SCHEMA_VERSION + 1;
    expect(validateProject(JSON.stringify(p), opts).ok).toBe(false);
  });
});

describe('checkLayout: 新しい項目だけの検査', () => {
  const errs = (l: AirportLayout) => checkLayout(l);
  it('妥当な自由形は通る', () => {
    expect(errs(withFree())).toEqual([]);
  });
  it('未知の alignment は拒否する', () => {
    const l = withFree();
    (l.runways.rwy_9 as unknown as { alignment: string }).alignment = 'curved';
    expect(errs(l).join()).toContain('未対応の形式');
  });
  it('不正な値を拒否する', () => {
    expect(errs(withFree({ headingDeg: 360 })).join()).toContain('headingDeg');
    expect(errs(withFree({ headingDeg: -1 })).join()).toContain('headingDeg');
    expect(errs(withFree({ headingDeg: NaN })).join()).toContain('headingDeg');
    expect(errs(withFree({ lengthM: 0 })).join()).toContain('lengthM');
    expect(errs(withFree({ lengthM: Infinity })).join()).toContain('lengthM');
    expect(errs(withFree({ lengthM: 10 })).join()).toContain('lengthM');
    expect(errs(withFree({ start: { x: NaN, y: 0 } })).join()).toContain('始点');
    expect(errs(withFree({ surfaceWidthM: 50 as 45 })).join()).toContain('舗装幅');
    expect(errs(withFree({ dims: { resaLengthM: -1 } })).join()).toContain('dims.resaLengthM');
    expect(errs(withFree({ dims: { holdingPositionM: NaN } })).join()).toContain('dims.holdingPositionM');
    expect(errs(withFree({ designatorSuffix: 'X' as 'L' })).join()).toContain('designatorSuffix');
  });
  it('従来形の滑走路の designatorSuffix も検査し、磁気偏角・ruleSet の範囲を見る', () => {
    const l = createSampleAirport();
    const rid = Object.keys(l.runways)[0]!;
    (l.runways[rid] as { designatorSuffix?: unknown }).designatorSuffix = 'Q';
    expect(errs(l).join()).toContain('designatorSuffix');
    const m = createSampleAirport();
    m.magneticVariationDeg = 181;
    expect(errs(m).join()).toContain('磁気偏角');
    m.magneticVariationDeg = Number.NaN;
    expect(errs(m).join()).toContain('磁気偏角');
    const n = createSampleAirport();
    (n as { ruleSet?: unknown }).ruleSet = 'strict';
    expect(errs(n).join()).toContain('ruleSet');
  });
  it('従来形の滑走路には新しい検査を足さない（既存のレイアウトは今までどおり通る）', () => {
    expect(errs(createSampleAirport())).toEqual([]);
  });
});
