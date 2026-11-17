import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState } from '../../../src/core/economy/company';
import { planDay } from '../../../src/core/economy/planning';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { DAY_SEC } from '../../../src/core/sim/rules';

function overnightCompany(seed = 'ovn-1'): CompanyState {
  const c = createSandboxCompany(seed);
  c.features = { overnight: true };
  addContract(c, {
    airlineId: 'SK', destinationId: 'KTA', typeId: 'B737-800', perDay: 2, window: 'evening',
    feeDiscount: 0.1, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, kind: 'overnight',
  });
  return c;
}

const run = (sim: Simulation, sec: number): void => {
  for (let i = 0; i < sec; i++) stepSimulation(sim);
};

describe('overnight: 夜間滞泊の計画（4B-1）', () => {
  it('overnight 契約は夕方着・翌朝発の便になり、翌日の計画に朝の出発を作らない', () => {
    const c = overnightCompany();
    const plan = planDay(c, 0);
    const ovn = plan.flights.filter((f) => f.overnight);
    expect(ovn).toHaveLength(2);
    for (const f of ovn) {
      expect(f.arrivalAt).toBeGreaterThanOrEqual((c.hours.closeMin - 240) * 60);
      expect(f.arrivalAt).toBeLessThanOrEqual((c.hours.closeMin - 30) * 60);
      expect(f.departureAt).toBeGreaterThan(DAY_SEC);
      const depMin = f.departureAt / 60 - 1440;
      expect(depMin).toBeGreaterThanOrEqual(c.hours.openMin + 30);
      expect(depMin).toBeLessThanOrEqual(c.hours.openMin + 30 + 90);
    }
    // 前日の滞泊が当日の分析に渡る（prevOvernight）。当日の計画の便は夕方着だけ
    const plan1 = planDay(c, 1);
    expect(plan1.prevOvernight).toHaveLength(2);
    expect(plan1.flights.every((f) => f.arrivalAt < DAY_SEC)).toBe(true);
    // 従来の契約だけの会社では滞泊の項目は出ない
    const plain = createSandboxCompany('ovn-plain');
    addContract(plain, {
      airlineId: 'SK', destinationId: 'KTA', typeId: 'B737-800', perDay: 2, window: 'evening',
      feeDiscount: 0.1, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0,
    });
    const pp = planDay(plain, 1);
    expect(pp.flights.every((f) => !f.overnight)).toBe(true);
    expect(pp.prevOvernight).toBeUndefined();
  });
});

describe('overnight: 記録と置き直し（4B-2）', () => {
  it('0:00 の締めで在泊機が記録され、停止 → 再開で同じ便名・機種・スポット・時刻に置き直される', () => {
    const c = overnightCompany();
    const sim = createSimulation(createSampleAirport(), { company: c, seed: 'ovn-1' });
    // 06:00 開始 → 翌日 01:00 まで（締めを 1 回通る）
    run(sim, DAY_SEC + 3600 - 6 * 3600);
    expect(c.day).toBe(1);
    expect(c.carryOver?.forDay).toBe(1);
    expect(c.carryOver?.aircraft).toHaveLength(2);
    const recs = c.carryOver!.aircraft;

    // 停止 → 再開（新しい sim。会社は締め後の状態）
    const c2 = structuredClone(c);
    const sim2 = createSimulation(createSampleAirport(), { company: c2, seed: 'ovn-1' });
    const materialized = Object.values(sim2.state.flights).filter((f) => f.carryOver);
    expect(materialized).toHaveLength(2);
    // 置き直された出発便は「今日」（sim 日 0）の朝。当日の計画が作る滞泊の出発は翌朝（sim 日 1）なので混ざらない
    const deps = Object.values(sim2.state.flights).filter((f) => f.overnight && f.direction === 'departure' && f.scheduled < DAY_SEC);
    expect(deps).toHaveLength(2);
    for (const rec of recs) {
      const dep = deps.find((f) => f.basedAircraftId === rec.basedAircraftId && f.destinationId === rec.destinationId && (f.scheduled % DAY_SEC) === rec.depSecOfDay);
      expect(dep, `記録 ${rec.sourceAircraftId} の出発便が置き直される`).toBeDefined();
      const ac = sim2.state.aircraft[dep!.aircraftId]!;
      expect(ac.typeId).toBe(rec.typeId);
      expect(ac.standId).toBe(rec.standId);
      expect(sim2.state.standAssignments[rec.standId]).toBe(ac.id);
      expect(ac.state).toBe('parked');
    }
    // 合成の到着便は旅客を持たない
    for (const f of materialized) {
      expect(f.pax.booked).toBe(0);
      expect(f.status).toBe('completed');
    }
    // 記録は消費される
    expect(c2.carryOver).toBeUndefined();
  }, 300000);

  it('スポットがすべて使えないと、出発便は欠航になりログが残る', () => {
    const c = overnightCompany('ovn-nostand');
    c.carryOver = {
      forDay: 0,
      aircraft: [{
        sourceAircraftId: 'ac_99', typeId: 'B737-800', airlineId: 'SK', contractId: null, destinationId: 'KTA',
        callsign: 'SK900', depNumber: 901, standId: 'no-such-stand', parkedBeforeSec: 3600, depSecOfDay: 23400, depDelaySec: 0, depPax: 100,
      }],
    };
    const layout = createSampleAirport();
    for (const st of Object.values(layout.stands)) st.buildState = 'planned';
    const sim = createSimulation(layout, { company: c, seed: 'ovn-nostand' });
    const dep = Object.values(sim.state.flights).find((f) => f.overnight && f.direction === 'departure');
    expect(dep?.status).toBe('cancelled');
    expect(sim.state.events.some((e) => e.kind === 'cannotOperate' && e.note === 'overnightNoStand')).toBe(true);
  });
});
