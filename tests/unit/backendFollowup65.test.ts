import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildAttentionItems } from '../../src/core/attention';
import { composeCapabilityReadings, layoutCapabilities } from '../../src/core/capability';
import { createHistory } from '../../src/core/editor/history';
import { createCareerCompany, createSandboxCompany, type DailyReport } from '../../src/core/economy/company';
import { emptyResponses, type DayReview } from '../../src/core/analytics/review';
import type { AirportLayout } from '../../src/core/model/types';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import type { Disruption, SimState } from '../../src/core/sim/types';
import { analyzeLayout } from '../../src/core/validation/validate';
import { editorStore, type EditorState } from '../../src/editor/store';
import { PROCESS_STEP_LABEL } from '../../src/i18n/ja';
import { processPeakHourOf, processPeakStartText, processPeakValue, ReviewBody, stepWaitRows } from '../../src/ui/DayReview';

/**
 * バックエンド追随 第1弾（項目6: 能力状態の統合 / 項目5: 日報項目の表示追随）。
 *
 * 項目6: 正本はバックエンドの operationalStateReadings。画面側は composeCapabilityReadings で
 * 合成し、同じ subjectId は運航中状態側を採る。旧 UI 側導出（CapabilityOpsInput）は撤去済み。
 * 項目5: 日報の peakStartMin（ローリング 60 分）・新工程・stepWaits・外部境界への表示追随と、
 * 旧日報（新フィールドを持たない）のフォールバック。
 */

const disruption = (over: Partial<Disruption>): Disruption =>
  ({
    id: 'dis_1', kind: 'runwayClosed', targetId: null, start: 0, end: null,
    status: 'active', resolvedAt: null, resolvedBy: null,
    affected: { tasks: [], flights: [], units: [] }, ...over,
  }) as Disruption;

const fakeState = (over: Partial<SimState>): SimState =>
  ({
    disruptions: [],
    runwayConfig: {},
    closures: { taxiways: [], stands: [], gates: [] },
    ...over,
  }) as SimState;

describe('項目6: 能力状態の統合（operationalStateReadings が正本）', () => {
  it('gateFailure は閉鎖台帳より優先して failed になり、行は 1 件だけ', () => {
    const layout = createSampleAirport();
    const tower = Object.values(layout.facilities).find((f) => f.kind === 'tower')!;
    const state = fakeState({
      disruptions: [disruption({ id: 'dis_7', kind: 'gateFailure', targetId: tower.id })],
      closures: { taxiways: [], stands: [], gates: [tower.id] },
      closureReasons: { taxiways: {}, stands: {}, gates: { [tower.id]: ['disruption:dis_7'] } },
    } as Partial<SimState>);
    const merged = composeCapabilityReadings(layout, state);
    const rows = merged.filter((r) => r.subjectId === tower.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('failed');
  });

  it('滑走路モード closed とスポット閉鎖（台帳）も合成列に出る', () => {
    const layout = createSampleAirport();
    const runway = Object.values(layout.runways)[0]!;
    const stand = Object.values(layout.stands)[0]!;
    const state = fakeState({
      runwayConfig: { [runway.id]: { mode: 'closed' } } as unknown as SimState['runwayConfig'],
      closures: { taxiways: [], stands: [stand.id], gates: [] },
      closureReasons: { taxiways: {}, stands: { [stand.id]: ['manual'] }, gates: {} },
    } as Partial<SimState>);
    const merged = composeCapabilityReadings(layout, state);
    expect(merged.find((r) => r.subjectId === runway.id)?.state).toBe('closed');
    expect(merged.find((r) => r.subjectId === stand.id)?.state).toBe('closed');
    // 静的な施設行と二重にならない（滑走路・スポットは施設行に無いので追加行として 1 件ずつ）
    expect(merged.filter((r) => r.subjectId === runway.id)).toHaveLength(1);
    expect(merged.filter((r) => r.subjectId === stand.id)).toHaveLength(1);
  });

  it('staffAbsence は resourceShortage 行になり、要対応では mid 帯・targetId なしで出る', () => {
    const layout = createSampleAirport();
    const tower = Object.values(layout.facilities).find((f) => f.kind === 'tower')!;
    const state = fakeState({
      disruptions: [disruption({ id: 'dis_3', kind: 'staffAbsence', targetId: null, amount: 2, affected: { tasks: [], flights: [], units: ['u1', 'u2'] } })],
      closures: { taxiways: [], stands: [], gates: [tower.id] },
      closureReasons: { taxiways: {}, stands: {}, gates: { [tower.id]: ['manual'] } },
    } as Partial<SimState>);
    const merged = composeCapabilityReadings(layout, state);
    const shortage = merged.find((r) => r.subjectId === 'staff:absence');
    expect(shortage?.state).toBe('resourceShortage');
    expect(shortage?.theoretical).toBeNull();

    const company = createCareerCompany();
    const items = buildAttentionItems({ layout, analysis: analyzeLayout(layout), company, capabilities: merged });
    const shortageItem = items.find((i) => i.source === 'capability' && i.subjectId === 'staff:absence');
    expect(shortageItem).toBeDefined();
    expect(shortageItem!.band).toBe('mid');
    // 実在しないエンティティは地図フォーカス先にしない
    expect(shortageItem!.targetId).toBeUndefined();
    // 実在する施設の閉鎖は targetId を持つ（従来どおり）
    const closedItem = items.find((i) => i.source === 'capability' && i.subjectId === tower.id);
    expect(closedItem?.targetId).toBe(tower.id);
    // supplyShortage は生成されない（F6-13 保留に連動）
    expect(merged.some((r) => r.state === 'supplyShortage')).toBe(false);
  });

  it('baggageFailure / vehicleFailure（障害由来）は failed になる', () => {
    const layout = createSampleAirport();
    const sorter = Object.values(layout.facilities).find((f) => f.kind === 'baggageSort') ?? Object.values(layout.facilities)[0]!;
    const state = fakeState({
      disruptions: [
        disruption({ id: 'dis_4', kind: 'baggageFailure', targetId: sorter.id }),
        disruption({ id: 'dis_5', kind: 'vehicleFailure', targetId: 'unit_9' }),
      ],
    });
    const merged = composeCapabilityReadings(layout, state);
    expect(merged.find((r) => r.subjectId === sorter.id)?.state).toBe('failed');
    expect(merged.find((r) => r.subjectId === 'unit_9')?.state).toBe('failed');
    // 3 画面の一致: 能力ビュー・施設能力節・要対応はすべて同じ合成列から引く
    const inspectorRow = merged.find((r) => r.subjectId === sorter.id);
    const company = createCareerCompany();
    const items = buildAttentionItems({ layout, analysis: analyzeLayout(layout), company, capabilities: merged });
    const attentionItem = items.find((i) => i.source === 'capability' && i.subjectId === sorter.id);
    expect(attentionItem?.band).toBe('high'); // failed は high 帯（CAPABILITY_BAND）
    expect(inspectorRow?.state).toBe('failed');
  });

  it('障害に由来しない設備故障（state.equipment）も failed として生成される（F6-04 第三弾で解消）', () => {
    // 当初は operationalStateReadings が equipment を読まず、ランダム故障・手動停止の
    // 仕分け設備が failed にならない「既知の不足」として固定していた。バックエンド
    // （PR #58）で設備故障台帳の生成が入り、前提が変わったため本テストを反転した。
    // 理由の区別は repairUntil: あり＝ランダム故障（自動復旧予定あり）、
    // なし＝手動停止（自動復旧なし）。生成規則の詳細は capabilityEquipmentF6 が正本。
    const layout = createSampleAirport();
    const sorter = Object.values(layout.facilities).find((f) => f.kind === 'baggageSort');
    expect(sorter).toBeDefined();

    // ランダム故障（repairUntil あり）: failed 行が 1 件だけ、根拠に自動復旧予定
    const random = composeCapabilityReadings(layout, fakeState({
      equipment: { [sorter!.id]: { broken: true, repairUntil: 3600, downSec: 600 } },
    } as Partial<SimState>));
    const randomRows = random.filter((r) => r.subjectId === sorter!.id);
    expect(randomRows).toHaveLength(1);
    expect(randomRows[0]!.state).toBe('failed');
    expect(randomRows[0]!.basis).toContain('ランダム故障');

    // 手動停止（repairUntil なし）: failed 行が 1 件だけ、根拠は手動停止
    const manual = composeCapabilityReadings(layout, fakeState({
      equipment: { [sorter!.id]: { broken: true, repairUntil: null, downSec: 600 } },
    } as Partial<SimState>));
    const manualRows = manual.filter((r) => r.subjectId === sorter!.id);
    expect(manualRows).toHaveLength(1);
    expect(manualRows[0]!.state).toBe('failed');
    expect(manualRows[0]!.basis).toContain('手動停止');

    // 障害由来と併存しても二重計上なし（障害側の根拠が優先）
    const both = composeCapabilityReadings(layout, fakeState({
      disruptions: [disruption({ id: 'dis_8', kind: 'baggageFailure', targetId: sorter!.id })],
      equipment: { [sorter!.id]: { broken: true, repairUntil: null, downSec: 600 } },
    } as Partial<SimState>));
    const bothRows = both.filter((r) => r.subjectId === sorter!.id);
    expect(bothRows).toHaveLength(1);
    expect(bothRows[0]!.state).toBe('failed');
    expect(bothRows[0]!.basis).toContain('障害 dis_8');
  });
});

// ---------------------------------------------------------------- 項目5

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

describe('項目5: 日報項目の表示追随（5-21/5-23）', () => {
  beforeEach(() => {
    setStore(createSampleAirport());
  });

  it('processPeakStartText: peakStartMin があれば開始分、無ければ時台にフォールバック', () => {
    expect(processPeakStartText({ peakHour: 10, peakStartMin: 635 })).toBe('ピーク 10:35〜の60分');
    expect(processPeakStartText({ peakHour: 8 })).toBe('ピーク 8 時台');
    expect(processPeakHourOf({ peakHour: 9, peakStartMin: 635 })).toBe(10);
    expect(processPeakHourOf({ peakHour: 9 })).toBe(9);
  });

  it('processPeakValue: 能力のある工程は開始分つきの書式、能力なし工程は実績のみ', () => {
    const withCap = processPeakValue({ step: 'checkIn', capacityPerHour: 600, demandPerHour: 500, peakHour: 10, peakStartMin: 635, peakProcessed: 400, utilization: 0.83, avgWaitSec: 90 });
    expect(withCap).toContain('能力 600 人/時');
    expect(withCap).toContain('需要 500 人/時');
    expect(withCap).toContain('ピーク 10:35〜の60分 実績 400 人');
    expect(withCap).toContain('使用率 83%');
    for (const step of ['apronBus', 'access']) {
      const v = processPeakValue({ step, capacityPerHour: 0, peakHour: 7, peakStartMin: 425, peakProcessed: 120, utilization: null, avgWaitSec: 30 });
      expect(v).toContain('能力は算出しない（実績のみ）');
      expect(v).not.toContain('能力 0 人/時');
      expect(v).not.toContain('使用率');
      expect(v).toContain('ピーク 07:05〜の60分 実績 120 人');
    }
    // 旧日報（peakStartMin なし）は時台表示にフォールバックする
    const legacy = processPeakValue({ step: 'security', capacityPerHour: 300, demandPerHour: 200, peakHour: 8, peakProcessed: 250, utilization: 0.5, avgWaitSec: 60 });
    expect(legacy).toContain('ピーク 8 時台 実績 250 人');
  });

  it('stepWaitRows: 工程の正規順に並び、ラベルが付く。持たない日報は空', () => {
    const rows = stepWaitRows({
      access: { p50Sec: 600, p95Sec: 900, pax: 50 },
      checkIn: { p50Sec: 45, p95Sec: 120, pax: 300 },
      restroom: { p50Sec: 10, p95Sec: 30, pax: 90 },
    });
    expect(rows.map((r) => r.step)).toEqual(['checkIn', 'restroom', 'access']);
    expect(rows.map((r) => r.label)).toEqual(['チェックイン', 'トイレ', 'アクセス到着']);
    expect(stepWaitRows(undefined)).toEqual([]);
  });

  it('PROCESS_STEP_LABEL は 9 工程すべてを持ち、attention の工程名も新工程で生キーにならない', () => {
    for (const step of ['checkIn', 'security', 'emigration', 'immigration', 'customs', 'transferSecurity', 'restroom', 'apronBus', 'access']) {
      expect(PROCESS_STEP_LABEL[step]).toBeDefined();
    }
    const layout = createSampleAirport();
    const company = createCareerCompany();
    company.reports = [makeReport({
      processPeak: [{ step: 'restroom', capacityPerHour: 100, demandPerHour: 100, peakHour: 8, peakStartMin: 500, peakProcessed: 90, utilization: 1, avgWaitSec: 30 }],
    })];
    const items = buildAttentionItems({ layout, analysis: analyzeLayout(layout), company });
    const item = items.find((i) => i.source === 'processPeak');
    expect(item?.title).toContain('トイレ');
    expect(item?.detail).toContain('ピーク 08:20〜の60分');
  });

  it('ReviewBody: 新形式の日報では開始分・能力なし工程・stepWaits 節・外部境界の注記が出る', () => {
    const html = renderReview(makeReport({
      doorToDoor: {
        departure: { p50Sec: 1800, p95Sec: 3600, pax: 100 },
        arrival: { p50Sec: 900, p95Sec: 1500, pax: 80 },
        transfer: null,
        stepFree: { completed: 0, missed: 0, rate: null },
        stepWaits: { checkIn: { p50Sec: 45, p95Sec: 120, pax: 300 }, access: { p50Sec: 600, p95Sec: 900, pax: 50 } },
      },
      processPeak: [
        { step: 'checkIn', capacityPerHour: 600, demandPerHour: 500, peakHour: 10, peakStartMin: 635, peakProcessed: 400, utilization: 0.83, avgWaitSec: 90 },
        { step: 'apronBus', capacityPerHour: 0, demandPerHour: 0, peakHour: 7, peakStartMin: 425, peakProcessed: 120, utilization: null, avgWaitSec: 30 },
      ],
    }));
    expect(html).toContain('data-testid="review-door-step-waits"');
    expect(html).toContain('data-testid="review-door-step-wait-checkIn"');
    expect(html).toContain('data-testid="review-door-step-wait-access"');
    expect(html).toContain('工程別の待ち時間');
    expect(html).toContain('出発（空港到着→搭乗）');
    expect(html).toContain('アクセス移動を含む空港への到着時点から測ります');
    expect(html).toContain('ピーク 10:35〜の60分');
    expect(html).toContain('最も混んだ連続60分');
    expect(html).toContain('ランプバス');
    expect(html).toContain('能力は算出しない（実績のみ）');
    expect(html).not.toContain('能力 0 人/時');
  });

  it('ReviewBody: 旧形式の日報（peakStartMin / stepWaits なし）でも壊れず従来表示に落ちる', () => {
    const html = renderReview(makeReport({
      doorToDoor: {
        departure: { p50Sec: 1800, p95Sec: 3600, pax: 100 },
        arrival: null,
        transfer: null,
        stepFree: { completed: 0, missed: 0, rate: null },
      },
      processPeak: [
        { step: 'security', capacityPerHour: 300, demandPerHour: 200, peakHour: 8, peakProcessed: 250, utilization: 0.5, avgWaitSec: 60 },
      ],
    }));
    expect(html).toContain('ピーク 8 時台');
    expect(html).not.toContain('review-door-step-waits');
    expect(html).toContain('data-testid="review-process-peak"');
    expect(html).toContain('保安検査場');
  });

  it('静的表示との不変条件: layoutCapabilities の行数は合成で減らない', () => {
    const layout = createSampleAirport();
    const plain = layoutCapabilities(layout);
    const merged = composeCapabilityReadings(layout, fakeState({}));
    expect(merged).toHaveLength(plain.length);
  });
});
