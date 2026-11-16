/**
 * 回帰（計画 1-14 / E-3）: 代替スポットへの変更（reassignStand）は、スポット割当済みの進入機にも効く。
 * 旧: assignStand の並びでホームスポットが計画スポットより先に評価され、元のスポットに戻った。
 * 新: reassignStand が Aircraft.requestedStandId を設定し、assignStand はそれを先頭の並び替えキーにする。割当に成功したら消す。
 */
import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { addDisruption, reassignStand, setManualResourceClosure } from '../../../src/core/sim/disruptions';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { SIM_START_SEC as T0 } from '../../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';

function setup(seed: string) {
  const sim = createSimulation(createSampleAirport(), { seed, settings: { autoSchedule: false, inboundDelayProb: 0 } });
  const ac = addTurnaround(sim, 'narrow180', T0 + 3600, { departureAt: T0 + 3 * 3600, plan: { contractId: 'e', destinationId: 'north', arrPax: 100, depPax: 100, standId: 'std_1', seats: 180 } });
  return { sim, ac };
}
const untilAssigned = (sim: Simulation, ac: { state: string; standId: string | null }) => {
  for (let k = 0; k < 20000 && !(ac.state === 'inbound' && ac.standId); k++) stepSimulation(sim);
};
const run = (sim: Simulation, sec: number) => { for (let i = 0; i < sec; i++) stepSimulation(sim); };

describe('1-14 reassignStand', () => {
  it('スポット割当済みの進入機を std_5 に変更すると、10 分後に std_5 に割り当てられ、requestedStandId は消える', () => {
    const { sim, ac } = setup('e-repro-reassign');
    untilAssigned(sim, ac);
    expect(ac.standId).not.toBeNull();
    expect(reassignStand(sim, ac.id, 'std_5')).toEqual({ ok: true });
    expect(ac.requestedStandId).toBe('std_5');
    run(sim, 600);
    expect(ac.standId).toBe('std_5');
    expect(ac.requestedStandId).toBeUndefined();
    expect(checkInvariants(sim)).toEqual([]);
  });

  it('割当前（scheduled）の変更は従来どおり効く', () => {
    const { sim, ac } = setup('s-reassign-pre');
    expect(ac.state).toBe('scheduled');
    expect(reassignStand(sim, ac.id, 'std_6')).toEqual({ ok: true });
    untilAssigned(sim, ac);
    expect(ac.standId).toBe('std_6');
    expect(ac.requestedStandId).toBeUndefined();
  });

  it('変更先が閉鎖中なら CLOSED で拒否し、要求を残さない', () => {
    const { sim, ac } = setup('s-reassign-closed');
    untilAssigned(sim, ac);
    const before = ac.standId;
    setManualResourceClosure(sim, 'stand', 'std_5', true);
    expect(reassignStand(sim, ac.id, 'std_5')).toEqual({ ok: false, reason: 'CLOSED' });
    expect(ac.requestedStandId).toBeUndefined();
    expect(ac.standId).toBe(before);
  });

  it('変更後に変更先が閉鎖された: 要求は残るが閉鎖スポットは使わず、運航は継続し不変条件を保つ', () => {
    const { sim, ac } = setup('s-reassign-then-closed');
    untilAssigned(sim, ac);
    expect(reassignStand(sim, ac.id, 'std_5')).toEqual({ ok: true });
    addDisruption(sim, { kind: 'standClosed', targetId: 'std_5', end: null });
    run(sim, 900);
    expect(ac.standId).not.toBeNull();
    expect(ac.standId).not.toBe('std_5');
    expect(checkInvariants(sim)).toEqual([]);
  });

  it('保存 → 復元 → 継続した結果が、続けて運航した結果と一致する（要求が残った状態で保存）', () => {
    const { sim: a, ac } = setup('s-reassign-save');
    untilAssigned(a, ac);
    reassignStand(a, ac.id, 'std_5');
    expect(ac.requestedStandId).toBe('std_5');
    const json = serializeProject(buildProject({ name: 'p', savedAt: '2026-11-13T00:00:00Z', layout: a.ctx.layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: a }));
    const r = validateProject(json, { fallbackCompany: createSandboxCompany() });
    expect(r.errors).toEqual([]);
    const { sim: b, violations } = restoreSimulation(r.project!.layout, r.project!.sim!, effectiveModels(r.project!.catalog));
    expect(violations).toEqual([]);
    expect(b.state.aircraft[ac.id]!.requestedStandId).toBe('std_5');
    run(a, 1800);
    run(b, 1800);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
    expect(a.state.aircraft[ac.id]!.standId).toBe('std_5');
  });
});
