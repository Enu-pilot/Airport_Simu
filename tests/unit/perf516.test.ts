import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addPortal, placeFacility } from '../../src/core/layout/operations';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { buildCompositeGraph, verifyPortalAccess } from '../../src/core/terminal/networkGraph';
import { analyzeLayout } from '../../src/core/validation/validate';
import type { AirportLayout } from '../../src/core/model/types';
import { must } from './helpers';

/**
 * 5-16 T9: 複合グラフ構築と検証（ポータル診断込み）の性能計測。
 * 閾値はこの VM の実測に余裕を持たせた緩い上限で、桁違いの退行だけを検出する。
 * 実測値はテスト出力（console.log）に残す。
 */
function timed<T>(label: string, fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  const ms = performance.now() - t0;
  console.log(`[perf516] ${label}: ${ms.toFixed(1)}ms`);
  return { value, ms };
}

function sampleWithPortals(): AirportLayout {
  let l = createSampleAirport();
  l = must(placeFacility(l, 'busTerminal', { x: 30, y: 58 })).layout;
  const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
  const entrance = Object.values(l.terminalAreas).find((a) => a.kind === 'entrance')!;
  const exit = Object.values(l.terminalAreas).find((a) => a.kind === 'exit')!;
  l = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
  l = must(addPortal(l, { facilityId: bt.id, areaId: exit.id })).layout;
  return l;
}

describe('5-16 T9 性能計測', () => {
  it('サンプル空港で複合グラフ・ポータル検証・全体検証が実用範囲に収まる', () => {
    const l = sampleWithPortals();
    const model = timed('buildTerminalModel', () => buildTerminalModel(l));
    expect(model.ms).toBeLessThan(1000);
    const graph = timed('buildCompositeGraph', () => buildCompositeGraph(l));
    expect(graph.ms).toBeLessThan(1000);
    expect(Object.keys(graph.value.nodes).length).toBeGreaterThan(0);
    const access = timed('verifyPortalAccess', () => verifyPortalAccess(l));
    expect(access.ms).toBeLessThan(2000);
    expect(access.value).toHaveLength(1);
    expect(access.value[0]!.toEntrance).toBe('operational');
    // analyzeLayout は verifyPortalAccess を含む全体検証（ポータル診断の分だけ増える）
    const analysis = timed('analyzeLayout', () => analyzeLayout(l));
    expect(analysis.ms).toBeLessThan(5000);
    expect(analysis.value.issues.some((i) => i.code === 'PORTAL_UNREACHABLE')).toBe(false);
  });
});
