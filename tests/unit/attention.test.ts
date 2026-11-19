import { describe, expect, it } from 'vitest';
import { buildAttentionItems, type AttentionSource } from '../../src/core/attention';
import { createCareerCompany, type CompanyState, type DailyReport } from '../../src/core/economy/company';
import { placeFacility } from '../../src/core/layout/operations';
import type { AirportLayout } from '../../src/core/model/types';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { analyzeLayout, type Issue } from '../../src/core/validation/validate';

const REPORT_SOURCES: AttentionSource[] = ['missed', 'groundWaits', 'processPeak', 'morningReadiness', 'hub', 'cargo', 'access', 'maintenance'];

const makeReport = (over: Partial<DailyReport>): DailyReport => ({ day: 0, ...over }) as unknown as DailyReport;

const companyWith = (over: Partial<DailyReport> | null): CompanyState => {
  const company = createCareerCompany();
  if (over) company.reports = [makeReport(over)];
  return company;
};

const build = (layout: AirportLayout, company: CompanyState, analysis = analyzeLayout(layout)) =>
  buildAttentionItems({ layout, analysis, company });

const peak = (utilization: number | null) => ({
  step: 'checkIn',
  capacityPerHour: 600,
  demandPerHour: 500,
  peakHour: 8,
  peakProcessed: 400,
  utilization,
  avgWaitSec: 300,
});

describe('UI改善 案1: buildAttentionItems', () => {
  it('日報が無いと日報由来の項目は出ない（未計測と問題なしを区別する）', () => {
    const layout = createStarterAirfield();
    const items = build(layout, companyWith(null));
    expect(items.filter((i) => REPORT_SOURCES.includes(i.source))).toEqual([]);
  });

  it('日報があっても全て 0 / 空なら日報由来の項目は出ない', () => {
    const layout = createStarterAirfield();
    const items = build(
      layout,
      companyWith({
        missedBreakdown: [],
        groundWaits: [],
        processPeak: [],
        morningReadiness: { scheduled: 3, ready: 3, atRisk: 0 },
        hub: { spawned: 10, connected: 10, missed: 0, noShow: 0 },
        cargo: { carriedM3: 100, leftoverM3: 0, revenue: 0, handlingCost: 0, truckTrips: 2 },
        kpi: { parkingFull: 0, roadDelayMin: 0 } as unknown as DailyReport['kpi'],
        maintenance: { checked: 2, overdue: 0, faults: 0, techCancelled: 0 },
      }),
    );
    expect(items.filter((i) => REPORT_SOURCES.includes(i.source))).toEqual([]);
  });

  it('検証: error は high、warning は low、info は対象外', () => {
    const layout = createStarterAirfield();
    const fake = (severity: string, key: string) =>
      ({ key, code: 'NO_RUNWAY', severity, targets: [], related: [], params: {} }) as unknown as Issue;
    const analysis = {
      ...analyzeLayout(layout),
      issues: [fake('error', 'e1'), fake('warning', 'w1'), fake('info', 'i1')],
    };
    const items = build(layout, companyWith(null), analysis).filter((i) => i.source === 'validation');
    expect(items.map((i) => [i.subjectId, i.band])).toEqual([
      ['e1', 'high'],
      ['w1', 'low'],
    ]);
  });

  it('能力状態: 建設中の管制塔は low で対象 ID を持つ', () => {
    const base = createStarterAirfield();
    const tower = Object.values(base.facilities).find((f) => f.kind === 'tower')!;
    const layout: AirportLayout = {
      ...base,
      facilities: { ...base.facilities, [tower.id]: { ...tower, buildState: 'underConstruction' } },
    };
    const items = build(layout, companyWith(null)).filter((i) => i.source === 'capability' && i.subjectId === tower.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.band).toBe('low');
    expect(items[0]!.targetId).toBe(tower.id);
  });

  it('能力状態: 能力 0 のバスターミナルは mid', () => {
    const placed = placeFacility(createStarterAirfield(), 'busTerminal', { x: 36, y: 58 });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const f = Object.values(placed.layout.facilities).find((x) => x.kind === 'busTerminal')!;
    const layout: AirportLayout = {
      ...placed.layout,
      facilities: { ...placed.layout.facilities, [f.id]: { ...f, props: { ...f.props, busesPerHour: 0 } } },
    };
    const items = build(layout, companyWith(null)).filter((i) => i.source === 'capability' && i.subjectId === f.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.band).toBe('mid');
  });

  it('乗り遅れ: 分類の合計が 100 人以上なら最大項目が high、それ以外は low', () => {
    const layout = createStarterAirfield();
    const areaId = Object.values(layout.terminalAreas)[0]!.id;
    const items = build(
      layout,
      companyWith({
        missedBreakdown: [
          { category: 'checkIn', spotId: areaId, count: 60 },
          { category: 'checkIn', spotId: null, count: 50 },
          { category: 'security', spotId: null, count: 99 },
        ],
      }),
    ).filter((i) => i.source === 'missed');
    // checkIn 合計 110 → 最大の 60 人の項目だけ high。security は合計 99 で low
    expect(items.find((i) => i.subjectId === `checkIn-${areaId}`)?.band).toBe('high');
    expect(items.find((i) => i.subjectId === 'checkIn-unknown')?.band).toBe('low');
    expect(items.find((i) => i.subjectId === 'security-unknown')?.band).toBe('low');
    expect(items.find((i) => i.subjectId === `checkIn-${areaId}`)?.targetId).toBe(areaId);
  });

  it('資源待ち: 3,600 秒が mid の境界', () => {
    const layout = createStarterAirfield();
    const at = build(layout, companyWith({ groundWaits: [{ reason: 'noEngineer', sec: 3600 }] })).find((i) => i.source === 'groundWaits');
    expect(at?.band).toBe('mid');
    const below = build(layout, companyWith({ groundWaits: [{ reason: 'noEngineer', sec: 3599 }] })).find((i) => i.source === 'groundWaits');
    expect(below?.band).toBe('low');
    const zero = build(layout, companyWith({ groundWaits: [{ reason: 'noEngineer', sec: 0 }] })).filter((i) => i.source === 'groundWaits');
    expect(zero).toEqual([]);
  });

  it('工程ピーク: 使用率 1.0 / 0.85 / 0.7 が high / mid / low の境界、未満と null は出ない', () => {
    const layout = createStarterAirfield();
    const bandOf = (u: number | null) =>
      build(layout, companyWith({ processPeak: [peak(u)] })).find((i) => i.source === 'processPeak')?.band;
    expect(bandOf(1.0)).toBe('high');
    expect(bandOf(0.85)).toBe('mid');
    expect(bandOf(0.7)).toBe('low');
    expect(bandOf(0.69)).toBeUndefined();
    expect(bandOf(null)).toBeUndefined();
  });

  it('工程ピーク: ターミナル別があれば空港全体と二重に出さない', () => {
    const layout = createStarterAirfield();
    const items = build(
      layout,
      companyWith({
        processPeak: [peak(0.5)],
        processPeakByTerminal: [
          { terminalId: 'T1', step: 'security', capacityPerHour: 300, peakHour: 9, peakProcessed: 280, utilization: 0.9, avgWaitSec: 60 },
        ],
      }),
    ).filter((i) => i.source === 'processPeak');
    expect(items).toHaveLength(1);
    expect(items[0]!.subjectId).toBe('T1:security');
    expect(items[0]!.band).toBe('mid');
  });

  it('翌朝リスク・貨物積み残しは mid、乗継・駐車場・整備は low', () => {
    const layout = createStarterAirfield();
    const items = build(
      layout,
      companyWith({
        morningReadiness: { scheduled: 5, ready: 3, atRisk: 2 },
        cargo: { carriedM3: 80, leftoverM3: 12.5, revenue: 0, handlingCost: 0, truckTrips: 3 },
        hub: { spawned: 100, connected: 90, missed: 10, noShow: 0 },
        kpi: { parkingFull: 4 } as unknown as DailyReport['kpi'],
        maintenance: { checked: 2, overdue: 1, faults: 0, techCancelled: 0 },
      }),
    );
    expect(items.find((i) => i.source === 'morningReadiness')?.band).toBe('mid');
    expect(items.find((i) => i.source === 'cargo')?.band).toBe('mid');
    expect(items.find((i) => i.source === 'hub')?.band).toBe('low');
    expect(items.find((i) => i.source === 'access' && i.subjectId === 'parkingFull')?.band).toBe('low');
    expect(items.find((i) => i.source === 'maintenance')?.band).toBe('low');
  });

  it('道路の平均遅れは 5 分未満では出ない', () => {
    const layout = createStarterAirfield();
    const small = build(layout, companyWith({ kpi: { roadDelayMin: 2 } as unknown as DailyReport['kpi'] })).filter((i) => i.subjectId === 'roadDelay');
    expect(small).toEqual([]);
    const big = build(layout, companyWith({ kpi: { roadDelayMin: 17.5 } as unknown as DailyReport['kpi'] })).filter((i) => i.subjectId === 'roadDelay');
    expect(big).toHaveLength(1);
    expect(big[0]!.band).toBe('low');
  });

  it('並び順: 帯（high→mid→low）→ 帯内は主指標の降順で決定的', () => {
    const layout = createStarterAirfield();
    const company = companyWith({
      processPeak: [peak(1.2)],
      groundWaits: [{ reason: 'noEngineer', sec: 7200 }],
      cargo: { carriedM3: 0, leftoverM3: 5, revenue: 0, handlingCost: 0, truckTrips: 0 },
      hub: { spawned: 50, connected: 40, missed: 10, noShow: 0 },
    });
    const reportItems = build(layout, company).filter((i) => REPORT_SOURCES.includes(i.source));
    expect(reportItems.map((i) => i.band)).toEqual(['high', 'mid', 'mid', 'low']);
    // mid 帯内は metric 降順: 資源待ち 7200秒 が貨物 5m³ より前
    expect(reportItems[1]!.source).toBe('groundWaits');
    expect(reportItems[2]!.source).toBe('cargo');
    // 同じ入力では毎回同じ順序
    expect(build(layout, company).map((i) => i.id)).toEqual(build(layout, company).map((i) => i.id));
  });
});
