import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { captureFreeRunways, captureFreeSim, freeFixturePath, FREE_FIXTURES, FREE_SIM_SEEDS, loadFreeFixture, type FreeFixtureName } from '../golden/capture.free';
import { checkGolden, goldenText } from '../golden/io';
import { checkLayout } from '../../src/core/io/project';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { isFreeRunway } from '../../src/core/model/types';
import { crossingFreeAirport, parallelFreeAirport } from './sim/crossingLayouts';

const builders: Record<FreeFixtureName, () => unknown> = {
  'free-crossing': () => crossingFreeAirport(),
  'free-parallel': () => parallelFreeAirport(),
};

describe('ゴールデン入力フィクスチャ（自由形）', () => {
  // 再生成（意図したときだけ。ゴールデン全体の再採取が必要になる）: GOLDEN_FIXTURES_UPDATE=1 npx vitest run tests/unit/golden.free.test.ts
  if (process.env.GOLDEN_FIXTURES_UPDATE === '1') {
    it('フィクスチャを再生成する', () => {
      for (const name of FREE_FIXTURES) {
        mkdirSync(dirname(freeFixturePath(name)), { recursive: true });
        writeFileSync(freeFixturePath(name), JSON.stringify(builders[name]()) + '\n');
      }
    });
    return;
  }
  for (const name of FREE_FIXTURES) {
    it(`${name}: 読み込めて、レイアウトとして妥当で、保存・読込で変わらない`, () => {
      const l = loadFreeFixture(name);
      expect(checkLayout(l)).toEqual([]);
      expect(importLayout(exportLayout(l))).toEqual(l);
    });
  }
});

/**
 * 自由形の滑走路のゴールデン（Phase 12 S13）。既存のゴールデンファイルは変えず、新しいファイルだけを追加する。
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.free.test.ts
 */
describe('ゴールデン: 自由形の滑走路（幾何・検証・番号）', () => {
  it('入力は自由形の交差・平行の空港で、基準値と一致する', () => {
    for (const name of FREE_FIXTURES) expect(Object.values(loadFreeFixture(name).runways).every(isFreeRunway)).toBe(true);
    const r = captureFreeRunways() as Record<string, { crossings: unknown[]; counts: { error: number }; runways: Record<string, { areas: { resa: unknown[] } }> }>;
    // 交差の空港には交差点があり、重なりのエラーはない。平行の空港には交差点がない
    expect(r['free-crossing']!.crossings).toHaveLength(1);
    expect(r['free-parallel']!.crossings).toHaveLength(0);
    expect(r['free-crossing']!.counts.error).toBe(0);
    for (const name of FREE_FIXTURES) for (const x of Object.values(r[name]!.runways)) expect(x.areas.resa).toHaveLength(2);
    checkGolden('free-runways.golden.json', goldenText(r));
  });
});

describe('ゴールデン: 自由形の運航（交差・平行 × 2 シード）', () => {
  it('運航が完了し、競合がなく、基準値（状態ハッシュ）と一致する', { timeout: 300_000 }, () => {
    const r = captureFreeSim() as { runs: Record<string, { stats: { arrivals: number; departures: number; conflicts: number } ; atomicCrossingTicks: number }> };
    for (const name of FREE_FIXTURES) {
      for (const seed of FREE_SIM_SEEDS) {
        const run = r.runs[`${name}|${seed}`]!;
        expect(run.stats.arrivals, `${name}|${seed}: 到着がない`).toBeGreaterThan(0);
        expect(run.stats.departures, `${name}|${seed}: 出発がない`).toBeGreaterThan(0);
        expect(run.stats.conflicts, `${name}|${seed}: 競合`).toBe(0);
      }
    }
    checkGolden('crossing-sim.golden.json', goldenText(r), { sim: true });
  });
});
