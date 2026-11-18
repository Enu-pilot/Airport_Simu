import { describe, expect, it } from 'vitest';
import { recordJourneyFinish, recordJourneyStepFreeMiss, takeJourneyStats, weightedPercentile } from '../../src/core/sim/journeyStats';
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
