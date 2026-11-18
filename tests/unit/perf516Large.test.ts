import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { buildCompositeGraph, verifyPortalAccess } from '../../src/core/terminal/networkGraph';
import { analyzeLayout } from '../../src/core/validation/validate';
import type { AirportLayout, Facility, PedestrianPortal } from '../../src/core/model/types';

/**
 * 5-16 T9（大規模側）: 約 500 施設 + 20 ポータルのレイアウトで
 * モデル構築・複合グラフ・ポータル検証・全体検証の性能を測る。
 * 閾値は桁違いの退行だけを検出する緩い上限。実測中央値を console.log に残す。
 */
function median3(label: string, fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`[perf516-large] ${label}: median ${times[1]!.toFixed(1)}ms`);
  return times[1]!;
}

function largeLayout(): AirportLayout {
  const l = createSampleAirport();
  const template = Object.values(l.facilities).find((f) => f.kind === 'hangar')!;
  const facilities: Record<string, Facility> = { ...l.facilities };
  // 建物を格子状に 480 個複製する（配置検証は対象外。構築・検証の計算量だけを測る）
  for (let i = 0; i < 480; i++) {
    const id = `perf_bldg_${i}`;
    facilities[id] = {
      ...template,
      id,
      name: `Perf Building ${i}`,
      origin: { x: 8 + (i % 24) * 6, y: 62 + Math.floor(i / 24) * 2 },
    };
  }
  // バスターミナル 20 個と入口へのポータル 20 本
  const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal');
  const entrance = Object.values(l.terminalAreas).find((a) => a.kind === 'entrance')!;
  const portals: Record<string, PedestrianPortal> = { ...(l.portals ?? {}) };
  const btTemplate: Facility = bt ?? {
    ...(Object.values(l.facilities).find((f) => f.kind === 'parking') as Facility),
    kind: 'busTerminal',
  };
  for (let i = 0; i < 20; i++) {
    const fid = `perf_bt_${i}`;
    facilities[fid] = { ...btTemplate, id: fid, name: `Perf Bus ${i}`, origin: { x: 8 + i * 7, y: 106 } };
    portals[`perf_portal_${i}`] = {
      id: `perf_portal_${i}`,
      name: '',
      facilityId: fid,
      areaId: entrance.id,
      floorIndex: entrance.level,
      mapLevel: 0,
      buildState: 'operational',
    };
  }
  return { ...l, facilities, portals };
}

describe('5-16 T9 大規模レイアウト性能', () => {
  it('約 500 施設 + 20 ポータルでも構築・検証が実用範囲に収まる', { timeout: 600000 }, () => {
    const l = largeLayout();
    expect(Object.keys(l.facilities).length).toBeGreaterThan(480);
    expect(median3('buildTerminalModel', () => buildTerminalModel(l))).toBeLessThan(10000);
    expect(median3('buildCompositeGraph', () => buildCompositeGraph(l))).toBeLessThan(10000);
    const access = verifyPortalAccess(l);
    expect(access.length).toBe(20);
    expect(median3('verifyPortalAccess', () => verifyPortalAccess(l))).toBeLessThan(30000);
    expect(median3('analyzeLayout', () => analyzeLayout(l))).toBeLessThan(60000);
  });
});
