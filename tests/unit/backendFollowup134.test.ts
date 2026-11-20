import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createHistory } from '../../src/core/editor/history';
import {
  addContract,
  createCompany,
  createSandboxCompany,
  type CompanyState,
  type DailyReport,
} from '../../src/core/economy/company';
import { BALANCE } from '../../src/core/economy/balance';
import { defaultCity } from '../../src/core/economy/city';
import { defaultGame } from '../../src/core/economy/game';
import { initialGoals, type Tier } from '../../src/core/economy/goals';
import { cargoPlannedTruckTripsByHour, cargoPlannedTruckTripsPerDay } from '../../src/core/economy/cargo';
import { hubChoiceShare } from '../../src/core/economy/hub';
import { destinationDef } from '../../src/core/economy/registry';
import type { DayPlan } from '../../src/core/economy/planning';
import { emptyResponses, type DayReview } from '../../src/core/analytics/review';
import { placeTerminalArea, type OpResult } from '../../src/core/layout/operations';
import type { AirportLayout } from '../../src/core/model/types';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addTurnaround, createSimulation, type Simulation } from '../../src/core/sim/simulation';
import { serviceAggregateUsage } from '../../src/core/sim/serviceAggregate';
import { runServiceDetailSim } from '../../src/core/terminal/serviceDetailSim';
import { editorStore, type EditorState } from '../../src/editor/store';
import { FOLLOWUP_UI } from '../../src/i18n/ja';
import { CargoTruckHourly, truckHourlyBarHeights } from '../../src/ui/AccessPanels';
import { cargoTransshipmentText, hubOdRows, ReviewBody } from '../../src/ui/DayReview';
import { connectionPairRows } from '../../src/ui/HubPanel';
import { loungeUsageRows, ServiceDetailResultView, ServiceProfileSection } from '../../src/ui/ServiceModesPanel';
import { must } from './helpers';
import { runUntil } from './sim/helpers';

/**
 * バックエンド追随 第2弾（項目1: ラウンジの運営モード実績 / 項目3: 貨物 Tier 6・7 /
 * 項目4: F6-17 直行競合の採用率と LF 脚注）。すべて表示専用の追随で、sim の計算は変えない。
 */

// ---------------------------------------------------------------- 項目1

const manual = { autoSchedule: false };

function layoutWithLounge(seats = 40): { layout: AirportLayout; terminal: string } {
  let layout = createSampleAirport();
  const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  const r: OpResult = placeTerminalArea(layout, terminal, 1, 'lounge', { x: 82, y: 51 }, { w: 4, h: 2, name: 'ラウンジ', props: { seats } });
  layout = must(r).layout;
  return { layout, terminal };
}

function runScenario(layout: AirportLayout, granularity: 'detailed' | 'aggregate', seed: string): Simulation {
  const sim = createSimulation(layout, { seed, settings: manual, serviceGranularity: granularity });
  const standId = Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;
  const t0 = sim.state.now;
  const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
    departureAt: t0 + 220 * 60,
    plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 },
  });
  runUntil(sim, () => ac.state === 'departed', 10 * 3600);
  return sim;
}

const renderProfile = (layout: AirportLayout, granularity: 'detailed' | 'aggregate', sim: Simulation): string =>
  renderToString(createElement(ServiceProfileSection, { layout, liveGranularity: granularity, liveUsage: serviceAggregateUsage(sim) }));

/** SSR が式の境界に入れるコメントを除いて、文言の並びで照合できるようにする */
const plain = (html: string): string => html.replace(/<!-- -->/g, '');

describe('項目1: ラウンジの運営モード実績', () => {
  it('loungeUsageRows: ラウンジ行だけを抜き出す', () => {
    const usage = new Map([
      ['t1|retail', { users: 5, groups: 2, dwellPaxSec: 600, revenue: 100, skipped: 1 }],
      ['t1|lounge', { users: 9, groups: 3, dwellPaxSec: 900, revenue: 0, skipped: 0 }],
    ]);
    const rows = loungeUsageRows(usage);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.terminalId).toBe('t1');
    expect(rows[0]!.usage.users).toBe(9);
    expect(loungeUsageRows(null)).toEqual([]);
  });

  it('詳細方式でもラウンジ実績が出る（文言は「記録されません」にならない）', () => {
    const { layout, terminal } = layoutWithLounge(40);
    const sim = runScenario(layout, 'detailed', 'followup134-detailed');
    const usage = serviceAggregateUsage(sim);
    expect(usage.get(`${terminal}|lounge`)!.users).toBeGreaterThan(0);
    const html = renderProfile(layout, 'detailed', sim);
    expect(html).toContain('data-testid="service-usage-lounge-detailed"');
    expect(html).toContain(`data-testid="service-usage-${terminal}-lounge"`);
    // 満席フォールバックは詳細方式では数えられないこと・満足度は未反映であることを明記する
    expect(html).toContain('満席時の待合フォールバック人数は数えられません');
    expect(html).toContain('満足度・空港評価にはまだ反映されません');
    expect(html).toContain('日報には残りません');
    expect(html).not.toContain('カテゴリ集約の実績は記録されません。店舗別');
  });

  it('集約方式の実績表にもラウンジ行と前提の脚注が出る', () => {
    const { layout, terminal } = layoutWithLounge(40);
    const sim = runScenario(layout, 'aggregate', 'followup134-aggregate');
    const html = renderProfile(layout, 'aggregate', sim);
    expect(html).toContain('data-testid="service-usage"');
    expect(html).toContain(`data-testid="service-usage-${terminal}-lounge"`);
    expect(html).toContain('満足度・空港評価にはまだ反映されません');
  });

  it('ラウンジの無い空港を詳細方式で運航しても、ラウンジ実績節は出ない', () => {
    const layout = createSampleAirport();
    const sim = runScenario(layout, 'detailed', 'followup134-none');
    const html = renderProfile(layout, 'detailed', sim);
    expect(html).toContain('data-testid="service-usage-detailed"');
    expect(html).not.toContain('service-usage-lounge-detailed');
  });

  it('詳細 sim の結果にラウンジ体験（参考値）と見送りが出る', () => {
    const { layout, terminal } = layoutWithLounge(40);
    const result = runServiceDetailSim(layout, {
      terminalId: terminal, durationSec: 2 * 3600, groupsPerHour: 60, stepFreeRatio: 0, seed: 'service-detail', nowMs: () => 0,
    });
    expect(result.loungeExperience.users).toBeGreaterThan(0);
    expect(result.loungeSkipped).toBeGreaterThan(0);
    const html = renderToString(createElement(ServiceDetailResultView, { layout, result }));
    expect(html).toContain('data-testid="service-detail-lounge"');
    expect(html).toContain('ラウンジ体験（参考値）');
    expect(plain(html)).toContain(`ラウンジ見送り（候補なし/満員/時間不足） ${result.loungeSkipped} 人`);
    expect(plain(html)).toContain('満足度式には接続していません');
    // 換算ポイントが算出できない結果（完了旅客 0）では未算出になる
    const empty = { ...result, loungeExperience: { users: 0, dwellPaxSec: 0, userHours: 0, estimatedSatisfactionPoints: null } };
    const html2 = renderToString(createElement(ServiceDetailResultView, { layout, result: empty }));
    expect(plain(html2)).toContain('満足度換算ポイント 未算出');
  });
});

// ---------------------------------------------------------------- 項目3

function cargoCareer(tier: Tier, destinations: string[], cargoFeature = true): CompanyState {
  const c = createCompany('career', `followup134-cargo-${tier}`);
  c.game = defaultGame();
  c.goals = { ...initialGoals(), tier };
  c.city = defaultCity('regional');
  c.rating = 80;
  if (cargoFeature) c.features = { cargo: true };
  for (const destinationId of destinations) {
    addContract(c, {
      airlineId: 'NH', destinationId, typeId: 'B777-300ER', perDay: 1, window: 'any',
      feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo',
    });
  }
  return c;
}

const renderTruck = (c: CompanyState): string => renderToString(createElement(CargoTruckHourly, { company: c }));

describe('項目3: 貨物 Tier 6（トラック時間帯配分）', () => {
  it('truckHourlyBarHeights: 最大を 100 に正規化し、全 0 では全 0', () => {
    expect(truckHourlyBarHeights([0, 5, 10])).toEqual([0, 50, 100]);
    expect(truckHourlyBarHeights([0, 0])).toEqual([0, 0]);
  });

  it('格 5 では分布を出さず、解放条件の注記だけを置く', () => {
    const html = renderTruck(cargoCareer(5, ['TWN']));
    expect(html).toContain('data-testid="access-cargo-truck-hourly"');
    expect(html).toContain('data-testid="access-cargo-truck-locked"');
    expect(html).toContain('格6でトラックの時間帯配分が有効になります');
    expect(html).not.toContain('access-cargo-truck-total');
  });

  it('格 6 では分布と計画台数（見込み）が出て、合計は core の計画台数と一致する', () => {
    const c = cargoCareer(6, ['TWN']);
    const byHour = cargoPlannedTruckTripsByHour(c, c.day)!;
    const total = cargoPlannedTruckTripsPerDay(c, c.day);
    expect(byHour.reduce((a, v) => a + v, 0)).toBeCloseTo(total, 6);
    const html = renderTruck(c);
    expect(html).toContain('data-testid="access-cargo-truck-total"');
    expect(html).toContain(`計画台数 ${total} 台/日`);
    expect(html).toContain('計画ベースの見込み');
    expect(html).toContain('実績の台数は日報の貨物行');
  });

  it('貨物機能が無効な会社では節ごと出ない', () => {
    expect(renderTruck(cargoCareer(6, ['TWN'], false))).toBe('');
  });
});

// ---------------------------------------------------------------- 日報（項目3 Tier 7 / 項目4 hubOd）

const makeReport = (over: Partial<DailyReport>): DailyReport =>
  ({
    day: 3,
    revenue: {},
    cost: {},
    construction: 0,
    totalRevenue: 0,
    totalCost: 0,
    operatingProfit: 0,
    cashEnd: 0,
    kpi: { otp: null, avgDelayMin: null, flights: 0, rating: null, paxSatisfaction: null, airlineSatisfaction: null, paxArrived: 0, paxDeparted: 0, missedPax: 0, leftBags: 0 },
    ...over,
  }) as unknown as DailyReport;

function setStore(layout: AirportLayout): void {
  editorStore.setState({
    history: createHistory(layout),
    company: createSandboxCompany(),
    selection: null,
    tool: 'select',
    draft: null,
    hover: null,
    hoverW: null,
    footprintEdit: null,
    pickCandidates: [],
    mode: 'build',
  } as Partial<EditorState>);
}

const renderReview = (report: DailyReport): string => {
  const review = {
    day: report.day, report, prev: null, compare: [], delayCauses: [], bottlenecks: [], disruptions: [],
    responses: emptyResponses(), airlines: [], tomorrow: { flights: 0, issues: [], completing: [], weather: null },
  } as unknown as DayReview;
  return renderToString(createElement(ReviewBody, { review }));
};

describe('項目3: 日報の積替貨物（Tier 7）', () => {
  it('cargoTransshipmentText: 値がある日だけ文を返し、0・未定義は null', () => {
    expect(cargoTransshipmentText({ transshipmentM3: 120.34 })).toContain('120.3 m³');
    expect(cargoTransshipmentText({ transshipmentM3: 120.34 })).toContain('翌日便へ接続します');
    expect(cargoTransshipmentText({ transshipmentM3: 120.34 })).toContain('当日便への積替はありません');
    expect(cargoTransshipmentText({ transshipmentM3: 0 })).toBeNull();
    expect(cargoTransshipmentText({})).toBeNull();
    expect(cargoTransshipmentText(undefined)).toBeNull();
  });

  it('ReviewBody: 積替がある日は行が出て、無い日は従来表示と同一', () => {
    setStore(createSampleAirport());
    const base = { carriedM3: 500, leftoverM3: 10, revenue: 1000, handlingCost: 200, truckTrips: 5 };
    const withT = renderReview(makeReport({ cargo: { ...base, transshipmentM3: 120.34 } }));
    expect(withT).toContain('data-testid="review-cargo-transshipment"');
    expect(withT).toContain('うち積替');
    expect(withT).toContain('120.3 m³');
    const without = renderReview(makeReport({ cargo: { ...base } }));
    expect(without).toContain('data-testid="review-cargo"');
    expect(without).not.toContain('review-cargo-transshipment');
    const zero = renderReview(makeReport({ cargo: { ...base, transshipmentM3: 0 } }));
    expect(zero).not.toContain('review-cargo-transshipment');
  });
});

describe('項目4: F6-17 直行競合の採用率', () => {
  it('hubOdRows: 採用率は hubChoiceShare の戻りと一致する', () => {
    const rows = hubOdRows([
      { from: 'TYO', to: 'OSA', kind: 'DD', pax: 120, pairs: 3, appeal: 1.234, avgQuality: 0.856, avgGapMin: 95.4 },
    ]);
    const expected = Math.round(hubChoiceShare(destinationDef('TYO'), destinationDef('OSA')) * 100);
    expect(rows[0]!.choiceSharePct).toBe(expected);
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(100);
  });

  it('connectionPairRows: 採用率は OD の hubChoiceShare と一致する', () => {
    const flight = (over: Record<string, unknown>) =>
      ({
        contractId: 'k', airlineId: 'NH', typeId: 'B738', arrNumber: 'NH1', depNumber: 'NH2',
        arrPax: 0, depPax: 0, seats: 180, inboundDelaySec: 0, ...over,
      }) as DayPlan['flights'][number];
    const plan = {
      day: 0,
      dropped: [],
      flights: [
        flight({ key: 'a1', destinationId: 'SPK', arrivalAt: 8 * 3600, departureAt: 9 * 3600, connections: [{ depKey: 'd1', pax: 12, kind: 'DD' }] }),
        flight({ key: 'd1', destinationId: 'OKA', arrivalAt: 10 * 3600, departureAt: 11 * 3600 }),
      ],
    } as DayPlan;
    const mctMin = { DD: { max: 45, median: 45 }, DI: { max: 60, median: 60 }, ID: { max: 60, median: 60 }, II: { max: 90, median: 90 } } as Parameters<typeof connectionPairRows>[1];
    const rows = connectionPairRows(plan, mctMin);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.choiceShare).toBeCloseTo(hubChoiceShare(destinationDef('SPK'), destinationDef('OKA')), 10);
  });

  it('ReviewBody: hubOd 表に採用率列と、魅力が適用前の値である説明が出る', () => {
    setStore(createSampleAirport());
    const html = renderReview(makeReport({
      hub: { spawned: 130, connected: 120, missed: 8, noShow: 2 },
      hubOd: [{ from: 'TYO', to: 'OSA', kind: 'DD', pax: 120, pairs: 3, appeal: 1.234, avgQuality: 0.856, avgGapMin: 95.4 }],
    }));
    expect(html).toContain('data-testid="review-hub-od"');
    expect(html).toContain(FOLLOWUP_UI.hubChoiceColumn);
    expect(plain(html)).toContain('魅力は、直行競合の採用率を掛ける前の値です');
    expect(plain(html)).toContain('採用率は暫定の前提での値です');
  });

  it('採用率の前提注記は係数の数値を直書きしていない（BALANCE が正本）', () => {
    expect(FOLLOWUP_UI.hubChoiceNote).not.toMatch(/\d/);
    expect(FOLLOWUP_UI.hubChoiceNote).toContain('暫定値');
    // 係数の正本は BALANCE.hub.nonstopPreference（hubChoiceShare が内部で読む）
    expect(typeof BALANCE.hub.nonstopPreference).toBe('number');
  });
});
