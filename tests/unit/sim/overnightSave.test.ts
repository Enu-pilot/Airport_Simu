import { describe, expect, it } from 'vitest';
import { createSandboxCompany, type CompanyState } from '../../../src/core/economy/company';
import { buildProject, serializeProject, validateProject } from '../../../src/core/io/project';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { createSimulation } from '../../../src/core/sim/simulation';

const NOW = '2026-11-18T00:00:00Z';

function savedCompany(): CompanyState {
  const layout = createSampleAirport();
  const standId = Object.values(layout.stands).find((s) => s.size === 'M')!.id;
  const c = createSandboxCompany('ovn-save');
  c.features = { overnight: true };
  c.carryOver = {
    forDay: c.day,
    aircraft: [{
      sourceAircraftId: 'ac_1', typeId: 'B737-800', airlineId: 'SK', contractId: null, destinationId: 'KTA',
      callsign: 'SK101', depNumber: 102, standId, parkedBeforeSec: 3600, depSecOfDay: 23400, depDelaySec: 0, depPax: 120,
    }],
  };
  return c;
}

describe('overnightSave: 建設モードで保存 → 読み込み → 再開（4B-2）', () => {
  it('保存・検証を往復した会社の記録は再開で 1 回だけ置き直される', () => {
    const layout = createSampleAirport();
    const p = buildProject({ name: 't', savedAt: NOW, layout, company: savedCompany(), pin: null, scenarios: [], sim: null });
    const v = validateProject(serializeProject(p), { fallbackCompany: createSandboxCompany() });
    expect(v.errors).toEqual([]);
    const loaded = v.project!.company;
    expect(loaded.carryOver?.aircraft).toHaveLength(1);

    const sim = createSimulation(layout, { company: loaded, seed: 'ovn-save' });
    const materialized = Object.values(sim.state.flights).filter((f) => f.carryOver);
    expect(materialized).toHaveLength(1);
    const ac = sim.state.aircraft[materialized[0]!.aircraftId]!;
    expect(ac.state).toBe('parked');
    expect(sim.state.standAssignments[ac.standId!]).toBe(ac.id);
    // 記録は消費され、同じ会社でもう一度 sim を作っても二重に置き直されない
    expect(loaded.carryOver).toBeUndefined();
    const sim2 = createSimulation(layout, { company: loaded, seed: 'ovn-save' });
    expect(Object.values(sim2.state.flights).filter((f) => f.carryOver)).toHaveLength(0);
  });
});
