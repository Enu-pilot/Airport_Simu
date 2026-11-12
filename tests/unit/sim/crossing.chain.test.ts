import { describe, expect, it } from 'vitest';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { createSandboxCompany } from '../../../src/core/economy/company';
import type { Aircraft } from '../../../src/core/sim/types';
import { freeShallowCrossingAirport, legacyTwinAirport } from './chainLayouts';

/**
 * 連続横断の占有の漏れ（Phase 12 の不具合修正 C1）の回帰テスト。
 * 従来形の平行 2 本（125 m 間隔）を 1 本の誘導路が横切ると、北の滑走路を抜ける前に南の滑走路の横断許可が降り、
 * 先の許可が上書きされて北の滑走路が解放されなかった（修正前: 不変条件違反が多数、出発 0、ダイバート 29/32）。
 */
const NOW = '2026-11-10T00:00:00Z';
const opts = { fallbackCompany: createSandboxCompany() };

function schedule(sim: Simulation): Aircraft[] {
  const t = sim.state.now + 20 * 60;
  const types = ['narrow180', 'regional70', 'narrow180', 'regional70'] as const;
  const acs: Aircraft[] = [];
  for (let w = 0; w < 8; w++) for (let k = 0; k < 4; k++) acs.push(addTurnaround(sim, types[k]!, t + w * 40 * 60 + k * 90, { departureAt: t + w * 40 * 60 + 30 * 60 + k * 100 }));
  return acs;
}

function run(layout: ReturnType<typeof legacyTwinAirport>, seed: string, hours: number) {
  const sim = createSimulation(layout, { seed, settings: { autoSchedule: false } });
  const acs = schedule(sim);
  let violations = 0;
  let first = '';
  let maxHeld = 0;
  let emptyHeld = false;
  for (let i = 0; i < hours * 3600; i++) {
    stepSimulation(sim);
    for (const ac of acs) {
      if (ac.heldCrossings) {
        maxHeld = Math.max(maxHeld, ac.heldCrossings.length);
        if (ac.heldCrossings.length === 0) emptyHeld = true; // 空のときはキーを消す
      }
    }
    if (i % 10 === 0) {
      const v = checkInvariants(sim);
      violations += v.length;
      if (v.length > 0 && !first) first = v[0]!;
    }
  }
  return { sim, acs, violations, first, maxHeld, emptyHeld };
}

describe('連続横断（C1）', () => {
  it('従来形の平行 2 本: 不変条件が常に成り立ち、占有が漏れず、全機が出発する（2 シード × 6 時間）', { timeout: 120_000 }, () => {
    for (const seed of ['a', 'b']) {
      const r = run(legacyTwinAirport(), seed, 6);
      expect(r.first, `${seed}: ${r.first}`).toBe('');
      expect(r.violations).toBe(0);
      expect(r.sim.state.stats.departures).toBeGreaterThanOrEqual(30);
      expect(r.sim.state.stats.diverted).toBeLessThanOrEqual(2);
      expect(r.emptyHeld).toBe(false);
      // 終了後は、横断の占有も許可も残らない
      for (const rs of Object.values(r.sim.state.runways)) expect(rs.occupant).toBeNull();
      for (const ac of r.acs) {
        expect(ac.crossing).toBeNull();
        expect('heldCrossings' in ac).toBe(false);
      }
    }
  });

  it('自由形の浅い交差（約 23°）: 不変条件が成り立ち、占有が漏れない', { timeout: 120_000 }, () => {
    const r = run(freeShallowCrossingAirport(), 'a', 6);
    expect(r.first).toBe('');
    expect(r.violations).toBe(0);
    expect(r.sim.state.stats.departures).toBeGreaterThanOrEqual(10);
    for (const rs of Object.values(r.sim.state.runways)) expect(rs.occupant).toBeNull();
  });

  it('先の許可が上書きされず、通過後にそれぞれの位置で解放される（heldCrossings は空なら消える）', { timeout: 120_000 }, () => {
    // 連続横断の幾何では、先の許可を heldCrossings に持つ機体が現れる
    const r = run(legacyTwinAirport(), 'a', 6);
    expect(r.maxHeld).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.sim.state)).not.toContain('"heldCrossings":[]');
  });
});

describe('安全網（離陸・スポット進入の終わりで開いた許可を解放する）', () => {
  it('出発機が離陸を始めるとき、開いたままの横断の占有を解放する', { timeout: 60_000 }, () => {
    const sim = createSimulation(legacyTwinAirport(), { seed: 'a', settings: { autoSchedule: false } });
    const acs = schedule(sim);
    let planted: { ac: Aircraft; rid: string } | null = null;
    for (let i = 0; i < 6 * 3600 && !planted; i++) {
      stepSimulation(sim);
      const ac = acs.find((a) => a.state === 'holdShort' && a.route);
      if (ac) {
        // 出発する滑走路とは別の滑走路を、この機体の「横断」として占有させる（許可の取り残しを再現）
        const other = Object.keys(sim.state.runways).find((id) => id !== ac.runwayId)!;
        sim.state.runways[other]!.occupant = { aircraftId: ac.id, purpose: 'crossing', since: sim.state.now };
        ac.crossing = { index: 0, runwayId: other };
        planted = { ac, rid: other };
      }
    }
    expect(planted).not.toBeNull();
    const { ac, rid } = planted!;
    for (let i = 0; i < 600 && (ac.state === 'holdShort' || ac.state === 'lineUp'); i++) stepSimulation(sim);
    expect(['takeoff', 'departed']).toContain(ac.state);
    expect(sim.state.runways[rid]!.occupant).toBeNull();
    expect(ac.crossing).toBeNull();
  });

  it('到着機がスポットに着くとき、開いたままの横断の占有を解放する', { timeout: 60_000 }, () => {
    const sim = createSimulation(legacyTwinAirport(), { seed: 'a', settings: { autoSchedule: false } });
    const acs = schedule(sim);
    let planted: { ac: Aircraft; rid: string } | null = null;
    for (let i = 0; i < 6 * 3600 && !planted; i++) {
      stepSimulation(sim);
      const ac = acs.find((a) => a.state === 'docking' && a.route);
      if (ac) {
        const rid = Object.keys(sim.state.runways)[0]!;
        if (sim.state.runways[rid]!.occupant) continue;
        sim.state.runways[rid]!.occupant = { aircraftId: ac.id, purpose: 'crossing', since: sim.state.now };
        ac.crossing = { index: 0, runwayId: rid };
        planted = { ac, rid };
      }
    }
    expect(planted).not.toBeNull();
    const { ac, rid } = planted!;
    for (let i = 0; i < 600 && ac.state === 'docking'; i++) stepSimulation(sim);
    expect(ac.state).not.toBe('docking');
    expect(sim.state.runways[rid]!.occupant).toBeNull();
    expect(ac.crossing).toBeNull();
  });
});

describe('保存と復元（C1）', () => {
  function savedMidRun(): { json: string; sim: Simulation } {
    const sim = createSimulation(legacyTwinAirport(), { seed: 'a', settings: { autoSchedule: false } });
    schedule(sim);
    for (let i = 0; i < 2 * 3600; i++) stepSimulation(sim);
    const p = buildProject({ name: 'x', savedAt: NOW, layout: sim.ctx.layout, company: createSandboxCompany(), pin: null, scenarios: [], sim });
    return { json: serializeProject(p), sim };
  }

  it('heldCrossings のないふつうの保存は、読み込んで書き直しても同一のバイト列', { timeout: 60_000 }, () => {
    const { json } = savedMidRun();
    const r = validateProject(json, opts);
    expect(r.errors).toEqual([]);
    expect(r.warnings.filter((w) => w.includes('修復'))).toEqual([]);
    // 運航状態は、読み込み前後でバイト列まで同一（heldCrossings などの新しいキーを足さない）
    expect(JSON.stringify(r.project!.sim)).toBe(JSON.stringify(JSON.parse(json).sim));
  });

  it('heldCrossings の滑走路・位置が不正な保存は拒否する', { timeout: 60_000 }, () => {
    const { json } = savedMidRun();
    const d = JSON.parse(json);
    const id = Object.keys(d.sim.state.aircraft)[0]!;
    d.sim.state.aircraft[id].heldCrossings = [{ index: 1, runwayId: 'rwy_999' }];
    const r = validateProject(JSON.stringify(d), opts);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('heldCrossings');
    d.sim.state.aircraft[id].heldCrossings = [];
    expect(validateProject(JSON.stringify(d), opts).ok).toBe(false);
  });

  it('漏れた横断の占有（持ち主の許可がない保存）は、警告つきで修復して読み込める', { timeout: 60_000 }, () => {
    const { json } = savedMidRun();
    const d = JSON.parse(json);
    const rid = Object.keys(d.sim.state.runways)[0]!;
    const ids = Object.keys(d.sim.state.aircraft);
    d.sim.state.runways[rid].occupant = { aircraftId: ids[0], purpose: 'crossing', since: 1 };
    const r = validateProject(JSON.stringify(d), opts);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toContain('修復');
    const { sim, violations, repaired } = restoreSimulation(r.project!.layout, r.project!.sim!, effectiveModels(r.project!.catalog));
    expect(repaired).toHaveLength(1);
    expect(violations).toEqual([]);
    expect(sim.state.runways[rid]!.occupant).toBeNull();
  });
});
