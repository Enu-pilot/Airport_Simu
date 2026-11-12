/**
 * 自由形の滑走路のゴールデン（Phase 12 S13。既存のゴールデンは変えない新しいファイルだけ）。
 *
 * 入力は凍結した JSON フィクスチャ（tests/golden/fixtures/free-crossing / free-parallel）。
 * - free-runways.golden.json: ネットワーク・検証の issue・runwayAreas の多角形・番号（偏角 0 と 10°E）・交差点
 * - crossing-sim.golden.json: 運航の状態ハッシュ（2 シード × 3 時間 × 2 レイアウト）。SIM_MODEL_VERSION の保護の対象
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.free.test.ts
 */
import { buildAirsideNetwork } from '../../src/core/airside/network';
import { airportKpis } from '../../src/core/analytics/kpi';
import { designatorsOf } from '../../src/core/layout/designators';
import { runwayAreas } from '../../src/core/layout/runwayAreas';
import { runwayAxis } from '../../src/core/layout/runway';
import { isFreeRunway, type AirportLayout } from '../../src/core/model/types';
import { SIM_MODEL_VERSION } from '../../src/core/scenario/scenario';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { analyzeLayout } from '../../src/core/validation/validate';
import { sha256 } from './capture';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { goldenDir } from './io';

/** 自由形のフィクスチャ（io.ts の FixtureName には足さない: 既存のゴールデンの入力の一覧を変えないため） */
export type FreeFixtureName = 'free-crossing' | 'free-parallel';
export const FREE_FIXTURES: readonly FreeFixtureName[] = ['free-crossing', 'free-parallel'];
export const freeFixturePath = (name: FreeFixtureName): string => resolve(goldenDir, 'fixtures', `${name}.layout.json`);
export const loadFreeFixture = (name: FreeFixtureName): AirportLayout => JSON.parse(readFileSync(freeFixturePath(name), 'utf8')) as AirportLayout;
export const FREE_SIM_SEEDS = ['free-a', 'free-b'] as const;
export const FREE_SIM_SECONDS = 3 * 3600;
export const FREE_SIM_FLIGHTS_PER_DAY = 120;

function describeLayout(layout: AirportLayout): unknown {
  const network = buildAirsideNetwork(layout);
  const analysis = analyzeLayout(layout);
  const runways: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(layout.runways)) {
    const ax = runwayAxis(r);
    runways[id] = {
      axis: { start: ax.start, end: ax.end, trueHeadingDeg: ax.trueHeadingDeg, lengthM: ax.lengthM },
      designators: designatorsOf(r, layout),
      areas: isFreeRunway(r) ? runwayAreas(r) : null,
    };
  }
  // 磁気偏角 10°E のときの番号（真方位から磁方位への変換と、番号の変化）
  const east10 = { ...layout, magneticVariationDeg: 10 };
  const designatorsEast10: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(east10.runways)) designatorsEast10[id] = designatorsOf(r, east10).text;
  return {
    network,
    crossings: network.crossings ?? [],
    issues: analysis.issues,
    counts: analysis.counts,
    operability: analysis.operability,
    runways,
    designatorsEast10,
  };
}

export function captureFreeRunways(): unknown {
  const out: Record<string, unknown> = {};
  for (const name of FREE_FIXTURES) out[name] = describeLayout(loadFreeFixture(name));
  return out;
}

export function captureFreeSim(): unknown {
  const runs: Record<string, unknown> = {};
  for (const name of FREE_FIXTURES) {
    const layout = loadFreeFixture(name);
    for (const seed of FREE_SIM_SEEDS) {
      const sim = createSimulation(layout, { seed, settings: { flightsPerDay: FREE_SIM_FLIGHTS_PER_DAY } });
      let crossingTicks = 0;
      let atomicCrossingTicks = 0;
      for (let i = 0; i < FREE_SIM_SECONDS; i++) {
        stepSimulation(sim);
        for (const ac of Object.values(sim.state.aircraft)) {
          if (ac.crossing) crossingTicks++;
          if (ac.crossing?.alsoRunwayIds) atomicCrossingTicks++;
        }
      }
      const json = JSON.stringify(sim.state);
      runs[`${name}|${seed}`] = {
        seconds: FREE_SIM_SECONDS,
        now: sim.state.now,
        stateSha256: sha256(json),
        stateLength: json.length,
        stats: sim.state.stats,
        crossingTicks,
        atomicCrossingTicks,
        aircraft: Object.keys(sim.state.aircraft).length,
        kpis: JSON.parse(JSON.stringify(airportKpis(sim))),
      };
    }
  }
  return { simModelVersion: SIM_MODEL_VERSION, flightsPerDay: FREE_SIM_FLIGHTS_PER_DAY, runs };
}
