import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 描画・UI・編集コードに座標の ±0.5 の生リテラルを書かない。World ↔ Map ↔ Scene の変換は
 * core/geometry/frames.ts（worldToMap / worldToScene / worldPolyToMap など）だけで行う。
 * 座標ではない 0.5（線幅・半径・比率など）は、その行に `frames-allow-0.5: <理由>` のコメントを付けて許可する。
 *
 * 検出する形: `x + 0.5` `x - .5` `0.5 + x` `${x + 0.5}`（テンプレート内の式）、`*` で始まる継続行。
 * 検出しない形: 単項の `-0.5`（`f(n, -0.5)`）、`x * 0.5 - y`（乗除に付いた 0.5）、文字列・コメント内。
 * 走査範囲: src/render, src/ui, src/editor と src/core/geometry/camera.ts。
 * （src/core の他の部分は設計上 World フレームで計算し、変換は S10 で frames に集約済み。frames.ts 自身は対象外）
 */
const ALLOW_MARKER = 'frames-allow-0.5';
const SRC = join(__dirname, '..', '..', '..', 'src');
const DIRS = ['render', 'ui', 'editor'].map((d) => join(SRC, d));
const FILES = [join(SRC, 'core', 'geometry', 'camera.ts')];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

/**
 * ソース全体からコメントと文字列リテラルの中身を空白にした行配列を返す（行数は元と同じ）。
 * テンプレートリテラルの `${ ... }` の中はコード扱い。
 */
export function codeLines(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  const mode: ('code' | 'tpl')[] = ['code'];
  const braces: number[] = [0];
  let i = 0;
  const put = (ch: string) => {
    if (ch === '\n') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  };
  while (i < src.length) {
    const ch = src[i]!;
    const nx = src[i + 1];
    const m = mode[mode.length - 1]!;
    if (m === 'tpl') {
      if (ch === '\\') {
        put(' ');
        i += 2;
      } else if (ch === '`') {
        cur += '"';
        mode.pop();
        braces.pop();
        i++;
      } else if (ch === '$' && nx === '{') {
        cur += ' ';
        mode.push('code');
        braces.push(0);
        i += 2;
      } else {
        put(ch === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    if (ch === '/' && nx === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '/' && nx === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') put('\n');
        i++;
      }
      i += 2;
    } else if (ch === "'" || ch === '"') {
      cur += '""';
      i++;
      while (i < src.length && src[i] !== ch && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
    } else if (ch === '`') {
      cur += '"';
      mode.push('tpl');
      braces.push(0);
      i++;
    } else if (ch === '{') {
      braces[braces.length - 1]!++;
      put(ch);
      i++;
    } else if (ch === '}') {
      if (braces[braces.length - 1] === 0 && mode.length > 1) {
        mode.pop();
        braces.pop();
        cur += ' ';
      } else {
        braces[braces.length - 1]!--;
        put(ch);
      }
      i++;
    } else {
      put(ch);
      i++;
    }
  }
  out.push(cur);
  return out;
}

/** 二項演算の `+ 0.5` / `- .5`（直前がオペランド、または継続行の行頭）、または `0.5 +` / `.5 -`（乗除に付いたものを除く） */
const OFFSET = /(?<=[\w)\]]\s*)[+-]\s*0?\.5(?![\d.])|^\s*[+-]\s*0?\.5(?![\d.])|(?<![\d.*/]\s*)(?<![\d.])0?\.5\s*[+-](?![+-=])/;

export function findOffsets(src: string): { line: number; text: string }[] {
  const raw = src.split('\n');
  const out: { line: number; text: string }[] = [];
  codeLines(src).forEach((code, i) => {
    if (raw[i]!.includes(ALLOW_MARKER)) return;
    if (OFFSET.test(code)) out.push({ line: i + 1, text: raw[i]!.trim() });
  });
  return out;
}

describe('frames lint: 描画・UI・編集コードに生の ±0.5 座標オフセットが無い', () => {
  it('検出器が +0.5 / -0.5 / .5 の各形と許可マーカーを正しく扱う', () => {
    expect(findOffsets('const x = p.x + 0.5;')).toHaveLength(1);
    expect(findOffsets('const x = (p.x - 0.5) * 25;')).toHaveLength(1);
    expect(findOffsets('const x = 0.5 + p.x;')).toHaveLength(1);
    expect(findOffsets('const x = p.x + .5;')).toHaveLength(1);
    expect(findOffsets('const x = p.x - .5;')).toHaveLength(1);
    expect(findOffsets('const x = p.x+0.5')).toHaveLength(1);
    expect(findOffsets('const s = `${p.x + 0.5}`')).toHaveLength(1);
    expect(findOffsets('const x = a\n  * 25\n  + 0.5')).toHaveLength(1);
    expect(findOffsets('const x = p.x + 0.5; // frames-allow-0.5: 線幅')).toHaveLength(0);
    expect(findOffsets('stroke({ width: 0.5, alpha: 0.5 })')).toHaveLength(0);
    expect(findOffsets("label('a - 0.5 b')")).toHaveLength(0);
    expect(findOffsets('const s = `a + 0.5 b`')).toHaveLength(0);
    expect(findOffsets('// p.x + 0.5')).toHaveLength(0);
    expect(findOffsets('/*\n * (x + 0.5) × 25\n */')).toHaveLength(0);
    expect(findOffsets('const k = 10.5 + 1')).toHaveLength(0);
    expect(findOffsets('const k = 1 + 10.5')).toHaveLength(0);
    expect(findOffsets('scale(n, -0.5)')).toHaveLength(0);
    expect(findOffsets('const v = x * 0.5 - y')).toHaveLength(0);
    expect(findOffsets('const v = x / 0.5 + y')).toHaveLength(0);
    expect(findOffsets('const v = i += 1')).toHaveLength(0);
  });

  it('src/render・src/ui・src/editor・camera.ts に違反が無い', () => {
    const bad: string[] = [];
    for (const f of [...DIRS.flatMap(files), ...FILES]) {
      for (const v of findOffsets(readFileSync(f, 'utf8'))) bad.push(`${f.slice(SRC.length + 1)}:${v.line}: ${v.text}`);
    }
    expect(bad).toEqual([]);
  });

  it('2D・3D の描画が frames の多角形変換（worldPolyToMap / worldPolyToScene）を使っている', () => {
    const scene = readFileSync(join(SRC, 'render', 'three', 'Scene3D.ts'), 'utf8');
    const map = readFileSync(join(SRC, 'render', 'MapRenderer.ts'), 'utf8');
    expect(scene).toMatch(/worldPolyToScene\(/);
    expect(map).toMatch(/worldPolyToMap\(/);
  });
});
