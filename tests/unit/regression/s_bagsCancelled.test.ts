/**
 * 回帰（計画 1-09 / docs/38 ID 09 / B-1）: 欠航した出発便の預け手荷物は、欠航確定後に終端状態（leftBehind / offloaded）になる。
 * 旧: reconcileDepartureBags が地上作業からしか呼ばれず、機体が cannotOperate / diverted の便では仕分け場の madeUp のまま activeBags に残った。
 */
import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { BAG_FINAL_STATES, reconcileDepartureBags } from '../../../src/core/sim/baggage';
import { checkGroundInvariants, checkPaxInvariants } from '../../../src/core/sim/invariants';
import { addTurnaround, createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import { runUntil } from '../sim/helpers';

describe('1-09 欠航便の手荷物', () => {
  it('欠航した出発便の手荷物は欠航確定の 1 時間後までに終端状態になる（seed b09-b / flightsPerDay 120）', { timeout: 600_000 }, () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'b09-b', settings: { flightsPerDay: 120 } });
    const stuck: string[] = [];
    let activeMax = 0;
    for (let i = 0; i < 14 * 3600; i++) {
      stepSimulation(sim);
      if (i % 600 !== 0) continue;
      activeMax = Math.max(activeMax, sim.state.activeBags.length);
      for (const f of Object.values(sim.state.flights)) {
        if (f.direction !== 'departure' || f.status !== 'cancelled' || f.pax.boarding !== 'closed') continue;
        for (const id of sim.state.flightBags[f.id] ?? []) {
          const b = sim.state.bags[id]!;
          if (!BAG_FINAL_STATES.includes(b.state) && sim.state.now - b.since > 3600) stuck.push(`${f.number}:${b.id}:${b.state}`);
        }
      }
    }
    expect(stuck.slice(0, 5), `終端に達しない手荷物 ${stuck.length} 個（例）`).toEqual([]);
    // 欠航便の手荷物が積み上がらない（activeBags が単調に増え続けない）
    expect(sim.state.activeBags.length).toBeLessThan(Math.max(activeMax, 1) + 1);
    expect([...checkGroundInvariants(sim, true), ...checkPaxInvariants(sim, true)]).toEqual([]);
  });

  it('搭乗中に出発便が欠航になる: 積載済みは offloaded、未積載は leftBehind。bagsLeftBehind は増えない', () => {
    const sim = createSimulation(createSampleAirport(), { seed: 's-bags-cancel', settings: { autoSchedule: false } });
    const t = sim.state.now + 20 * 60;
    const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
    const dep = sim.state.flights[ac.departureFlightId]!;
    const bagsOf = () => (sim.state.flightBags[dep.id] ?? []).map((id) => sim.state.bags[id]!);
    // 積載済みの手荷物が出て、まだ搭乗が閉じていない時点まで進める
    runUntil(sim, () => bagsOf().some((b) => b.state === 'loaded') && dep.pax.boarding !== 'closed', 6 * 3600);
    const loaded = bagsOf().filter((b) => b.state === 'loaded').length;
    expect(loaded).toBeGreaterThan(0);
    const before = sim.state.groundStats.bagsLeftBehind;
    dep.status = 'cancelled';
    for (let i = 0; i < 5; i++) stepSimulation(sim);
    expect(dep.pax.boarding).toBe('closed');
    const after = bagsOf();
    expect(after.filter((b) => b.state === 'loaded')).toHaveLength(0);
    expect(after.filter((b) => b.state === 'offloaded').length).toBe(loaded);
    expect(after.every((b) => BAG_FINAL_STATES.includes(b.state))).toBe(true);
    expect(after.some((b) => b.state === 'leftBehind')).toBe(true);
    expect(sim.state.groundStats.bagsLeftBehind).toBe(before); // 欠航は積み残しに数えない
    expect([...checkGroundInvariants(sim, true), ...checkPaxInvariants(sim, true)]).toEqual([]);
  });

  it('乗り遅れ（missed）の手荷物は従来どおり bagsLeftBehind に数える（回帰）', () => {
    const sim = createSimulation(createSampleAirport(), { seed: 's-bags-missed', settings: { autoSchedule: false } });
    const t = sim.state.now + 20 * 60;
    const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
    const dep = sim.state.flights[ac.departureFlightId]!;
    const pending = () => (sim.state.flightBags[dep.id] ?? []).map((id) => sim.state.bags[id]!).filter((b) => ['checkedIn', 'sorting', 'madeUp'].includes(b.state));
    runUntil(sim, () => pending().length > 0, 6 * 3600);
    const target = pending()[0]!;
    sim.state.paxGroups[target.paxGroupId]!.state = 'missed'; // 乗り遅れ（手動で状態だけ与える。件数の数え方だけを見る）
    const before = sim.state.groundStats.bagsLeftBehind;
    const left = reconcileDepartureBags(sim, dep.id, false);
    expect(left).toBeGreaterThan(0);
    expect(sim.state.bags[target.id]!.state).toBe('leftBehind');
    expect(sim.state.groundStats.bagsLeftBehind).toBe(before + left);
  });
});
