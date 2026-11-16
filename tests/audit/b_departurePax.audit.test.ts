import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { checkInvariants, checkGroundInvariants, checkPaxInvariants } from '../../src/core/sim/invariants';
import { createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { PAX_FINAL_STATES } from '../../src/core/sim/types';

/**
 * docs/38 ID 08: 旅客生成 → チェックイン → 保安検査 → 搭乗 / 乗り遅れ。
 * 便ごとの保存則 booked = boarded + missed + 処理中、ID一意性、所属ターミナル、窓口数上限を、複数シードで途中経過も含めて確認する。
 */
function drive(sim: Simulation, hours: number, every = 45, fullEvery = 1800): { maxActive: number } {
  let maxActive = 0;
  for (let i = 0; i < hours * 3600; i++) {
    stepSimulation(sim);
    maxActive = Math.max(maxActive, sim.state.activePax.length);
    if (i % every === 0) {
      const v = checkInvariants(sim);
      if (v.length) throw new Error(`seed=${sim.state.seed} t=${sim.state.now}: ${v.slice(0, 5).join(' / ')}`);
    }
    if (i % fullEvery === 0) {
      const v = [...checkPaxInvariants(sim, true), ...checkGroundInvariants(sim, true)];
      if (v.length) throw new Error(`full seed=${sim.state.seed} t=${sim.state.now}: ${v.slice(0, 5).join(' / ')}`);
    }
  }
  return { maxActive };
}

const SEEDS = ['b08-a', 'b08-b', 'b08-c'];

describe('08 出発旅客の保存則（サンプル空港・複数シード）', () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 便ごとに booked = boarded + missed、グループID一意、所属ターミナルは1便1つ`, { timeout: 300_000 }, () => {
      const sim = createSimulation(createSampleAirport(), { seed, settings: { flightsPerDay: 90 } });
      drive(sim, 6);
      const { state, ctx } = sim;
      const seen = new Set<string>();
      let closedDeps = 0;
      for (const f of Object.values(state.flights).filter((x) => x.direction === 'departure' && x.pax.generated)) {
        const ids = state.flightPax[f.id] ?? [];
        const groups = ids.map((id) => state.paxGroups[id]!);
        for (const id of ids) {
          expect(seen.has(id), `重複ID ${id}`).toBe(false);
          seen.add(id);
          expect(state.paxGroups[id]!.flightId).toBe(f.id);
          expect(state.paxGroups[id]!.direction).toBe('departure');
        }
        const total = groups.reduce((s, g) => s + g.count, 0);
        expect(total).toBe(f.pax.booked);
        const done = groups.filter((g) => PAX_FINAL_STATES.includes(g.state));
        const inProcess = groups.filter((g) => !PAX_FINAL_STATES.includes(g.state)).reduce((s, g) => s + g.count, 0);
        const boarded = groups.filter((g) => g.state === 'boarded').reduce((s, g) => s + g.count, 0);
        const missed = groups.filter((g) => g.state === 'missed').reduce((s, g) => s + g.count, 0);
        // 欠航便の旅客は 'cancelled'（乗り遅れ missed には数えない。passengers.ts missGroups）
        const cancelled = groups.filter((g) => g.state === 'cancelled').reduce((s, g) => s + g.count, 0);
        expect(boarded).toBe(f.pax.boarded);
        expect(missed).toBe(f.pax.missed);
        expect(f.pax.boarded + f.pax.missed + cancelled + inProcess).toBe(f.pax.booked);
        if (f.status === 'cancelled') expect(f.pax.boarded).toBe(0);
        if (f.pax.boarding === 'closed') {
          closedDeps++;
          expect(inProcess, `${f.number} 搭乗締切後に処理中の旅客`).toBe(0);
          expect(f.pax.boarded + f.pax.missed + cancelled).toBe(f.pax.booked);
          expect(done.length).toBe(groups.length);
        }
        // 所属ターミナル: 1便の旅客は同一のターミナル（ゲートが決まっていればそのゲートのターミナル）
        const terminals = new Set(groups.map((g) => g.terminalId));
        expect(terminals.size, `${f.number} のターミナル`).toBeLessThanOrEqual(1);
        if (f.pax.gateId && terminals.size === 1) expect([...terminals][0]).toBe(ctx.terminal.gates[f.pax.gateId]?.terminalId);
        // 搭乗済みは保安検査済み
        for (const g of groups) if (g.state === 'boarded') expect(g.securityCleared).toBe(true);
      }
      expect(closedDeps).toBeGreaterThan(5);
      // 全体統計は便の合計と一致する
      const deps = Object.values(state.flights).filter((x) => x.direction === 'departure' && x.pax.generated);
      expect(state.paxStats.boarded).toBe(deps.reduce((s, f) => s + f.pax.boarded, 0));
      expect(state.paxStats.missed).toBe(deps.reduce((s, f) => s + f.pax.missed, 0));
    });
  }

  it('決定性: 同一シードの2回の運航で旅客状態が一致する', { timeout: 300_000 }, () => {
    const mk = () => {
      const sim = createSimulation(createSampleAirport(), { seed: 'b08-det', settings: { flightsPerDay: 90 } });
      drive(sim, 3, 600, 3600);
      return sim;
    };
    const a = mk();
    const b = mk();
    expect(JSON.stringify(a.state.paxGroups)).toBe(JSON.stringify(b.state.paxGroups));
    expect(JSON.stringify(a.state.paxStats)).toBe(JSON.stringify(b.state.paxStats));
  });
});

describe('08 窓口数・同時処理の上限', () => {
  it('チェックイン・保安検査の同時処理数が常に窓口数以内（P3）で、待ち行列の人数が減ることもある（高需要でも破綻しない）', { timeout: 300_000 }, () => {
    const layout = createSampleAirport();
    const sim = createSimulation(layout, { seed: 'b08-load', settings: { flightsPerDay: 160 } });
    let maxQueue = 0;
    for (let i = 0; i < 5 * 3600; i++) {
      stepSimulation(sim);
      if (i % 30 === 0) {
        for (const fac of Object.values(sim.state.facilities)) maxQueue = Math.max(maxQueue, fac.queue.length);
        const v = checkPaxInvariants(sim, false);
        if (v.length) throw new Error(`t=${sim.state.now}: ${v.slice(0, 3).join(' / ')}`);
      }
    }
    expect(maxQueue).toBeGreaterThan(0);
    for (const f of Object.values(sim.state.flights)) {
      if (f.direction !== 'departure' || f.pax.boarding !== 'closed') continue;
      const cancelled = (sim.state.flightPax[f.id] ?? []).map((id) => sim.state.paxGroups[id]!).filter((g) => g.state === 'cancelled').reduce((s, g) => s + g.count, 0);
      expect(f.pax.boarded + f.pax.missed + cancelled).toBe(f.pax.booked);
    }
  });
});
