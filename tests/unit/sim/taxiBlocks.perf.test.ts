import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import type { AirportLayout } from '../../../src/core/model/types';
import { addTurnaround, createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import { manual } from '../../audit/d_helpers';
import { createStressLayout } from '../../golden/layouts';
import { asBlock, phase2 } from './blockHelpers';

/** 2-09: 30 機が同時に動く負荷（ストレス配置）で、従来方式と block の 1 ティックの計算時間を比べる（性能の閾値は 1.5 倍） */
function build(layout: AirportLayout, seed: string) {
  const sim = createSimulation(layout, { seed, settings: manual });
  const rng = new Rng(`${seed}:arr`);
  const t0 = sim.state.now + 600;
  for (let i = 0; i < 30; i++) addTurnaround(sim, i % 3 === 0 ? 'regional70' : 'narrow180', t0 + i * 120 + rng.int(0, 60), { departureAt: t0 + 3000 + i * 60 });
  return sim;
}

function timeRun(layout: AirportLayout, seed: string, ticks: number): { msPerTick: number; moving: number } {
  const sim = build(layout, seed);
  let movingSum = 0;
  const t = performance.now();
  for (let i = 0; i < ticks; i++) {
    stepSimulation(sim);
    if (i % 60 === 0) movingSum += Object.values(sim.state.aircraft).filter((a) => ['landing', 'vacating', 'taxiIn', 'taxiOut', 'pushback', 'holdShort', 'lineUp'].includes(a.state)).length;
  }
  return { msPerTick: (performance.now() - t) / ticks, moving: movingSum / Math.ceil(ticks / 60) };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('2-09 taxiBlocks.perf: 計算時間（従来方式の 1.5 倍以内）', () => {
  it('30 機が同時に動く 2 時間: 1 ティックの時間の中央値（5 回）が従来の 1.5 倍以内', { timeout: 120_000 }, () => {
    const seed = 'perf-1';
    timeRun(createStressLayout(), seed, 1500); // ウォームアップ
    const legacy: number[] = [];
    const block: number[] = [];
    let movingL = 0;
    let movingB = 0;
    for (let k = 0; k < 5; k++) {
      const a = timeRun(createStressLayout(), seed, 5400);
      const b = timeRun(asBlock(createStressLayout()), seed, 5400);
      legacy.push(a.msPerTick);
      block.push(b.msPerTick);
      movingL = a.moving;
      movingB = b.moving;
    }
    const ratio = median(block) / median(legacy);
    phase2('2-09-tick', { legacyMsPerTick: Math.round(median(legacy) * 1000) / 1000, blockMsPerTick: Math.round(median(block) * 1000) / 1000, ratio: Math.round(ratio * 100) / 100, avgMovingLegacy: Math.round(movingL * 10) / 10, avgMovingBlock: Math.round(movingB * 10) / 10, target: 1.5 });
    expect(ratio).toBeLessThanOrEqual(1.5);
  });

  it('1 日スキップ（86400 ティック）: 同じ 30 機で従来の 1.5 倍以内', { timeout: 150_000 }, () => {
    const seed = 'perf-2';
    const a = timeRun(createStressLayout(), seed, 86400);
    const b = timeRun(asBlock(createStressLayout()), seed, 86400);
    const ratio = b.msPerTick / a.msPerTick;
    phase2('2-09-day', { legacyMsPerTick: Math.round(a.msPerTick * 1000) / 1000, blockMsPerTick: Math.round(b.msPerTick * 1000) / 1000, ratio: Math.round(ratio * 100) / 100, target: 1.5 });
    expect(ratio).toBeLessThanOrEqual(1.5);
  });
});
