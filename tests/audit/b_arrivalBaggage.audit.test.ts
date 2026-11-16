import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { BAG_FINAL_STATES, setEquipmentBroken } from '../../src/core/sim/baggage';
import { checkGroundInvariants, checkInvariants, checkPaxInvariants } from '../../src/core/sim/invariants';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';

/**
 * docs/38 ID 09: 到着旅客（降機 → 受取 → 退出）と手荷物（生成 → 仕分け → 積載 → 受取）の保存則。
 * 既知の不具合（欠航便の出発手荷物が終端状態に到達しない）は tests/audit/known-issues/b_bagsCancelled.repro.test.ts。
 */
function drive(sim: Simulation, seconds: number): void {
  for (let i = 0; i < seconds; i++) {
    stepSimulation(sim);
    if (i % 60 === 0) {
      const v = checkInvariants(sim);
      if (v.length) throw new Error(`seed=${sim.state.seed} t=${sim.state.now}: ${v.slice(0, 4).join(' / ')}`);
    }
    if (i % 3600 === 0) {
      const v = [...checkGroundInvariants(sim, true), ...checkPaxInvariants(sim, true)];
      if (v.length) throw new Error(`full seed=${sim.state.seed} t=${sim.state.now}: ${v.slice(0, 4).join(' / ')}`);
    }
  }
}

describe('09 手荷物と到着旅客の保存則（複数シード）', () => {
  for (const seed of ['b09-a', 'b09-b', 'b09-c']) {
    it(`seed=${seed}: ID一意・グループ手荷物数一致・積載1回・終端状態の集計が groundStats と一致`, { timeout: 400_000 }, () => {
      const sim = createSimulation(createSampleAirport(), { seed, settings: { flightsPerDay: 100 } });
      drive(sim, 8 * 3600);
      const { state } = sim;
      const bags = Object.values(state.bags);
      expect(bags.length).toBeGreaterThan(500);
      // ID一意性（Record のキーと bag.id が一致、flightBags/groupBags の重複なし）
      const fromFlights = Object.values(state.flightBags).flat();
      expect(new Set(fromFlights).size).toBe(fromFlights.length);
      expect(fromFlights.length).toBe(bags.length);
      const fromGroups = Object.values(state.groupBags).flat();
      expect(new Set(fromGroups).size).toBe(fromGroups.length);
      for (const b of bags) expect(state.bags[b.id]).toBe(b);
      // 集計の整合: 終端状態の個数 = groundStats
      const count = (s: string) => bags.filter((b) => b.state === s).length;
      expect(count('collected')).toBe(state.groundStats.bagsCollected);
      // 計画 1-09 で更新: 欠航便（旅客グループが cancelled）の手荷物は leftBehind になるが bagsLeftBehind には数えない
      const cancelledLeft = bags.filter((b) => b.state === 'leftBehind' && state.paxGroups[b.paxGroupId]?.state === 'cancelled').length;
      expect(count('leftBehind') - cancelledLeft).toBe(state.groundStats.bagsLeftBehind);
      // 積載は1回だけ。積載後に取り下ろされたものは offloaded
      const everLoaded = bags.filter((b) => b.history.some((h) => h.state === 'loaded')).length;
      expect(everLoaded).toBe(state.groundStats.bagsLoaded);
      expect(everLoaded - count('loaded')).toBe(state.groundStats.bagsOffloaded);
      // activeBags は終端状態を含まず、非終端の全手荷物を含む（漏れも重複もない）
      const nonFinal = bags.filter((b) => !BAG_FINAL_STATES.includes(b.state)).map((b) => b.id).sort();
      expect([...new Set(state.activeBags)].sort()).toEqual(nonFinal);
      expect(new Set(state.activeBags).size).toBe(state.activeBags.length);
      // 退出済みの到着グループは全手荷物を受け取り済み、到着手荷物は出発状態を取らない
      for (const g of Object.values(state.paxGroups)) {
        if (g.direction === 'arrival' && g.state === 'exited') for (const id of state.groupBags[g.id] ?? []) expect(state.bags[id]!.state, g.id).toBe('collected');
      }
      // 完了した到着便: 降機人数 = 退出人数、降機人数 = グループ合計
      for (const f of Object.values(state.flights).filter((x) => x.direction === 'arrival' && x.pax.generated && x.pax.exited === x.pax.deplaned && x.pax.deplaneRemaining === 0)) {
        const gs = (state.flightPax[f.id] ?? []).map((id) => state.paxGroups[id]!);
        expect(gs.reduce((s, g) => s + g.count, 0)).toBe(f.pax.deplaned);
        expect(gs.every((g) => g.state === 'exited')).toBe(true);
      }
      // 出発済みの便（欠航を除く）に非終端の手荷物は残らない
      for (const f of Object.values(state.flights).filter((x) => x.direction === 'departure' && x.status === 'completed')) {
        for (const b of (state.flightBags[f.id] ?? []).map((id) => state.bags[id]!)) expect(BAG_FINAL_STATES, `${b.id} ${b.state}`).toContain(b.state);
      }
    });
  }
});

describe('09 設備停止時の手荷物（積み残しの記録と保存則）', () => {
  it('仕分け設備を長時間止めても手荷物は消えず、積み残しは leftBehind として1回だけ記録される', { timeout: 400_000 }, () => {
    const layout = createSampleAirport();
    const sim = createSimulation(layout, { seed: 'b09-sorter', settings: { autoSchedule: false } });
    const stand = Object.keys(layout.stands).sort()[0]!;
    for (let k = 0; k < 3; k++) {
      addTurnaround(sim, 'narrow180', 20 * 60 + k * 900, { departureAt: 3 * 3600 + k * 900, plan: { contractId: 'b', destinationId: 'north', arrPax: 120, depPax: 150, standId: k === 0 ? stand : null, seats: 180 } });
    }
    const sorter = sim.ctx.sorters[0]!;
    setEquipmentBroken(sim, sorter.id, true, 5 * 3600);
    drive(sim, 7 * 3600);
    const { state } = sim;
    const dep = Object.values(state.flights).filter((f) => f.direction === 'departure');
    const bags = Object.values(state.bags).filter((b) => b.direction === 'departure');
    expect(bags.length).toBeGreaterThan(0);
    expect(dep.every((f) => f.status === 'completed' || f.status === 'cancelled')).toBe(true);
    // 仕分け不能 → 積み残し。積載・積み残し・取り下ろしの和が全個数
    const n = (s: string) => bags.filter((b) => b.state === s).length;
    expect(n('loaded') + n('leftBehind') + n('offloaded')).toBe(bags.length);
    expect(n('leftBehind')).toBe(state.groundStats.bagsLeftBehind);
    expect(n('leftBehind')).toBeGreaterThan(0);
    for (const b of bags.filter((x) => x.state === 'leftBehind')) expect(b.history.filter((h) => h.state === 'leftBehind').length).toBe(1);
    expect(bags.filter((b) => b.state === 'loaded').every((b) => b.loadedOn !== null)).toBe(true);
  });

  it('受取所のベルト故障中は受取が止まり、復旧後に全員が退出する（手荷物の取りこぼしなし）', { timeout: 400_000 }, () => {
    const layout = createSampleAirport();
    const sim = createSimulation(layout, { seed: 'b09-belt', settings: { autoSchedule: false } });
    addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 3 * 3600, plan: { contractId: 'b', destinationId: 'north', arrPax: 150, depPax: 100, standId: null, seats: 180 } });
    const claims = Object.values(layout.terminalAreas).filter((a) => a.kind === 'baggageClaim').map((a) => a.id);
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) setEquipmentBroken(sim, `belt:${c}`, true, 45 * 60);
    drive(sim, 5 * 3600);
    const arr = Object.values(sim.state.flights).find((f) => f.direction === 'arrival')!;
    expect(arr.pax.deplaned).toBeGreaterThan(0);
    expect(arr.pax.exited).toBe(arr.pax.deplaned);
    const bags = Object.values(sim.state.bags).filter((b) => b.direction === 'arrival');
    expect(bags.length).toBeGreaterThan(0);
    expect(bags.every((b) => b.state === 'collected')).toBe(true);
    // ベルト復旧までは受取が起きない: ベルトに出た時刻 >= 故障解除時刻
    expect(Math.min(...bags.map((b) => b.history.find((h) => h.state === 'onBelt')!.t))).toBeGreaterThanOrEqual(45 * 60);
  });
});
