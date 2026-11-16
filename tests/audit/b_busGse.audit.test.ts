import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { APRON_BUS_CAPACITY } from '../../src/core/sim/busRules';
import { checkBusInvariants, checkGroundInvariants, checkInvariants } from '../../src/core/sim/invariants';
import { createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { busLayout } from '../unit/sim/busHelpers';

/** docs/38 ID 12（ランプバス: 不足・BU1–BU4・定員）/ 13（GSE: 二重割当なし・依存順）/ 14（燃料: 現行で実際に効く範囲）。最小構成。 */
function drive(sim: Simulation, sec: number, every = 60): void {
  for (let i = 0; i < sec; i++) {
    stepSimulation(sim);
    if (i % every === 0) {
      const v = [...checkInvariants(sim), ...(sim.state.bus ? checkBusInvariants(sim) : [])];
      if (v.length) throw new Error(`seed=${sim.state.seed} t=${i}: ${v.slice(0, 3).join(' / ')}`);
    }
    if (sim.state.bus) for (const t of Object.values(sim.state.bus.trips)) if (t.pax > APRON_BUS_CAPACITY) throw new Error('bus over capacity');
  }
}

describe('12 ランプバス（複数シード・台数不足）', () => {
  for (const [seed, buses] of [['b12-a', 1], ['b12-b', 2], ['b12-c', 3]] as const) {
    it(`seed=${seed} buses=${buses}: BU1–BU4・定員を保ち、搭乗済み+乗り遅れ+欠航が予約数に一致`, { timeout: 400_000 }, () => {
      const sim = createSimulation(busLayout({ buses }), { seed, settings: { flightsPerDay: 120 } });
      drive(sim, 5 * 3600);
      for (const f of Object.values(sim.state.flights).filter((x) => x.direction === 'departure' && x.pax.boarding === 'closed' && x.pax.generated)) {
        const c = (sim.state.flightPax[f.id] ?? []).map((id) => sim.state.paxGroups[id]!).filter((g) => g.state === 'cancelled').reduce((s, g) => s + g.count, 0);
        expect(f.pax.boarded + f.pax.missed + c).toBe(f.pax.booked);
      }
      expect(Object.values(sim.state.flights).some((f) => f.pax.bus)).toBe(true);
      expect(checkGroundInvariants(sim, true)).toEqual([]);
    });
  }
});

describe('13 GSE・折り返し（人員不足）', () => {
  it('作業員を絞っても 1 ユニットが 2 作業に割り当てられず（G1）、先行作業完了前に開始しない（G2/G3）', { timeout: 400_000 }, () => {
    const l = createSampleAirport();
    const base = Object.values(l.facilities).find((f) => f.kind === 'gseBase')!;
    base.props = { ...base.props, staff: 4, tugs: 1, beltLoaders: 1, baggageTractors: 1 };
    const sim = createSimulation(l, { seed: 'b13-a', settings: { flightsPerDay: 90 } });
    drive(sim, 5 * 3600, 30);
    expect(checkGroundInvariants(sim, true)).toEqual([]);
    expect(Object.values(sim.state.groundStats.blockedSec).reduce((s, n) => s + (n ?? 0), 0)).toBeGreaterThan(0);
  });
});

describe('14 燃料（現行実装の範囲の確認）', () => {
  it('サンプル空港は燃料施設あり・ハイドラント配管なし（配管があると給油車不要・作業 0.6 倍: ground.ts:173。道路/鉄道の運行は未検証）', () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'b14' });
    expect(sim.ctx.hasFuelFarm).toBe(true);
    expect(sim.ctx.hydrantStands.size).toBe(0);
  });
});
