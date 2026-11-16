/**
 * 回帰（計画 1-07 / 1-11 / 監査 b ID 10・12 / P-1）: バスゲートの一時閉鎖後も旅客が取り残されない。
 * 旧: 明示バスゲートが閉鎖されると applyBusDeparture が p.gateId=null にし、未入場グループの terminalId が null になったまま再開しても戻らず、全員 unreachable で乗り遅れた。
 * 新: 旅客生成後のバスゲートは固定する。閉鎖中は旅客がゲート工程で待ち、再開すれば搭乗する。締切までに再開しなければ facilityClosed で乗り遅れる（別ターミナルへは回さない）。
 */
import { describe, expect, it } from 'vitest';
import { busTwoTerminalLayout } from '../../audit/b_helpers';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { addDisruption } from '../../../src/core/sim/disruptions';
import { checkBusInvariants, checkInvariants, checkPaxInvariants } from '../../../src/core/sim/invariants';
import { SIM_START_SEC as T0 } from '../../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import type { PaxGroup } from '../../../src/core/sim/types';

const plan = (standId: string) => ({ contractId: 'b', destinationId: 'north', arrPax: 120, depPax: 150, standId, seats: 180 });

function scenario(seed: string, depAfter = 3 * 3600) {
  const { layout, t1 } = busTwoTerminalLayout();
  layout.stands.std_8!.remoteBoarding = 'bus';
  layout.stands.std_8!.busGateId = 'fac_10';
  const sim = createSimulation(layout, { seed, settings: { autoSchedule: false } });
  const ac = addTurnaround(sim, 'narrow180', T0 + 20 * 60, { departureAt: T0 + depAfter, plan: plan('std_8') });
  const dep = sim.state.flights[ac.departureFlightId]!;
  const groups = (): PaxGroup[] => (sim.state.flightPax[dep.id] ?? []).map((id) => sim.state.paxGroups[id]!);
  return { sim, ac, dep, t1, groups };
}

function run(sim: Simulation, seconds: number, every = 60): void {
  for (let i = 0; i < seconds; i++) {
    stepSimulation(sim);
    if (i % every === 0) {
      const v = [...checkInvariants(sim), ...checkPaxInvariants(sim, false), ...checkBusInvariants(sim)];
      if (v.length) throw new Error(`t=${sim.state.now - T0}: ${v.slice(0, 4).join(' / ')}`);
    }
  }
}

describe('1-07 バスゲートの一時閉鎖と旅客', () => {
  it('明示バスゲートの一時閉鎖が出発よりかなり前に終われば、旅客は再開後に搭乗できる（再現テスト）', { timeout: 300_000 }, () => {
    const { sim, dep, t1 } = scenario('b10-div');
    let closed = false;
    let nullAfterReopen = 0;
    for (let i = 0; i < 4 * 3600; i++) {
      if (!closed && sim.state.now >= T0 + 1500) { addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_10', end: T0 + 1500 + 3600 }); closed = true; }
      stepSimulation(sim);
      if (sim.state.now === T0 + 6000) {
        expect(dep.pax.gateId).toBe('fac_10');
        nullAfterReopen = (sim.state.flightPax[dep.id] ?? []).map((id) => sim.state.paxGroups[id]!).filter((g) => g.terminalId !== t1 && g.state !== 'boarded').length;
      }
    }
    expect(nullAfterReopen).toBe(0);
    expect(dep.pax.boarded).toBeGreaterThan(dep.pax.booked * 0.8);
  });

  it('閉鎖中もゲートは固定されたままで（p.gateId を null にしない）、旅客の terminalId は保たれる', { timeout: 300_000 }, () => {
    const { sim, dep, t1, groups } = scenario('s-pin');
    run(sim, 1500);
    expect(dep.pax.generated).toBe(true);
    addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_10', end: T0 + 1500 + 3600 });
    for (let i = 0; i < 3000; i++) {
      stepSimulation(sim);
      if (i % 100 === 0) {
        expect(dep.pax.gateId).toBe('fac_10');
        expect(groups().every((g) => g.terminalId === t1 || ['missed', 'cancelled'].includes(g.state))).toBe(true);
      }
    }
  });

  it('締切まで閉鎖が続く: 乗れなかった全員が facilityClosed（待機中）か late で乗り遅れ、人数と不変条件が保たれる', { timeout: 300_000 }, () => {
    const { sim, dep, groups } = scenario('s-closed-forever');
    run(sim, 1500);
    addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_10', end: null });
    run(sim, 4 * 3600);
    expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
    expect(dep.pax.missed).toBeGreaterThan(0);
    const missed = groups().filter((g) => g.state === 'missed');
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((g) => g.reason === 'facilityClosed' || g.reason === 'late')).toBe(true);
    expect(missed.some((g) => g.reason === 'unreachable' || g.reason === 'noGate')).toBe(false);
    expect(groups().reduce((s, g) => s + g.count, 0)).toBe(dep.pax.booked);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('閉鎖が搭乗開始後に起きても、ゲートは固定され、人数・不変条件が保たれる', { timeout: 300_000 }, () => {
    const { sim, dep } = scenario('s-after-open');
    for (let i = 0; i < 6 * 3600 && dep.pax.boarding === 'notStarted'; i++) stepSimulation(sim);
    expect(dep.pax.boarding).toBe('open');
    addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_10', end: sim.state.now + 300 });
    run(sim, 3 * 3600);
    expect(dep.pax.gateId).toBe('fac_10');
    expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('旅客を生成する前に閉鎖・再開した場合は、生成が再開まで待ち、再開後に全員が運ばれる', { timeout: 300_000 }, () => {
    const { sim, dep } = scenario('s-pre-generate', 6 * 3600); // 生成は出発の 3 時間前 = T0+3h
    addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_10', end: T0 + 3.5 * 3600 });
    run(sim, 3 * 3600 + 600); // 生成時刻を過ぎても閉鎖中
    expect(dep.pax.generated).toBe(false);
    run(sim, 3 * 3600);
    expect(dep.pax.generated).toBe(true);
    expect(dep.pax.boarded).toBeGreaterThan(dep.pax.booked * 0.8);
    expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
  });

  it('保存 → 復元 → 継続した結果が、続けて運航した結果と一致する（閉鎖中に保存）', { timeout: 300_000 }, () => {
    const { sim: a } = scenario('s-save');
    run(a, 1500);
    addDisruption(a, { kind: 'gateFailure', targetId: 'fac_10', end: T0 + 1500 + 3600 });
    run(a, 1800); // 閉鎖中
    const json = serializeProject(buildProject({ name: 'p', savedAt: '2026-11-13T00:00:00Z', layout: a.ctx.layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: a }));
    const r = validateProject(json, { fallbackCompany: createSandboxCompany() });
    expect(r.errors).toEqual([]);
    const { sim: b, violations } = restoreSimulation(r.project!.layout, r.project!.sim!, effectiveModels(r.project!.catalog));
    expect(violations).toEqual([]);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
    for (let i = 0; i < 3 * 3600; i++) {
      stepSimulation(a);
      stepSimulation(b);
    }
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });
});
