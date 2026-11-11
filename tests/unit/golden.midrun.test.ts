import { describe, expect, it } from 'vitest';
import { captureMidRunRestore } from '../golden/capture';
import { checkGolden, goldenText } from '../golden/io';

/**
 * 途中保存・復元のゴールデン。+3 時間で保存→検証→復元し、元と復元後を +2 時間進めた状態が一致する。
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.midrun.test.ts（既存の golden.test.ts の基準値には触れない）
 */

describe('ゴールデン: 運航の途中保存・復元', () => {
  it('復元後の +2 時間が元と一致し、基準値と一致する', { timeout: 300_000 }, () => {
    const r = captureMidRunRestore();
    expect(r.violations).toEqual([]);
    expect(r.hashes.restored).toBe(r.hashes.original);
    checkGolden('sim-midrun.golden.json', goldenText(r), { sim: true });
  });
});
