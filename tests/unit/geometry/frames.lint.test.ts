import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 描画コード（src/render）に座標の ±0.5 の生リテラルを書かない。World ↔ Map ↔ Scene の変換は
 * core/geometry/frames.ts（worldToMap / worldToScene など）だけで行う。
 * 座標ではない 0.5（線幅・半径・比率など）は、その行に `frames-allow-0.5: <理由>` のコメントを付けて許可する。
 */
const ALLOW_MARKER = 'frames-allow-0.5';
const ROOT = join(__dirname, '..', '..', '..', 'src', 'render');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

/** 行から文字列リテラルとコメントを除いたもの（コメントは許可マーカーの判定用に別に見る） */
export function stripLine(line: string): string {
  if (/^\s*(\*|\/\*)/.test(line)) return '';
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

const OFFSET = /[+-]\s*0\.5(?![\d.])|(?<![\d.])0\.5\s*[+-](?!=)/;

export function findOffsets(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  src.split('\n').forEach((raw, i) => {
    if (raw.includes(ALLOW_MARKER)) return;
    if (OFFSET.test(stripLine(raw))) out.push({ line: i + 1, text: raw.trim() });
  });
  return out;
}

describe('frames lint: src/render に生の ±0.5 座標オフセットが無い', () => {
  it('検出器が +0.5 / -0.5 と許可マーカーを正しく扱う', () => {
    expect(findOffsets('const x = p.x + 0.5;')).toHaveLength(1);
    expect(findOffsets('const x = (p.x - 0.5) * 25;')).toHaveLength(1);
    expect(findOffsets('const x = 0.5 + p.x;')).toHaveLength(1);
    expect(findOffsets('const x = p.x + 0.5; // frames-allow-0.5: 線幅')).toHaveLength(0);
    expect(findOffsets('stroke({ width: 0.5, alpha: 0.5 })')).toHaveLength(0);
    expect(findOffsets("label('a - 0.5 b')")).toHaveLength(0);
    expect(findOffsets('// p.x + 0.5')).toHaveLength(0);
    expect(findOffsets(' * (x + 0.5) × 25')).toHaveLength(0);
    expect(findOffsets('const k = 10.5 + 1')).toHaveLength(0);
  });

  it('src/render 配下の全ファイルに違反が無い', () => {
    const bad: string[] = [];
    for (const f of files(ROOT)) {
      for (const v of findOffsets(readFileSync(f, 'utf8'))) bad.push(`${f.slice(ROOT.length - 10)}:${v.line}: ${v.text}`);
    }
    expect(bad).toEqual([]);
  });
});
