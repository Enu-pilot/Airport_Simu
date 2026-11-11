/**
 * ゴールデンファイルの読み書き（照合・再採取）と、フィクスチャの読み込み。
 *
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden*.test.ts
 *
 * 運航ゴールデン（`sim: true`）には SIM_MODEL_VERSION の保護がある（設計 D10）:
 * 内容が変わるのに SIM_MODEL_VERSION が採取時（tests/golden/sim-versions.json）と同じなら、再採取を拒否して例外にする。
 * 例外: 変わったのが版に敏感なキー（VERSION_SENSITIVE_KEYS）だけで `normalizedSha256` が同一のとき（`isVersionOnlyChange`）。
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

/** 版（SCHEMA_VERSION など）が変わると変わりうるキー。`normalizedSha256`（版を除いたハッシュ）は含めない */
export const VERSION_SENSITIVE_KEYS: readonly string[] = ['sha256', 'length', 'exportLayoutSha256'];

/**
 * 旧・新の運航ゴールデンの差が「版に敏感なキーの値だけ」で、かつ両方に `normalizedSha256` があり同一か。
 * 版の更新（Phase 12 の SCHEMA_VERSION 3）だけで運航ゴールデンの再採取が拒否されないための例外（B.4）。
 * 構造（キー集合・配列長）が違う、版に敏感でないキーが違う、`normalizedSha256` が無い／違うときは false。
 */
export function isVersionOnlyChange(oldText: string, newText: string): boolean {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(oldText);
    b = JSON.parse(newText);
  } catch {
    return false;
  }
  const norm = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!norm(a) || !norm(b)) return false;
  if (typeof a.normalizedSha256 !== 'string' || a.normalizedSha256 !== b.normalizedSha256) return false;
  const same = (x: unknown, y: unknown, key: string | null): boolean => {
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
      return x.every((e, i) => same(e, y[i], key));
    }
    if (norm(x) || norm(y)) {
      if (!norm(x) || !norm(y)) return false;
      const kx = Object.keys(x);
      const ky = Object.keys(y);
      if (kx.length !== ky.length || !kx.every((k) => k in y)) return false;
      return kx.every((k) => same(x[k], y[k], k));
    }
    if (x === y) return true;
    return key !== null && VERSION_SENSITIVE_KEYS.includes(key);
  };
  return same(a, b, null);
}

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
      const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
      const changed = before !== null && before !== text;
      if (changed && ledger[file] === SIM_MODEL_VERSION && !isVersionOnlyChange(before, text)) {
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
