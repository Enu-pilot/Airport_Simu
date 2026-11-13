import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createCareerCompany, createSandboxCompany } from '../../src/core/economy/company';
import { createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { dayMarker, majorDisruptionWatcher, nextCloseAt, stepTicks } from '../../src/core/sim/dayloop';
import { Rng } from '../../src/core/rng';
import { DAY_SEC } from '../../src/core/sim/rules';

/**
 * 1 日のループの決定性: 分割の仕方・停止条件の有無にかかわらず、締めの時点の状態は連続実行と一致する。
 */

const hash = (sim: Simulation) => JSON.stringify({ state: sim.state, company: sim.company });

type Make = () => Simulation;
const CASES: Record<string, Make> = {
  'サンプル空港＋サンドボックス会社': () => createSimulation(createSampleAirport(), { seed: 'dl1', company: createSandboxCompany('dl1') }),
  'キャリア初期': () => createSimulation(createStarterAirfield(), { seed: 'dl2', company: createCareerCompany('dl2') }),
  'ランダム障害 ON': () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'dl3', company: createSandboxCompany('dl3') });
    sim.state.settings.randomDisruptions = true;
    return sim;
  },
};

/** 連続実行: stepSimulation を締めまで（基準） */
function continuous(sim: Simulation): number {
  const m = dayMarker(sim);
  let n = 0;
  do {
    stepSimulation(sim);
    n++;
  } while (dayMarker(sim) === m);
  return n;
}

/** ランダムなチャンク（1〜5000）で締めまで進める。stopWhen は止まるたびに続きを進める */
function chunked(sim: Simulation, seed: string, withWatcher: boolean): { chunks: number; stops: number } {
  const rng = new Rng(seed);
  const m = dayMarker(sim);
  const stopWhen = withWatcher ? majorDisruptionWatcher(sim) : undefined;
  let chunks = 0;
  let stops = 0;
  for (;;) {
    const r = stepTicks(sim, rng.int(1, 5000), { stopAtDayClose: true, ...(stopWhen ? { stopWhen } : {}) });
    chunks++;
    if (r.stop === 'predicate') stops++;
    if (r.stop === 'dayClose') {
      expect(dayMarker(sim)).toBe(m + 1);
      return { chunks, stops };
    }
    expect(r.stop === null || r.stop === 'predicate').toBe(true);
  }
}

describe('stepTicks: 分割しても連続実行と同じ', () => {
  for (const [name, make] of Object.entries(CASES)) {
    it(`${name}: ランダムなチャンク・一括・停止条件つきがすべて一致する`, { timeout: 300_000 }, () => {
      const base = make();
      const need = nextCloseAt(base) - base.state.now + 1;
      expect(continuous(base)).toBe(need);
      const expected = hash(base);

      const a = make();
      const ra = chunked(a, 'chunks-a', false);
      expect(ra.chunks).toBeGreaterThan(10);
      expect(hash(a)).toBe(expected);

      const b = make();
      const rb = stepTicks(b, Number.MAX_SAFE_INTEGER, { stopAtDayClose: true });
      expect(rb).toEqual({ ticks: need, stop: 'dayClose' });
      expect(hash(b)).toBe(expected);

      const c = make();
      chunked(c, 'chunks-b', true);
      expect(hash(c)).toBe(expected);
    });
  }

  it('締めを行った tick の直後で止まる（now は 0:00 の 1 秒後）', () => {
    const sim = CASES['キャリア初期']!();
    const r = stepTicks(sim, DAY_SEC * 2, { stopAtDayClose: true });
    expect(r.stop).toBe('dayClose');
    expect(sim.state.now).toBe(DAY_SEC + 1);
    expect(sim.company!.day).toBe(1);
    expect(sim.company!.reports.length).toBe(1);
  });

  it('stopAtDayClose なしでは日をまたいで進む', () => {
    const sim = CASES['キャリア初期']!();
    const r = stepTicks(sim, DAY_SEC + 100);
    expect(r).toEqual({ ticks: DAY_SEC + 100, stop: null });
    expect(sim.company!.day).toBe(1);
  });

  it('stopWhen は条件を満たした tick の直後で止まり、状態を変えない', () => {
    const a = CASES['サンプル空港＋サンドボックス会社']!();
    const t0 = a.state.now;
    const r = stepTicks(a, 10_000, { stopWhen: (s) => s.state.now >= t0 + 777 });
    expect(r).toEqual({ ticks: 777, stop: 'predicate' });
    const b = CASES['サンプル空港＋サンドボックス会社']!();
    stepTicks(b, 777);
    expect(hash(a)).toBe(hash(b));
  });

  it('重大な障害の検出: 滑走路の閉鎖で止まる', () => {
    const sim = CASES['サンプル空港＋サンドボックス会社']!();
    const watch = majorDisruptionWatcher(sim);
    expect(stepTicks(sim, 600, { stopWhen: watch }).stop).toBeNull();
    const rid = Object.keys(sim.state.runways)[0]!;
    sim.state.disruptions.push({
      id: 'dz1', kind: 'runwayClosed', targetId: rid, start: sim.state.now, end: null, status: 'active', resolvedAt: null, resolvedBy: null,
      affected: { tasks: [], flights: [], units: [] }, origin: 'manual',
    });
    expect(stepTicks(sim, 5, { stopWhen: watch })).toEqual({ ticks: 1, stop: 'predicate' });
    // 同じ障害では二度と止まらない
    expect(stepTicks(sim, 5, { stopWhen: watch }).stop).toBeNull();
  });
});
