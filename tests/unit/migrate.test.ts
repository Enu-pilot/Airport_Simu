import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany } from '../../src/core/economy/company';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { migrateLayout } from '../../src/core/io/migrate';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject, type ProjectFile } from '../../src/core/io/project';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import type { AirportLayout } from '../../src/core/model/types';

const opts = { fallbackCompany: createSandboxCompany() };

/** v1 の形: terminalAreas が無く schemaVersion が 1 */
function v1Of(l: AirportLayout): Record<string, unknown> {
  const c = structuredClone(l) as unknown as Record<string, unknown>;
  delete c.terminalAreas;
  c.schemaVersion = 1;
  return c;
}

/** v1 → v2 後に期待されるレイアウト（terminalAreas = {}、schemaVersion = 2） */
function v2Expected(): AirportLayout {
  const l = createSampleAirport();
  l.terminalAreas = {};
  l.schemaVersion = 2;
  return l;
}

describe('レイアウト移行 v1 → v2（migrate.ts）', () => {
  it('migrateLayout は v1 だけを書き換え、v2 以上とオブジェクト以外は触らない', () => {
    const v1 = v1Of(createSampleAirport());
    migrateLayout(v1, 1);
    expect(v1.terminalAreas).toEqual({});
    expect(v1.schemaVersion).toBe(2);
    const v2 = structuredClone(createSampleAirport());
    const before = structuredClone(v2);
    migrateLayout(v2, 2);
    expect(v2).toEqual(before);
    expect(() => migrateLayout(null, 1)).not.toThrow();
    expect(() => migrateLayout('x', 1)).not.toThrow();
  });

  it('v1 レイアウトファイルを importLayout で読むと従来どおりの v2 になる', () => {
    const json = JSON.stringify({ format: 'skyport-layout', schemaVersion: 1, layout: v1Of(createSampleAirport()) });
    expect(importLayout(json)).toEqual(v2Expected());
    // v2 は恒等
    expect(importLayout(exportLayout(createSampleAirport()))).toEqual(createSampleAirport());
  });

  it('v1 レイアウトだけのファイルを validateProject（旧形式）で読むと従来どおりの v2 になる', () => {
    const json = JSON.stringify({ format: 'skyport-layout', schemaVersion: 1, layout: v1Of(createSampleAirport()) });
    const r = validateProject(json, opts);
    expect(r.errors).toEqual([]);
    expect(r.project!.layout).toEqual(v2Expected());
  });

  it('v1 レイアウトを含む v1 プロジェクト（運航状態入り）が従来どおり読め、運航状態も一致する', () => {
    const layout = v2Expected();
    const a = createSimulation(layout, { company: createSandboxCompany() });
    for (let i = 0; i < 120; i++) stepSimulation(a);
    const p = JSON.parse(serializeProject(buildProject({ name: 'x', savedAt: '', layout: a.ctx.layout, company: a.company!, pin: null, scenarios: [], sim: a }))) as ProjectFile;
    const expectedLayout = structuredClone(p.layout);
    const expectedSim = structuredClone(p.sim);
    p.layout = v1Of(p.layout) as unknown as AirportLayout;
    const r = validateProject(JSON.stringify(p), opts);
    expect(r.errors).toEqual([]);
    expect(r.project!.layout).toEqual(expectedLayout);
    expect(r.project!.sim).toEqual(expectedSim);
    const { violations } = restoreSimulation(r.project!.layout, r.project!.sim!, effectiveModels(r.project!.catalog));
    expect(violations).toEqual([]);
  });
});
