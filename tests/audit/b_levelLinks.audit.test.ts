import { describe, expect, it } from 'vitest';
import { addSecondTerminal } from './b_helpers';
import { addTerminalTransitLink, updateEntity } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { terminalLinkCapacityPerHour } from '../../src/core/terminal/model';
import { reassignStand } from '../../src/core/sim/disruptions';
import { checkInvariants, checkPaxInvariants } from '../../src/core/sim/invariants';
import { setAreaClosed } from '../../src/core/sim/passengers';
import { SIM_START_SEC as T0 } from '../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { PAX_FINAL_STATES } from '../../src/core/sim/types';
import { must } from '../unit/helpers';

/**
 * docs/38 ID 11: 階層移動・連絡設備（docs/34, docs/35）。
 * 既存の単体テスト（terminalTransit / verticalTransport / multiTerminalPassengers）が個別機能を押さえているので、
 * ここでは「運航中の閉鎖・スポット変更・能力待ち」を複数シードで組み合わせ、予約の漏れ・能力超過・取りこぼしがないことを確認する。
 */
const groupsOf = (sim: Simulation, flightId: string) => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);

describe('11 垂直移動設備（エスカレーター）の閉鎖と再開', () => {
  for (const seed of ['b11-a', 'b11-b', 'b11-c']) {
    it(`seed=${seed}: 唯一の上下移動設備(ta_5)を 30 分閉鎖 → 待機が発生し、再開後 15 分以内に解消、不変条件・保存則を維持`, { timeout: 400_000 }, () => {
      const sim = createSimulation(createSampleAirport(), { seed, settings: { flightsPerDay: 100 } });
      let peakWaiting = 0;
      let waitingAfterReopen = -1;
      for (let i = 0; i < 4 * 3600; i++) {
        if (i === 3600) expect(setAreaClosed(sim, 'ta_5', true)).toBe(true);
        if (i === 3600 + 1800) setAreaClosed(sim, 'ta_5', false);
        stepSimulation(sim);
        if (i % 60 === 0) {
          const v = checkInvariants(sim);
          if (v.length) throw new Error(`t=${i}: ${v.slice(0, 3).join(' / ')}`);
          const waiting = sim.state.activePax.filter((id) => sim.state.paxGroups[id]!.state === 'waitingFacility').length;
          if (i >= 3600 && i < 5400) peakWaiting = Math.max(peakWaiting, waiting);
          if (i === 5400 + 900) waitingAfterReopen = waiting;
        }
      }
      expect(peakWaiting).toBeGreaterThan(10);
      expect(waitingAfterReopen).toBeLessThanOrEqual(3);
      expect(checkPaxInvariants(sim, true)).toEqual([]);
      for (const f of Object.values(sim.state.flights).filter((x) => x.direction === 'departure' && x.pax.boarding === 'closed')) {
        const gs = groupsOf(sim, f.id);
        const cancelled = gs.filter((g) => g.state === 'cancelled').reduce((s, g) => s + g.count, 0);
        expect(f.pax.boarded + f.pax.missed + cancelled).toBe(f.pax.booked);
      }
    });
  }
});

/** 2 ターミナル。std_1(fac_3) は B に接続する独立ゲート、std_2(fac_4) は A。A↔B の出発区域に連絡通路（能力 cap 人/時）を引く。 */
function transferLayout(cap: number) {
  const tt = addSecondTerminal(createSampleAirport());
  let l = must(updateEntity(tt.layout, 'fac_3', { props: { ...tt.layout.facilities.fac_3!.props, connectedTo: tt.t2 } })).layout;
  const waiting = (t: string) => Object.values(l.terminalAreas).find((a) => a.terminalId === t && a.kind === 'waiting')!.id;
  const linked = must(addTerminalTransitLink(l, { kind: 'walkway', fromAreaId: waiting(tt.t2), toAreaId: waiting(tt.t1), distanceM: 250, travelSec: 120, capacityPerHour: cap, bidirectional: true, allowedZones: ['departure'] }));
  l = linked.layout;
  return { ...tt, layout: l, linkId: Object.keys(l.terminalLinks ?? {})[0]!, areaB: waiting(tt.t2), areaA: waiting(tt.t1) };
}

describe('11 ターミナル間連絡通路: スポット変更による旅客の移動（複数シード）', () => {
  for (const [seed, switchAfter, cap] of [['b11-t1', 7500, 60], ['b11-t2', 8100, 40], ['b11-t3', 8700, 120]] as const) {
    it(`seed=${seed}: B のゲート便を ${switchAfter}s 後に A のスポットへ変更。能力 ${cap}/h を超える予約は発生せず、人数が保存され、予約が残らない`, { timeout: 400_000 }, () => {
      const { layout, linkId } = transferLayout(cap);
      const sim = createSimulation(layout, { seed, settings: { autoSchedule: false } });
      const ac = addTurnaround(sim, 'narrow180', T0 + 150 * 60, { departureAt: T0 + 5 * 3600, plan: { contractId: 'b11', destinationId: 'north', arrPax: 100, depPax: 170, standId: 'std_1', seats: 180 } });
      const dep = sim.state.flights[ac.departureFlightId]!;
      let switched = false;
      let maxUsage = 0;
      let sawWaitingTransport = false;
      for (let i = 0; i < 8 * 3600; i++) {
        if (!switched && sim.state.now >= T0 + switchAfter) {
          expect(reassignStand(sim, ac.id, 'std_2')).toEqual({ ok: true });
          switched = true;
        }
        stepSimulation(sim);
        const usage = sim.state.terminalTransit?.passengersByLink[linkId] ?? 0;
        maxUsage = Math.max(maxUsage, usage);
        if (i % 20 === 0) {
          const v = checkInvariants(sim);
          if (v.length) throw new Error(`seed=${seed} t=${sim.state.now - T0}: ${v.slice(0, 3).join(' / ')}`);
          if (groupsOf(sim, dep.id).some((g) => g.state === 'waitingTransport')) sawWaitingTransport = true;
        }
      }
      expect(switched).toBe(true);
      expect(maxUsage).toBeLessThanOrEqual(cap);
      const gs = groupsOf(sim, dep.id);
      expect(gs.reduce((s, g) => s + g.count, 0)).toBe(dep.pax.booked);
      expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
      for (const g of gs) {
        expect(PAX_FINAL_STATES).toContain(g.state);
        // 終了したグループは連絡設備の予約情報を持ち越さない
        expect(g.terminalLinkId, g.id).toBeUndefined();
        expect(g.terminalLinkWaitingId, g.id).toBeUndefined();
        expect(g.terminalLinkPaxAccumulated, g.id).toBeUndefined();
        expect(g.targetTerminalId ?? undefined, g.id).toBeUndefined();
        if (g.state === 'boarded') expect(g.terminalId).toBe(sim.ctx.terminal.gates[g.boardedGate!]?.terminalId);
      }
      expect(layout.terminalLinks![linkId] && terminalLinkCapacityPerHour(layout.terminalLinks![linkId]!)).toBe(cap);
      void sawWaitingTransport;
    });
  }

  it('通路の端点エリアを閉鎖して再開: 能力予約は残らず、再開後に全員が搭乗または乗り遅れで確定（保存則）', { timeout: 400_000 }, () => {
    const { layout, areaA } = transferLayout(60);
    const sim = createSimulation(layout, { seed: 'b11-close', settings: { autoSchedule: false } });
    const ac = addTurnaround(sim, 'narrow180', T0 + 150 * 60, { departureAt: T0 + 5 * 3600, plan: { contractId: 'b11', destinationId: 'north', arrPax: 100, depPax: 170, standId: 'std_1', seats: 180 } });
    const dep = sim.state.flights[ac.departureFlightId]!;
    let switched = false;
    for (let i = 0; i < 8 * 3600; i++) {
      const rel = sim.state.now - T0;
      if (!switched && rel >= 8000) { expect(reassignStand(sim, ac.id, 'std_2')).toEqual({ ok: true }); switched = true; }
      if (rel === 9600) setAreaClosed(sim, areaA, true);
      if (rel === 9600 + 900) setAreaClosed(sim, areaA, false);
      stepSimulation(sim);
      if (i % 20 === 0) {
        const v = checkInvariants(sim);
        if (v.length) throw new Error(`t=${rel}: ${v.slice(0, 3).join(' / ')}`);
      }
    }
    expect(switched).toBe(true);
    expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
    expect(dep.pax.boarded).toBeGreaterThan(dep.pax.booked * 0.5);
    for (const g of groupsOf(sim, dep.id)) expect(g.terminalLinkId ?? g.terminalLinkWaitingId ?? g.terminalLinkPaxAccumulated).toBeUndefined();
  });
});
