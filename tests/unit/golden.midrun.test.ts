import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureMidRunRestore } from '../golden/capture';

/**
 * 途中保存・復元のゴールデン。+3 時間で保存→検証→復元し、元と復元後を +2 時間進めた状態が一致する。
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.midrun.test.ts（既存の golden.test.ts の基準値には触れない）
 */
const path = resolve(__dirname, '../golden/sim-midrun.golden.json');

describe('ゴールデン: 運航の途中保存・復元', () => {
  it('復元後の +2 時間が元と一致し、基準値と一致する', { timeout: 300_000 }, () => {
    const r = captureMidRunRestore();
    expect(r.violations).toEqual([]);
    expect(r.hashes.restored).toBe(r.hashes.original);
    const text = JSON.stringify(r, null, 1) + '\n';
    if (process.env.GOLDEN_UPDATE === '1') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return;
    }
    expect(existsSync(path), 'sim-midrun.golden.json がありません（GOLDEN_UPDATE=1 で採取）').toBe(true);
    expect(text === readFileSync(path, 'utf8'), 'sim-midrun.golden.json が基準値と一致しません').toBe(true);
  });
});
