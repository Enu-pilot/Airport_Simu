import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany, contractsOf, type CompanyState } from '../../src/core/economy/company';
import { computeKpi } from '../../src/core/economy/ops';
import { analyzeDayPlan, planDay, type DayPlan, type PlanAnalysis } from '../../src/core/economy/planning';
import { airlineScorecard } from '../../src/core/economy/airlineScore';
import { createContext } from '../../src/core/sim/context';
import { addDisruption } from '../../src/core/sim/disruptions';
import { addTurnaround, createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import type { SimEvent } from '../../src/core/sim/types';
import { deriveAlerts, ALERT_VISIBLE } from '../../src/ui/operate/alerts';
import { importantEvents } from '../../src/ui/operate/events';
import { emptyLayout } from './helpers';

/** 12B-1（運航モードの画面）で使う、読み取り専用の導出関数のテスト */

function runFor(sim: ReturnType<typeof createSimulation>, sec: number): void {
  for (let i = 0; i < sec; i++) stepSimulation(sim);
}

describe('12B-1: 読み取り専用の集計・導出は状態を変えない', { timeout: 120_000 }, () => {
  const company = createSandboxCompany();
  const sim = createSimulation(createSampleAirport(), { company });
  for (let i = 0; i < 3; i++) addTurnaround(sim, 'narrow180', sim.state.now + 600 + i * 900);
  runFor(sim, 3 * 3600);

  it('computeKpi（本日の KPI カード）は呼び出し前後でシミュレーションと会社の状態を変えない', () => {
    const before = JSON.stringify(sim.state);
    const beforeCompany = JSON.stringify(sim.company);
    const a = computeKpi(sim, sim.company!);
    const b = computeKpi(sim, sim.company!);
    expect(JSON.stringify(sim.state)).toBe(before);
    expect(JSON.stringify(sim.company)).toBe(beforeCompany);
    expect(b).toEqual(a);
    expect(a.kpi.flights).toBeGreaterThan(0);
  });

  it('機体・旅客グループが欠けていても computeKpi は例外にならず、残りの集計は変わらない', () => {
    const copy = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    for (let i = 0; i < 3; i++) addTurnaround(copy, 'narrow180', copy.state.now + 600 + i * 900);
    runFor(copy, 3 * 3600);
    const base = computeKpi(copy, copy.company!);
    // 欠損を作る: 旅客グループの参照だけ残して実体を消す / 機体を消す
    const groupId = copy.state.activePax[0];
    if (groupId) delete copy.state.paxGroups[groupId];
    const flight = Object.values(copy.state.flights).find((f) => f.status === 'cancelled' || f.status === 'diverted' || f.direction === 'departure')!;
    delete copy.state.aircraft[flight.aircraftId];
    expect(() => computeKpi(copy, copy.company!)).not.toThrow();
    const after = computeKpi(copy, copy.company!);
    expect(after.kpi.avgWaitMin).toBe(base.kpi.avgWaitMin);
    expect(base.kpi.flights).toBeGreaterThan(0);
  });

  it('airlineScorecard と deriveAlerts も状態を変えず、同じ入力で同じ結果になる', () => {
    const c = sim.company!;
    const plan = planDay(c, c.day, sim.state.access?.factor ?? 1, sim.ctx.types);
    const analysis = analyzeDayPlan(plan, sim.ctx);
    const before = JSON.stringify([sim.state, c, plan, analysis]);
    const s1 = airlineScorecard({ company: c, ctx: sim.ctx, records: sim.state.analytics.records, plan, analysis });
    const s2 = airlineScorecard({ company: c, ctx: sim.ctx, records: sim.state.analytics.records, plan, analysis });
    const a1 = deriveAlerts(sim, c);
    expect(JSON.stringify([sim.state, c, plan, analysis])).toBe(before);
    expect(s2).toEqual(s1);
    expect(s1.length).toBeGreaterThan(0);
    expect(deriveAlerts(sim, c)).toEqual(a1);
  });
});

describe('12B-1: アラート（deriveAlerts）', () => {
  const make = () => createSimulation(createSampleAirport(), { company: createSandboxCompany() });

  it('滑走路閉鎖は重大で、同じ対象はまとめて count を増やす。閉じた key は除く', () => {
    const sim = make();
    const rwy = Object.keys(sim.ctx.layout.runways)[0]!;
    addDisruption(sim, { kind: 'runwayClosed', targetId: rwy, end: null });
    addDisruption(sim, { kind: 'runwayClosed', targetId: rwy, end: null });
    const r = deriveAlerts(sim, sim.company);
    const a = r.alerts.find((x) => x.key === `disruption:runwayClosed:${rwy}`)!;
    expect(a.severity).toBe('critical');
    expect(a.count).toBe(2);
    expect(a.actions).toEqual(expect.arrayContaining(['focus', 'repair']));
    expect(a.target).toEqual({ kind: 'runway', id: rwy });
    const dismissed = deriveAlerts(sim, sim.company, [a.key]);
    expect(dismissed.alerts.find((x) => x.key === a.key)).toBeUndefined();
    expect(dismissed.keys).toContain(a.key);
  });

  it('重大が注意より先、新しいものが先。障害のないときは空', () => {
    const sim = make();
    expect(deriveAlerts(sim, sim.company).alerts).toEqual([]);
    const rwy = Object.keys(sim.ctx.layout.runways)[0]!;
    addDisruption(sim, { kind: 'weather', targetId: null, weather: 'fog', end: null });
    addDisruption(sim, { kind: 'runwayClosed', targetId: rwy, end: null });
    const sev = deriveAlerts(sim, sim.company).alerts.map((a) => a.severity);
    expect(sev[0]).toBe('critical');
    expect(sev).toContain('warning');
    expect(ALERT_VISIBLE).toBe(3);
  });

  it('復旧した障害・古いイベントはアラートにならない', () => {
    const sim = make();
    const rwy = Object.keys(sim.ctx.layout.runways)[0]!;
    const d = addDisruption(sim, { kind: 'runwayClosed', targetId: rwy, end: sim.state.now + 60 });
    runFor(sim, 120);
    expect(d.status).toBe('resolved');
    expect(deriveAlerts(sim, sim.company).alerts).toEqual([]);
    // 直近 10 分より古いダイバートは対象外
    const ac = Object.values(sim.state.aircraft)[0]!;
    sim.state.events.push({ t: sim.state.now - 3600, kind: 'diverted', aircraftId: ac.id });
    expect(deriveAlerts(sim, sim.company).alerts).toEqual([]);
    sim.state.events.push({ t: sim.state.now, kind: 'diverted', aircraftId: ac.id });
    const r = deriveAlerts(sim, sim.company);
    expect(r.alerts[0]).toMatchObject({ key: `diverted:${ac.id}`, severity: 'critical', target: { kind: 'aircraft', id: ac.id } });
  });
});

describe('12B-1: 航空会社の評価カード（airlineScorecard）', () => {
  const emptyAnalysis = (): PlanAnalysis => ({ assignments: {}, issues: [], hourly: { movements: [], depPax: [] }, capacity: { movementsPerHour: 0, securityPerHour: 0, checkInPerHour: 0, turnarounds: 0 }, peakTurnarounds: 0 });
  const noPlan = (day = 0): DayPlan => ({ day, flights: [], dropped: [] });
  const input = (company: CompanyState, layout = createSampleAirport(), plan = noPlan(), analysis = emptyAnalysis()) => ({ company, ctx: createContext(layout), records: [], plan, analysis });
  const get = (list: ReturnType<typeof airlineScorecard>, id: string, key: string) => list.find((s) => s.airlineId === id)!.components.find((c) => c.key === key)!;

  it('料金倍率が高いと料金の要素が注意・不足になり、料金に敏感な航空会社ほど厳しい', () => {
    const c = createSandboxCompany();
    for (const k of Object.values(c.contracts)) k.feeDiscount = 0; // 割引がないときの判定
    expect(get(airlineScorecard(input(c)), 'AQ', 'fees').level).toBe('good');
    c.fees.landing = c.fees.terminal = c.fees.parking = 1.4;
    const r = airlineScorecard(input(c));
    expect(get(r, 'AQ', 'fees').level).toBe('bad'); // 敏感さ 0.8
    expect(get(r, 'SK', 'fees').level).toBe('bad'); // 敏感さ 0.3
    c.fees.landing = c.fees.terminal = c.fees.parking = 1.2;
    const r2 = airlineScorecard(input(c));
    expect(get(r2, 'AQ', 'fees').level).toBe('warn');
    expect(get(r2, 'SK', 'fees').level).toBe('warn');
    c.fees.landing = c.fees.terminal = c.fees.parking = 1.1;
    expect(get(airlineScorecard(input(c)), 'SK', 'fees').level).toBe('good');
  });

  it('契約の機種を運航できる施設がないと機材の対応が不足になり、足りないものに出る', () => {
    const c = createSandboxCompany();
    const k = contractsOf(c, 'active')[0] ?? contractsOf(c)[0]!;
    k.status = 'active';
    const r = airlineScorecard(input(c, emptyLayout()));
    const comp = get(r, k.airlineId, 'aircraft');
    expect(comp.level).toBe('bad');
    expect(comp.facts.names).toContain(k.typeId);
    const s = r.find((x) => x.airlineId === k.airlineId)!;
    expect(s.lacking.map((x) => x.key)).toContain('aircraft');
    expect(s.lacking.length).toBeLessThanOrEqual(2);
  });

  it('計画のスポット不足・運用時間に入らない契約を、その航空会社の便だけ数える', () => {
    const c = createSandboxCompany();
    const k = contractsOf(c, 'active')[0] ?? contractsOf(c)[0]!;
    k.status = 'active';
    const ctx = createContext(createSampleAirport());
    const plan = planDay(c, c.day, 1, ctx.types);
    const mine = plan.flights.filter((f) => f.airlineId === k.airlineId);
    expect(mine.length).toBeGreaterThan(0);
    const analysis = emptyAnalysis();
    analysis.issues.push({ code: 'STAND_CONFLICT', severity: 'error', keys: [mine[0]!.key] });
    plan.dropped.push(k.id);
    const r = airlineScorecard({ company: c, ctx, records: [], plan, analysis });
    expect(get(r, k.airlineId, 'stand')).toMatchObject({ level: 'bad', facts: { value: 1 } });
    expect(get(r, k.airlineId, 'slots').level).toBe('bad');
    const other = r.find((s) => s.airlineId !== k.airlineId && s.active);
    if (other) expect(get(r, other.airlineId, 'stand').level).not.toBe('bad');
  });

  it('実績の記録から定時性・折り返し・旅客体験を判定する（記録がなければ判定しない）', () => {
    const c = createSandboxCompany();
    const sim = createSimulation(createSampleAirport(), { company: c });
    expect(get(airlineScorecard(input(c)), 'SK', 'otp').level).toBe('n/a');
    const base = { aircraftId: 'ac_1', arrNumber: 'SK1', depNumber: 'SK2', airlineId: 'SK', contractId: null, typeId: 'B737-800W', result: 'completed' as const, causes: ['groundHandling'], arrRunway: null, depRunway: null, standId: null, gateId: null, arrScheduled: 1000, landedAt: 1000 + 40 * 60, blockIn: 5000, readyAt: 5000 + 90 * 60, blockOut: 12000, depScheduled: 12000 - 30 * 60, takeoffAt: null, airborneHoldSec: 0, taxiInSec: 0, taxiOutSec: 0, groundDistM: 0, groundStopSec: 0, seats: 100, paxBooked: 100, paxBoarded: 90, paxMissed: 10, paxArrived: 100, bagsLoaded: 90, bagsLeft: 10, taskSec: {}, taskBlockedSec: 0, revenue: 0, disruptions: [] };
    const r = airlineScorecard({ ...input(c), ctx: sim.ctx, records: [base] });
    const otp = get(r, 'SK', 'otp');
    expect(otp.level).toBe('bad');
    expect(otp.facts.names).toEqual(['groundHandling']);
    expect(get(r, 'SK', 'turnaround').level).toBe('bad');
    expect(get(r, 'SK', 'pax').level).toBe('bad');
    // 他の航空会社の記録は混ざらない
    expect(get(r, 'NP', 'otp').level).toBe('n/a');
  });
});

describe('12B-1: イベントカード', () => {
  it('細かい記録を除いて新しい順に最大 8 件', () => {
    const ev: SimEvent[] = [];
    for (let i = 0; i < 30; i++) ev.push({ t: i, kind: i % 2 ? 'state' : 'hold', aircraftId: 'a' });
    const r = importantEvents(ev);
    expect(r).toHaveLength(8);
    expect(r.every((e) => e.kind === 'hold')).toBe(true);
    expect(r[0]!.t).toBeGreaterThan(r[1]!.t);
  });
});
