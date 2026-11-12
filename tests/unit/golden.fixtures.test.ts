import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { checkLayout } from '../../src/core/io/project';
import { analyzeLayout } from '../../src/core/validation/validate';
import { createContext } from '../../src/core/sim/context';
import { FIXTURE_NAMES, fixturePath, loadFixture, type FixtureName } from '../golden/io';
import { createAllHeadingsLayout, createStressLayout } from '../golden/layouts';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';

/**
 * ゴールデンの入力レイアウト（フィクスチャ）。
 * 編集操作の挙動が将来変わっても、ゴールデンの入力が黙って変わらないよう JSON として凍結する。
 * 再生成（意図したときだけ。ゴールデン全体の再採取が必要になる）:
 *   GOLDEN_FIXTURES_UPDATE=1 npx vitest run tests/unit/golden.fixtures.test.ts
 */
const builders: Record<FixtureName, () => unknown> = {
  sample: () => createSampleAirport(),
  starter: () => createStarterAirfield(),
  'all-headings': () => createAllHeadingsLayout(),
  stress: () => createStressLayout(),
};

describe('ゴールデン入力フィクスチャ', () => {
  if (process.env.GOLDEN_FIXTURES_UPDATE === '1') {
    it('フィクスチャを再生成する', () => {
      for (const name of FIXTURE_NAMES) {
        mkdirSync(dirname(fixturePath(name)), { recursive: true });
        writeFileSync(fixturePath(name), JSON.stringify(builders[name]()) + '\n');
      }
    });
    return;
  }

  for (const name of FIXTURE_NAMES) {
    it(`${name}: 読み込めて、レイアウトとして妥当で、保存・読込で変わらない`, () => {
      const l = loadFixture(name);
      expect(checkLayout(l)).toEqual([]);
      expect(importLayout(exportLayout(l))).toEqual(l);
    });
  }

  it('ストレスレイアウトは 2 本の平行滑走路・斜め誘導路・12 以上のスポットを持ち、エラーなしで運航できる', () => {
    const l = loadFixture('stress');
    expect(Object.keys(l.runways)).toHaveLength(2);
    expect(Object.keys(l.stands).length).toBeGreaterThanOrEqual(10);
    const diagonal = Object.values(l.taxiways).filter((e) => {
      const a = l.taxiNodes[e.from]!.pos;
      const b = l.taxiNodes[e.to]!.pos;
      return a.x !== b.x && a.y !== b.y;
    });
    expect(diagonal.length).toBeGreaterThanOrEqual(3);
    expect(analyzeLayout(l).counts.error).toBe(0);
    // 北の滑走路には南の滑走路を横断しないと着けない（横断ノードが両滑走路に属する）
    const ctx = createContext(l);
    const [rn, rs] = Object.keys(ctx.runways).sort();
    expect(ctx.runways[rn!]!.nodes.length).toBeGreaterThan(2);
    expect(ctx.runways[rs!]!.nodes.length).toBeGreaterThan(2);
  });
});
