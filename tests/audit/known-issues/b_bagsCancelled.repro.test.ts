import { expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { BAG_FINAL_STATES } from '../../../src/core/sim/baggage';
import { createSimulation, stepSimulation } from '../../../src/core/sim/simulation';

/**
 * 既知の不具合（docs/38 ID 09 / docs/13 §3）: 欠航（到着機の迂回 diverted → 折り返し出発便が cancelled）した出発便の
 * 預け手荷物が、積み残し・取り下ろし等の終端状態に到達せず、仕分け場の 'madeUp' のまま activeBags に残り続ける。
 * 期待（docs/13 §3「乗り遅れた旅客の手荷物は積まない」、reconcileDepartureBags は 'cancelled' を paxGone とみなす）:
 *   欠航便の手荷物は欠航の確定後に終端状態（leftBehind / offloaded）へ移る。
 * 現状: reconcileDepartureBags は ground.ts の board / loadBags 作業からしか呼ばれず、機体が cannotOperate/diverted の便では呼ばれない。
 * 再現: seed 'b09-b', flightsPerDay 120, 12 時間後に SK205（ac_52, diverted）の手荷物 80 個が madeUp のまま。
 */
it('欠航した出発便の手荷物は欠航確定の 1 時間後までに終端状態になる', { timeout: 600_000 }, () => {
  const sim = createSimulation(createSampleAirport(), { seed: 'b09-b', settings: { flightsPerDay: 120 } });
  const stuck: string[] = [];
  for (let i = 0; i < 14 * 3600; i++) {
    stepSimulation(sim);
    if (i % 600 !== 0) continue;
    for (const f of Object.values(sim.state.flights)) {
      if (f.direction !== 'departure' || f.status !== 'cancelled' || f.pax.boarding !== 'closed') continue;
      // 搭乗締切（欠航による一括締め）から 1 時間以上経過した手荷物
      for (const id of sim.state.flightBags[f.id] ?? []) {
        const b = sim.state.bags[id]!;
        if (!BAG_FINAL_STATES.includes(b.state) && sim.state.now - b.since > 3600) stuck.push(`${f.number}:${b.id}:${b.state}`);
      }
    }
  }
  expect(stuck.slice(0, 5), `終端に達しない手荷物 ${stuck.length} 個（例）`).toEqual([]);
});
