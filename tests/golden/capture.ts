/**
 * ゴールデン基準値の採取関数（Phase 11 S0）。
 *
 * リファクタ前の現行コードの出力を固定し、以後の幾何基盤の導入が既存結果を
 * 1 ビットも変えないことを機械的に確認するためのもの。
 * 純関数のみ（ファイル入出力は tests/unit/golden.test.ts が行う）。
 */
import { createHash } from 'node:crypto';
import { buildAirsideNetwork } from '../../src/core/airside/network';
import { createSandboxCompany } from '../../src/core/economy/company';
import { buildProject, serializeProject } from '../../src/core/io/project';
import { exportLayout } from '../../src/core/io/serialize';
import { footprintOf, footprintOwnerIds } from '../../src/core/layout/footprint';
import { addTaxiwayPath, placeRunway, type OpResult } from '../../src/core/layout/operations';
import { headingVector, runwayDesignators, runwayEnd, runwayLengthM, runwayPolygon, runwayStripPolygon } from '../../src/core/layout/runway';
import type { AirportLayout, Heading } from '../../src/core/model/types';
import { airportKpis } from '../../src/core/analytics/kpi';
import { SIM_MODEL_VERSION } from '../../src/core/scenario/scenario';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { analyzeLayout } from '../../src/core/validation/validate';
import { emptyLayout, must } from '../unit/helpers';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 運航ゴールデンのシミュレーション時間（秒）。1 tick = 1 秒 */
export const SIM_SECONDS = 24 * 3600;

const HEADINGS: Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * 8 方位すべての滑走路（長さ・幅を変える）と、滑走路を斜めに横切る誘導路を持つ専用レイアウト。
 * 重なり・交差の検証結果も含めて採取対象（エラーが出てもよい）。
 */
export function createAllHeadingsLayout(): AirportLayout {
  let l = emptyLayout(260, 220);
  const step = (r: OpResult) => (l = must(r).layout);
  const widths = [30, 45, 60] as const;
  // 中心を 8 か所に分散して置く（始点, 方位, 長さ）
  const specs: { start: { x: number; y: number }; h: Heading; len: number }[] = [
    { start: { x: 20, y: 60 }, h: 0, len: 40 },
    { start: { x: 60, y: 20 }, h: 45, len: 31 },
    { start: { x: 80, y: 40 }, h: 90, len: 57 },
    { start: { x: 200, y: 20 }, h: 135, len: 23 },
    { start: { x: 150, y: 100 }, h: 180, len: 45 },
    { start: { x: 230, y: 120 }, h: 225, len: 66 },
    { start: { x: 140, y: 150 }, h: 270, len: 90 },
    { start: { x: 30, y: 130 }, h: 315, len: 18 },
    // 長さ違いの追加（最小に近い・長大）
    { start: { x: 20, y: 200 }, h: 90, len: 30 },
    { start: { x: 60, y: 210 }, h: 90, len: 120 },
    { start: { x: 200, y: 200 }, h: 45, len: 1 },
  ];
  specs.forEach((s, i) => step(placeRunway(l, s.start, s.h, s.len, { surfaceWidthM: widths[i % 3]!, name: '' })));
  // 滑走路を斜めに横切る誘導路・滑走路端へ接続する誘導路
  const paths: { x: number; y: number }[][] = [
    [{ x: 70, y: 30 }, { x: 90, y: 50 }, { x: 110, y: 70 }],
    [{ x: 100, y: 60 }, { x: 80, y: 40 }],
    [{ x: 10, y: 50 }, { x: 40, y: 50 }, { x: 60, y: 30 }],
    [{ x: 150, y: 140 }, { x: 170, y: 160 }],
    [{ x: 210, y: 110 }, { x: 180, y: 140 }, { x: 150, y: 170 }],
    [{ x: 20, y: 130 }, { x: 40, y: 130 }],
    [{ x: 20, y: 60 }, { x: 20, y: 90 }, { x: 50, y: 120 }],
    [{ x: 200, y: 20 }, { x: 215, y: 35 }],
  ];
  for (const p of paths) {
    const r = addTaxiwayPath(l, p, { widthClass: 'M' });
    if (r.ok) l = r.layout;
  }
  return l;
}

export interface NamedLayout {
  name: string;
  layout: AirportLayout;
}

export function goldenLayouts(): NamedLayout[] {
  return [
    { name: 'sample', layout: createSampleAirport() },
    { name: 'starter', layout: createStarterAirfield() },
    { name: 'all-headings', layout: createAllHeadingsLayout() },
  ];
}

/** 幾何の採取（ネットワーク・検証・フットプリント・多角形頂点・番号） */
export function captureGeometry(layout: AirportLayout): unknown {
  const network = buildAirsideNetwork(layout);
  const analysis = analyzeLayout(layout);
  const footprints: Record<string, unknown> = {};
  for (const id of footprintOwnerIds(layout)) footprints[id] = footprintOf(layout, id);
  const runways: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(layout.runways)) {
    runways[id] = {
      heading: r.heading,
      length: r.length,
      headingVector: headingVector(r.heading),
      end: runwayEnd(r),
      lengthM: runwayLengthM(r),
      polygon: runwayPolygon(r),
      stripPolygon: runwayStripPolygon(r),
      designators: runwayDesignators(r.heading),
    };
  }
  return {
    network,
    issues: analysis.issues,
    counts: analysis.counts,
    operability: analysis.operability,
    footprints,
    runways,
    exportLayoutSha256: sha256(exportLayout(layout)),
  };
}

/** 全方位・全長さ範囲の純粋な滑走路幾何（レイアウト不要）。 */
export function captureRunwayTable(): unknown {
  const out: Record<string, unknown> = {};
  for (const h of HEADINGS) {
    const rows: unknown[] = [];
    for (const len of [1, 2, 3, 7, 10, 33, 80, 120]) {
      const r = { id: 'x', name: '', start: { x: 5, y: 7 }, heading: h, length: len, surfaceWidthM: 45 as const, buildState: 'operational' as const };
      rows.push({ len, end: runwayEnd(r), lengthM: runwayLengthM(r), polygon: runwayPolygon(r), strip: runwayStripPolygon(r) });
    }
    out[String(h)] = { vector: headingVector(h), designators: runwayDesignators(h), rows };
  }
  return out;
}

/** サンドボックス会社 × サンプル空港を SIM_SECONDS 進めた結果 */
export function captureSim(seconds = SIM_SECONDS): unknown {
  const sim = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
  for (let i = 0; i < seconds; i++) stepSimulation(sim);
  const k = airportKpis(sim);
  return {
    simModelVersion: SIM_MODEL_VERSION,
    seconds,
    now: sim.state.now,
    stateSha256: sha256(JSON.stringify(sim.state)),
    stateLength: JSON.stringify(sim.state).length,
    stats: sim.state.stats,
    recordCount: sim.state.analytics.records.length,
    cash: sim.company?.cash ?? null,
    kpis: JSON.parse(JSON.stringify(k)),
  };
}

/** 固定プロジェクトの serializeProject 出力 */
export function captureProject(): unknown {
  const p = buildProject({
    name: 'golden',
    savedAt: '2026-11-10T00:00:00Z',
    layout: createAllHeadingsLayout(),
    company: createSandboxCompany(),
    pin: null,
    scenarios: [],
    sim: null,
  });
  const json = serializeProject(p);
  return { length: json.length, sha256: sha256(json) };
}
