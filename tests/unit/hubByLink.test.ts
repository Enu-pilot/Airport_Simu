import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createCareerCompany, type DailyReport } from '../../src/core/economy/company';
import { settleDay } from '../../src/core/economy/ops';
import { createSimulation, type Simulation } from '../../src/core/sim/simulation';

/**
 * 乗継リンク別実績（hubStats.byLink）の日次集計。
 * SimState.hubStats は累計、DailyReport.hub は当日分（差分）という既存の契約を、
 * リンク別でも同じに保つことを固定する。
 */
function hubSim(): Simulation {
  const company = createCareerCompany();
  company.features = { hub: true };
  const sim = createSimulation(createStarterAirfield(), { company });
  sim.state.hubStats = { spawned: 0, connected: 0, missed: 0, noShow: 0, byLink: {} };
  return sim;
}

/** DayReview のリンク別ブロックの表示条件（src/ui/DayReview.tsx と同じ述語） */
const byLinkVisible = (r: DailyReport): boolean => !!(r.hub?.byLink && Object.keys(r.hub.byLink).length > 0);

describe('日報の乗継リンク別集計（hub.byLink）', () => {
  it('1. 乗継リンクごとの利用実績が日報に記録される（既存4項目の集計は不変）', () => {
    const sim = hubSim();
    sim.state.hubStats = { spawned: 40, connected: 35, missed: 3, noShow: 2, byLink: { linkA: 12 } };
    const r = settleDay(sim, true)!;
    expect(r.hub).toEqual({ spawned: 40, connected: 35, missed: 3, noShow: 2, byLink: { linkA: 12 } });
    expect(byLinkVisible(r)).toBe(true);
  });

  it('2. 複数リンクの実績が正しく分離される', () => {
    const sim = hubSim();
    sim.state.hubStats!.byLink = { linkA: 10, linkB: 4, linkC: 27 };
    const r = settleDay(sim, true)!;
    expect(r.hub?.byLink).toEqual({ linkA: 10, linkB: 4, linkC: 27 });
  });

  it('3. 2日目の集計で前日の累計を二重計上しない', () => {
    const sim = hubSim();
    sim.state.hubStats!.byLink = { linkA: 10 };
    const day1 = settleDay(sim, true)!;
    expect(day1.hub?.byLink).toEqual({ linkA: 10 });
    sim.state.hubStats!.byLink.linkA = 25;
    const day2 = settleDay(sim, true)!;
    expect(day2.hub?.byLink).toEqual({ linkA: 15 });
  });

  it('4. 前日に存在しなかったリンクも集計でき、増分のないリンクは含めない', () => {
    const sim = hubSim();
    sim.state.hubStats!.byLink = { linkA: 10 };
    settleDay(sim, true);
    sim.state.hubStats!.byLink = { linkA: 10, linkB: 7 };
    const day2 = settleDay(sim, true)!;
    expect(day2.hub?.byLink).toEqual({ linkB: 7 });
  });

  it('5. 利用実績がない場合は byLink を持たず、表示条件も偽になる', () => {
    const sim = hubSim();
    sim.state.hubStats = { spawned: 5, connected: 5, missed: 0, noShow: 0, byLink: {} };
    const r = settleDay(sim, true)!;
    expect(r.hub).toEqual({ spawned: 5, connected: 5, missed: 0, noShow: 0 });
    expect(r.hub?.byLink).toBeUndefined();
    expect(byLinkVisible(r)).toBe(false);
  });

  it('6. 旧データ互換: byLink の無い hubStats でも締められ、byLink の無い旧日報は表示対象にならない', () => {
    const sim = hubSim();
    // 旧セーブの hubStats は byLink を持たないことがある（実行時の形）
    sim.state.hubStats = { spawned: 5, connected: 5, missed: 0, noShow: 0 } as Simulation['state']['hubStats'];
    const r = settleDay(sim, true)!;
    expect(r.hub).toEqual({ spawned: 5, connected: 5, missed: 0, noShow: 0 });
    expect(r.hub?.byLink).toBeUndefined();

    // 旧日報（hub に byLink が無い）は型として有効で、表示ガードで弾かれる
    const legacy = { hub: { spawned: 1, connected: 1, missed: 0, noShow: 0 } } as unknown as DailyReport;
    expect(legacy.hub?.byLink).toBeUndefined();
    expect(byLinkVisible(legacy)).toBe(false);
  });
});
