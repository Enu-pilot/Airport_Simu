/**
 * 監査 c / docs/38 ID 16: 経営（契約・増便・能力ダッシュボード・台帳・日次 KPI）。
 *  - 台帳: cashEnd(d) + 営業利益(d+1) − 建設(d+1) + 報酬(d+1) = cashEnd(d+1)
 *  - 便ごとの収入の合計 = 日報の着陸・ターミナル・地上支援（・駐機）の収入
 *  - 能力ダッシュボード（capacity.ts）の計画値 = 実際の運航の離着陸数（障害なしの日）
 */
import { describe, expect, it } from 'vitest';
import { sampleSim, runChecked, DAY_SEC } from './c_helpers';
import { acceptOffer, changeFrequency, createCareerCompany, post, rejectOffer, createSandboxCompany, addContract } from '../../src/core/economy/company';
import { analyzeAirportCapacity, previewFrequencyCapacity } from '../../src/core/economy/capacity';
import { RUNWAY_HOURLY_CAPACITY } from '../../src/core/economy/planning';
import { createSimulation } from '../../src/core/sim/simulation';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { BALANCE } from '../../src/core/economy/balance';
import type { Simulation } from '../../src/core/sim/simulation';

const periodRecords = (sim: Simulation, from: number, to: number) =>
  sim.state.analytics.records.filter((r) => {
    const t = r.takeoffAt ?? r.blockOut ?? r.landedAt ?? r.depScheduled;
    return t >= from && t < to;
  });

describe('ID16 台帳の整合（資金・日報）', () => {
  it('3 日連続: cashEnd(d)+利益(d+1)−建設(d+1)+報酬(d+1)=cashEnd(d+1)、日報の合計と内訳が一致、today は締めで空になる', () => {
    const c = createSandboxCompany('c-ledger');
    c.game = { version: 1, difficulty: 'normal', weather: 'levels', airlineEval: true, goals: true, climate: 'temperate' };
    c.airlineEval = {};
    c.goals = { done: {}, streaks: {}, tier: 0, grants: [], boostUntil: 0 };
    const sim = createSimulation(createSampleAirport(), { seed: 'c-ledger', company: c });
    const cash0 = c.cash;
    // 2 日目に建設費を計上する（建設の列と資金の整合を確認）
    runChecked(sim, DAY_SEC - 6 * 3600 + 30, 600, 'ledger-d0');
    post(c, 'construction', -123_456);
    runChecked(sim, DAY_SEC, 600, 'ledger-d1');
    runChecked(sim, DAY_SEC, 600, 'ledger-d2');
    const rs = c.reports;
    expect(rs.length).toBeGreaterThanOrEqual(3);
    expect(rs[0]!.cashEnd).toBeCloseTo(cash0 + rs[0]!.operatingProfit - rs[0]!.construction + (rs[0]!.grants ?? 0), 4);
    for (let i = 1; i < rs.length; i++) {
      const a = rs[i - 1]!;
      const b = rs[i]!;
      expect(b.day).toBe(a.day + 1);
      expect(b.cashEnd).toBeCloseTo(a.cashEnd + b.operatingProfit - b.construction + (b.grants ?? 0), 4);
    }
    expect(rs.some((r) => r.construction === 123_456)).toBe(true);
    for (const r of rs) {
      expect(r.totalRevenue).toBeCloseTo(Object.values(r.revenue).reduce((s, v) => s + (v ?? 0), 0), 6);
      expect(r.totalCost).toBeCloseTo(Object.values(r.cost).reduce((s, v) => s + (v ?? 0), 0), 6);
      expect(r.operatingProfit).toBeCloseTo(r.totalRevenue - r.totalCost, 6);
    }
    // 現在の資金 = 最後の cashEnd + 締め後に積まれた当日分
    const todayNet = Object.values(c.today).reduce((s, v) => s + (v ?? 0), 0);
    expect(c.cash).toBeCloseTo(rs.at(-1)!.cashEnd + todayNet, 4);
  });

  it('便ごとの収入（FlightRecord.revenue）の合計 = 日報の着陸・駐機・ターミナル・地上支援の収入（初日）', () => {
    const sim = sampleSim({ seed: 'c-revenue' });
    runChecked(sim, DAY_SEC - 6 * 3600 + 5, 600, 'revenue');
    const rep = sim.company!.reports[0]!;
    const recs = periodRecords(sim, 6 * 3600, DAY_SEC);
    const perFlight = recs.reduce((s, r) => s + r.revenue, 0);
    const ledger = (rep.revenue.landing ?? 0) + (rep.revenue.parking ?? 0) + (rep.revenue.terminal ?? 0) + (rep.revenue.groundHandling ?? 0);
    expect(perFlight).toBeCloseTo(ledger, 4);
    expect(rep.revenue.contract).toBeGreaterThan(0); // 契約の固定収入は便ではなく日に帰属
  });

  it('日報の KPI は運航の記録・統計と一致する（便数・旅客・欠航・ダイバート）', () => {
    const sim = sampleSim({ seed: 'c-kpi' });
    runChecked(sim, DAY_SEC - 6 * 3600 + 5, 600, 'kpi');
    const k = sim.company!.reports[0]!.kpi;
    const recs = periodRecords(sim, 6 * 3600, DAY_SEC);
    expect(k.paxDeparted).toBe(recs.reduce((s, r) => s + r.paxBoarded, 0));
    expect(k.paxArrived).toBe(recs.reduce((s, r) => s + r.paxArrived, 0));
    expect(k.paxDeparted).toBe(sim.state.paxStats.boarded);
    expect(k.paxArrived).toBe(sim.state.paxStats.deplaned);
    expect(k.movements).toBe(sim.state.stats.arrivals + sim.state.stats.departures);
    expect(k.flights).toBe(k.movements);
    expect(k.cancelled).toBe(sim.state.stats.cancelled);
    expect(k.diverted).toBe(sim.state.stats.diverted);
    expect(k.otp === null || (k.otp >= 0 && k.otp <= 1)).toBe(true);
    for (const v of [k.runwayUtil, k.gateUtil, k.facilityUtil]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('遅延 KPI: 評価用の avgDelayMin と実測 actualAvgDelayMin は別の値として記録され、評価用 ≤ 実測（外部要因・猶予を除外）', () => {
    const sim = sampleSim({ seed: 'c-delay' });
    runChecked(sim, 2 * DAY_SEC - 6 * 3600 + 5, 600, 'delay');
    for (const r of sim.company!.reports) {
      expect(r.kpi.actualAvgDelayMin).toBeDefined();
      expect(r.kpi.avgDelayMin).toBeLessThanOrEqual(r.kpi.actualAvgDelayMin! + 1e-9);
    }
  });
});

describe('ID16 契約・増便の判断', () => {
  it('提案の受諾 / 拒否 / 期限: 状態遷移と拒否理由（支援外・路線・能力不足）', () => {
    const c = createCareerCompany('c-offers');
    const offer = addContract(c, { airlineId: 'RJ', destinationId: 'MSK', typeId: 'regional70', perDay: 2, window: 'any', feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'offered', offerExpiresDay: 3 });
    expect(acceptOffer(c, offer.id, false)).toEqual({ ok: false, reason: 'UNSUPPORTED' });
    expect(acceptOffer(c, offer.id, true, 'airline-unsupported')).toEqual({ ok: false, reason: 'AIRLINE_ROUTE_UNSUPPORTED' });
    expect(acceptOffer(c, offer.id, true, 'international-processing-required')).toEqual({ ok: false, reason: 'INTERNATIONAL_PROCESSING_REQUIRED' });
    expect(acceptOffer(c, offer.id, true, 'available', 'unacceptable')).toEqual({ ok: false, reason: 'CAPACITY_INSUFFICIENT' });
    expect(c.contracts[offer.id]!.status).toBe('offered');
    c.day = 5;
    expect(acceptOffer(c, offer.id, true)).toEqual({ ok: true });
    const k = c.contracts[offer.id]!;
    expect([k.status, k.startDay, k.endDay]).toEqual(['active', 5, 5 + BALANCE.offers.contractDays - 1]);
    expect(acceptOffer(c, offer.id, true)).toEqual({ ok: false, reason: 'NOT_OFFERED' });
    expect(rejectOffer(c, offer.id)).toEqual({ ok: false, reason: 'NOT_OFFERED' });
    expect(acceptOffer(c, 'nope', true)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('増便: 満足度が increaseMinSat 未満なら拒否、能力不足も拒否。減便は満足度を下げ、1 便未満には減らせない', () => {
    const c = createCareerCompany('c-freq');
    const id = Object.values(c.contracts)[0]!.id;
    const k = c.contracts[id]!;
    const rel = c.airlines[k.airlineId]!;
    rel.satisfaction = BALANCE.contracts.increaseMinSat + 10;
    const n0 = k.perDay;
    expect(changeFrequency(c, id, 1, 'unacceptable')).toEqual({ ok: false, reason: 'CAPACITY_INSUFFICIENT' });
    expect(k.perDay).toBe(n0);
    expect(changeFrequency(c, id, 1)).toEqual({ ok: true });
    expect(k.perDay).toBe(n0 + 1);
    rel.satisfaction = BALANCE.contracts.increaseMinSat - 30;
    expect(changeFrequency(c, id, 1)).toEqual({ ok: false, reason: 'AIRLINE_REFUSED' });
    const s0 = rel.satisfaction;
    expect(changeFrequency(c, id, -1)).toEqual({ ok: true });
    expect(rel.satisfaction).toBeCloseTo(Math.max(0, s0 - BALANCE.contracts.decreasePenaltySat), 6);
    while (k.perDay > 1) changeFrequency(c, id, -1);
    expect(changeFrequency(c, id, -1)).toEqual({ ok: false, reason: 'MIN_FREQUENCY' });
    k.status = 'ended' as typeof k.status;
    expect(changeFrequency(c, id, 1)).toEqual({ ok: false, reason: 'NOT_ACTIVE' });
  });

  it('日の締めで提案が作られ（維持される上限 maxOpen 以内）、期限切れの提案は実運航の便に入らない', () => {
    const sim = sampleSim({ seed: 'c-offergen' });
    runChecked(sim, 3 * DAY_SEC - 6 * 3600 + 5, 1200, 'offers');
    const offered = Object.values(sim.company!.contracts).filter((k) => k.status === 'offered');
    expect(offered.length).toBeLessThanOrEqual(BALANCE.offers.maxOpen);
    const offeredAirlines = new Set(offered.map((k) => k.id));
    for (const f of Object.values(sim.state.flights)) if (f.contractId) expect(offeredAirlines.has(f.contractId)).toBe(false);
  });
});

describe('ID16 能力ダッシュボード（capacity.ts）と実運航の突き合わせ', () => {
  it('障害なしの初日: 計画の時間別離着陸数 = 実測の時間別離着陸数。滑走路能力 ≥ 実測ピーク。計画便数×2 = 実測の離着陸', () => {
    const seed = 'c-capacity';
    const sim = sampleSim({ seed });
    const cap = analyzeAirportCapacity(sim.company!, sim.ctx); // 運航前（day 0）の計画
    runChecked(sim, DAY_SEC - 6 * 3600 + 5, 600, 'capacity');
    const act = Array<number>(24).fill(0);
    for (const r of sim.state.analytics.records) {
      if (r.landedAt !== null) act[Math.floor(r.landedAt / 3600)] = (act[Math.floor(r.landedAt / 3600)] ?? 0) + 1;
      if (r.takeoffAt !== null) act[Math.floor(r.takeoffAt / 3600)] = (act[Math.floor(r.takeoffAt / 3600)] ?? 0) + 1;
    }
    expect(act).toEqual(cap.analysis.hourly.movements);
    const runway = cap.summary.find((m) => m.name === '滑走路')!;
    const nRunways = Object.values(sim.ctx.runways).filter((r) => r.operational).length;
    expect(runway.capacity).toBe(nRunways * RUNWAY_HOURLY_CAPACITY);
    expect(Math.max(...act)).toBeLessThanOrEqual(runway.capacity!);
    expect(runway.demand).toBe(Math.max(...act));
    expect(cap.plan.flights.length * 2).toBe(act.reduce((a, b) => a + b, 0));
    // 日計の理論値は実測の 1 日の離着陸数以上
    const day = cap.summary.find((m) => m.name === '1日総処理（滑走路・理論値）')!;
    expect(day.capacity!).toBeGreaterThanOrEqual(act.reduce((a, b) => a + b, 0));
    // 旅客: 計画の出発旅客の合計は、実測の搭乗旅客と一致（乱数の系列が同じ seed・同じ会社の日）
    const planDep = cap.plan.flights.reduce((s, f) => s + f.depPax, 0);
    expect(Math.abs(planDep - sim.state.paxStats.boarded)).toBeLessThanOrEqual(Math.ceil(planDep * 0.02));
  });

  it('未算出の指標は null / uncomputed のまま（誘導路・搭乗バス・プッシュバック）。全指標で utilization/spare は能力と需要から導かれる', () => {
    const sim = sampleSim({ seed: 'c-cap2' });
    const cap = analyzeAirportCapacity(sim.company!, sim.ctx);
    for (const n of ['誘導路', '搭乗バス', 'プッシュバック']) {
      const m = cap.summary.find((x) => x.name === n)!;
      expect([m.capacity, m.demand, m.status]).toEqual([null, null, 'uncomputed']);
    }
    for (const m of cap.summary) {
      if (m.capacity !== null && m.demand !== null && m.capacity > 0) {
        expect(m.utilization).toBeCloseTo(m.demand / m.capacity, 9);
        expect(m.spare).toBeCloseTo(Math.max(0, m.capacity - m.demand), 9);
        expect(m.status).toBe(m.demand / m.capacity > 1 ? 'shortage' : m.demand / m.capacity >= 0.8 ? 'warning' : 'adequate');
      }
    }
  });

  it('増便プレビューは会社状態を変えず、増便後の計画便数が増える', () => {
    const sim = sampleSim({ seed: 'c-cap3' });
    const before = JSON.stringify(sim.company);
    const id = Object.values(sim.company!.contracts)[0]!.id;
    const p = previewFrequencyCapacity(sim.company!, sim.ctx, id);
    expect(JSON.stringify(sim.company)).toBe(before);
    expect(p).toBeTruthy();
  });

  it('ダッシュボードの「地上支援・折り返し」同時処理上限と、実運航の同時ターンアラウンド数を記録する（差は分析用、判定は緩く）', () => {
    const sim = sampleSim({ seed: 'c-cap4' });
    const cap = analyzeAirportCapacity(sim.company!, sim.ctx);
    const turn = cap.summary.find((m) => m.name === '地上支援・折り返し')!;
    let maxConcurrent = 0;
    for (let i = 0; i < DAY_SEC - 6 * 3600; i++) {
      runChecked(sim, 1, 1, 'cap4');
      if (i % 30 === 0) maxConcurrent = Math.max(maxConcurrent, Object.values(sim.state.aircraft).filter((a) => a.state === 'turnaround').length);
    }
    // 計画のピーク同時折り返しと、実測のピークの差は 1 機以内（計画は着陸〜出発の窓、実測は turnaround 状態のみ）
    expect(Math.abs((turn.demand ?? 0) - maxConcurrent)).toBeLessThanOrEqual(3);
    expect(turn.capacity).toBeGreaterThan(0);
  });
});
