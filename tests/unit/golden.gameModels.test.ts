import { describe, expect, it } from 'vitest';
import { captureGameModels } from '../golden/capture';
import { checkGolden, goldenText } from '../golden/io';

/**
 * 12B-3a B5・B6: 評価・目標を含むゲームのモデルの新規ゴールデン（SIM_MODEL_VERSION の保護の対象）。
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.gameModels.test.ts
 */
describe('ゴールデン: ゲームのモデル（評価・目標、12B-3a）', () => {
  it('評価の移動平均・目標・格が基準値と一致する', { timeout: 900_000 }, () => {
    const r = captureGameModels() as { runs: Record<string, { airlineEval: Record<string, unknown>; goals: { done: Record<string, number> } }> };
    expect(Object.keys(r.runs['day0-normal']!.airlineEval).length).toBeGreaterThan(0);
    expect(r.runs['day0-normal']!.goals.done.flights10).toBe(0);
    checkGolden('game-models.golden.json', goldenText(r), { sim: true });
  });
});
