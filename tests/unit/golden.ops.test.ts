import { describe, expect, it } from 'vitest';
import {
  captureNormalizedHashes,
  captureProjectWithSim,
  captureRoutes,
  captureStress,
  normalizedLayoutJson,
  normalizedProjectJson,
  sha256,
  stringifyRoutes,
  STRESS_SEEDS,
} from '../golden/capture';
import { checkGolden, goldenText, loadFixture } from '../golden/io';
import { exportLayout } from '../../src/core/io/serialize';

/**
 * 追加のゴールデン（Phase 11 レビュー対応）:
 *  - ストレス運航（2 本の平行滑走路・斜め誘導路・横断・12 スポット × 2 シード）
 *  - 経路（スポット × 滑走路 × 滑走路ノードの nodes / cum / 旋回角 / 停止位置）
 *  - 運航状態入りの保存
 *  - 版に依存しないハッシュ（SCHEMA_VERSION を上げても変わらない）
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.ops.test.ts
 */
describe('ゴールデン: ストレス運航', () => {
  it('横断・ホールドショートを含み、基準値と一致する', { timeout: 120_000 }, () => {
    const r = captureStress() as { runs: Record<string, { crossings: number; holdShortTicks: number; stats: { arrivals: number; departures: number } }> };
    for (const seed of STRESS_SEEDS) {
      const run = r.runs[seed]!;
      expect(run.crossings, `${seed}: 滑走路横断が起きていない`).toBeGreaterThan(0);
      expect(run.stats.arrivals).toBeGreaterThan(0);
      expect(run.stats.departures).toBeGreaterThan(0);
    }
    checkGolden('stress-sim.golden.json', goldenText(r), { sim: true });
  });
});

describe('ゴールデン: 経路', () => {
  it('スポット × 滑走路ノードの経路（nodes・cum・旋回角・停止位置）が基準値と一致する', () => {
    const sample = captureRoutes(loadFixture('sample'));
    const stress = captureRoutes(loadFixture('stress'));
    // 到達できる経路が十分にあり、斜め区間（旋回角 45/135 など）・滑走路手前の停止位置を含む
    const all = [...Object.values(sample), ...Object.values(stress)].filter(Boolean) as { turns: number[]; holds: unknown[] }[];
    expect(all.length).toBeGreaterThan(200);
    expect(all.some((r) => r.turns.some((t) => t === 45))).toBe(true);
    expect(all.some((r) => r.holds.length > 0)).toBe(true);
    checkGolden('routes.golden.json', stringifyRoutes({ sample, stress }));
  });
});

describe('ゴールデン: 運航状態入りの保存', () => {
  it('+2 時間の serializeProject（sim あり）が基準値と一致する', { timeout: 120_000 }, () => {
    checkGolden('project-sim.golden.json', goldenText(captureProjectWithSim()), { sim: true });
  });
});

describe('ゴールデン: 版に依存しないハッシュ', () => {
  it('レイアウトの内容・プロジェクトの内容の正規化ハッシュが基準値と一致する', () => {
    checkGolden('normalized-hashes.golden.json', goldenText(captureNormalizedHashes()));
  });
  it('正規化は schemaVersion だけを無視する（版番号を変えても不変、内容を変えると変わる）', () => {
    const l = loadFixture('sample');
    const bumped = { ...l, schemaVersion: l.schemaVersion + 1 };
    expect(normalizedLayoutJson(bumped)).toBe(normalizedLayoutJson(l));
    expect(exportLayout(bumped)).not.toBe(exportLayout(l)); // 従来のハッシュは layout.schemaVersion を含む
    expect(normalizedLayoutJson({ ...l, name: 'x' })).not.toBe(normalizedLayoutJson(l));
    const pj = JSON.stringify({ versions: { layoutSchema: 2, simModel: 'a' }, layout: { schemaVersion: 2, name: 'n' } });
    const pj3 = JSON.stringify({ versions: { layoutSchema: 3, simModel: 'a' }, layout: { schemaVersion: 3, name: 'n' } });
    expect(sha256(normalizedProjectJson(pj3))).toBe(sha256(normalizedProjectJson(pj)));
    const pjx = JSON.stringify({ versions: { layoutSchema: 3, simModel: 'b' }, layout: { schemaVersion: 3, name: 'n' } });
    expect(normalizedProjectJson(pjx)).not.toBe(normalizedProjectJson(pj));
  });
});
