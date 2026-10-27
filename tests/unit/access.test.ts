import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { analyzeLayout } from '../../src/core/validation/validate';
import { addRoadPath, placeFacility, purchaseLand, updateEntity, type PlaceFacilityOptions } from '../../src/core/layout/operations';
import type { AirportLayout, FacilityKind } from '../../src/core/model/types';
import { Terrain } from '../../src/core/model/types';
import { terrainAt } from '../../src/core/model/site';
import { analyzeAccess, type AccessMode } from '../../src/core/access/model';
import { congestionDelayMin } from '../../src/core/access/runtime';
import { BALANCE } from '../../src/core/economy/balance';
import { chargeConstruction, constructionCost, scaleFactor } from '../../src/core/economy/construction';
import { createCareerCompany, createCompany, setFees, type CompanyState } from '../../src/core/economy/company';
import { advanceProjects, applyCompletedProjects, prepareCareerEdit, startClosure, syncProjects } from '../../src/core/economy/expansion';
import { analyzeDayPlan, planDay } from '../../src/core/economy/planning';
import { dailyFixedCosts } from '../../src/core/economy/ops';
import { createContext } from '../../src/core/sim/context';
import { createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { checkInvariants, checkPaxInvariants } from '../../src/core/sim/invariants';
import { DAY_SEC } from '../../src/core/sim/rules';
import { must } from './helpers';

// ---------------------------------------------------------------- 補助

/**
 * 小さな飛行場（ターミナル x46〜65・y49〜56、一般道路 y=57 と x=76）の周りに交通施設を置く。
 *   タクシー (36,58)、ホテル (39,58)、バス (30,58)、駅 (68,58) + 鉄道 x=70 を南の敷地外周 (y=105) まで、職員用駐車場 (77,58)
 */
function withFacility(l: AirportLayout, kind: FacilityKind, x: number, y: number, opts: PlaceFacilityOptions = {}): AirportLayout {
  return must(placeFacility(l, kind, { x, y }, opts)).layout;
}
const withRail = (l: AirportLayout) => must(addRoadPath(l, [{ x: 70, y: 61 }, { x: 70, y: 105 }], { roadClass: 'rail', name: '空港線' })).layout;
const withStation = (l: AirportLayout, props = {}) => withFacility(l, 'railStation', 68, 58, { props });
const facilityOf = (l: AirportLayout, kind: string) => Object.values(l.facilities).find((f) => f.kind === kind)!;

function runDay(sim: Simulation, full = false): void {
  const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
  while (sim.state.now <= target) {
    stepSimulation(sim);
    const v = [...checkInvariants(sim), ...(full ? checkPaxInvariants(sim, false) : [])];
    if (v.length > 0) throw new Error(`t=${sim.state.now}: ${v.join(' / ')}`);
  }
}
const lastKpi = (c: CompanyState) => c.reports[c.reports.length - 1]!.kpi;
const lastReport = (c: CompanyState) => c.reports[c.reports.length - 1]!;

/** 手段の分担率を固定して運航する（容量のテスト用） */
function simWithShares(layout: AirportLayout, shares: Partial<Record<AccessMode, number>>, c = createCareerCompany()): Simulation {
  const sim = createSimulation(layout, { company: c });
  const acc = sim.state.access!;
  for (const m of Object.keys(acc.shares) as AccessMode[]) acc.shares[m] = shares[m] ?? 0;
  acc.available = (Object.keys(shares) as AccessMode[]).filter((m) => (shares[m] ?? 0) > 0);
  return sim;
}

// ---------------------------------------------------------------- アクセスの分析

describe('アクセス手段と接続', () => {
  const base = createStarterAirfield();

  it('小さな飛行場は自家用車・送迎・徒歩だけ使え、アクセス係数はほぼ 1', () => {
    const a = analyzeAccess(base);
    expect(a.entrances).toBe(1);
    expect(a.modes.car.available && a.modes.dropoff.available && a.modes.walk.available).toBe(true);
    expect(a.modes.taxi.reason).toBe('noFacility');
    expect(a.modes.rail.reason).toBe('noFacility');
    expect(a.factor).toBeGreaterThan(0.95);
    expect(a.factor).toBeLessThan(1.05);
    const shares = Object.values(a.modes).reduce((s, m) => s + m.share, 0);
    expect(shares).toBeCloseTo(1);
  });

  it('接続されていない駅: 鉄道線がなければ使われず（警告）、需要も増えない。外周まで線路を敷くと使える', () => {
    const noRail = withStation(base);
    const a = analyzeAccess(noRail);
    expect(a.modes.rail.available).toBe(false);
    expect(a.modes.rail.reason).toBe('notConnected');
    expect(a.factor).toBe(analyzeAccess(base).factor);
    expect(analyzeLayout(noRail).issues.map((i) => i.code)).toContain('STATION_NO_RAIL');

    const connected = withRail(noRail);
    const b = analyzeAccess(connected);
    expect(b.modes.rail.available).toBe(true);
    expect(b.trainsPerHour).toBe(4);
    expect(b.factor).toBeGreaterThan(a.factor);
    expect(analyzeLayout(connected).issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('道路から離れた・ターミナルから遠い施設は使われない', () => {
    const isolated = withFacility(base, 'taxiStand', 36, 64);
    expect(analyzeAccess(isolated).modes.taxi.reason).toBe('notConnected');
    expect(analyzeLayout(isolated).issues.map((i) => i.code)).toContain('ACCESS_NOT_CONNECTED');
    // 道路沿いだがターミナルから 16 タイルより遠い
    const far = withFacility(base, 'busStop', 79, 70);
    const r = analyzeAccess(must(addRoadPath(far, [{ x: 77, y: 70 }, { x: 78, y: 70 }])).layout);
    expect(['tooFar', 'notConnected']).toContain(r.modes.bus.reason);
  });

  it('施設を置くだけでは需要は無限に増えない（アクセス性は飽和し、係数は上限 1.1）', () => {
    let l = withRail(withStation(base));
    l = withFacility(l, 'taxiStand', 36, 58);
    l = withFacility(l, 'busStop', 30, 58);
    const one = analyzeAccess(l).factor;
    l = withFacility(l, 'busStop', 25, 58);
    const two = analyzeAccess(l).factor;
    expect(two).toBeGreaterThanOrEqual(one);
    expect(two - one).toBeLessThan(0.02);
    expect(two).toBeLessThanOrEqual(BALANCE.accessModel.factor.max);
  });

  it('利用料金: 駐車料金を上げると自家用車の分担率が下がる', () => {
    const cheap = analyzeAccess(base, { fees: { carPark: 0.5 } }).modes.car.share;
    const dear = analyzeAccess(base, { fees: { carPark: 2 } }).modes.car.share;
    expect(dear).toBeLessThan(cheap);
  });

  it('混雑の遅れ（BPR 型）: 容量を超えると急に大きくなり、上限で止まる', () => {
    expect(congestionDelayMin(35, 450, 900)).toBeCloseTo(35 * 0.15 * 0.5 ** 4);
    expect(congestionDelayMin(35, 1800, 900)).toBeCloseTo(35 * 0.15 * 16);
    expect(congestionDelayMin(35, 9000, 900)).toBe(BALANCE.accessModel.congestionMaxMin);
  });
});

// ---------------------------------------------------------------- 運航中のアクセス

describe('運航中のアクセス', { timeout: 120_000 }, () => {
  it('アクセス手段の変更で旅客数が変わる: 鉄道・バス・タクシーを整備すると計画旅客数・実際の旅客数が増え、手段別の利用が記録される', () => {
    const base = createStarterAirfield();
    let better = withRail(withStation(base));
    better = withFacility(better, 'taxiStand', 36, 58);
    better = withFacility(better, 'busStop', 30, 58);
    const c = createCareerCompany();
    const fa = analyzeAccess(base, { fees: c.fees }).factor;
    const fb = analyzeAccess(better, { fees: c.fees }).factor;
    const paxOf = (f: number) => planDay(c, 0, f).flights.reduce((s, x) => s + x.depPax + x.arrPax, 0);
    expect(paxOf(fb)).toBeGreaterThan(paxOf(fa));

    const s1 = createSimulation(base, { company: createCareerCompany() });
    const s2 = createSimulation(better, { company: createCareerCompany() });
    runDay(s1, true);
    runDay(s2, true);
    const k1 = lastKpi(s1.company!);
    const k2 = lastKpi(s2.company!);
    expect(k2.paxDeparted + k2.paxArrived).toBeGreaterThan(k1.paxDeparted + k1.paxArrived);
    expect(k2.modePax!.rail).toBeGreaterThan(0);
    expect(k1.modePax!.rail).toBe(0);
    expect(lastReport(s2.company!).revenue.transit).toBeGreaterThan(0);
    expect(k2.accessFactor).toBeCloseTo(fb);
  });

  it('駐車場満車: 台数が少ないと停められない車が出て、駐車場収入が減り、翌日は自家用車の分担率が下がる', () => {
    const small = structuredClone(createStarterAirfield());
    facilityOf(small, 'parking').props.spaces = 5;
    const sim = createSimulation(small, { company: createCareerCompany() });
    runDay(sim);
    const k = lastKpi(sim.company!);
    expect(k.parkingFull).toBeGreaterThan(0);
    expect(sim.company!.accessFeedback.parkingFullRate).toBeGreaterThan(0);
    const normal = createSimulation(createStarterAirfield(), { company: createCareerCompany() });
    runDay(normal);
    expect(lastKpi(normal.company!).parkingFull).toBe(0);
    expect(lastReport(sim.company!).revenue.carPark ?? 0).toBeLessThan(lastReport(normal.company!).revenue.carPark!);
    // 満車の経験が翌日の選択に反映される
    const before = analyzeAccess(small).modes.car.share;
    const after = analyzeAccess(small, { feedback: sim.company!.accessFeedback }).modes.car.share;
    expect(after).toBeLessThan(before);
    // 日をまたいで駐車している車は持ち越される
    expect(sim.company!.parkedCars.length).toBeGreaterThan(0);
  });

  it('アクセス容量の不足: タクシー乗車枠が少ないと到着旅客が乗り場で長く待ち、満足度が下がる', () => {
    const one = withFacility(createStarterAirfield(), 'taxiStand', 36, 58, { props: { berths: 1 } });
    const six = withFacility(createStarterAirfield(), 'taxiStand', 36, 58, { props: { berths: 8 } });
    const a = simWithShares(one, { taxi: 1 });
    const b = simWithShares(six, { taxi: 1 });
    runDay(a, true);
    runDay(b, true);
    const ka = lastKpi(a.company!);
    const kb = lastKpi(b.company!);
    expect(ka.transitWaitMin!).toBeGreaterThan(kb.transitWaitMin!);
    expect(ka.avgWaitMin).toBeGreaterThan(kb.avgWaitMin);
    expect(ka.paxSatisfaction!).toBeLessThan(kb.paxSatisfaction!);
  });

  it('アクセス容量の不足: バスの便数が少ないと出発旅客が次の便に回され、遅れて着いて乗り遅れが増える', () => {
    const few = withFacility(createStarterAirfield(), 'busStop', 30, 58, { props: { busesPerHour: 1, busBays: 1 } });
    const many = withFacility(createStarterAirfield(), 'busStop', 30, 58, { props: { busesPerHour: 12, busBays: 2 } });
    const a = simWithShares(few, { bus: 1 });
    const b = simWithShares(many, { bus: 1 });
    runDay(a);
    runDay(b);
    expect(a.state.access!.stats.transitFull + lastKpi(a.company!).missedPax).toBeGreaterThan(0);
    expect(lastKpi(a.company!).missedPax).toBeGreaterThanOrEqual(lastKpi(b.company!).missedPax);
    expect(lastKpi(a.company!).paxSatisfaction!).toBeLessThan(lastKpi(b.company!).paxSatisfaction!);
  });

  it('アクセス容量の不足: 道路の容量が小さいと車の旅客が遅れ、道路の遅れが KPI に出る', () => {
    const sim = simWithShares(createStarterAirfield(), { dropoff: 1 });
    sim.state.access!.roadCapacity = 15;
    runDay(sim);
    const normal = simWithShares(createStarterAirfield(), { dropoff: 1 });
    runDay(normal);
    expect(lastKpi(sim.company!).roadDelayMin!).toBeGreaterThan(lastKpi(normal.company!).roadDelayMin! + 1);
    expect(sim.company!.accessFeedback.roadDelayMin).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 費用・土地・拡張

describe('周辺施設・土地・拡張', () => {
  const base = createStarterAirfield();

  it('職員用駐車場が足りないと通勤対策費がかかり、整備すると無くなる', () => {
    const a = analyzeAccess(base);
    expect(a.staffSpacesNeeded).toBeGreaterThan(0);
    expect(dailyFixedCosts(createContext(base)).staffCommute).toBe(a.staffSpacesNeeded * BALANCE.daily.staffCommutePerMissing);
    const withLot = withFacility(base, 'staffParking', 77, 58);
    expect(analyzeAccess(withLot).staffSpaces).toBe(120);
    expect(dailyFixedCosts(createContext(withLot)).staffCommute).toBe(0);
  });

  it('交通施設・ホテルは建設費と運営費がかかる（空港の規模が大きいほど建設費が高い）', () => {
    const l = withFacility(base, 'hotel', 39, 58);
    expect(constructionCost(base, l)).toBe(Math.round(BALANCE.construction.access.hotel * scaleFactor(base)));
    expect(dailyFixedCosts(createContext(l)).accessOps).toBe(BALANCE.daily.access.hotel);
    const bigger = withRail(withStation(base));
    expect(scaleFactor(bigger)).toBeGreaterThan(scaleFactor(base));
    const extra = (x: AirportLayout) => constructionCost(x, withFacility(x, 'taxiStand', 36, 58));
    expect(extra(bigger)).toBeGreaterThan(extra(base));
  });

  it('土地の拡張: 敷地に隣接する未取得地を購入すると建設できるようになり、費用は面積 × 単価 × 規模係数', () => {
    expect(terrainAt(base.site, 3, 50)).toBe(Terrain.offsite);
    const r = must(purchaseLand(base, { x: 0, y: 40 }, { x: 5, y: 60 }));
    expect(r.layout.site.purchased).toBe(6 * 21);
    expect(terrainAt(r.layout.site, 3, 50)).not.toBe(Terrain.offsite);
    expect(terrainAt(base.site, 3, 50)).toBe(Terrain.offsite); // 元のレイアウトは変わらない
    expect(constructionCost(base, r.layout)).toBe(Math.round(6 * 21 * BALANCE.construction.landPerTile * scaleFactor(base)));
    // 購入した土地に建設できる
    const built = must(placeFacility(r.layout, 'staffParking', { x: 1, y: 44 }));
    expect(analyzeLayout(built.layout).byTarget[built.created[0]!]?.map((i) => i.code) ?? []).not.toContain('UNBUILDABLE_TERRAIN');
    // 敷地に接していない土地・取得済みの土地は買えない
    const far = purchaseLand(base, { x: 0, y: 0 }, { x: 2, y: 2 });
    expect(far).toEqual({ ok: false, reason: 'LAND_NOT_ADJACENT' });
    expect(purchaseLand(base, { x: 40, y: 40 }, { x: 45, y: 45 })).toEqual({ ok: false, reason: 'NO_CHANGE' });
  });

  it('資金不足: 土地や大きな施設を買えない（現金は変わらない）', () => {
    const c = createCompany('career');
    c.cash = 100_000;
    const r = must(purchaseLand(base, { x: 0, y: 30 }, { x: 5, y: 80 }));
    expect(chargeConstruction(c, base, r.layout)).toMatchObject({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    expect(chargeConstruction(c, base, withRail(withStation(base)))).toMatchObject({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    expect(c.cash).toBe(100_000);
  });

  it('拡張計画（キャリア）: 新設は工期を待って完成し、完成までは運用できない', () => {
    const c = createCareerCompany();
    const placed = must(placeFacility(base, 'taxiStand', { x: 36, y: 58 }));
    const l = prepareCareerEdit(c, base, placed.layout);
    const id = placed.created[0]!;
    expect(l.facilities[id]!.buildState).toBe('underConstruction');
    expect(c.projects[id]).toMatchObject({ kind: 'build', remaining: 1 });
    expect(analyzeAccess(l).modes.taxi.available).toBe(false);
    advanceProjects(c);
    const done = applyCompletedProjects(c, l)!;
    expect(done.facilities[id]!.buildState).toBe('operational');
    expect(c.projects[id]).toBeUndefined();
    expect(analyzeAccess(done).modes.taxi.available).toBe(true);
  });

  it('拡張計画（キャリア）: 運用中の滑走路を延長すると改修工事で閉鎖され、運航計画に影響が出る', () => {
    const c = createCareerCompany();
    const rwy = Object.keys(base.runways)[0]!;
    const longer = prepareCareerEdit(c, base, must(updateEntity(base, rwy, { length: 100 })).layout);
    expect(longer.runways[rwy]!.buildState).toBe('underConstruction');
    expect(c.projects[rwy]).toMatchObject({ kind: 'renovation', remaining: 6 });
    const issues = analyzeDayPlan(planDay(c, 0), createContext(longer)).issues.map((i) => i.code);
    expect(issues).toContain('SIZE_UNSUPPORTED');
    // 元に戻すと工事は取り消される
    syncProjects(c, base);
    expect(c.projects[rwy]).toBeUndefined();
  });

  it('一時閉鎖: 指定した日数だけ運用を止め、日次締めで再開する。サンドボックスは工期なし', () => {
    const c = createCareerCompany();
    const stand = Object.keys(base.stands)[0]!;
    const closed = startClosure(c, base, stand, 2)!;
    expect(closed.stands[stand]!.buildState).toBe('underConstruction');
    expect(Object.values(createContext(closed).stands).filter((s) => s.operational)).toHaveLength(2);
    advanceProjects(c);
    expect(applyCompletedProjects(c, closed)).toBeNull();
    advanceProjects(c);
    expect(applyCompletedProjects(c, closed)!.stands[stand]!.buildState).toBe('operational');

    const sandbox = createCompany('sandbox');
    const placed = must(placeFacility(base, 'taxiStand', { x: 36, y: 58 }));
    expect(prepareCareerEdit(sandbox, base, placed.layout)).toBe(placed.layout);
  });

  it('運航中に工期が進み、完成が会社に記録される', () => {
    const c = createCareerCompany();
    const placed = must(placeFacility(base, 'busStop', { x: 30, y: 58 }));
    const l = prepareCareerEdit(c, base, placed.layout);
    const sim = createSimulation(l, { company: c });
    runDay(sim);
    expect(c.projects[placed.created[0]!]!.remaining).toBe(0);
  });

  it('料金: 交通事業者の使用料を上げると、その手段の運賃が上がる', () => {
    const c = createCompany('career');
    setFees(c, { rail: 2 });
    const l = withRail(withStation(base));
    expect(analyzeAccess(l, { fees: c.fees }).modes.rail.fare).toBeGreaterThan(analyzeAccess(l).modes.rail.fare);
  });
});
