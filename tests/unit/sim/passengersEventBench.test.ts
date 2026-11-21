import { afterEach, describe, expect, it } from 'vitest';
import { createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import {
  peekPerfSnapshot,
  resetPerfStats,
  setPaxDetailEnabled,
  setPerfClock,
  takePerfSnapshot,
} from '../../../src/core/sim/perfStats';
import { loadFixture } from '../../golden/io';
import { setFacilityEventModeForTest, setPaxEventModeForTest } from '../../../src/core/sim/passengers';
import { setBagEventModeForTest } from '../../../src/core/sim/baggage';

/**
 * 性能改善 第4弾（PERF4）のベンチ: 第3弾と同じストレスフィクスチャ
 * （stress レイアウト・flightsPerDay 120）で 7,200 tick × 3 回の中央値を測る。
 * 数値は console に出し、合否は桁違いの退行だけを見る緩い上限にする（VM のノイズが大きいため）。
 * PERF4-0 のサブフェーズ計測を有効化し、passengers の内訳（便/占有/グループ/施設）も併記する。
 */
const TICKS = 7200;
const WARMUP = 3600;

function runOnce(eventMode: boolean): { msPerTick: number; snap: ReturnType<typeof peekPerfSnapshot> } {
  setPaxEventModeForTest(eventMode);
  setFacilityEventModeForTest(eventMode);
  setBagEventModeForTest(eventMode);
  const sim = createSimulation(loadFixture('stress'), { seed: 'stress-a', settings: { flightsPerDay: 120 } });
  for (let i = 0; i < WARMUP; i++) stepSimulation(sim);
  resetPerfStats();
  takePerfSnapshot();
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) stepSimulation(sim);
  const ms = performance.now() - t0;
  return { msPerTick: ms / TICKS, snap: peekPerfSnapshot() };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('PERF4 ベンチ（ストレスフィクスチャ）', () => {
  afterEach(() => {
    setPaxDetailEnabled(false);
    setPerfClock(() => 0);
    resetPerfStats();
    setPaxEventModeForTest(true);
    setFacilityEventModeForTest(true);
    setBagEventModeForTest(true);
  });

  it('7,200 tick × 3 回の中央値と passengers 内訳を記録する（従来モード→イベントモード）', { timeout: 1_200_000 }, () => {
    setPerfClock(() => performance.now());
    setPaxDetailEnabled(true);
    // before: 従来モード（全走査。PAX 完了ツリー相当のアルゴリズム）
    const legacyRuns: ReturnType<typeof runOnce>[] = [];
    for (let k = 0; k < 3; k++) legacyRuns.push(runOnce(false));
    const legacyMed = median(legacyRuns.map((r) => r.msPerTick));
    const legacySnap = legacyRuns[legacyRuns.length - 1]!.snap;
    const lstep = (key: string): number => legacySnap.steps.find((s) => s.key === key)?.avgMs ?? 0;
    console.log(
      `[perf4-bench] BEFORE tick median ${legacyMed.toFixed(3)} ms/tick (runs: ${legacyRuns.map((r) => r.msPerTick.toFixed(3)).join(', ')}), passengers ${lstep('passengers').toFixed(3)}, baggage ${lstep('baggage').toFixed(3)}`,
    );
    // after: イベントモード（PERF4 全適用）
    const runs: ReturnType<typeof runOnce>[] = [];
    for (let k = 0; k < 3; k++) runs.push(runOnce(true));
    const med = median(runs.map((r) => r.msPerTick));
    const last = runs[runs.length - 1]!.snap;
    const step = (key: string): number => last.steps.find((s) => s.key === key)?.avgMs ?? 0;
    const detail = Object.fromEntries(last.paxDetail.map((d) => [d.key, Math.round(d.avgMs * 1000) / 1000]));
    console.log(
      `[perf4-bench] AFTER tick median ${med.toFixed(3)} ms/tick (runs: ${runs.map((r) => r.msPerTick.toFixed(3)).join(', ')})`,
    );
    console.log(
      `[perf4-bench] perfStats tick ${last.tickAvgMs.toFixed(3)} ms, passengers ${step('passengers').toFixed(3)}, baggage ${step('baggage').toFixed(3)}, aircraft ${step('aircraft').toFixed(3)}, other-sum ${(last.tickAvgMs - step('passengers') - step('baggage') - step('aircraft')).toFixed(3)}`,
    );
    console.log(`[perf4-bench] paxDetail ${JSON.stringify(detail)}`);
    console.log(
      `[perf4-bench] scale paxGroups=${last.scale.paxGroups} scan=${last.scale.paxScan ?? '-'} pending=${last.scale.paxPending ?? '-'} sleeping=${last.scale.paxSleeping ?? '-'} awake=${last.scale.paxAwake ?? '-'} bags=${last.scale.bags} aircraft=${last.scale.aircraft}`,
    );
    expect(med).toBeLessThan(30); // 桁違いの退行検出のみ（第3弾実測 3.834 ms/tick）
    expect(last.scale.paxGroups).toBeGreaterThan(100);
  });
});
