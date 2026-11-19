import { describe, expect, it } from 'vitest';
import { recordJourneyFinish, recordJourneyStart, recordJourneyStepFreeMiss, recordStepWait, takeJourneyStats, weightedPercentile } from '../../src/core/sim/journeyStats';
import { createSandboxCompany } from '../../src/core/economy/company';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { DAY_SEC } from '../../src/core/sim/rules';
import type { PaxGroup, SimState } from '../../src/core/sim/types';

describe('5-23 Door-to-Door KPI の集計', () => {
  it('人数重みつき分位点が正しい', () => {
    // 100 人が 600 秒、10 人が 3600 秒 → p50 は 600、p95 も 600（累積 100/110 ≥ 0.95 は 3600 側）
    expect(weightedPercentile([[600, 100], [3600, 10]], 0.5)).toBe(600);
    expect(weightedPercentile([[600, 100], [3600, 10]], 0.95)).toBe(3600);
    expect(weightedPercentile([], 0.5)).toBeNull();
  });

  it('完了・乗り遅れの記録から種類別の要約と Step-free 率を作る', () => {
    const state = { now: 10000 } as SimState;
    const g = (over: Partial<PaxGroup>): PaxGroup => ({ appearAt: 9000, count: 10, direction: 'departure', ...over } as PaxGroup);
    recordJourneyFinish(state, g({}));
    recordJourneyFinish(state, g({ direction: 'arrival', appearAt: 8000 }));
    recordJourneyFinish(state, g({ transfer: { fromFlightId: 'x', kind: 'DD' }, appearAt: 9500, stepFree: true } as Partial<PaxGroup>));
    recordJourneyStepFreeMiss(state, 5);
    const s = takeJourneyStats(state);
    expect(s!.departure).toMatchObject({ p50Sec: 1000, pax: 10 });
    expect(s!.arrival).toMatchObject({ p50Sec: 2000, pax: 10 });
    expect(s!.transfer).toMatchObject({ p50Sec: 500, pax: 10 });
    expect(s!.stepFree).toEqual({ completed: 10, missed: 5, rate: 0.667 });
    expect(takeJourneyStats(state)).toBeNull();
  });

  it('外部境界（5-23 残件）: 出発の所要は記録した出現時刻から測り、アクセス移動を含む', () => {
    const state = { now: 10000 } as SimState;
    // 出現は 8000。その後アクセス遅延で appearAt が 9000 に後ろ倒しされても起点は 8000
    recordJourneyStart(state, 'g-ext', 8000);
    const g = { id: 'g-ext', appearAt: 9000, count: 4, direction: 'departure' } as PaxGroup;
    recordJourneyFinish(state, g);
    const s = takeJourneyStats(state);
    expect(s!.departure).toMatchObject({ p50Sec: 2000, pax: 4 });
  });

  it('工程別パーセンタイル（5-23 残件）: 工程ごとの待ちを分位点で返す', () => {
    const state = { now: 10000 } as SimState;
    recordStepWait(state, 'checkIn', 600, 100);
    recordStepWait(state, 'checkIn', 3600, 10);
    recordStepWait(state, 'security', 120, 50);
    recordJourneyFinish(state, { appearAt: 9000, count: 10, direction: 'departure' } as PaxGroup);
    const s = takeJourneyStats(state);
    expect(s!.stepWaits!.checkIn).toMatchObject({ p50Sec: 600, p95Sec: 3600, pax: 110 });
    expect(s!.stepWaits!.security).toMatchObject({ p50Sec: 120, pax: 50 });
  });
});

describe('5-23 日報への反映', () => {
  it('1 日運航すると doorToDoor に出発・到着の分位点が付く', { timeout: 600000 }, () => {
    const c = createSandboxCompany('d2d-523');
    const sim = createSimulation(createStarterAirfield(), { company: c, seed: 'd2d-523' });
    const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
    while (sim.state.now <= target) stepSimulation(sim);
    const r = c.reports[c.reports.length - 1]!;
    expect(r.doorToDoor).toBeDefined();
    expect(r.doorToDoor!.departure).not.toBeNull();
    expect(r.doorToDoor!.departure!.pax).toBeGreaterThan(0);
    expect(r.doorToDoor!.departure!.p50Sec).toBeGreaterThan(0);
    expect(r.doorToDoor!.departure!.p95Sec).toBeGreaterThanOrEqual(r.doorToDoor!.departure!.p50Sec);
    expect(r.doorToDoor!.arrival).not.toBeNull();
  });
});
