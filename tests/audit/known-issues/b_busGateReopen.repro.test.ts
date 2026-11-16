import { expect, it } from 'vitest';
import { busTwoTerminalLayout } from '../b_helpers';
import { addDisruption } from '../../../src/core/sim/disruptions';
import { SIM_START_SEC as T0 } from '../../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation } from '../../../src/core/sim/simulation';

/**
 * 既知の不具合（docs/38 ID 10/12, docs/35 §5.2・docs/29 §7「搭乗開始前ならゲートを選び直す」）:
 * 明示バスゲート（remoteBoarding='bus'）が一時的に閉鎖されると、applyBusDeparture が p.gateId=null にし、
 * reconcileDepartureGate(null) で未入場グループの terminalId が null になる。再開後に p.gateId が復帰しても
 * reconcileDepartureGate が呼ばれない（passengers.ts: `if (p.generated && previousGateId && previousGateId !== p.gateId)` の
 * previousGateId が null で偽）ため、グループの terminalId は null のまま → 'stranded/noGate' → 全員 'unreachable' で乗り遅れる。
 * シナリオ: busTwoTerminalLayout, std_8 を 'bus'+fac_10 に固定、T0+25分〜T0+85分だけ fac_10 を閉鎖、出発は T0+3h。
 * 期待: 閉鎖は出発の 1 時間 35 分以上前に終わるので、旅客の大半が搭乗できる。現状: 54 グループ（150 人）全員が乗り遅れ。
 */
it('明示バスゲートの一時閉鎖が出発よりかなり前に終われば、旅客は再開後に搭乗できる', { timeout: 300_000 }, () => {
  const { layout, t1 } = busTwoTerminalLayout();
  layout.stands.std_8!.remoteBoarding = 'bus';
  layout.stands.std_8!.busGateId = 'fac_10';
  const sim = createSimulation(layout, { seed: 'b10-div', settings: { autoSchedule: false } });
  const ac = addTurnaround(sim, 'narrow180', T0 + 20 * 60, { departureAt: T0 + 3 * 3600, plan: { contractId: 'b', destinationId: 'north', arrPax: 120, depPax: 150, standId: 'std_8', seats: 180 } });
  const dep = sim.state.flights[ac.departureFlightId]!;
  let closed = false;
  let nullAfterReopen = 0;
  for (let i = 0; i < 4 * 3600; i++) {
    if (!closed && sim.state.now >= T0 + 1500) { addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_10', end: T0 + 1500 + 3600 }); closed = true; }
    stepSimulation(sim);
    if (sim.state.now === T0 + 6000) {
      // 再開(T0+5100)後: ゲートは fac_10 に復帰している → 未入場グループの terminalId も復帰しているべき
      expect(dep.pax.gateId).toBe('fac_10');
      nullAfterReopen = (sim.state.flightPax[dep.id] ?? []).map((id) => sim.state.paxGroups[id]!).filter((g) => g.terminalId !== t1 && g.state !== 'boarded').length;
    }
  }
  expect(nullAfterReopen).toBe(0);
  expect(dep.pax.boarded).toBeGreaterThan(dep.pax.booked * 0.8);
});
