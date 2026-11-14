import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addDisruption, resolveDisruption, setManualResourceClosure } from '../../../src/core/sim/disruptions';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { addTurnaround, createSimulation, stepSimulation } from '../../../src/core/sim/simulation';

const opts = { fallbackCompany: createSandboxCompany() };
const NOW = '2026-11-13T00:00:00Z';

describe('スポット・誘導路の使用停止', () => {
  it('閉鎖したスポットを新しい到着機に割り当てず、未着陸の予約は安全に解放する', () => {
    const sim = createSimulation(createSampleAirport(), { settings: { autoSchedule: false, flightsPerDay: 0 } });
    const standId = 'std_1';
    expect(setManualResourceClosure(sim, 'stand', standId, true)).toEqual({ ok: true });
    const ac = addTurnaround(sim, 'B737-800W', sim.state.now + 600, { plan: { contractId: 'test', destinationId: 'test', arrPax: 10, depPax: 10, standId } });
    for (let i = 0; i < 120; i++) stepSimulation(sim);
    expect(ac.standId).not.toBe(standId);
    expect(sim.state.standAssignments[standId]).toBeUndefined();
  });

  it('閉鎖中の誘導路を新しく探索する到着経路に含めず、代替路がなければ noRoute で待機する', () => {
    const layout = createSampleAirport();
    const sim = createSimulation(layout, { settings: { autoSchedule: false, flightsPerDay: 0 } });
    const taxiwayId = Object.values(layout.taxiways).find((taxiway) => taxiway.name === 'B1')!.id;
    expect(setManualResourceClosure(sim, 'taxiway', taxiwayId, true)).toEqual({ ok: true });
    const ac = addTurnaround(sim, 'B737-800W', sim.state.now + 600, { plan: { contractId: 'test', destinationId: 'test', arrPax: 10, depPax: 10, standId: 'std_1' } });
    let routed = false;
    for (let i = 0; i < 3600 && !routed; i++) {
      stepSimulation(sim);
      if (ac.route?.kind === 'landing') routed = true;
    }
    expect(routed).toBe(true);
    expect(ac.route!.edges.some((edge) => sim.ctx.network.edges[edge]?.sourceId === taxiwayId)).toBe(false);

    const isolated = createSimulation(createSampleAirport(), { settings: { autoSchedule: false, flightsPerDay: 0 } });
    for (const id of Object.keys(isolated.ctx.layout.taxiways)) setManualResourceClosure(isolated, 'taxiway', id, true);
    const waiting = addTurnaround(isolated, 'B737-800W', isolated.state.now + 600);
    for (let i = 0; i < 700; i++) stepSimulation(isolated);
    expect(waiting.route).toBeNull();
    expect(waiting.holdReason).toBe('noRoute');
  });

  it('手動閉鎖と障害閉鎖の解除は互いに独立し、既存の移動経路は途中で破棄しない', () => {
    const sim = createSimulation(createSampleAirport(), { settings: { autoSchedule: false, flightsPerDay: 0 } });
    const ac = addTurnaround(sim, 'B737-800W', sim.state.now + 600);
    for (let i = 0; i < 3600 && !ac.route; i++) stepSimulation(sim);
    expect(ac.route).not.toBeNull();
    const existingRoute = ac.route!;
    const taxiwayId = existingRoute.edges.map((edge) => sim.ctx.network.edges[edge]?.sourceId).find((id): id is string => !!id && !!sim.ctx.layout.taxiways[id])!;
    const disruption = addDisruption(sim, { kind: 'taxiwayClosed', targetId: taxiwayId, end: sim.state.now + 3600 });
    expect(setManualResourceClosure(sim, 'taxiway', taxiwayId, true)).toEqual({ ok: true });
    expect(resolveDisruption(sim, disruption.id)).toBe(true);
    expect(sim.state.closures.taxiways).toContain(taxiwayId);
    expect(sim.state.closureReasons!.taxiways[taxiwayId]).toEqual(['manual']);
    expect(ac.route).toEqual(existingRoute);
    expect(setManualResourceClosure(sim, 'taxiway', taxiwayId, false)).toEqual({ ok: true });
    expect(sim.state.closures.taxiways).not.toContain(taxiwayId);
  });

  it('閉鎖理由を保存・復元し、旧形式の閉鎖配列も移行する', () => {
    const sim = createSimulation(createSampleAirport(), { company: createSandboxCompany(), settings: { autoSchedule: false, flightsPerDay: 0 } });
    const taxiwayId = Object.keys(sim.ctx.layout.taxiways)[0]!;
    setManualResourceClosure(sim, 'taxiway', taxiwayId, true);
    const project = buildProject({ name: 'closures', savedAt: NOW, layout: sim.ctx.layout, company: sim.company!, pin: null, scenarios: [], sim });
    expect(project.formatVersion).toBe(2);
    const imported = validateProject(serializeProject(project), opts);
    expect(imported.errors).toEqual([]);
    const restored = restoreSimulation(imported.project!.layout, imported.project!.sim!, effectiveModels(imported.project!.catalog));
    expect(restored.violations).toEqual([]);
    expect(restored.sim.state.closures.taxiways).toContain(taxiwayId);
    expect(restored.sim.state.closureReasons!.taxiways[taxiwayId]).toEqual(['manual']);
    expect(checkInvariants(restored.sim)).toEqual([]);

    const legacy = structuredClone(project);
    delete (legacy.sim!.state as typeof sim.state).closureReasons;
    delete (legacy.sim!.state as typeof sim.state).airlineStandHomes;
    legacy.formatVersion = 1;
    legacy.versions.format = 1;
    const legacyImport = validateProject(serializeProject(legacy), opts);
    expect(legacyImport.errors).toEqual([]);
    expect(legacyImport.project!.sim!.state.closureReasons!.taxiways[taxiwayId]).toEqual(['legacy']);
  });
});
