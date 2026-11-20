import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PERF_STEP_KEYS,
  peekPerfSnapshot,
  perfChainStart,
  recordDraw,
  recordFrame,
  resetPerfStats,
  setPerfClock,
  takePerfSnapshot,
} from '../../src/core/sim/perfStats';

/**
 * 性能計測（perf-audit.md §7）: 集計の平均・リセット・規模カウンタの保持を検証する。
 * 時計は注入式なので、読むたびに 5ms 進む偽時計で決定的に検証する。
 */
beforeEach(() => {
  resetPerfStats();
  let t = 0;
  setPerfClock(() => (t += 5));
});

afterEach(() => {
  setPerfClock(() => 0);
  resetPerfStats();
});

describe('perfStats の集計', () => {
  it('チェーンで記録した tick は合計と内訳が一致し、規模カウンタが残る', () => {
    const chain = perfChainStart();
    chain.mark('economy');
    chain.mark('passengers');
    chain.finish('analytics', { paxGroups: 12, aircraft: 3, bags: 40 });
    const snap = peekPerfSnapshot();
    expect(snap.ticks).toBe(1);
    expect(snap.scale).toEqual({ paxGroups: 12, aircraft: 3, bags: 40 });
    expect(snap.steps.map((s) => s.key).sort()).toEqual([...PERF_STEP_KEYS].sort());
    // 偽時計は1読み 5ms: economy / passengers / analytics が各 5ms、合計 15ms
    expect(snap.tickAvgMs).toBeCloseTo(15, 6);
    const byKey = Object.fromEntries(snap.steps.map((s) => [s.key, s.avgMs]));
    expect(byKey.economy).toBeCloseTo(5, 6);
    expect(byKey.passengers).toBeCloseTo(5, 6);
    expect(byKey.analytics).toBeCloseTo(5, 6);
    const stepSum = snap.steps.reduce((a, s) => a + s.avgMs, 0);
    expect(stepSum).toBeCloseTo(snap.tickAvgMs, 6);
    // 内訳は降順
    const avgs = snap.steps.map((s) => s.avgMs);
    expect(avgs).toEqual([...avgs].sort((a, b) => b - a));
  });

  it('時計が未注入（0固定）でも tick 数と規模だけは記録される', () => {
    setPerfClock(() => 0);
    const chain = perfChainStart();
    chain.finish('other', { paxGroups: 1, aircraft: 1, bags: 1 });
    const snap = peekPerfSnapshot();
    expect(snap.ticks).toBe(1);
    expect(snap.tickAvgMs).toBe(0);
    expect(snap.scale.paxGroups).toBe(1);
  });

  it('take でリセットされるが規模カウンタは保持される', () => {
    const chain = perfChainStart();
    chain.finish('other', { paxGroups: 5, aircraft: 2, bags: 7 });
    const first = takePerfSnapshot();
    expect(first.ticks).toBe(1);
    const after = peekPerfSnapshot();
    expect(after.ticks).toBe(0);
    expect(after.tickAvgMs).toBe(0);
    expect(after.scale).toEqual({ paxGroups: 5, aircraft: 2, bags: 7 });
  });

  it('描画とフレームの記録が平均化される', () => {
    recordDraw(4);
    recordDraw(6);
    recordFrame(10, false);
    recordFrame(20, true);
    recordFrame(30, false);
    const snap = peekPerfSnapshot();
    expect(snap.drawCount).toBe(2);
    expect(snap.drawAvgMs).toBeCloseTo(5, 6);
    expect(snap.frames).toBe(3);
    expect(snap.ticksPerFrame).toBeCloseTo(20, 6);
    expect(snap.droppedFrames).toBe(1);
  });

  it('空のウィンドウは 0 を返す（NaN にならない）', () => {
    const snap = peekPerfSnapshot();
    expect(snap.ticks).toBe(0);
    expect(snap.tickAvgMs).toBe(0);
    expect(snap.drawAvgMs).toBe(0);
    expect(snap.ticksPerFrame).toBe(0);
    expect(snap.steps.every((s) => s.avgMs === 0 && s.share === 0)).toBe(true);
  });
});
