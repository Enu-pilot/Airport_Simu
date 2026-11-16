/** 監査 c / ID18: 長時間・高負荷。数値（wall ms・heap・イベント数）は test-results には書かず、失敗しない範囲の上限だけ検査する */
import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { sampleSim, runChecked, DAY_SEC } from './c_helpers';
import { EVENT_LOG_LIMIT } from '../../src/core/sim/types';

const note = (s: string) => { if (process.env.AUDIT_NOTES) appendFileSync(process.env.AUDIT_NOTES, s + '\n'); };

describe('ID18 長時間・高負荷', () => {
  it('3 日 + ランダム障害: 毎日出発があり、イベントログは上限以内、日報が増え続けても状態の大きさが日ごとに線形を超えて増えない', () => {
    const sim = sampleSim({ seed: 'c-long3', settings: { randomDisruptions: true } });
    const sizes: number[] = [];
    for (let d = 0; d < 3; d++) {
      const dep0 = sim.state.stats.departures;
      const t0 = performance.now();
      runChecked(sim, (d + 1) * DAY_SEC - sim.state.now + 600, 60, `long d${d}`);
      note(`longrun seed=c-long3 day=${d} wallMs=${Math.round(performance.now() - t0)} heapMB=${Math.round(process.memoryUsage().heapUsed / 1e6)} events=${sim.state.events.length} stateKB=${Math.round(JSON.stringify(sim.state).length / 1024)}`);
      expect(sim.state.stats.departures - dep0).toBeGreaterThan(0);
      expect(sim.state.events.length).toBeLessThanOrEqual(EVENT_LOG_LIMIT);
      sizes.push(JSON.stringify(sim.state).length);
    }
    // 3 日目の状態は 1 日目の 4 倍未満（記録の蓄積は線形・有界）
    expect(sizes[2]!).toBeLessThan(sizes[0]! * 4);
    expect(sim.company!.reports.length).toBeGreaterThanOrEqual(2);
  });

  it('高負荷: 乱数スケジュール 150 往復/日を 8 時間（旅客・手荷物が大量）。不変条件・旅客保存則を保つ', () => {
    const sim = sampleSim({ seed: 'c-load150', sandbox: false, settings: { flightsPerDay: 150 } });
    const t0 = performance.now();
    runChecked(sim, 8 * 3600, 120, 'load150');
    note(`load seed=c-load150 flights=${Object.keys(sim.state.flights).length} spawned=${sim.state.paxStats.spawned} bags=${Object.keys(sim.state.bags).length} wallMs=${Math.round(performance.now() - t0)} heapMB=${Math.round(process.memoryUsage().heapUsed / 1e6)}`);
    expect(Object.keys(sim.state.flights).length).toBeGreaterThan(150);
    expect(sim.state.paxStats.spawned).toBeGreaterThan(5000);
    const p = sim.state.paxStats;
    expect(p.boarded + p.missed).toBeLessThanOrEqual(p.spawned);
    expect(sim.state.events.length).toBeLessThanOrEqual(EVENT_LOG_LIMIT);
  });
});
