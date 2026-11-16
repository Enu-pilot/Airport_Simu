/**
 * 計画 1-11 / K-1: リモートスポットの所属ターミナル（Stand.terminalId）と、旅客生成後のバスゲート固定。
 * 決定規則は resolveBusGateForStand（計画・検証・画面・運航が共有する 1 つの関数）。表は impl_phase1_plan 1-11。
 */
import { describe, expect, it } from 'vitest';
import { busTwoTerminalLayout } from '../../audit/b_helpers';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { createContext } from '../../../src/core/sim/context';
import { addDisruption } from '../../../src/core/sim/disruptions';
import { checkBusInvariants, checkInvariants, checkPaxInvariants } from '../../../src/core/sim/invariants';
import { SIM_START_SEC as T0 } from '../../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { resolveBusGateForStand } from '../../../src/core/terminal/busGateAssignment';
import type { AirportLayout } from '../../../src/core/model/types';
import type { PaxGroup } from '../../../src/core/sim/types';
import { createHash } from 'node:crypto';

const plan = (standId: string) => ({ contractId: 'b', destinationId: 'north', arrPax: 120, depPax: 150, standId, seats: 180 });
const resolve = (layout: AirportLayout, standId: string, closed: string[] = []) => {
  const ctx = createContext(layout);
  const point = ctx.network.nodes[ctx.stands[standId]!.node]?.pos ?? null;
  return resolveBusGateForStand(layout, ctx.terminal, standId, point, ctx.busGates, closed);
};
const groupsOf = (sim: Simulation, flightId: string): PaxGroup[] => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);
const hash = (sim: Simulation) => createHash('sha256').update(JSON.stringify(sim.state)).digest('hex');

function drive(sim: Simulation, seconds: number, every = 60): void {
  for (let i = 0; i < seconds; i++) {
    stepSimulation(sim);
    if (i % every === 0) {
      const v = [...checkInvariants(sim), ...checkPaxInvariants(sim, false), ...checkBusInvariants(sim)];
      if (v.length) throw new Error(`t=${sim.state.now - T0}: ${v.slice(0, 4).join(' / ')}`);
    }
  }
}

function run(layout: AirportLayout, seed: string, standId = 'std_8', depAfter = 3 * 3600) {
  const sim = createSimulation(layout, { seed, settings: { autoSchedule: false } });
  const ac = addTurnaround(sim, 'narrow180', T0 + 20 * 60, { departureAt: T0 + depAfter, plan: plan(standId) });
  return { sim, ac, arr: sim.state.flights[ac.arrivalFlightId]!, dep: sim.state.flights[ac.departureFlightId]! };
}

describe('決定規則（resolveBusGateForStand）', () => {
  it("auto + terminalId=T2: 最寄りが T1 のスポットでも T2 のゲートを選ぶ。T1 指定なら従来どおり", () => {
    const { layout, t1, t2 } = busTwoTerminalLayout();
    expect(resolve(layout, 'std_8')).toEqual({ gateId: 'fac_10', terminalId: t1 }); // 従来
    layout.stands.std_8!.terminalId = t2;
    expect(resolve(layout, 'std_8')).toEqual({ gateId: 'fac_11', terminalId: t2 });
    layout.stands.std_8!.terminalId = t1;
    expect(resolve(layout, 'std_8')).toEqual({ gateId: 'fac_10', terminalId: t1 });
  });

  it('auto + terminalId: そのターミナルのゲートがすべて使えなければ unconfigured（別のターミナルへは移さない）', () => {
    const { layout, t2 } = busTwoTerminalLayout();
    layout.stands.std_8!.terminalId = t2;
    expect(resolve(layout, 'std_8', ['fac_11'])).toEqual({ gateId: null, terminalId: null, failure: 'unconfigured' });
  });

  it("'bus' + busGateId: terminalId と所属が一致するときだけ使う。不一致は invalidGate（代わりを探さない）", () => {
    const { layout, t1, t2 } = busTwoTerminalLayout();
    layout.stands.std_8!.remoteBoarding = 'bus';
    layout.stands.std_8!.busGateId = 'fac_10';
    expect(resolve(layout, 'std_8')).toEqual({ gateId: 'fac_10', terminalId: t1 }); // terminalId 未設定は従来どおり
    layout.stands.std_8!.terminalId = t1;
    expect(resolve(layout, 'std_8')).toEqual({ gateId: 'fac_10', terminalId: t1 });
    layout.stands.std_8!.terminalId = t2;
    expect(resolve(layout, 'std_8')).toEqual({ gateId: null, terminalId: null, failure: 'invalidGate' });
  });

  it("'none' では terminalId を無視する（バスなし）", () => {
    const { layout, t2 } = busTwoTerminalLayout();
    layout.stands.std_8!.remoteBoarding = 'none';
    layout.stands.std_8!.terminalId = t2;
    expect(resolve(layout, 'std_8')).toEqual({ gateId: null, terminalId: null, failure: 'disabled' });
  });

  it('存在しない terminalId は候補なし（unconfigured）。決定的で、レイアウトの並び順に依存しない', () => {
    const { layout } = busTwoTerminalLayout();
    layout.stands.std_8!.terminalId = 'fac_nope';
    expect(resolve(layout, 'std_8').failure).toBe('unconfigured');
  });
});

describe('運航: terminalId を指定したスポット', () => {
  it('正常: auto + T2 指定の std_8 → 到着・出発とも T2 のゲート・施設だけを使い、全員が搭乗する', { timeout: 300_000 }, () => {
    const { layout, t2 } = busTwoTerminalLayout();
    layout.stands.std_8!.terminalId = t2;
    const { sim, arr, dep } = run(layout, 'k1-normal');
    drive(sim, 5 * 3600);
    for (const f of [arr, dep]) {
      expect(f.pax.gateId).toBe('fac_11');
      const gs = groupsOf(sim, f.id);
      expect(gs.length).toBeGreaterThan(0);
      expect(gs.every((g) => g.terminalId === t2)).toBe(true);
    }
    expect(dep.pax.boarded).toBe(150);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('境界: T2 のゲートがすべて閉鎖 → 旅客を生成せず busFailure（T1 へ移さない）。再開すれば生成される', { timeout: 300_000 }, () => {
    const { layout, t1, t2 } = busTwoTerminalLayout();
    layout.stands.std_8!.terminalId = t2;
    const { sim, arr, dep } = run(layout, 'k1-closed', 'std_8', 6 * 3600);
    addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_11', end: T0 + 3.5 * 3600 });
    drive(sim, 3 * 3600 + 600);
    expect(arr.pax.busFailure).toBe('unconfigured');
    expect(groupsOf(sim, dep.id).length).toBe(0);
    expect(Object.values(sim.state.paxGroups).some((g) => g.terminalId === t1)).toBe(false);
    drive(sim, 3 * 3600);
    expect(dep.pax.generated).toBe(true);
    expect(groupsOf(sim, dep.id).every((g) => g.terminalId === t2)).toBe(true);
    expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
  });

  it('境界: 生成後に T2 のゲートが閉鎖 → 待機 → 再開後に搭乗する（T1 へ回らない）', { timeout: 300_000 }, () => {
    const { layout, t2 } = busTwoTerminalLayout();
    layout.stands.std_8!.terminalId = t2;
    const { sim, dep } = run(layout, 'k1-reopen');
    drive(sim, 1500);
    expect(dep.pax.generated).toBe(true);
    addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_11', end: T0 + 1500 + 3600 });
    drive(sim, 4 * 3600);
    expect(dep.pax.gateId).toBe('fac_11');
    expect(groupsOf(sim, dep.id).every((g) => g.terminalId === t2)).toBe(true);
    expect(dep.pax.boarded).toBeGreaterThan(dep.pax.booked * 0.8);
    expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
  });

  it("異常: 'bus' + 不一致の terminalId → 旅客を生成しない（invalidGate）", { timeout: 300_000 }, () => {
    const { layout, t2 } = busTwoTerminalLayout();
    layout.stands.std_8!.remoteBoarding = 'bus';
    layout.stands.std_8!.busGateId = 'fac_10';
    layout.stands.std_8!.terminalId = t2;
    const { sim, arr, dep } = run(layout, 'k1-mismatch');
    drive(sim, 4 * 3600);
    expect(arr.pax.busFailure).toBe('invalidGate');
    expect(groupsOf(sim, arr.id).length).toBe(0);
    expect(groupsOf(sim, dep.id).length).toBe(0);
  });

  it('回帰: terminalId を最寄りと同じ T1 にしても、未設定の旧レイアウトと状態が完全一致する（障害なし）', { timeout: 300_000 }, () => {
    const a = busTwoTerminalLayout();
    const b = busTwoTerminalLayout();
    b.layout.stands.std_8!.terminalId = b.t1;
    const ra = run(a.layout, 'k1-legacy');
    const rb = run(b.layout, 'k1-legacy');
    drive(ra.sim, 5 * 3600);
    drive(rb.sim, 5 * 3600);
    expect(hash(rb.sim)).toBe(hash(ra.sim));
  });

  it('決定性: 同じ入力は同じ結果', { timeout: 300_000 }, () => {
    const mk = () => {
      const { layout, t2 } = busTwoTerminalLayout();
      layout.stands.std_8!.terminalId = t2;
      const r = run(layout, 'k1-det');
      drive(r.sim, 2 * 3600);
      return hash(r.sim);
    };
    expect(mk()).toBe(mk());
  });

  it('保存 → 復元 → 継続した結果が、続けて運航した結果と一致する（terminalId あり・閉鎖中）', { timeout: 300_000 }, () => {
    const { layout, t2 } = busTwoTerminalLayout();
    layout.stands.std_8!.terminalId = t2;
    const { sim: a } = run(layout, 'k1-save');
    drive(a, 1500);
    addDisruption(a, { kind: 'gateFailure', targetId: 'fac_11', end: T0 + 1500 + 3600 });
    drive(a, 1800);
    const json = serializeProject(buildProject({ name: 'p', savedAt: '2026-11-13T00:00:00Z', layout: a.ctx.layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: a }));
    const r = validateProject(json, { fallbackCompany: createSandboxCompany() });
    expect(r.errors).toEqual([]);
    expect(r.project!.layout.stands.std_8!.terminalId).toBe(t2);
    const { sim: b, violations } = restoreSimulation(r.project!.layout, r.project!.sim!, effectiveModels(r.project!.catalog));
    expect(violations).toEqual([]);
    for (let i = 0; i < 3 * 3600; i++) {
      stepSimulation(a);
      stepSimulation(b);
    }
    expect(hash(b)).toBe(hash(a));
  });
});
