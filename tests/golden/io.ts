/**
 * ゴールデンファイルの読み書き（照合・再採取）と、フィクスチャの読み込み。
 *
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden*.test.ts
 *
 * 運航ゴールデン（`sim: true`）には SIM_MODEL_VERSION の保護がある（設計 D10）:
 * 内容が変わるのに SIM_MODEL_VERSION が採取時（tests/golden/sim-versions.json）と同じなら、再採取を拒否して例外にする。
 * 運航結果を意図して変えるときは、先に SIM_MODEL_VERSION を上げる（保存済みの運航状態が復元されなくなるため）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect } from 'vitest';
import type { AirportLayout } from '../../src/core/model/types';
import { SIM_MODEL_VERSION } from '../../src/core/scenario/scenario';

export const GOLDEN_UPDATE = process.env.GOLDEN_UPDATE === '1';
export const goldenDir = resolve(__dirname);

const LEDGER = 'sim-versions.json';

function readLedger(): Record<string, string> {
  const p = resolve(goldenDir, LEDGER);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>) : {};
}

function writeLedger(l: Record<string, string>): void {
  const sorted = Object.fromEntries(Object.entries(l).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(resolve(goldenDir, LEDGER), JSON.stringify(sorted, null, 1) + '\n');
}

/** 標準の書式（JSON、インデント 1） */
export const goldenText = (v: unknown): string => JSON.stringify(v, null, 1) + '\n';

/**
 * ゴールデンの照合。`GOLDEN_UPDATE=1` のときは書き込む。
 * `sim: true` は運航結果に依存するゴールデン（SIM_MODEL_VERSION の保護と版の記録の対象）
 */
export function checkGolden(file: string, text: string, opts: { sim?: boolean } = {}): void {
  const path = resolve(goldenDir, file);
  if (GOLDEN_UPDATE) {
    if (opts.sim) {
      const ledger = readLedger();
      const changed = existsSync(path) && readFileSync(path, 'utf8') !== text;
      if (changed && ledger[file] === SIM_MODEL_VERSION) {
        throw new Error(
          `${file}: 運航結果が変わりましたが SIM_MODEL_VERSION（${SIM_MODEL_VERSION}）が採取時と同じです。` +
            '既存レイアウトの運航結果を変えるなら、先に SIM_MODEL_VERSION を上げてください（docs/22 §ゴールデン）。再採取は拒否しました。',
        );
      }
      ledger[file] = SIM_MODEL_VERSION;
      writeLedger(ledger);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  expect(existsSync(path), `${file} がありません（GOLDEN_UPDATE=1 で採取）`).toBe(true);
  expect(text === readFileSync(path, 'utf8'), `${file} が基準値と一致しません`).toBe(true);
  if (opts.sim) expect(readLedger()[file], `${file} の採取時の SIM_MODEL_VERSION が sim-versions.json にありません`).toBeTypeOf('string');
}

export type FixtureName = 'sample' | 'starter' | 'all-headings' | 'stress';
export const FIXTURE_NAMES: readonly FixtureName[] = ['sample', 'starter', 'all-headings', 'stress'];

export const fixturePath = (name: FixtureName): string => resolve(goldenDir, 'fixtures', `${name}.layout.json`);

/** 凍結済みの入力レイアウトを読む（編集操作を経由しない） */
export function loadFixture(name: FixtureName): AirportLayout {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as AirportLayout;
}
