import { describe, expect, it } from 'vitest';
import { createSimulation, addTurnaround } from '../../../src/core/sim/simulation';
import { serviceAggregateUsage } from '../../../src/core/sim/serviceAggregate';
import { runServiceDetailSim } from '../../../src/core/terminal/serviceDetailSim';
import {
  areaKindOfServiceCategory,
  categoryProfile,
  isLoungeEligible,
  loungeSeats,
  serviceCategoryOfAreaKind,
  serviceProfilesFor,
  type ServiceFacilityProfile,
} from '../../../src/core/terminal/serviceProfile';
import { readingsFromServiceProfiles } from '../../../src/core/capability';
import { placeTerminalArea, type OpResult } from '../../../src/core/layout/operations';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import type { AirportLayout } from '../../../src/core/model/types';
import { buildProject, serializeProject, validateProject, layoutUsesFormat8, PROJECT_FORMAT_MAX_READABLE } from '../../../src/core/io/project';
import { addContract, createSandboxCompany, type CompanyState, type Contract } from '../../../src/core/economy/company';
import type { DayPlan, PlannedFlight } from '../../../src/core/economy/planning';
import { connectionQuality, onwardAppeal, planConnections, summarizeTransferOd } from '../../../src/core/economy/hub';
import { destinationDef } from '../../../src/core/economy/registry';
import { settleDay } from '../../../src/core/economy/ops';
import type { HubAnalysis } from '../../../src/core/terminal/hub';
import { layoutWithShops } from '../serviceFixture';
import { must } from '../helpers';
import { runUntil } from './helpers';

/**
 * PO 決定（2026-11-19）の実装固定:
 * - 1B: サービス粒度の既定を集約方式（'aggregate'）にする。'detailed' は明示指定で従来どおり。
 * - 2A: ラウンジをエリア種別として新設（席数ベース・資格モデル・詳細モードの滞留先・保存形式 8）。
 * - 5A: 乗継需要モデルの OD 集計（計算は変えず、計画結果の表示用集計と日報 hubOd）。
 */

/* ------------------------------------------------------------------ */
/* 1B: 集約方式の既定化                                                */
/* ------------------------------------------------------------------ */

const manual = { autoSchedule: false };

function runShopScenario(opts: { serviceGranularity?: 'detailed' | 'aggregate' }): { boarded: number; users: number; revenue: number } {
  const { layout } = layoutWithShops();
  const sim = createSimulation(layout, { seed: 'svc-1b', settings: manual, ...opts });
  const standId = Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;
  const t0 = sim.state.now;
  const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
    departureAt: t0 + 220 * 60,
    plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 },
  });
  runUntil(sim, () => ac.state === 'departed', 10 * 3600);
  const usage = [...serviceAggregateUsage(sim).values()];
  return {
    boarded: sim.state.paxStats.boarded,
    users: usage.reduce((s, u) => s + u.users, 0),
    revenue: usage.reduce((s, u) => s + u.revenue, 0),
  };
}

describe('1B: サービス粒度の既定は集約方式', () => {
  it('省略時は aggregate になり、明示指定の aggregate と結果が完全一致する', { timeout: 120_000 }, () => {
    const { layout } = layoutWithShops();
    const simDefault = createSimulation(layout, { seed: 'svc-1b', settings: manual });
    expect(simDefault.serviceGranularity).toBe('aggregate');
    const a = runShopScenario({});
    const b = runShopScenario({ serviceGranularity: 'aggregate' });
    expect(a).toEqual(b);
    expect(a.users).toBeGreaterThan(0);
    expect(a.boarded).toBeGreaterThan(0);
  });

  it("'detailed' は明示指定で従来どおり選べ、集約実績は立たない", { timeout: 120_000 }, () => {
    const { layout } = layoutWithShops();
    const sim = createSimulation(layout, { seed: 'svc-1b', settings: manual, serviceGranularity: 'detailed' });
    expect(sim.serviceGranularity).toBe('detailed');
    const d = runShopScenario({ serviceGranularity: 'detailed' });
    expect(d.users).toBe(0);
    expect(d.revenue).toBe(0);
    expect(d.boarded).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 2A: ラウンジ                                                        */
/* ------------------------------------------------------------------ */

function layoutWithLounge(seats = 25): { layout: AirportLayout; terminal: string; lounge: string } {
  let layout = createSampleAirport();
  const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  const r: OpResult = placeTerminalArea(layout, terminal, 1, 'lounge', { x: 82, y: 51 }, { w: 4, h: 2, name: 'ラウンジ', props: { seats } });
  const m = must(r);
  layout = m.layout;
  return { layout, terminal, lounge: m.created[0]! };
}

const facilityProfile = (partial: Partial<ServiceFacilityProfile>): ServiceFacilityProfile => ({
  areaId: 'ta_x', terminalId: 't1', category: 'lounge', kind: 'lounge', zone: 'departure', level: 1,
  capacity: 40, areaCapacity: 100, dwellSec: null, spendPerPax: null, operational: true, ...partial,
});

describe('2A: ラウンジの profile と資格モデル', () => {
  it('カテゴリ対応: lounge は独立カテゴリで、能力は席数（窓口数ではない）', () => {
    expect(serviceCategoryOfAreaKind('lounge')).toBe('lounge');
    expect(areaKindOfServiceCategory('lounge')).toBe('lounge');
    const { layout, terminal, lounge } = layoutWithLounge(25);
    const profiles = serviceProfilesFor(layout);
    const f = profiles.facilities.find((x) => x.areaId === lounge)!;
    expect(f.category).toBe('lounge');
    expect(f.capacity).toBe(25);
    expect(f.dwellSec).toBeNull();
    expect(f.spendPerPax).toBeNull();
    const cat = categoryProfile(profiles, terminal, 'lounge')!;
    expect(cat.status).toBe('available');
    expect(cat.totalCapacity).toBe(25);
    // 店舗・飲食・待合とは混ざらない
    expect(categoryProfile(profiles, terminal, 'retail')!.facilityIds).not.toContain(lounge);
    expect(categoryProfile(profiles, terminal, 'waiting')!.facilityIds).not.toContain(lounge);
  });

  it('資格: 出発区域（国内/国際）・運用中・席数>0 のときだけ利用可。一般区域と到着区域は不可', () => {
    expect(isLoungeEligible(facilityProfile({}))).toBe(true);
    expect(isLoungeEligible(facilityProfile({ zone: 'departureIntl' }))).toBe(true);
    expect(isLoungeEligible(facilityProfile({ zone: 'landside' }))).toBe(false);
    expect(isLoungeEligible(facilityProfile({ zone: 'arrival' }))).toBe(false);
    expect(isLoungeEligible(facilityProfile({ operational: false }))).toBe(false);
    expect(isLoungeEligible(facilityProfile({ capacity: 0 }))).toBe(false);
    expect(loungeSeats({ seats: 30 })).toBe(30);
    expect(loungeSeats({})).toBe(0);
    expect(loungeSeats({ seats: -5 })).toBe(0);
  });

  it('未設置ターミナルでは lounge カテゴリは notConfigured', () => {
    const layout = createSampleAirport();
    const profiles = serviceProfilesFor(layout);
    for (const t of profiles.terminals) {
      expect(categoryProfile(profiles, t, 'lounge')!.status).toBe('notConfigured');
    }
  });

  it('能力契約: ラウンジは seats 単位で読み取れ、未設置は notInstalled', () => {
    const { layout, terminal } = layoutWithLounge(25);
    const readings = readingsFromServiceProfiles(layout);
    const lounge = readings.find((r) => r.subjectId === `${terminal}:lounge`)!;
    expect(lounge.domain).toBe('passenger-service');
    expect(lounge.unit).toBe('seats');
    expect(lounge.theoretical).toBe(25);
    expect(lounge.effective).toBe(25);
    expect(lounge.state).toBe('operational');
    const plain = readingsFromServiceProfiles(createSampleAirport());
    expect(plain.filter((r) => r.subjectId.endsWith(':lounge')).every((r) => r.state === 'notInstalled' && r.theoretical === null)).toBe(true);
  });
});

describe('2A: ラウンジの保存形式（形式 8）', () => {
  it('ラウンジを含むレイアウトは形式 8、含まなければ従来どおり。往復で保持される', () => {
    const { layout } = layoutWithLounge();
    expect(layoutUsesFormat8(layout)).toBe(true);
    expect(layoutUsesFormat8(createSampleAirport())).toBe(false);
    expect(PROJECT_FORMAT_MAX_READABLE).toBe(9); // 機能H で保存形式 9（搭乗橋 PBB）まで読めるようになった
    const project = buildProject({ name: 'lounge', savedAt: '2026-11-19T00:00:00Z', layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    const raw = JSON.parse(serializeProject(project)) as { versions: { format: number } };
    expect(raw.versions.format).toBe(8);
    const loaded = validateProject(JSON.stringify(raw), { fallbackCompany: createSandboxCompany() });
    expect(loaded.ok).toBe(true);
    expect(Object.values(loaded.project!.layout.terminalAreas).some((a) => a.kind === 'lounge')).toBe(true);
    // ラウンジなしのプロジェクトは形式 8 にならない（旧読込互換）
    const plain = buildProject({ name: 'plain', savedAt: '2026-11-19T00:00:00Z', layout: createSampleAirport(), company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    const rawPlain = JSON.parse(serializeProject(plain)) as { versions: { format: number } };
    expect(rawPlain.versions.format).toBeLessThan(8);
  });
});

describe('2A: 詳細モードのラウンジ滞留', () => {
  it('ラウンジ意図のあるグループが席数内で滞留し、実績と体験指標が立つ（売上は持たない）', () => {
    const { layout, terminal, lounge } = layoutWithLounge(200);
    const r = runServiceDetailSim(layout, {
      terminalId: terminal, seed: 'lounge-1', durationSec: 3 * 3600, groupsPerHour: 60,
      visitProb: 0, loungeVisitProb: 1, budgetMinSec: 90 * 60, budgetMaxSec: 100 * 60,
    });
    expect(r.boarded + r.boardedLate + r.failed + r.unfinished).toBe(r.spawnedPax);
    expect(r.failed).toBe(0);
    expect(r.loungeExperience.users).toBeGreaterThan(0);
    expect(r.records[lounge]?.users).toBe(r.loungeExperience.users);
    expect(r.records[lounge]?.revenue).toBe(0);
    expect(r.records[lounge]?.dwellPaxSec).toBeGreaterThan(0);
    const loungeAgg = r.aggregated.airport.find((c) => c.category === 'lounge')!;
    expect(loungeAgg.users).toBe(r.loungeExperience.users);
    expect(loungeAgg.revenue).toBe(0);
    expect(r.loungeExperience.userHours).toBeCloseTo(r.loungeExperience.dwellPaxSec / 3600);
    expect(r.loungeExperience.estimatedSatisfactionPoints).not.toBeNull();
    expect(r.loungeExperience.estimatedSatisfactionPoints!).toBeGreaterThan(0);
    expect(r.loungeExperience.estimatedSatisfactionPoints!).toBeLessThanOrEqual(5);
    // 待合とは別集計（ラウンジ意図 100%・時間十分なら待合利用は原則ない）
    const waitingAgg = r.aggregated.airport.find((c) => c.category === 'waiting')!;
    expect(waitingAgg.users).toBeLessThan(r.loungeExperience.users);
  });

  it('席数が小さいと満員で入れず、待合へフォールバックする（turnedAway / loungeSkipped）', () => {
    const { layout, terminal, lounge } = layoutWithLounge(2);
    const r = runServiceDetailSim(layout, {
      terminalId: terminal, seed: 'lounge-2', durationSec: 2 * 3600, groupsPerHour: 300,
      visitProb: 0, loungeVisitProb: 1, budgetMinSec: 90 * 60, budgetMaxSec: 100 * 60,
    });
    expect(r.boarded + r.boardedLate + r.failed + r.unfinished).toBe(r.spawnedPax);
    const turned = r.records[lounge]?.turnedAway ?? 0;
    expect(turned + r.loungeSkipped).toBeGreaterThan(0);
    expect(r.loungeExperience.users).toBeGreaterThan(0);
    expect(r.boarded + r.boardedLate).toBeGreaterThan(0);
  });

  it('ラウンジの無いターミナルでは従来どおり（体験指標はゼロ。換算ポイントは利用者ゼロのため 0）', () => {
    const { layout, terminal } = layoutWithShops();
    const r = runServiceDetailSim(layout, {
      terminalId: terminal, seed: 'lounge-3', durationSec: 2 * 3600, groupsPerHour: 40, visitProb: 0.5,
    });
    expect(r.loungeSkipped).toBe(0);
    expect(r.loungeExperience.users).toBe(0);
    // 完了旅客がいるため換算は可能で、利用者ゼロ → 効果ゼロ（null は完了旅客ゼロのときだけ）
    expect(r.loungeExperience.estimatedSatisfactionPoints).toBe(0);
    expect(r.boarded + r.boardedLate).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5A: 乗継 OD 集計                                                    */
/* ------------------------------------------------------------------ */

const MCT_DD = 30 * 60;
const hubAnalysis: HubAnalysis = {
  mct: { DD: MCT_DD, DI: null, ID: null, II: null },
  byKind: {
    DD: { max: MCT_DD, median: MCT_DD, pairs: 1 },
    DI: { max: null, median: null, pairs: 0 },
    ID: { max: null, median: null, pairs: 0 },
    II: { max: null, median: null, pairs: 0 },
  },
  pairMct: new Map(),
};
const T0 = 10 * 3600;

function setup5A(): { c: CompanyState; arrK: Contract } {
  const c = createSandboxCompany('xfer-od');
  c.features = { hub: true };
  c.hub = { banks: [], maxConnectMin: 240 };
  const arrK = addContract(c, {
    airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 1, window: 'any',
    feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, transferShare: 0.5,
  });
  return { c, arrK };
}

function flight5A(partial: Partial<PlannedFlight> & Pick<PlannedFlight, 'key' | 'contractId' | 'destinationId' | 'arrivalAt' | 'departureAt'>): PlannedFlight {
  return {
    airlineId: 'HB', typeId: 'B737-800', arrNumber: 'HB100', depNumber: 'HB101',
    arrPax: 0, depPax: 0, seats: 180, inboundDelaySec: 0, ...partial,
  };
}

describe('5A: 乗継 OD 集計（summarizeTransferOd）', () => {
  it('OD ごとに合算され、合計は connections 合計 = transferIn 合計と一致する', () => {
    const { c, arrK } = setup5A();
    const kTyo = addContract(c, {
      airlineId: 'HB', destinationId: 'TYO', typeId: 'B737-800', perDay: 1, window: 'any',
      feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, transferShare: 0.5,
    });
    const kMsk = addContract(c, {
      airlineId: 'HB', destinationId: 'MSK', typeId: 'B737-800', perDay: 1, window: 'any',
      feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, transferShare: 0.5,
    });
    const arr = flight5A({ key: 'arr:0:0', contractId: arrK.id, destinationId: 'KTA', arrivalAt: T0, departureAt: T0 + 600 * 60, arrPax: 200 });
    const dep = (key: string, k: Contract, gapMin: number): PlannedFlight =>
      flight5A({ key, contractId: k.id, destinationId: k.destinationId, arrivalAt: 80000, departureAt: T0 + gapMin * 60, seats: 180, depPax: 0 });
    const plan: DayPlan = { day: 0, flights: [arr, dep('dep:tyo1', kTyo, 75), dep('dep:tyo2', kTyo, 120), dep('dep:msk', kMsk, 75)], dropped: [] };
    planConnections(plan, c, hubAnalysis);
    const entries = summarizeTransferOd(plan, hubAnalysis);
    const totalConn = plan.flights.reduce((s, f) => s + (f.connections ?? []).reduce((x, cn) => x + cn.pax, 0), 0);
    const totalIn = plan.flights.reduce((s, f) => s + (f.transferIn ?? 0), 0);
    expect(totalConn).toBeGreaterThan(0);
    expect(entries.reduce((s, e) => s + e.pax, 0)).toBe(totalConn);
    expect(totalIn).toBe(totalConn);
    // TYO 行きは 2 便が 1 エントリに合算される
    const tyo = entries.find((e) => e.from === 'KTA' && e.to === 'TYO' && e.kind === 'DD')!;
    expect(tyo.pairs).toBe(2);
    expect(tyo.appeal).toBeCloseTo(onwardAppeal(destinationDef('KTA'), destinationDef('TYO')), 10);
    expect(tyo.avgQuality).toBeGreaterThan(0);
    expect(tyo.avgQuality).toBeLessThanOrEqual(1);
    expect(tyo.avgGapMin).toBeGreaterThan(75);
    expect(tyo.avgGapMin).toBeLessThan(120);
    // 品質の内訳が再計算と一致する（人数重み平均）
    const q = (gapMin: number) => connectionQuality(gapMin * 60, MCT_DD);
    const p1 = arr.connections!.find((cn) => cn.depKey === 'dep:tyo1')!.pax;
    const p2 = arr.connections!.find((cn) => cn.depKey === 'dep:tyo2')!.pax;
    expect(tyo.avgQuality).toBeCloseTo((q(75) * p1 + q(120) * p2) / (p1 + p2), 10);
    // 人数の多い順
    expect(entries[0]!.pax).toBeGreaterThanOrEqual(entries[entries.length - 1]!.pax);
  });

  it('接続がない計画・ハブ無効では空（計算には触れない）', () => {
    const { c, arrK } = setup5A();
    const arr = flight5A({ key: 'arr:0:0', contractId: arrK.id, destinationId: 'KTA', arrivalAt: T0, departureAt: T0 + 600 * 60, arrPax: 200 });
    const plan: DayPlan = { day: 0, flights: [arr], dropped: [] };
    expect(summarizeTransferOd(plan, hubAnalysis)).toEqual([]);
    planConnections(plan, c, hubAnalysis);
    expect(summarizeTransferOd(plan, hubAnalysis)).toEqual([]);
  });

  it('日報 hubOd: 計画スナップショットがその日の日報にだけ写る', () => {
    const layout = createSampleAirport();
    const c = createSandboxCompany('xfer-od-report');
    c.features = { hub: true };
    c.hub = { banks: [], maxConnectMin: 240 };
    const sim = createSimulation(layout, { seed: 'xfer-od-report', company: c, settings: manual });
    const entry = { from: 'KTA', to: 'TYO', kind: 'DD' as const, pax: 42, pairs: 2, appeal: 1.5, avgQuality: 0.9, avgGapMin: 90 };
    sim.transferOdPlan = { day: c.day, entries: [entry] };
    const report = settleDay(sim, true)!;
    expect(report.hubOd).toEqual([entry]);
    // 日がずれたスナップショットは写らない
    const c2 = createSandboxCompany('xfer-od-report2');
    c2.features = { hub: true };
    c2.hub = { banks: [], maxConnectMin: 240 };
    const sim2 = createSimulation(layout, { seed: 'xfer-od-report2', company: c2, settings: manual });
    sim2.transferOdPlan = { day: c2.day + 1, entries: [entry] };
    expect(settleDay(sim2, true)!.hubOd).toBeUndefined();
    // ハブ無効では写らない
    const c3 = createSandboxCompany('xfer-od-report3');
    const sim3 = createSimulation(layout, { seed: 'xfer-od-report3', company: c3, settings: manual });
    sim3.transferOdPlan = { day: c3.day, entries: [entry] };
    expect(settleDay(sim3, true)!.hubOd).toBeUndefined();
  });
});
