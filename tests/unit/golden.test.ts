import { describe, it } from 'vitest';
import { captureGeometry, captureProject, captureRunwayTable, captureSim, goldenLayouts, SIM_SECONDS } from '../golden/capture';
import { checkGolden, goldenText } from '../golden/io';

/**
 * ゴールデン基準値。リファクタ前の出力を固定し、現行コードが完全に再現することを確認する。
 * 入力レイアウトは凍結済みフィクスチャ（tests/golden/fixtures）。
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.test.ts
 * （意図した挙動変更のときだけ。幾何基盤の導入では更新してはならない。
 *   運航ゴールデンは SIM_MODEL_VERSION を上げずに内容を変える再採取を拒否する）
 */
describe('ゴールデン基準値（幾何・検証・運航・保存）', () => {
  for (const { name, layout } of goldenLayouts()) {
    it(`${name}: ネットワーク・検証・フットプリント・滑走路多角形が基準値と一致する`, () => {
      checkGolden(`geometry-${name}.golden.json`, goldenText(captureGeometry(layout)));
    });
  }

  it('滑走路の 8 方位 × 長さ表が基準値と一致する', () => {
    checkGolden('runway-table.golden.json', goldenText(captureRunwayTable()));
  });

  it('固定プロジェクトの serializeProject 出力が基準値と一致する', () => {
    checkGolden('project.golden.json', goldenText(captureProject()));
  });

  it(`固定シードの運航（${SIM_SECONDS / 3600} 時間）が基準値と一致する`, { timeout: 300_000 }, () => {
    checkGolden('sim.golden.json', goldenText(captureSim()), { sim: true });
  });
});
