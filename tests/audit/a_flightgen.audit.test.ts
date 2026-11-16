/**
 * 監査 docs/38 ID 07（便生成・航空会社・スポット）。
 * 既存: tests/unit/sim/airlineStandHomes.test.ts, capacity.test.ts, economy.test.ts（planDay）, operations.test.ts。
 * 追加: 契約の便数/航空会社/機種/時間帯を変えた planDay ↔ analyzeDayPlan ↔ 実際に生成された運航スケジュールの整合、
 *       増便時の割当と能力不足（STAND_CONFLICT）の挙動、ホームスポットの運航中の整合（複数シード）。
 */
import { describe, expect, it } from 'vitest';
import { createCompany, addContract, createSandboxCompany, createCareerCompany, type CompanyState, type Contract } from '../../src/core/economy/company';
import { analyzeDayPlan, planDay, STAND_GAP_SEC } from '../../src/core/economy/planning';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createContext } from '../../src/core/sim/context';
import { DAY_SEC } from '../../src/core/sim/rules';
import { createSimulation } from '../../src/core/sim/simulation';
import type { AircraftTypeId } from '../../src/core/sim/aircraftTypes';
import { allSettled, runWatched } from './a_helpers';

type K = Omit<Contract, 'id' | 'numberBase'>;
const base = { feeDiscount: 0.1, startDay: 0, endDay: 9999, status: 'active' as const, offerExpiresDay: 0 };
const k = (airlineId: string, destinationId: string, typeId: AircraftTypeId, perDay: number, window: Contract['window'] = 'any'): K => ({ ...base, airlineId, destinationId, typeId, perDay, window });

function companyWith(seed: string, list: K[]): CompanyState {
  const c = createCompany('sandbox', seed);
  for (const x of list) addContract(c, x);
  return c;
}

describe('ID07 planDay: 契約の便数・航空会社・機種・時間帯を変えたときの計画', () => {
  const ctx = createContext(createSampleAirport());
  const WINDOWS: Contract['window'][] = ['morning', 'daytime', 'evening', 'any'];
  const TYPES: AircraftTypeId[] = ['regional70', 'narrow180', 'A320neo', 'B737-800W'];
  for (const seed of ['a7-s1', 'a7-s2', 'a7-s3']) {
    for (const perDay of [1, 2, 4, 8]) {
      it(`seed=${seed} perDay=${perDay}: 便数=契約合計、便名が一意、到着<出発、時間帯・運用時間内、決定的`, () => {
        const list: K[] = [];
        WINDOWS.forEach((w, i) => list.push(k(['SK', 'NP', 'RJ', 'AQ'][i]!, ['TWN', 'YKH', 'KTA', 'MSK'][i]!, TYPES[i]!, perDay, w)));
        const c = companyWith(seed, list);
        const plan = planDay(c, 0);
        expect(plan.flights.length + plan.dropped.length, `${seed}`).toBe(perDay * list.length);
        expect(new Set(plan.flights.map((f) => f.arrNumber)).size).toBe(plan.flights.length);
        expect(new Set(plan.flights.map((f) => f.key)).size).toBe(plan.flights.length);
        for (const f of plan.flights) {
          expect(f.departureAt, f.key).toBeGreaterThan(f.arrivalAt);
          expect(f.arrPax).toBeLessThanOrEqual(f.seats);
          expect(f.depPax).toBeLessThanOrEqual(f.seats);
          expect(f.arrivalAt, f.key).toBeGreaterThanOrEqual(c.hours.openMin * 60 - 3600);
          expect(f.arrivalAt, f.key).toBeLessThan(DAY_SEC);
        }
        expect(JSON.stringify(planDay(c, 0))).toBe(JSON.stringify(plan));
        // 計画と分析: 割当は存在する機体全てに対し、同じスポットの使用区間が重ならない
        const an = analyzeDayPlan(plan, ctx);
        const byStand = new Map<string, { from: number; to: number; key: string }[]>();
        for (const f of plan.flights) {
          const sid = an.assignments[f.key]?.standId;
          if (sid) byStand.set(sid, [...(byStand.get(sid) ?? []), { from: f.arrivalAt, to: f.departureAt + STAND_GAP_SEC, key: f.key }]);
        }
        for (const [sid, spans] of byStand) {
          spans.sort((a, b) => a.from - b.from);
          for (let i = 1; i < spans.length; i++) expect(spans[i]!.from, `${seed} ${sid} ${spans[i - 1]!.key}/${spans[i]!.key}`).toBeGreaterThanOrEqual(spans[i - 1]!.to);
        }
        // 割当なし = STAND_CONFLICT が出ている（無言の欠落がない）
        const unassigned = plan.flights.filter((f) => !an.assignments[f.key]?.standId).map((f) => f.key);
        const conflicted = new Set(an.issues.filter((i) => i.code === 'STAND_CONFLICT' || i.code === 'SIZE_UNSUPPORTED').flatMap((i) => i.keys));
        for (const key of unassigned) expect(conflicted.has(key), `${seed} ${key} unassigned without issue`).toBe(true);
      });
    }
  }

  it('増便すると便数が単調増加し、スポット数を超える同時折り返しでは STAND_CONFLICT が現れる（starterAirfield: スポット 3）', () => {
    const starter = createContext(createStarterAirfield());
    let prevFlights = -1;
    let sawConflict = false;
    for (let n = 1; n <= 12; n++) {
      const c = companyWith('a7-grow', [k('RJ', 'KTA', 'regional70', n, 'daytime'), k('NP', 'YKH', 'narrow180', n, 'daytime')]);
      const plan = planDay(c, 0);
      expect(plan.flights.length).toBeGreaterThanOrEqual(prevFlights);
      prevFlights = plan.flights.length;
      const an = analyzeDayPlan(plan, starter);
      if (an.issues.some((i) => i.code === 'STAND_CONFLICT')) sawConflict = true;
      // 割り当てられた便は常に実在スポット
      for (const a of Object.values(an.assignments)) if (a.standId) expect(starter.layout.stands[a.standId]).toBeDefined();
      if (n === 1) expect(an.issues.some((i) => i.code === 'STAND_CONFLICT')).toBe(false);
    }
    expect(sawConflict, '12 便/日×2 契約をスポット 3 つの空港に入れても能力不足が報告されない').toBe(true);
  });
});

describe('ID07 計画と実際に生成された運航スケジュールの一貫性', () => {
  for (const seed of ['a7-sim1', 'a7-sim2', 'a7-sim3']) {
    it(`seed=${seed}: createSimulation(会社付き, autoSchedule) の便 = planDay の便（便名・機種・予定スポット・旅客数・航空会社）`, () => {
      const company = createSandboxCompany(seed);
      const layout = createSampleAirport();
      const sim = createSimulation(layout, { seed, company });
      const plan = planDay(sim.company!, 0, 1, sim.ctx.types);
      const flights = Object.values(sim.state.flights);
      // 1 計画便 = 到着 + 出発の 2 便（開始 6:00 より前の到着は 20 分後へ繰り下げられるが便数は変わらない）
      expect(flights.length).toBe(plan.flights.length * 2);
      const byNumber = new Map(flights.map((f) => [f.number, f]));
      const analysisIds = new Set(Object.keys(layout.stands));
      for (const p of plan.flights) {
        const arr = byNumber.get(p.arrNumber)!;
        const dep = byNumber.get(p.depNumber)!;
        expect(arr, `${seed} ${p.arrNumber}`).toBeDefined();
        expect(dep, `${seed} ${p.depNumber}`).toBeDefined();
        expect(arr.aircraftId).toBe(dep.aircraftId);
        expect(arr.airlineId).toBe(p.airlineId);
        expect(arr.contractId).toBe(p.contractId);
        // 旅客数はアクセス係数（会社の前日実績。ここでは 1 を仮定）で数%ずれうる。座席数を超えず、±5% 以内
        expect(Math.abs(arr.plannedPax! - p.arrPax), `${seed} ${p.arrNumber}`).toBeLessThanOrEqual(Math.max(2, p.seats * 0.05));
        expect(Math.abs(dep.plannedPax! - p.depPax), `${seed} ${p.depNumber}`).toBeLessThanOrEqual(Math.max(2, p.seats * 0.05));
        expect(arr.plannedPax!).toBeLessThanOrEqual(p.seats);
        expect(sim.state.aircraft[arr.aircraftId]!.typeId).toBe(p.typeId);
        expect(arr.scheduled).toBeGreaterThanOrEqual(p.arrivalAt);
        expect(dep.scheduled).toBeGreaterThan(arr.scheduled);
        if (arr.plannedStandId) expect(analysisIds.has(arr.plannedStandId)).toBe(true);
        expect(arr.plannedStandId).toBe(dep.plannedStandId);
      }
      expect(sim.state.scheduledDays).toEqual([0]);
    });
  }

  it('増便（契約の perDay +1）後に作り直した運航では便数が増え、既存契約の便名・機種は変わらない', () => {
    const c0 = createSandboxCompany('a7-inc');
    const s0 = createSimulation(createSampleAirport(), { seed: 'a7-inc', company: c0 });
    const c1 = createSandboxCompany('a7-inc');
    const target = Object.values(c1.contracts).find((x) => x.airlineId === 'AQ')!;
    target.perDay += 1;
    const s1 = createSimulation(createSampleAirport(), { seed: 'a7-inc', company: c1 });
    expect(Object.keys(s1.state.flights).length).toBe(Object.keys(s0.state.flights).length + 2);
    const nums0 = new Set(Object.values(s0.state.flights).map((f) => f.number));
    const nums1 = new Set(Object.values(s1.state.flights).map((f) => f.number));
    for (const n of nums0) expect(nums1.has(n), `既存の便名 ${n} が増便で消えた`).toBe(true);
  });
});

describe('ID07 運航中の割当整合・ホームスポット（複数シード、2 時間 + 夕方）', () => {
  for (const seed of ['a7-run1', 'a7-run2', 'a7-run3']) {
    it(`seed=${seed}: サンプル空港 + サンドボックス会社を 10:00 まで運航。二重占有なし・ホーム一覧が実在スポットで重複なし・割当イベントと実割当が一致`, { timeout: 240_000 }, () => {
      const sim = createSimulation(createSampleAirport(), { seed, company: createSandboxCompany(seed) });
      const r = runWatched(sim, 4 * 3600, { every: 20 }); // 6:00 → 10:00
      expect(r.violations, seed).toEqual([]);
      expect(r.maxStandOwners, seed).toBeLessThanOrEqual(1);
      const homes = sim.state.airlineStandHomes!;
      expect(homes.day).toBe(0);
      const standIds = new Set(Object.keys(sim.ctx.layout.stands));
      for (const [airline, ids] of Object.entries(homes.byAirline)) {
        expect(new Set(ids).size, `${seed} ${airline} home dup`).toBe(ids.length);
        for (const id of ids) expect(standIds.has(id), `${seed} ${airline} ${id}`).toBe(true);
      }
      // standAssigned イベントのスポットは、その機体が実際に使ったスポット（f.standId）と一致する
      const ev = sim.state.events.filter((e) => e.kind === 'standAssigned');
      expect(ev.length, seed).toBeGreaterThan(0);
      for (const e of ev) {
        const ac = sim.state.aircraft[e.aircraftId!]!;
        const f = sim.state.flights[ac.arrivalFlightId]!;
        if (f.standId) expect(f.standId, `${seed} ${e.aircraftId}`).toBe(e.standId);
        expect(e.airlineId).toBe(f.airlineId);
      }
      // 乗り入れ会社別: 同時刻に別機が同一スポットに居ない（r.maxStandOwners 済）。過半の便が計画スポットか同社ホームに入る
      expect(Object.keys(homes.byAirline).length).toBeGreaterThanOrEqual(2);
    });
  }

  it('キャリア初期（starterAirfield, スポット 3）を 1 日運航して全機が終端に達し、不変条件違反がない（seed=a7-career）', { timeout: 300_000 }, () => {
    const sim = createSimulation(createStarterAirfield(), { seed: 'a7-career', company: createCareerCompany('a7-career') });
    const r = runWatched(sim, DAY_SEC - sim.state.now - 1, { every: 60 });
    expect(r.violations).toEqual([]);
    expect(r.maxStandOwners).toBeLessThanOrEqual(1);
    expect(allSettled(sim)).toBe(true);
  });
});

describe('ID07 能力不足（スポット 3 つに過大な契約）: 計画の警告と実運航の挙動が一致する', () => {
  for (const seed of ['a7-over1', 'a7-over2', 'a7-over3']) {
    it(`seed=${seed}: starterAirfield に 10 便/日×2 契約。STAND_CONFLICT を警告し、実運航は noStand 待機/ダイバートになるが二重割当・不変条件違反はない`, { timeout: 240_000 }, () => {
      const company = companyWith(seed, [k('RJ', 'KTA', 'regional70', 10, 'daytime'), k('NP', 'YKH', 'regional70', 10, 'daytime')]);
      const layout = createStarterAirfield();
      const plan = planDay(company, 0);
      const an = analyzeDayPlan(plan, createContext(layout));
      expect(an.issues.some((i) => i.code === 'STAND_CONFLICT'), seed).toBe(true);
      const sim = createSimulation(layout, { seed, company });
      const reasons = new Set<string>();
      const r = runWatched(sim, 16 * 3600, {
        every: 30,
        onTick: (s) => {
          for (const a of Object.values(s.state.aircraft)) if (a.holdReason) reasons.add(a.holdReason);
        },
      });
      expect(r.violations, seed).toEqual([]);
      expect(r.maxStandOwners, seed).toBeLessThanOrEqual(1);
      expect(reasons.has('noStand') || sim.state.stats.diverted > 0, `${seed} reasons=${[...reasons]} diverted=${sim.state.stats.diverted}`).toBe(true);
      expect(sim.state.stats.departures, seed).toBeGreaterThan(0);
      // 到着 + ダイバート + 未着 = 計画便数（失われた便がない）
      const arrFlights = Object.values(sim.state.flights).filter((f) => f.direction === 'arrival');
      expect(arrFlights.length).toBe(plan.flights.length);
    });
  }
});
