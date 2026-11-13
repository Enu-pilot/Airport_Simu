import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../src/core/economy/company';
import { buildProject, formatVersionOf, serializeProject, validateProject, PROJECT_FORMAT_VERSION, PROJECT_FORMAT_VERSION_2 } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';

const NOW = '2026-11-13T00:00:00Z';
const opts = { fallbackCompany: createSandboxCompany() };
const build = (layout = createSampleAirport()) => buildProject({ name: 't', savedAt: NOW, layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });

describe('12B-3a A1: 保存形式の版は新しい項目を使うときだけ 2', () => {
  it('従来のレイアウト・会社は 1 のまま（formatVersion も versions.format も）', () => {
    const p = build();
    expect(p.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(p.versions.format).toBe(PROJECT_FORMAT_VERSION);
    expect(formatVersionOf(p)).toBe(1);
  });

  it('バスゲート・connectedTo・apronBuses > 0 のどれかがあると 2。apronBuses 0 は 1', () => {
    const l = createSampleAirport();
    const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
    const base = Object.values(l.facilities).find((f) => f.kind === 'gseBase')!;
    base.props.apronBuses = 0;
    expect(build(l).formatVersion).toBe(1);
    base.props.apronBuses = 2;
    expect(build(l).formatVersion).toBe(PROJECT_FORMAT_VERSION_2);
    base.props.apronBuses = 0;
    gate.props.boardingMode = 'bus';
    expect(build(l).formatVersion).toBe(2);
    delete gate.props.boardingMode;
    gate.props.connectedTo = 'fac_1';
    expect(build(l).formatVersion).toBe(2);
  });

  it('v2 を読め、v1 はそのまま読め、v3 は拒否する。読み込み後の再保存も条件どおりの版になる', () => {
    const l = createSampleAirport();
    Object.values(l.facilities).find((f) => f.kind === 'gate')!.props.boardingMode = 'bus';
    const p2 = build(l);
    const r2 = validateProject(serializeProject(p2), opts);
    expect(r2.errors).toEqual([]);
    expect(r2.project!.formatVersion).toBe(2);
    expect(r2.migratedFrom).toBeNull();
    const p1 = build();
    const r1 = validateProject(serializeProject(p1), opts);
    expect(r1.project!.formatVersion).toBe(1);
    expect(r1.migratedFrom).toBeNull();
    const r3 = validateProject(JSON.stringify({ ...p2, formatVersion: 3 }), opts);
    expect(r3.ok).toBe(false);
    // v2 を名乗るが新しい項目を使わないファイルは、再保存で 1 に戻る
    const r2plain = validateProject(JSON.stringify({ ...p1, formatVersion: 2 }), opts);
    expect(r2plain.project!.formatVersion).toBe(1);
  });
});
