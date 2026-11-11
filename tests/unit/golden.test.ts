import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureGeometry, captureProject, captureRunwayTable, captureSim, goldenLayouts, SIM_SECONDS } from '../golden/capture';

/**
 * ゴールデン基準値。リファクタ前の出力を固定し、現行コードが完全に再現することを確認する。
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.test.ts
 * （意図した挙動変更のときだけ。幾何基盤の導入では更新してはならない）
 */
const UPDATE = process.env.GOLDEN_UPDATE === '1';
const dir = resolve(__dirname, '../golden');

function check(file: string, actual: unknown): void {
  const path = resolve(dir, file);
  // JSON を経由して比較する（数値は JS の最短表記で往復厳密）
  const text = JSON.stringify(actual, null, 1) + '\n';
  if (UPDATE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  expect(existsSync(path), `${file} がありません（GOLDEN_UPDATE=1 で採取）`).toBe(true);
  const expected = readFileSync(path, 'utf8');
  expect(text === expected, `${file} が基準値と一致しません`).toBe(true);
}

describe('ゴールデン基準値（幾何・検証・運航・保存）', () => {
  for (const { name, layout } of goldenLayouts()) {
    it(`${name}: ネットワーク・検証・フットプリント・滑走路多角形が基準値と一致する`, () => {
      check(`geometry-${name}.golden.json`, captureGeometry(layout));
    });
  }

  it('滑走路の 8 方位 × 長さ表が基準値と一致する', () => {
    check('runway-table.golden.json', captureRunwayTable());
  });

  it('固定プロジェクトの serializeProject 出力が基準値と一致する', () => {
    check('project.golden.json', captureProject());
  });

  it(`固定シードの運航（${SIM_SECONDS / 3600} 時間）が基準値と一致する`, { timeout: 300_000 }, () => {
    check('sim.golden.json', captureSim());
  });
});
