import { describe, expect, it } from 'vitest';
import { heatBand, processAreaHeat, segmentEdgeLoads, staticBottlenecks } from '../../src/core/access/heatmap';
import { analyzeAccess } from '../../src/core/access/model';
import { accessDeparture } from '../../src/core/access/runtime';
import { createSandboxCompany, type DailyReport } from '../../src/core/economy/company';
import { updateEntity } from '../../src/core/layout/operations';
import type { AirportLayout } from '../../src/core/model/types';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createSimulation } from '../../src/core/sim/simulation';
import type { PaxGroup } from '../../src/core/sim/types';
import { must } from './helpers';

const seg = (l: AirportLayout): AirportLayout => ({ ...l, accessCapacityModel: 'segment' });

function edgeWhere(l: AirportLayout, pred: (e: AirportLayout['roads'][string], a: { x: number; y: number }, b: { x: number; y: number }) => boolean): string {
  return Object.values(l.roads).find((e) => pred(e, l.roadNodes[e.from]!.pos, l.roadNodes[e.to]!.pos))!.id;
}
/** y=57 の横方向の一般道路（ターミナル前の車寄せの区間。accessSegments.test と同じ探し方） */
const horizontalRoad = (l: AirportLayout): string => edgeWhere(l, (e, a, b) => e.roadClass === 'public' && a.y === 57 && b.y === 57);

describe('accessHeatmap: heatBand（使用率の3段階）', () => {
  it('境界: 40%未満 / 40%以上70%未満 / 70%以上', () => {
    expect(heatBand(0)).toBe(0);
    expect(heatBand(0.39)).toBe(0);
    expect(heatBand(0.4)).toBe(1);
    expect(heatBand(0.69)).toBe(1);
    expect(heatBand(0.7)).toBe(2);
    expect(heatBand(1.5)).toBe(2);
  });
});

describe('accessHeatmap: staticBottlenecks（2a 静的ボトルネック）', () => {
  it('集約モデルでは根拠がないため出さない', () => {
    expect(staticBottlenecks(createStarterAirfield())).toEqual([]);
  });

  it('区間モデルでは解析済みの bottleneckEdgeId が global として返る', () => {
    const base = seg(createStarterAirfield());
    const list = staticBottlenecks(base);
    expect(list.length).toBeGreaterThan(0);
    const globals = list.filter((b) => b.global);
    expect(globals).toHaveLength(1);
    expect(globals[0]!.edgeId).toBe(analyzeAccess(base).segments!.bottleneckEdgeId);
    expect(globals[0]!.capacityPerHour).toBe(900);
  });

  it('細くした区間が global になり、容量と車線数が出る', () => {
    const base = createStarterAirfield();
    const horizontal = horizontalRoad(base);
    const narrowed = seg(must(updateEntity(base, horizontal, { capacityPerHour: 300, lanes: 2 })).layout);
    const list = staticBottlenecks(narrowed);
    const global = list.find((b) => b.global)!;
    expect(global.edgeId).toBe(horizontal);
    expect(global.capacityPerHour).toBe(300);
    expect(global.lanes).toBe(2);
  });
});

describe('accessHeatmap: segmentEdgeLoads（2b 区間別ライブ交通量）', () => {
  it('区間モデルでない runtime では空', () => {
    const sim = createSimulation(createStarterAirfield(), { company: createSandboxCompany('agg-run'), seed: 'agg-run' });
    expect(sim.state.access!.segments).toBeUndefined();
    expect(segmentEdgeLoads(sim.state.access!, 0)).toEqual([]);
  });

  it('運航中に記録された辺ごとの台数を volume / capacity として読み取る（集計の追加なし）', () => {
    const layout = seg(createStarterAirfield());
    const sim = createSimulation(layout, { company: createSandboxCompany('seg-heat'), seed: 'seg-heat' });
    const acc = sim.state.access!;
    for (const m of Object.keys(acc.shares) as (keyof typeof acc.shares)[]) acc.shares[m] = m === 'dropoff' ? 1 : 0;
    const group = (id: string): PaxGroup => ({ id, count: 2, walkSec: 0 }) as unknown as PaxGroup;
    for (let i = 0; i <= 100; i++) accessDeparture(sim, group(`g${i}`));
    const hour = Math.floor(sim.state.now / 3600);
    const loads = segmentEdgeLoads(acc, hour);
    expect(loads.length).toBeGreaterThan(0);
    for (const load of loads) {
      // 記録済みの台数そのもの（貨物背景交通はこのセーブでは 0）
      expect(load.volume).toBe(acc.hourly[`seg:${load.edgeId}:${hour}`]);
      expect(load.capacity).toBe(acc.segments!.edges[load.edgeId]!.capacity);
      expect(load.ratio).toBeCloseTo(load.volume / load.capacity);
    }
    // 交通量のない時間帯は出さない
    expect(segmentEdgeLoads(acc, (hour + 3) % 24)).toEqual([]);
  });
});

describe('accessHeatmap: processAreaHeat（2c 工程使用率のエリア対応）', () => {
  const areas = [
    { id: 'a1', kind: 'checkIn', terminalId: 't1' },
    { id: 'a2', kind: 'security', terminalId: 't1' },
    { id: 'a3', kind: 'checkIn', terminalId: 't2' },
  ];
  const report = (over: Partial<DailyReport>): DailyReport => ({ day: 0, ...over }) as unknown as DailyReport;
  const peakRow = (step: string, utilization: number | null) => ({
    step, capacityPerHour: 600, demandPerHour: 500, peakHour: 8, peakProcessed: 400, utilization, avgWaitSec: 300,
  });
  const termRow = (terminalId: string, step: string, utilization: number | null) => ({
    terminalId, step, capacityPerHour: 600, peakHour: 8, peakProcessed: 400, utilization, avgWaitSec: 300,
  });

  it('日報がなければ出さない', () => {
    expect(processAreaHeat(undefined, areas)).toEqual([]);
    expect(processAreaHeat(report({}), areas)).toEqual([]);
  });

  it('ターミナル別があればそちらを優先し、空港全体と二重に数えない', () => {
    const r = report({
      processPeak: [peakRow('checkIn', 0.5)],
      processPeakByTerminal: [termRow('t1', 'checkIn', 0.9)],
    });
    expect(processAreaHeat(r, areas)).toEqual([{ areaId: 'a1', step: 'checkIn', utilization: 0.9 }]);
  });

  it('ターミナル別がなければ工程別（空港全体）で引く。使用率 null は出さない', () => {
    const r = report({ processPeak: [peakRow('security', 0.5), peakRow('checkIn', null)] });
    expect(processAreaHeat(r, areas)).toEqual([{ areaId: 'a2', step: 'security', utilization: 0.5 }]);
  });
});
