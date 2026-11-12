import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany } from '../../src/core/economy/company';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { buildProject, checkLayout, serializeProject, validateProject } from '../../src/core/io/project';
import { designatorsOf } from '../../src/core/layout/designators';
import { runwayAreas } from '../../src/core/layout/runwayAreas';
import { MAX_RUNWAY_LENGTH, placeFreeRunway, placeRunway, snapRunwayToGrid, updateEntity, updateLayoutSettings } from '../../src/core/layout/operations';
import { analyzeLayout } from '../../src/core/validation/validate';
import { TILE_M } from '../../src/core/model/catalog';
import type { AirportLayout, RunwayFree } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

type G = { start: { x: number; y: number }; headingDeg: number; lengthM: number };
const east = (y: number, x = 20): G => ({ start: { x, y }, headingDeg: 90, lengthM: 1000 });
const free = (l: AirportLayout, g: G, o = {}) => must(placeFreeRunway(l, g, o)).layout;
const conflicts = (l: AirportLayout) => analyzeLayout(l).issues.filter((i) => i.code === 'RUNWAY_DESIGNATOR_CONFLICT');
const text = (l: AirportLayout, id: string) => designatorsOf(l.runways[id]!, l).text;
const opts = { fallbackCompany: createSandboxCompany() };

describe('監査修正（S0〜S4）', () => {
  it('負の標高を保存・再読込できる（プロジェクトの検証・checkLayout・importLayout）', () => {
    const l = free(emptyLayout(), east(30), { dims: { elevationStartM: -3, elevationEndM: -1.5, resaLengthM: 100 } });
    expect(checkLayout(l, 'x')).toEqual([]);
    expect((importLayout(exportLayout(l)).runways['rwy_1'] as RunwayFree).dims).toEqual({ elevationStartM: -3, elevationEndM: -1.5, resaLengthM: 100 });
    const json = serializeProject(buildProject({ name: 'x', savedAt: '', layout: l, company: createSandboxCompany(), pin: null, scenarios: [], sim: null }));
    const rep = validateProject(json, opts);
    expect(rep.errors).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(((rep.project!.layout.runways['rwy_1']) as RunwayFree).dims?.elevationStartM).toBe(-3);
  });

  it('混在: 自由形は従来形の滑走路を数えず自動の接尾辞を付けない。同じ番号は警告し、手動の接尾辞で解消する', () => {
    let l = must(placeRunway(emptyLayout(), { x: 20, y: 30 }, 90, 40)).layout;
    l = free(l, east(40));
    expect(text(l, 'rwy_1')).toEqual(['09', '27']);
    expect(text(l, 'rwy_2')).toEqual(['09', '27']);
    const c = conflicts(l);
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]!.targets).toEqual(['rwy_1', 'rwy_2']);
    // 手動の上書き（自由形・従来形のどちらにも有効）で解消する
    const fixedFree = must(updateEntity(l, 'rwy_2', { designatorSuffix: 'R' })).layout;
    expect(text(fixedFree, 'rwy_2')).toEqual(['09R', '27L']);
    expect(conflicts(fixedFree)).toHaveLength(0);
    const fixedLegacy = must(updateEntity(l, 'rwy_1', { designatorSuffix: 'L' })).layout;
    expect(text(fixedLegacy, 'rwy_1')).toEqual(['09L', '27R']);
    expect(conflicts(fixedLegacy)).toHaveLength(0);
  });

  it('自由形 2 本は従来どおり L/R、従来形を加えても自由形の接尾辞は変わらない', () => {
    let l = free(free(emptyLayout(), east(20)), east(32));
    const before = [text(l, 'rwy_1'), text(l, 'rwy_2')];
    expect(before).toEqual([['09L', '27R'], ['09R', '27L']]);
    l = must(placeRunway(l, { x: 20, y: 60 }, 90, 40)).layout;
    expect([text(l, 'rwy_1'), text(l, 'rwy_2')]).toEqual(before);
  });

  it('自由形の平行が 4 本以上: 自動では接尾辞を付けず、RUNWAY_DESIGNATOR_CONFLICT を出す', () => {
    let l = emptyLayout(120, 100);
    for (let i = 0; i < 4; i++) l = free(l, east(10 + i * 20));
    for (const id of ['rwy_1', 'rwy_2', 'rwy_3', 'rwy_4']) expect(text(l, id)).toEqual(['09', '27']);
    const c = conflicts(l);
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]!.severity).toBe('warning');
    expect(c[0]!.targets).toEqual(['rwy_1', 'rwy_2', 'rwy_3', 'rwy_4']);
  });

  it('checkLayout / importLayout: 未知の dims キー・不正な長さ・未知の alignment を拒否する。従来形の有効なデータは通る', () => {
    const base = createSampleAirport();
    const withRunway = (over: Record<string, unknown>) => {
      const l = structuredClone(base) as AirportLayout;
      l.runways['rwy_9'] = { id: 'rwy_9', name: '', alignment: 'free', start: { x: 5, y: 5 }, headingDeg: 10, lengthM: 1000, surfaceWidthM: 45, buildState: 'operational', ...over } as RunwayFree;
      return l;
    };
    expect(checkLayout(withRunway({ dims: { bogus: 1 } }), 'x').join()).toContain('dims.bogus');
    expect(checkLayout(withRunway({ dims: { stripHalfWidthM: 0 } }), 'x').join()).toContain('dims.stripHalfWidthM');
    expect(checkLayout(withRunway({ dims: { resaWidthM: 0 } }), 'x').join()).toContain('dims.resaWidthM');
    expect(checkLayout(withRunway({ dims: { resaLengthM: 0 } }), 'x')).toEqual([]);
    const imp = (l: AirportLayout) => () => importLayout(exportLayout(l));
    expect(imp(withRunway({ lengthM: -5 }))).toThrow(/lengthM/);
    expect(imp(withRunway({ alignment: 'curved' }))).toThrow(/未対応/);
    expect(imp(withRunway({ headingDeg: 400 }))).toThrow(/headingDeg/);
    expect(imp(withRunway({ dims: { bogus: 1 } }))).toThrow(/dims/);
    expect(imp(withRunway({}))).not.toThrow();
    expect(imp(base)).not.toThrow();
    // 従来形の有効なデータは JSON のバイト列まで変わらない
    expect(JSON.stringify(importLayout(exportLayout(base)))).toBe(JSON.stringify(base));
  });

  it('dims の編集: 幅 0（着陸帯の半幅・RESA の幅）は INVALID_VALUE、RESA の長さ 0 は RESA なし', () => {
    const l = free(emptyLayout(), east(30));
    const u = (dims: Record<string, number>) => updateEntity(l, 'rwy_1', { dims });
    expect(u({ stripHalfWidthM: 0 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(u({ resaWidthM: 0 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(placeFreeRunway(emptyLayout(), east(30), { dims: { stripHalfWidthM: 0 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    const noResa = must(u({ resaLengthM: 0 })).layout.runways['rwy_1'] as RunwayFree;
    expect(runwayAreas(noResa).resa).toEqual([]);
    const withResa = runwayAreas(l.runways['rwy_1'] as RunwayFree);
    expect(withResa.resa).toHaveLength(2);
  });

  it('snapRunwayToGrid: 従来形の最大の長さを超えるときは黙って短くせず TOO_LONG_FOR_GRID', () => {
    const ok = free(emptyLayout(), { start: { x: 10, y: 10 }, headingDeg: 90, lengthM: MAX_RUNWAY_LENGTH * TILE_M });
    expect((must(snapRunwayToGrid(ok, 'rwy_1')).layout.runways['rwy_1'] as { length: number }).length).toBe(MAX_RUNWAY_LENGTH);
    const tooLong = free(emptyLayout(), { start: { x: 10, y: 10 }, headingDeg: 90, lengthM: (MAX_RUNWAY_LENGTH + 5) * TILE_M });
    expect(snapRunwayToGrid(tooLong, 'rwy_1')).toEqual({ ok: false, reason: 'TOO_LONG_FOR_GRID' });
  });

  it('updateLayoutSettings: 結果は他の操作と同じく整合している（スポットの入口ノードなど）', () => {
    const l = createSampleAirport();
    const r = must(updateLayoutSettings(l, { ruleSet: 'realistic', magneticVariationDeg: 5 })).layout;
    expect(r.ruleSet).toBe('realistic');
    expect(r.magneticVariationDeg).toBe(5);
    expect(updateLayoutSettings(r, { ruleSet: 'realistic' })).toEqual({ ok: false, reason: 'NO_CHANGE' });
  });
});
