import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import { busLayout } from './busHelpers';

/** 12B-3a A9: バスの運行の状態を含む保存・復元（運航中の保存からの継続が、中断しなかった場合と一致する）と、新しい項目の厳格な形の検証 */
type D = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const opts = { fallbackCompany: createSandboxCompany() };
const NOW = '2026-11-13T00:00:00Z';

function midRun() {
  const a = createSimulation(busLayout({ buses: 3 }), { seed: 'bus-a', settings: { flightsPerDay: 160 } });
  for (let i = 0; i < 20 * 3600 && !Object.values(a.state.bus?.trips ?? {}).some((t) => t.phase === 'driving' && t.pax > 0); i++) stepSimulation(a);
  return a;
}
const project = (sim: ReturnType<typeof midRun>) => buildProject({ name: 'bus', savedAt: NOW, layout: sim.ctx.layout, company: createSandboxCompany(), pin: null, scenarios: [], sim });

describe('バス搭乗の保存', () => {
  it('運航中（バスの運行中）に保存 → 読み込み → 継続すると、中断しなかった場合とビット単位で一致し、BU 不変条件を保つ', { timeout: 300_000 }, () => {
    const a = midRun();
    expect(Object.values(a.state.bus!.trips).some((t) => t.phase === 'driving')).toBe(true);
    const p = project(a);
    expect(p.formatVersion).toBe(2);
    const r = validateProject(serializeProject(p), opts);
    expect(r.errors).toEqual([]);
    const { sim: b, violations } = restoreSimulation(r.project!.layout, r.project!.sim!, effectiveModels(r.project!.catalog));
    expect(violations).toEqual([]);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
    for (let i = 0; i < 2 * 3600; i++) {
      stepSimulation(a);
      stepSimulation(b);
      if (i % 300 === 0) expect(checkInvariants(b)).toEqual([]);
    }
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });

  it('新しい項目の形が不正なファイルは読み込まない（何も適用しない）', { timeout: 300_000 }, () => {
    const a = midRun();
    const good = JSON.parse(serializeProject(project(a)));
    const bad = (mutate: (d: D) => void, re: RegExp) => {
      const d = structuredClone(good);
      mutate(d);
      const r = validateProject(JSON.stringify(d), opts);
      expect(r.ok, String(re)).toBe(false);
      expect(r.errors.join('\n')).toMatch(re);
    };
    const gate = (d: D) => Object.values<D>(d.layout.facilities).find((f) => f.kind === 'gate' && f.props.boardingMode === 'bus');
    bad((d) => (gate(d)!.props.boardingMode = 'rail'), /搭乗方式/);
    bad((d) => (gate(d)!.props.connectedTo = 'fac_14'), /接続先/);
    bad((d) => (Object.values<D>(d.layout.facilities).find((f) => f.kind === 'gseBase')!.props.apronBuses = 99), /ランプバス台数/);
    bad((d) => (d.sim.state.bus.stats.trips = 'x'), /bus\.stats/);
    const tripId = Object.keys(good.sim.state.bus.trips)[0]!;
    bad((d) => (d.sim.state.bus.trips[tripId].phase = 'flying'), /段階/);
    bad((d) => (d.sim.state.bus.trips[tripId].gateId = 'fac_999'), /ゲート/);
    bad((d) => (d.sim.state.bus.trips[tripId].groups = ['pg_nope']), /旅客グループ/);
    bad((d) => delete d.sim.state.bus, /バスの運行（bus）がありません/);
  });

  it('従来の運航の保存は formatVersion 1 のままで、バスの状態・項目を含まない', { timeout: 300_000 }, () => {
    const l = busLayout({ gate: 'none', buses: 0 });
    const a = createSimulation(l, { seed: 'legacy', settings: { flightsPerDay: 60 } });
    for (let i = 0; i < 3600; i++) stepSimulation(a);
    const p = buildProject({ name: 'legacy', savedAt: NOW, layout: l, company: createSandboxCompany(), pin: null, scenarios: [], sim: a });
    expect(p.formatVersion).toBe(1);
    expect(JSON.stringify(p)).not.toContain('apronBus');
    expect(validateProject(serializeProject(p), opts).ok).toBe(true);
  });
});
