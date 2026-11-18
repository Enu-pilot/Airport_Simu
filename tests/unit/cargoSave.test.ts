import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { buildProject, validateProject } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation } from '../../src/core/sim/simulation';

/**
 * 5-12 CARGO-07: 貨物設定の保存・互換性。
 * 貨物契約（kind 'cargo'）と features.cargo を含む保存が検証を通って往復し、
 * 貨物を持たない旧来の保存も従来どおり読み込めること。
 */
describe('5-12 CARGO-07 貨物の保存と互換性', () => {
  it('貨物契約と features.cargo が保存→検証→復元で往復する', () => {
    const layout = createSampleAirport();
    const company = createSandboxCompany('cargo-save');
    company.city = defaultCity('regional');
    company.features = { cargo: true };
    addContract(company, {
      airlineId: 'NH', destinationId: 'TWN', typeId: 'B777-300ER', perDay: 1, window: 'any',
      feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo',
    });
    const sim = createSimulation(layout, { company, seed: 'cargo-save' });
    const project = buildProject({ name: 'cargo-test', savedAt: '', layout, sim, company, pin: null, scenarios: [] });
    const report = validateProject(JSON.stringify(project), { fallbackCompany: createSandboxCompany('fb') });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    const restored = report.project!.sim!.company!;
    expect(restored.features?.cargo).toBe(true);
    const kinds = Object.values(restored.contracts).map((k) => k.kind);
    expect(kinds).toContain('cargo');
  });

  it('貨物のない保存は従来どおり検証を通る（形式の版は上がらない）', () => {
    const layout = createSampleAirport();
    const company = createSandboxCompany('plain-save');
    const sim = createSimulation(layout, { company, seed: 'plain-save' });
    const project = buildProject({ name: 'plain', savedAt: '', layout, sim, company, pin: null, scenarios: [] });
    const report = validateProject(JSON.stringify(project), { fallbackCompany: createSandboxCompany('fb2') });
    expect(report.errors).toEqual([]);
    expect(report.project!.formatVersion).toBe(project.formatVersion);
  });
});
