import { describe, expect, it } from 'vitest';
import { createHistory } from '../../../src/core/editor/history';
import { computePreview } from '../../../src/editor/tools';
import { editorStore } from '../../../src/editor/store';
import type { AirportLayout } from '../../../src/core/model/types';
import { emptyLayout } from '../helpers';

/** 1-01（V-1）: 既定の能力 0 は「未設定」としてコアへ渡さない。コアの「明示した 0 以下は不正」は変えない。 */
function preview(layout: AirportLayout, capacity: number, roadClass = 'public') {
  const base = editorStore.getState();
  const state = {
    tool: 'road' as const,
    options: { ...base.options, roadClass: roadClass as never, roadCapacityPerHour: capacity },
    hover: { x: 14, y: 10 },
    hoverW: undefined,
    draft: { kind: 'path' as const, points: [{ x: 10, y: 10 }] },
    history: createHistory(layout),
    interiorLevel: 0,
  };
  return computePreview(state as never);
}

describe('道路ツールの既定能力（1-01）', () => {
  const layout = emptyLayout();
  for (const roadClass of ['public', 'service', 'rail', 'walkway', 'fuel']) {
    it(`能力 0（既定）: ${roadClass} は成功し、capacityPerHour キーが付かない`, () => {
      const p = preview(layout, 0, roadClass);
      expect(p?.result.ok).toBe(true);
      if (!p?.result.ok) return;
      const roads = Object.values(p.result.layout.roads);
      expect(roads.length).toBeGreaterThan(0);
      for (const r of roads) expect('capacityPerHour' in r).toBe(false);
    });
  }
  it('能力 600: 値が入る', () => {
    const p = preview(layout, 600);
    expect(p?.result.ok).toBe(true);
    if (!p?.result.ok) return;
    for (const r of Object.values(p.result.layout.roads)) expect(r.capacityPerHour).toBe(600);
  });
  it('負の値: 入力欄が 0 に丸める（Toolbox の onChange と同じ式）→ 未設定として成功', () => {
    const rounded = Math.max(0, Number('-1') || 0);
    expect(rounded).toBe(0);
    expect(preview(layout, rounded)?.result.ok).toBe(true);
  });
});
