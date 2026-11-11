import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { analyzeLayout } from '../../src/core/validation/validate';
import { deleteEntity, placeFacility, placeStand, placeTerminalArea, setBuildState } from '../../src/core/layout/operations';
import type { AirportLayout } from '../../src/core/model/types';
import { BALANCE } from '../../src/core/economy/balance';
import { chargeConstruction, constructionCost, layoutValue, scaleFactor } from '../../src/core/economy/construction';
import {
  acceptOffer,
  addContract,
  changeFrequency,
  contractsOf,
  createCareerCompany,
  createCompany,
  generateOffers,
  setFees,
  setHours,
  updateContracts,
  type CompanyState,
  type Contract,
} from '../../src/core/economy/company';
import { analyzeDayPlan, planDay, type DayPlan } from '../../src/core/economy/planning';
import { checkBankruptcy, dailyFixedCosts, landingFee, parkingFee, settleDay } from '../../src/core/economy/ops';
import { createContext } from '../../src/core/sim/context';
import { createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { checkInvariants } from '../../src/core/sim/invariants';
import { DAY_SEC } from '../../src/core/sim/rules';
import { must } from './helpers';

// ---------------------------------------------------------------- 補助

const facilityOf = (l: AirportLayout, kind: string) => Object.values(l.facilities).find((f) => f.kind === kind)!;
const areaOf = (l: AirportLayout, kind: string) => Object.values(l.terminalAreas).find((a) => a.kind === kind)!;

/** 次の 0:00 の日次締めまで進める（不変条件も確認） */
function runDay(sim: Simulation): void {
  const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
  while (sim.state.now <= target) {
    stepSimulation(sim);
    const v = checkInvariants(sim);
    if (v.length > 0) throw new Error(`t=${sim.state.now}: ${v.join(' / ')}`);
  }
}

function careerSim(layout = createStarterAirfield(), company: CompanyState = createCareerCompany()): Simulation {
  return createSimulation(layout, { company });
}

const lastReport = (c: CompanyState) => c.reports[c.reports.length - 1]!;

function contract(c: CompanyState, k: Partial<Contract> & Pick<Contract, 'airlineId' | 'typeId' | 'perDay'>): Contract {
  return addContract(c, {
    destinationId: 'KTA',
    window: 'any',
    feeDiscount: 0,
    startDay: 0,
    endDay: 29,
    status: 'active',
    offerExpiresDay: 0,
    ...k,
  });
}

/** 契約1件だけの会社 */
function companyWith(k: Partial<Contract> & Pick<Contract, 'airlineId' | 'typeId' | 'perDay'>): CompanyState {
  const c = createCompany('career', 'test');
  contract(c, k);
  return c;
}

// ---------------------------------------------------------------- 開始レイアウト・建設費

describe('小さな飛行場と建設費', () => {
  const layout = createStarterAirfield();

  it('開始レイアウトはエラー・警告がなく、M級まで運航できる', () => {
    const a = analyzeLayout(layout);
    expect(a.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(Object.values(a.operability).every((o) => o.operable)).toBe(true);
    expect(layoutValue(layout)).toBeGreaterThan(0);
  });

  // 建設費には空港の規模による割増（docs/15 §5）が掛かる
  const k = scaleFactor(layout);

  it('スポットを建設すると区分の建設費、撤去すると25%が戻る', () => {
    const r = must(placeStand(layout, { x: 63, y: 42 }, 'M', 180, 'operational', '4'));
    expect(constructionCost(layout, r.layout)).toBe(Math.round(BALANCE.construction.stand.M * k));
    const removed = must(deleteEntity(r.layout, r.created[0]!)).layout;
    expect(constructionCost(r.layout, removed)).toBe(Math.round(-BALANCE.construction.stand.M * BALANCE.construction.refundRate * scaleFactor(r.layout)));
  });

  it('計画中の施設は無料で、建設中・運用中に変えた時点で支払う', () => {
    const r = must(placeFacility(layout, 'hangar', { x: 90, y: 60 }, { buildState: 'planned' }));
    expect(constructionCost(layout, r.layout)).toBe(0);
    const built = must(setBuildState(r.layout, 'operational', r.created)).layout;
    expect(constructionCost(r.layout, built)).toBe(Math.round(BALANCE.construction.facility.hangar! * k));
  });

  it('資金不足: 建設費が現金を超える編集は受け付けず、現金は変わらない', () => {
    const c = createCompany('career');
    c.cash = 500_000;
    const r = must(placeFacility(layout, 'hangar', { x: 90, y: 60 }));
    const res = chargeConstruction(c, layout, r.layout);
    expect(res).toMatchObject({ ok: false, reason: 'INSUFFICIENT_FUNDS', cost: Math.round(1_200_000 * k) });
    expect(c.cash).toBe(500_000);
    // 撤去（払い戻し）は資金不足でも可能
    const gate = facilityOf(layout, 'gate');
    const removed = chargeConstruction(c, layout, must(deleteEntity(layout, gate.id)).layout);
    expect(removed.ok).toBe(true);
    expect(c.cash).toBeGreaterThan(500_000);
    expect(c.today.construction).toBeGreaterThan(0);
  });

  it('資金が足りれば支払い、当日の建設費として記録される', () => {
    const c = createCompany('career');
    const r = must(placeStand(layout, { x: 63, y: 42 }, 'M', 180, 'operational', '4'));
    expect(chargeConstruction(c, layout, r.layout).ok).toBe(true);
    expect(c.cash).toBe(BALANCE.initialCash.career - Math.round(BALANCE.construction.stand.M * k));
    expect(c.today.construction).toBe(-Math.round(BALANCE.construction.stand.M * k));
  });
});

// ---------------------------------------------------------------- 運航計画

describe('運航計画', () => {
  const ctx = createContext(createStarterAirfield());

  it('契約から1日分の便を決定的に作り、便数・時間・旅客数が契約と運用時間に従う', () => {
    const c = createCareerCompany();
    const a = planDay(c, 3);
    expect(planDay(c, 3)).toEqual(a);
    expect(a.flights.length).toBe(3);
    for (const f of a.flights) {
      expect(f.arrivalAt).toBeGreaterThanOrEqual(c.hours.openMin * 60);
      expect(f.departureAt).toBeLessThanOrEqual(c.hours.closeMin * 60);
      expect(f.depPax).toBeGreaterThan(0);
      expect(f.arrNumber).toMatch(/^(RJ|HB)\d+$/);
    }
    // 日が変われば別の揺らぎ
    expect(planDay(c, 4).flights.map((f) => f.arrivalAt)).not.toEqual(a.flights.map((f) => f.arrivalAt));
  });

  it('増便: 便数を増やすと計画の便が増える（満足度が低いと航空会社が応じない）', () => {
    const c = createCareerCompany();
    const k = contractsOf(c, 'active')[0]!;
    c.airlines[k.airlineId]!.satisfaction = 80;
    expect(changeFrequency(c, k.id, 1)).toEqual({ ok: true });
    expect(planDay(c, 0).flights.length).toBe(4);
    c.airlines[k.airlineId]!.satisfaction = 30;
    expect(changeFrequency(c, k.id, 1)).toEqual({ ok: false, reason: 'AIRLINE_REFUSED' });
  });

  it('料金を上げると搭乗率（計画旅客数）が下がる', () => {
    const c = createCareerCompany();
    const base = planDay(c, 0).flights.reduce((s, f) => s + f.depPax, 0);
    setFees(c, { terminal: 2 });
    expect(planDay(c, 0).flights.reduce((s, f) => s + f.depPax, 0)).toBeLessThan(base);
  });

  it('スポットとゲートを仮割り当てし、競合がなければ問題なし', () => {
    const r = analyzeDayPlan(planDay(createCareerCompany(), 0), ctx);
    expect(r.issues).toEqual([]);
    for (const a of Object.values(r.assignments)) {
      expect(a.standId).not.toBeNull();
      expect(a.gateId).not.toBeNull();
    }
  });

  it('スケジュール競合: 朝に集中した便がスポット数を超えると STAND_CONFLICT', () => {
    const c = companyWith({ airlineId: 'AQ', typeId: 'narrow180', perDay: 12, window: 'morning' });
    const r = analyzeDayPlan(planDay(c, 0), ctx);
    const conflict = r.issues.find((i) => i.code === 'STAND_CONFLICT');
    expect(conflict?.keys.length).toBeGreaterThan(0);
    // 割り当てできた便同士はスポットの使用時間が重ならない
    const plan = planDay(c, 0);
    const byStand = new Map<string, [number, number][]>();
    for (const f of plan.flights) {
      const s = r.assignments[f.key]!.standId;
      if (s) byStand.set(s, [...(byStand.get(s) ?? []), [f.arrivalAt, f.departureAt]]);
    }
    for (const spans of byStand.values()) {
      spans.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
    }
  });

  it('運航できない機種（L級）は SIZE_UNSUPPORTED、時間帯に収まらない便は OUTSIDE_HOURS', () => {
    const c = companyWith({ airlineId: 'SK', typeId: 'wide300', perDay: 1 });
    expect(analyzeDayPlan(planDay(c, 0), ctx).issues.map((i) => i.code)).toContain('SIZE_UNSUPPORTED');
    const d = companyWith({ airlineId: 'RJ', typeId: 'regional70', perDay: 2, window: 'evening' });
    setHours(d, { openMin: 6 * 60, closeMin: 13 * 60 });
    const plan = planDay(d, 0);
    expect(plan.flights).toEqual([]);
    expect(analyzeDayPlan(plan, ctx).issues.map((i) => i.code)).toContain('OUTSIDE_HOURS');
  });

  it('処理能力の超過: 滑走路・保安検査・地上支援', () => {
    const c = createCompany('career');
    const k = contract(c, { airlineId: 'RJ', typeId: 'regional70', perDay: 1 });
    // 08時台に到着が集中する計画を直接作る
    const flights = Array.from({ length: 32 }, (_, i) => ({
      key: `x:${i}`,
      contractId: k.id,
      airlineId: 'RJ',
      destinationId: 'KTA',
      typeId: 'regional70' as const,
      arrNumber: `RJ${i}`,
      depNumber: `RJ${i}x`,
      arrivalAt: 8 * 3600 + i * 60,
      departureAt: 10 * 3600 + i * 60,
      arrPax: 60,
      depPax: 60,
      seats: 70,
      inboundDelaySec: 0,
    }));
    const plan: DayPlan = { day: 0, flights, dropped: [] };
    const r = analyzeDayPlan(plan, ctx);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain('RUNWAY_OVERLOAD');
    expect(codes).toContain('SECURITY_OVERLOAD');
    expect(codes).toContain('GROUND_OVERLOAD');
    expect(r.issues.find((i) => i.code === 'RUNWAY_OVERLOAD')!.detail).toBe('08時');
    expect(r.hourly.movements[8]).toBe(32);
  });
});

// ---------------------------------------------------------------- 収入

describe('収入の計算', () => {
  it('着陸料: 重量 × 単価 × 料金倍率 × ピーク割増 × 契約割引', () => {
    const c = createCompany('career');
    const ac = { typeId: 'narrow180' as const };
    expect(landingFee(c, ac, 12 * 3600, 1)).toBe(78 * 150);
    expect(landingFee(c, ac, 8 * 3600, 1)).toBe(78 * 150 * 1.25);
    setFees(c, { landing: 1.5 });
    expect(landingFee(c, ac, 12 * 3600, 0.9)).toBeCloseTo(78 * 150 * 1.5 * 0.9);
  });

  it('駐機料: 無料時間（2時間）を超えた分を1時間単位で切り上げ', () => {
    const c = createCompany('career');
    const ac = { typeId: 'narrow180' as const };
    expect(parkingFee(c, ac, 2 * 3600, 1)).toBe(0);
    expect(parkingFee(c, ac, 2 * 3600 + 60, 1)).toBe(1000);
    expect(parkingFee(c, ac, 4.5 * 3600, 1)).toBe(3000);
  });

  it('運航実績から着陸料・ターミナル使用料・地上支援料が計上される', () => {
    const c = companyWith({ airlineId: 'RJ', typeId: 'regional70', perDay: 2, feeDiscount: 0.2 });
    const sim = careerSim(createStarterAirfield(), c);
    runDay(sim);
    const flights = Object.values(sim.state.flights);
    const arrivals = flights.filter((f) => f.direction === 'arrival' && f.actual !== null);
    const deps = flights.filter((f) => f.direction === 'departure' && f.actual !== null);
    expect(arrivals.length).toBe(2);
    expect(deps.length).toBe(2);
    const r = lastReport(c);
    const expectedLanding = arrivals.reduce((s, f) => s + Math.round(landingFee(c, { typeId: 'regional70' }, f.actual!, 0.8)), 0);
    expect(r.revenue.landing).toBe(expectedLanding);
    const boarded = deps.reduce((s, f) => s + f.pax.boarded, 0);
    const deplaned = arrivals.reduce((s, f) => s + f.pax.deplaned, 0);
    expect(boarded).toBeGreaterThan(0);
    // 端数は人数ごとに丸める
    expect(r.revenue.terminal!).toBeCloseTo(boarded * 120 * 0.8 + deplaned * 60 * 0.8, -2);
    expect(r.revenue.groundHandling).toBe(2 * BALANCE.fees.groundHandling.S * 0.8);
    expect(r.revenue.contract).toBeGreaterThan(0);
    expect(r.revenue.carPark).toBeGreaterThan(0);
    expect(r.kpi.paxDeparted).toBe(boarded);
  });

  it('店舗・飲食店があると、時間に余裕のある旅客が立ち寄って売上が出る', () => {
    const base = createStarterAirfield();
    const terminal = facilityOf(base, 'terminal').id;
    let l = must(placeTerminalArea(base, terminal, 1, 'shop', { x: 62, y: 51 }, { w: 2, h: 2, name: '売店' })).layout;
    l = must(placeTerminalArea(l, terminal, 1, 'restaurant', { x: 64, y: 51 }, { w: 2, h: 2, name: 'カフェ' })).layout;
    const withShop = careerSim(l);
    runDay(withShop);
    const r = lastReport(withShop.company!);
    expect((r.revenue.retail ?? 0) + (r.revenue.dining ?? 0)).toBeGreaterThan(0);
    const without = careerSim();
    runDay(without);
    expect(lastReport(without.company!).revenue.retail).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 費用

describe('費用の計算', () => {
  const layout = createStarterAirfield();

  it('1日あたりの固定費は施設・人員の規模から決まる', () => {
    const f = dailyFixedCosts(createContext(layout));
    expect(f.salary).toBe(10 * 1200 + 2 * 2000);
    expect(f.vehicles).toBe((1 + 2 + 2 + 1 + 1 + 1) * 300);
    expect(f.counterStaff).toBe(6 * 800 + 2 * 2500 + 3 * 600);
    expect(f.utilities).toBe(20 * 8 * 2 * 30);
    expect(f.maintenance).toBe(Math.round(layoutValue(layout) * 0.0003 * scaleFactor(layout)));
  });

  it('丸1日運航すると固定費が1日分、地上作業費が作業ごとに計上される', () => {
    const sim = careerSim(layout);
    // 1日目は 06:00 開始なので、2日目（丸1日）で確認する
    runDay(sim);
    runDay(sim);
    const r = lastReport(sim.company!);
    expect(r.partial).toBe(false);
    expect(Math.abs(r.cost.salary! - 16000)).toBeLessThanOrEqual(24);
    const done = Object.values(sim.state.tasks).filter((t) => t.state === 'done' && t.doneAt! >= DAY_SEC && t.doneAt! < 2 * DAY_SEC);
    const expected = done.reduce((s, t) => s + (BALANCE.taskCost[t.kind] ?? 0) + (t.kind === 'inspect' && t.note ? BALANCE.taskCost.defect! : 0), 0);
    expect(r.cost.groundOps).toBe(expected);
    expect(r.operatingProfit).toBe(r.totalRevenue - r.totalCost);
  });

  it('途中で運航を止めると、その日を経過時間分だけ締める（固定費・契約料は按分）', () => {
    const sim = careerSim(layout);
    const c = sim.company!;
    for (let i = 0; i < 6 * 3600; i++) stepSimulation(sim);
    const r = settleDay(sim, true)!;
    expect(r.partial).toBe(true);
    expect(Math.abs(r.cost.salary! - 4000)).toBeLessThanOrEqual(6);
    expect(Math.abs(r.revenue.contract! - (3 * 3000) / 4)).toBeLessThanOrEqual(6);
    expect(c.day).toBe(1);
    expect(c.reports.length).toBe(1);
  });

  it('経営破綻: 現金のマイナスが30日続くとキャリアモードは破綻（サンドボックスは続行）', () => {
    const c = createCompany('career');
    const s = createCompany('sandbox');
    c.cash = -1;
    s.cash = -1;
    for (let i = 0; i < BALANCE.bankruptcyDays - 1; i++) {
      checkBankruptcy(c);
      checkBankruptcy(s);
    }
    expect(c.bankrupt).toBe(false);
    checkBankruptcy(c);
    checkBankruptcy(s);
    expect(c.bankrupt).toBe(true);
    expect(s.bankrupt).toBe(false);
  });
});

// ---------------------------------------------------------------- 運航・容量・遅延が KPI と収支に与える影響

describe('運航の状況と KPI・収支', { timeout: 120_000 }, () => {
  const run = (layout: AirportLayout, c: CompanyState, days = 2) => {
    const sim = careerSim(layout, c);
    for (let d = 0; d < days; d++) runDay(sim);
    return sim;
  };
  const baseline = run(createStarterAirfield(), createCareerCompany());
  const baseReport = lastReport(baseline.company!);

  it('基準: 小さな飛行場の初期契約はすべて定時に運航でき、利益が出る', () => {
    expect(baseReport.kpi.flights).toBe(6);
    expect(baseReport.kpi.otp).toBe(1);
    expect(baseReport.kpi.missedPax).toBe(0);
    expect(baseReport.operatingProfit).toBeGreaterThan(0);
    expect(baseReport.kpi.paxSatisfaction!).toBeGreaterThan(80);
    expect(baseline.company!.rating).toBeGreaterThan(50);
  });

  it('増便すると収入は増えるが、スポット・地上支援が混雑して遅延や地上作業時間が増える', () => {
    const c = createCareerCompany();
    contract(c, { airlineId: 'AQ', typeId: 'narrow180', perDay: 6, window: 'morning' });
    contract(c, { airlineId: 'HB', typeId: 'regional70', perDay: 4, window: 'morning' });
    const busy = lastReport(run(createStarterAirfield(), c).company!);
    expect(busy.kpi.flights).toBeGreaterThan(baseReport.kpi.flights);
    expect(busy.totalRevenue).toBeGreaterThan(baseReport.totalRevenue);
    expect(busy.kpi.gateUtil).toBeGreaterThan(baseReport.kpi.gateUtil);
    expect(busy.kpi.avgDelayMin).toBeGreaterThan(baseReport.kpi.avgDelayMin);
    expect(busy.kpi.otp!).toBeLessThan(1);
    // 混雑による補償や地上作業費が増え、収入ほどには利益が伸びない
    expect(busy.totalCost).toBeGreaterThan(baseReport.totalCost);
    expect(busy.operatingProfit / busy.kpi.flights).toBeLessThan(baseReport.totalRevenue / baseReport.kpi.flights);
  });

  it('施設の容量不足: 保安検査レーンが足りないと待ち時間・乗り遅れが増え、補償と満足度に響く', () => {
    const l = structuredClone(createStarterAirfield());
    areaOf(l, 'security').props.lanes = 1;
    areaOf(l, 'security').props.serviceSecPerPax = 60;
    const c = createCareerCompany();
    const short = lastReport(run(l, c).company!);
    expect(short.kpi.avgWaitMin).toBeGreaterThan(baseReport.kpi.avgWaitMin);
    expect(short.kpi.missedPax).toBeGreaterThan(0);
    expect(short.cost.compensation ?? 0).toBeGreaterThan(0);
    expect(short.kpi.paxSatisfaction!).toBeLessThan(baseReport.kpi.paxSatisfaction!);
    expect(short.revenue.terminal!).toBeLessThan(baseReport.revenue.terminal!);
  });

  it('遅延の影響: 作業員が不足すると地上作業が遅れ、定時率・航空会社満足度・空港評価が下がる', () => {
    // 折り返しが重なる計画で、作業員だけを減らして比べる
    const plan = () => {
      const c = createCareerCompany();
      contract(c, { airlineId: 'AQ', typeId: 'narrow180', perDay: 4, window: 'morning' });
      return c;
    };
    const full = run(createStarterAirfield(), plan());
    const l = structuredClone(createStarterAirfield());
    Object.assign(facilityOf(l, 'gseBase').props, { staff: 3, beltLoaders: 1, baggageTractors: 1 });
    const short = run(l, plan());
    const a = lastReport(full.company!);
    const r = lastReport(short.company!);
    expect(r.kpi.avgGroundMin).toBeGreaterThan(a.kpi.avgGroundMin);
    expect(r.kpi.avgDelayMin).toBeGreaterThan(a.kpi.avgDelayMin);
    expect(r.kpi.otp!).toBeLessThan(a.kpi.otp!);
    expect(r.kpi.airlineSatisfaction!).toBeLessThan(a.kpi.airlineSatisfaction!);
    expect(short.company!.rating).toBeLessThan(full.company!.rating);
  });

  it('同じ条件なら日報は完全に一致する（決定性）', () => {
    const again = run(createStarterAirfield(), createCareerCompany());
    expect(again.company!.reports).toEqual(baseline.company!.reports);
    expect(again.company!.cash).toBe(baseline.company!.cash);
  });
});

// ---------------------------------------------------------------- 航空会社・契約

describe('航空会社と契約', () => {
  it('定時率が低い日が続くと満足度が下がり、撤退する', () => {
    const c = createCareerCompany();
    const k = contractsOf(c, 'active').find((x) => x.airlineId === 'RJ')!;
    for (let d = 0; d < 6 && k.status === 'active'; d++) {
      updateContracts(c, { RJ: { flights: 4, onTime: 0, paxBoarded: 100, missedPax: 20, leftBags: 5, cancelled: 1 } });
      c.day++;
    }
    expect(k.status).toBe('withdrawn');
  });

  it('満足度が高いまま契約満了日を迎えると増便して更新する', () => {
    const c = createCareerCompany();
    const k = contractsOf(c, 'active')[0]!;
    c.airlines[k.airlineId]!.satisfaction = 90;
    c.day = k.endDay;
    const before = k.perDay;
    updateContracts(c, { [k.airlineId]: { flights: 4, onTime: 4, paxBoarded: 200, missedPax: 0, leftBags: 0, cancelled: 0 } });
    expect(k.status).toBe('active');
    expect(k.perDay).toBe(before + 1);
    expect(k.endDay).toBeGreaterThan(c.day);
  });

  it('提案は決定的に作られ、運航できない機種の提案は受け入れられない', () => {
    const a = createCompany('career', 's');
    const b = createCompany('career', 's');
    a.rating = b.rating = 90;
    for (let i = 0; i < 5; i++) {
      generateOffers(a, ['regional70', 'narrow180']);
      generateOffers(b, ['regional70', 'narrow180']);
    }
    expect(a.contracts).toEqual(b.contracts);
    const offers = contractsOf(a, 'offered');
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.length).toBeLessThanOrEqual(BALANCE.offers.maxOpen);
    expect(acceptOffer(a, offers[0]!.id, false)).toEqual({ ok: false, reason: 'UNSUPPORTED' });
    expect(acceptOffer(a, offers[0]!.id, true)).toEqual({ ok: true });
    expect(a.contracts[offers[0]!.id]!.status).toBe('active');
  });
});
