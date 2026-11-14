import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { updateEntity } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { DAY_SEC } from '../../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { setManualResourceClosure } from '../../../src/core/sim/disruptions';
import { must } from '../helpers';
import { runUntil } from './helpers';
import { busLayout } from './busHelpers';

const manual = { autoSchedule: false };
const plan = (standId: string) => ({ contractId: 'test', destinationId: 'north', arrPax: 80, depPax: 80, standId, seats: 180 });

function limitedLayout(): AirportLayout {
  const layout = busLayout({ gate: 'none', buses: 0 });
  for (const stand of Object.values(layout.stands)) stand.buildState = 'underConstruction';
  for (const id of ['std_1', 'std_2', 'std_3']) layout.stands[id]!.buildState = 'operational';
  return layout;
}

function add(sim: Simulation, airline: string, delay: number, standId = 'std_1', typeId: 'narrow180' | 'regional70' = 'narrow180') {
  return addTurnaround(sim, typeId, sim.state.now + delay, {
    airline,
    departureAt: sim.state.now + delay + 2 * 3600,
    plan: { ...plan(standId), seats: typeId === 'narrow180' ? 180 : 70 },
  });
}

describe('航空会社別ホームスポット', () => {
  it('同一社は初回スポットをホーム登録し、次便を近接する追加ホームへ、他社は未割当スポットへ誘導する', () => {
    const sim = createSimulation(limitedLayout(), { seed: 'airline-home-cluster', settings: manual });
    const first = add(sim, 'SK', 60);
    const sameAirline = add(sim, 'SK', 10 * 60);
    const otherAirline = add(sim, 'NP', 20 * 60);
    expect(runUntil(sim, () => !!first.standId && !!sameAirline.standId && !!otherAirline.standId, 3 * 3600)).toBeLessThan(3 * 3600);
    expect(first.standId).toBe('std_1');
    expect(sameAirline.standId).not.toBe(first.standId);
    expect(otherAirline.standId).toBe('std_3');
    expect(sim.state.airlineStandHomes?.byAirline.SK).toContain(first.standId);
    expect(sim.state.airlineStandHomes?.byAirline.SK).toContain(sameAirline.standId);
    expect(sim.state.airlineStandHomes?.byAirline.NP).toEqual(['std_3']);
  });

  it('サイズ不適合とホームスポット閉鎖時は適合する代替先を使い、理由と履歴を記録する', () => {
    let layout = limitedLayout();
    layout = must(updateEntity(layout, 'std_1', { size: 'S' })).layout;
    const sim = createSimulation(layout, { seed: 'airline-home-fallback', settings: manual });
    const first = add(sim, 'SK', 60);
    expect(runUntil(sim, () => first.state === 'turnaround', 3 * 3600)).toBeLessThan(3 * 3600);
    expect(first.standId).not.toBe('std_1');
    const currentHome = first.standId!;
    expect(setManualResourceClosure(sim, 'stand', currentHome, true)).toEqual({ ok: true });
    const alternative = add(sim, 'SK', 20 * 60);
    expect(runUntil(sim, () => !!alternative.standId, 3 * 3600)).toBeLessThan(3 * 3600);
    expect(alternative.standId).not.toBe(currentHome);
    expect(sim.state.airlineStandHomes?.byAirline.SK?.[0]).toBe(alternative.standId);
    expect(sim.state.events.some((event) => event.aircraftId === alternative.id && event.standAssignmentReason === 'fallback' && event.standId === alternative.standId)).toBe(true);
  });

  it('日付が変わると航空会社別ホーム割当をリセットする', () => {
    const sim = createSimulation(limitedLayout(), { seed: 'airline-home-daily', settings: manual });
    sim.state.airlineStandHomes = { day: 0, byAirline: { SK: ['std_1'] } };
    sim.state.now = DAY_SEC;
    stepSimulation(sim);
    expect(sim.state.airlineStandHomes).toEqual({ day: 1, byAirline: {} });
  });

  it('ホーム割当フィールドのない旧運航保存を読み込み、次の保存で初期化できる', () => {
    const layout = limitedLayout();
    const sim = createSimulation(layout, { seed: 'airline-home-old-save', settings: manual });
    const project = buildProject({ name: 'old save', savedAt: '2026-11-14T00:00:00Z', layout, company: createSandboxCompany(), pin: null, scenarios: [], sim });
    const raw = JSON.parse(serializeProject(project)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    delete raw.sim.state.airlineStandHomes;
    raw.versions.simModel = 'skyport-sim-10.1';
    const loaded = validateProject(JSON.stringify(raw), { fallbackCompany: createSandboxCompany() });
    expect(loaded.ok).toBe(true);
    const restored = restoreSimulation(loaded.project!.layout, loaded.project!.sim!, effectiveModels(loaded.project!.catalog));
    expect(restored.violations).toEqual([]);
    expect(restored.sim.state.airlineStandHomes).toEqual({ day: Math.floor(sim.state.now / DAY_SEC), byAirline: {} });
  });
});
