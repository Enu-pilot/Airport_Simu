import { describe, expect, it } from 'vitest';
import { createSandboxCompany, importCompany } from '../../src/core/economy/company';
import { PROJECT_FORMAT_VERSION_6, buildProject, serializeProject, validateProject } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';

const NOW = '2026-11-18T00:00:00Z';
const opts = { fallbackCompany: createSandboxCompany() };

function phase4Company() {
  const c = createSandboxCompany();
  c.features = { overnight: true };
  c.carryOver = {
    forDay: 3,
    aircraft: [{
      sourceAircraftId: 'ac_1', typeId: 'B737-800', airlineId: 'SK', contractId: 'K_1', destinationId: 'KTA',
      callsign: 'SK101', depNumber: 102, standId: 'st_1', parkedBeforeSec: 3600, depSecOfDay: 23400, depDelaySec: 0, depPax: 120,
    }],
  };
  const k = Object.values(c.contracts)[0]!;
  k.kind = 'overnight';
  return c;
}

describe('projectFormat6: フェーズ 4 の項目の保存と検証（4-13）', () => {
  it('フェーズ 4 の項目がある会社は保存形式 6 で書き出され、検証を通って往復する', () => {
    const p = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: phase4Company(), pin: null, scenarios: [], sim: null });
    expect(p.formatVersion).toBe(PROJECT_FORMAT_VERSION_6);
    const v = validateProject(serializeProject(p), opts);
    expect(v.errors).toEqual([]);
    expect(v.project!.company.features).toEqual({ overnight: true });
    expect(v.project!.company.carryOver?.aircraft).toHaveLength(1);
    expect(Object.values(v.project!.company.contracts)[0]!.kind).toBe('overnight');
  });

  it('フェーズ 4 の項目がない会社は版が上がらない', () => {
    const p = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    expect(p.formatVersion).toBeLessThan(PROJECT_FORMAT_VERSION_6);
  });

  it('版 5 以下を名乗るのにフェーズ 4 の項目があるファイルは拒否する', () => {
    const p = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: phase4Company(), pin: null, scenarios: [], sim: null });
    const r = validateProject(JSON.stringify({ ...p, formatVersion: 5 }), opts);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/フェーズ 4/);
  });

  it('features がない会社の carryOver は検証エラー。importCompany では捨てる', () => {
    const c = phase4Company();
    delete c.features;
    const p = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: c, pin: null, scenarios: [], sim: null });
    const r = validateProject(serializeProject(p), opts);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/features/);
    const imported = importCompany(JSON.stringify(c));
    expect(imported!.carryOver).toBeUndefined();
  });

  it('範囲外の値は検証エラー（depSecOfDay・transferShare・波の時間帯）', () => {
    const c = phase4Company();
    c.carryOver!.aircraft[0]!.depSecOfDay = 90000;
    const p = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: c, pin: null, scenarios: [], sim: null });
    expect(validateProject(serializeProject(p), opts).ok).toBe(false);

    const c2 = phase4Company();
    Object.values(c2.contracts)[0]!.transferShare = 0.9;
    const p2 = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: c2, pin: null, scenarios: [], sim: null });
    expect(validateProject(serializeProject(p2), opts).errors.join('\n')).toMatch(/transferShare/);

    const c3 = createSandboxCompany();
    c3.features = { hub: true };
    c3.hub = { banks: [{ id: 'b1', arriveFromMin: 600, arriveToMin: 500, departFromMin: 700, departToMin: 800 }], maxConnectMin: 240 };
    const p3 = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: c3, pin: null, scenarios: [], sim: null });
    expect(validateProject(serializeProject(p3), opts).errors.join('\n')).toMatch(/hub\.banks/);
  });
});
