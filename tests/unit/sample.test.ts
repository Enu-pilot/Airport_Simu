import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { analyzeLayout } from '../../src/core/validation/validate';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { runwayMaxSize } from '../../src/core/layout/runway';
import { entityTypeOf } from '../../src/core/model/types';

describe('サンプル空港', () => {
  const layout = createSampleAirport();
  const analysis = analyzeLayout(layout);

  it('エラー・警告がない', () => {
    const problems = analysis.issues.filter((i) => i.severity !== 'info');
    expect(problems).toEqual([]);
  });

  it('全施設が運用可能', () => {
    const notOperable = Object.entries(analysis.operability).filter(([, o]) => !o.operable);
    expect(notOperable).toEqual([]);
  });

  it('同じシードからは同じレイアウトが生成される（決定性）', () => {
    expect(exportLayout(createSampleAirport())).toBe(exportLayout(layout));
  });

  it('全スポットが接続され、L級滑走路を持つ', () => {
    expect(Object.keys(analysis.network.standLinks).sort()).toEqual(Object.keys(layout.stands).sort());
    expect(Object.values(layout.runways).map(runwayMaxSize)).toEqual(['L']);
  });

  it('参照整合性: エッジの端点・ゲートの紐付け・ネットワークの元エンティティが存在する', () => {
    for (const e of Object.values(layout.taxiways)) {
      expect(layout.taxiNodes[e.from]).toBeDefined();
      expect(layout.taxiNodes[e.to]).toBeDefined();
    }
    for (const e of Object.values(layout.roads)) {
      expect(layout.roadNodes[e.from]).toBeDefined();
      expect(layout.roadNodes[e.to]).toBeDefined();
    }
    for (const f of Object.values(layout.facilities)) {
      if (f.kind === 'gate') expect(layout.stands[f.props.standId as string]).toBeDefined();
    }
    for (const e of Object.values(analysis.network.edges)) {
      expect(analysis.network.nodes[e.from]).toBeDefined();
      expect(analysis.network.nodes[e.to]).toBeDefined();
      const type = entityTypeOf(e.sourceId);
      expect(type).not.toBeNull();
    }
  });

  it('IDは種類ごとに一意で、カウンタ以下', () => {
    const all = [
      ...Object.keys(layout.runways),
      ...Object.keys(layout.taxiNodes),
      ...Object.keys(layout.taxiways),
      ...Object.keys(layout.roadNodes),
      ...Object.keys(layout.roads),
      ...Object.keys(layout.stands),
      ...Object.keys(layout.facilities),
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) {
      const [prefix, n] = id.split('_') as [string, string];
      expect(Number(n)).toBeLessThanOrEqual(layout.counters[prefix]!);
    }
  });

  it('JSON 書き出し → 読み込みで同一', () => {
    const restored = importLayout(exportLayout(layout));
    expect(restored).toEqual(layout);
    expect(analyzeLayout(restored).issues).toEqual(analysis.issues);
  });
});
