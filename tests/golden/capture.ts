/**
 * ゴールデン基準値の採取関数（Phase 11 S0）。
 *
 * リファクタ前の現行コードの出力を固定し、以後の幾何基盤の導入が既存結果を
 * 1 ビットも変えないことを機械的に確認するためのもの。
 * 入力レイアウトは凍結した JSON フィクスチャ（tests/golden/fixtures、io.ts の loadFixture）から読む。
 * 純関数のみ（ファイル入出力は tests/unit/golden*.test.ts が行う）。
 */
import { createHash } from 'node:crypto';
import { findPath } from '../../src/core/sim/pathfinding';
import { createContext } from '../../src/core/sim/context';
import { holdShortDistance, makeRoute, turnAngleAt } from '../../src/core/sim/routes';
import { compareIds } from '../../src/core/model/ids';
import { buildAirsideNetwork } from '../../src/core/airside/network';
import { createSandboxCompany } from '../../src/core/economy/company';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../src/core/io/project';
import { exportLayout } from '../../src/core/io/serialize';
import { footprintOf, footprintOwnerIds } from '../../src/core/layout/footprint';
import { headingVector, runwayDesignators, runwayEnd, runwayLengthM, runwayPolygon, runwayStripPolygon } from '../../src/core/layout/runway';
import type { AirportLayout, Heading, RunwayGrid8 } from '../../src/core/model/types';
import { airportKpis } from '../../src/core/analytics/kpi';
import { checkInvariants } from '../../src/core/sim/invariants';
import { SIM_MODEL_VERSION } from '../../src/core/scenario/scenario';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { analyzeLayout } from '../../src/core/validation/validate';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { goldenDir, loadFixture } from './io';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 運航ゴールデンのシミュレーション時間（秒）。1 tick = 1 秒 */
export const SIM_SECONDS = 24 * 3600;

const HEADINGS: Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];

export interface NamedLayout {
  name: string;
  layout: AirportLayout;
}

export function goldenLayouts(): NamedLayout[] {
  return [
    { name: 'sample', layout: loadFixture('sample') },
    { name: 'starter', layout: loadFixture('starter') },
    { name: 'all-headings', layout: loadFixture('all-headings') },
  ];
}

/** 幾何の採取（ネットワーク・検証・フットプリント・多角形頂点・番号） */
export function captureGeometry(layout: AirportLayout): unknown {
  const network = buildAirsideNetwork(layout);
  const analysis = analyzeLayout(layout);
  const footprints: Record<string, unknown> = {};
  for (const id of footprintOwnerIds(layout)) footprints[id] = footprintOf(layout, id);
  const runways: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(layout.runways) as [string, RunwayGrid8][]) {
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
  const sim = createSimulation(loadFixture('sample'), { company: createSandboxCompany() });
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
    layout: loadFixture('all-headings'),
    company: createSandboxCompany(),
    pin: null,
    scenarios: [],
    sim: null,
  });
  const json = serializeProject(p);
  return { length: json.length, sha256: sha256(json) };
}

/** 途中保存・復元の運航（+3 時間で保存 → 検証 → 復元し、元と復元後をそれぞれ +2 時間進める） */
export function captureMidRunRestore(): { saved: unknown; hashes: { original: string; restored: string }; violations: string[]; projectLength: number } {
  const company = createSandboxCompany();
  const sim = createSimulation(loadFixture('sample'), { company });
  const SAVE_AT = 3 * 3600;
  const MORE = 2 * 3600;
  for (let i = 0; i < SAVE_AT; i++) stepSimulation(sim);
  const json = serializeProject(
    buildProject({ name: 'midrun', savedAt: '2026-11-10T00:00:00Z', layout: sim.ctx.layout, company, pin: null, scenarios: [], sim }),
  );
  const report = validateProject(json, { fallbackCompany: createSandboxCompany() });
  if (!report.ok || !report.project?.sim) throw new Error(`検証に失敗: ${report.errors.join(' / ')}`);
  const { sim: restored, violations } = restoreSimulation(report.project.layout, report.project.sim, effectiveModels(report.project.catalog));
  for (let i = 0; i < MORE; i++) {
    stepSimulation(sim);
    stepSimulation(restored);
  }
  // state は挿入順も含めて完全一致。company は importCompany が項目順を正規化するため、キーを整列して比較する
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canon(x)])) : v;
  const h = (s: typeof sim): string => sha256(JSON.stringify({ state: s.state, company: canon(s.company) }));
  return { saved: { seconds: SAVE_AT, then: MORE, now: sim.state.now }, hashes: { original: h(sim), restored: h(restored) }, violations, projectLength: json.length };
}

// ---------------------------------------------------------------- 版に依存しないハッシュ（R5）

/**
 * 版番号（レイアウトの schemaVersion、プロジェクトの versions.layoutSchema）を除いたレイアウトの JSON。
 * SCHEMA_VERSION を上げても（データの中身が同じなら）変わらない。
 */
export function normalizedLayoutJson(layout: AirportLayout): string {
  const { schemaVersion: _v, ...rest } = layout;
  void _v;
  return JSON.stringify(rest);
}

/** serializeProject の出力から、レイアウト版（versions.layoutSchema、layout.schemaVersion）を除いて再直列化する */
export function normalizedProjectJson(json: string): string {
  const p = JSON.parse(json) as { versions: Record<string, unknown>; layout: Record<string, unknown> };
  delete p.versions.layoutSchema;
  delete p.layout.schemaVersion;
  return JSON.stringify(p);
}

/**
 * 版に依存しないハッシュ。従来の `exportLayoutSha256`・`project.golden.json` のハッシュは schemaVersion を含むので、
 * SCHEMA_VERSION を上げる版（Phase 12）で 1 度だけ再採取される。そのとき本ハッシュが不変であれば、版番号以外は何も変わっていない。
 */
export function captureNormalizedHashes(): unknown {
  const layouts: Record<string, string> = {};
  for (const { name, layout } of [...goldenLayouts(), { name: 'stress', layout: loadFixture('stress') }]) layouts[name] = sha256(normalizedLayoutJson(layout));
  const project = serializeProject(
    buildProject({ name: 'golden', savedAt: '2026-11-10T00:00:00Z', layout: loadFixture('all-headings'), company: createSandboxCompany(), pin: null, scenarios: [], sim: null }),
  );
  return { layouts, project: sha256(normalizedProjectJson(project)) };
}

// ---------------------------------------------------------------- 経路ゴールデン（R-G3）

/**
 * 各スポット × 滑走路 × 滑走路上ノードについて、出発（スポット → 滑走路ノード）と到着（滑走路ノード → スポット）の経路を採取する。
 * ノード列・累積距離 `cum`・各頂点の旋回角 `turnAngleAt`・滑走路ノードの手前の停止位置（holdShortDistance）を厳密な数値で固定する。
 * 値は 1 経路 1 行（`stringifyRoutes`）。
 */
export function captureRoutes(layout: AirportLayout): Record<string, unknown> {
  const ctx = createContext(layout);
  const out: Record<string, unknown> = {};
  const stands = Object.values(ctx.stands).sort((a, b) => compareIds(a.id, b.id));
  const runways = Object.values(ctx.runways).sort((a, b) => compareIds(a.id, b.id));
  for (const st of stands) {
    for (const rw of runways) {
      rw.nodes.forEach((node, idx) => {
        for (const dir of ['dep', 'arr'] as const) {
          const path = findPath(ctx.network, {
            sources: [{ node: dir === 'dep' ? st.node : node, cost: 0 }],
            goals: new Map([[dir === 'dep' ? node : st.node, 0]]),
            size: st.size,
            speed: 10,
            allowStands: [st.id],
          });
          const key = `${st.id}|${rw.id}|${idx}|${dir}`;
          if (!path) {
            out[key] = null;
            continue;
          }
          const route = makeRoute(ctx, dir === 'dep' ? 'taxiOut' : 'taxiIn', path.nodes, path.edges);
          const turns = path.nodes.map((_, i) => turnAngleAt(ctx, route, i));
          const holds: [number, number][] = [];
          path.nodes.forEach((n, i) => {
            if (i >= 1 && ctx.network.nodes[n]!.runwayIds.length > 0) holds.push([i, holdShortDistance(route.cum[i]! - route.cum[i - 1]!)]);
          });
          out[key] = { nodes: path.nodes, cum: route.cum, turns, holds };
        }
      });
    }
  }
  return out;
}

/** 経路ゴールデンの書式: レイアウトごとに、キー 1 つが 1 行 */
export function stringifyRoutes(byLayout: Record<string, Record<string, unknown>>): string {
  const lines: string[] = ['{'];
  const names = Object.keys(byLayout);
  names.forEach((n, i) => {
    lines.push(` ${JSON.stringify(n)}: {`);
    const keys = Object.keys(byLayout[n]!);
    keys.forEach((k, j) => lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(byLayout[n]![k])}${j < keys.length - 1 ? ',' : ''}`));
    lines.push(` }${i < names.length - 1 ? ',' : ''}`);
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- ストレス運航ゴールデン（R-G2）

/** ストレス運航: 2 シード × 3 時間、会社なし・高需要（1 日 120 往復） */
export const STRESS_SEEDS = ['stress-a', 'stress-b'] as const;
export const STRESS_SECONDS = 3 * 3600;
export const STRESS_FLIGHTS_PER_DAY = 120;

export function captureStress(): unknown {
  const layout = loadFixture('stress');
  const runs: Record<string, unknown> = {};
  for (const seed of STRESS_SEEDS) {
    const sim = createSimulation(layout, { seed, settings: { flightsPerDay: STRESS_FLIGHTS_PER_DAY } });
    const crossed = new Set<string>();
    let crossingHoldTicks = 0;
    let holdShortTicks = 0;
    for (let i = 0; i < STRESS_SECONDS; i++) {
      stepSimulation(sim);
      for (const ac of Object.values(sim.state.aircraft)) {
        if (ac.crossing) crossed.add(`${ac.id}:${ac.crossing.index}`);
        if (ac.holdReason === 'crossing') crossingHoldTicks++;
        if (ac.state === 'holdShort') holdShortTicks++;
      }
    }
    const json = JSON.stringify(sim.state);
    runs[seed] = {
      seconds: STRESS_SECONDS,
      now: sim.state.now,
      stateSha256: sha256(json),
      stateLength: json.length,
      stats: sim.state.stats,
      /** 滑走路横断の許可を受けた回数（航空機 × 横断位置の重複なし） */
      crossings: crossed.size,
      crossingHoldTicks,
      holdShortTicks,
      aircraft: Object.keys(sim.state.aircraft).length,
      kpis: JSON.parse(JSON.stringify(airportKpis(sim))),
    };
  }
  return { simModelVersion: SIM_MODEL_VERSION, flightsPerDay: STRESS_FLIGHTS_PER_DAY, runs };
}

// ---------------------------------------------------------------- 運航状態入りの保存（R-G1 の補完）

/** サンドボックス会社 × サンプル空港を +2 時間進めた時点の serializeProject 出力（sim を含む） */
export function captureProjectWithSim(): { length: number; sha256: string; normalizedSha256: string; simModelVersion: string; now: number } {
  const company = createSandboxCompany();
  const sim = createSimulation(loadFixture('sample'), { company });
  for (let i = 0; i < 2 * 3600; i++) stepSimulation(sim);
  const json = serializeProject(
    buildProject({ name: 'golden-midrun', savedAt: '2026-11-10T00:00:00Z', layout: sim.ctx.layout, company, pin: null, scenarios: [], sim }),
  );
  return { simModelVersion: SIM_MODEL_VERSION, now: sim.state.now, length: json.length, sha256: sha256(json), normalizedSha256: sha256(normalizedProjectJson(json)) };
}

// ---------------------------------------------------------------- 12B-3a A0: リモートスポットの従来の挙動（特性テスト）

/**
 * ゲートのないスポット（リモート）を含む従来のレイアウト（legacy-remote.layout.json = サンプルからゲート 2 つを外したもの）の 1 日の運航。
 * 12B-3a（バス搭乗・独立ゲート）を入れる前の現行コードの出力で、バスゲートのないデータでは 1 ビットも変わらないことを固定する。
 * 出発旅客は「ゲートなし」で乗り遅れ（noGate）、到着旅客は到達不能で降機口のないまま留まる（stranded）のが従来の挙動。
 */
export function captureLegacyRemote(): unknown {
  const layout = JSON.parse(readFileSync(resolve(goldenDir, 'fixtures', 'legacy-remote.layout.json'), 'utf8')) as AirportLayout;
  const runs: Record<string, unknown> = {};
  const variants: { name: string; make: () => ReturnType<typeof createSimulation> }[] = [
    { name: 'sandbox', make: () => createSimulation(layout, { company: createSandboxCompany() }) },
    { name: 'plain-seed', make: () => createSimulation(layout, { seed: 'legacy-remote', settings: { flightsPerDay: 160 } }) },
  ];
  for (const v of variants) {
    const sim = v.make();
    for (let i = 0; i < SIM_SECONDS; i++) stepSimulation(sim);
    const json = JSON.stringify(sim.state);
    const byReason: Record<string, number> = {};
    const byState: Record<string, number> = {};
    for (const g of Object.values(sim.state.paxGroups)) {
      if (g.state === 'missed') byReason[g.reason ?? 'none'] = (byReason[g.reason ?? 'none'] ?? 0) + g.count;
      if (g.direction === 'arrival') byState[g.state] = (byState[g.state] ?? 0) + g.count;
    }
    runs[v.name] = {
      seconds: SIM_SECONDS,
      stateSha256: sha256(json),
      stateLength: json.length,
      stats: sim.state.stats,
      paxStats: sim.state.paxStats,
      missedByReason: byReason,
      arrivalPaxByState: byState,
      remoteStands: Object.values(sim.ctx.stands).filter((s) => !s.contact).length,
      kpis: JSON.parse(JSON.stringify(airportKpis(sim))),
    };
  }
  return { simModelVersion: SIM_MODEL_VERSION, runs };
}

// ---------------------------------------------------------------- 12B-3a: バス搭乗・独立ゲート（新規）

/**
 * バス搭乗の空港（bus.layout.json = サンプル空港 + リモートスポット 5（M×4・L×1）・バスゲート 2（1 つは独立ゲート）・独立コンタクトゲート 1・ランプバス 3 台）の運航。
 * サンドボックスの会社の 1 日と、便数の多い条件の半日。SIM_MODEL_VERSION は上げない（新しいデータがあるときだけの挙動）。
 */
export function captureBusSim(): unknown {
  const layout = JSON.parse(readFileSync(resolve(goldenDir, 'fixtures', 'bus.layout.json'), 'utf8')) as AirportLayout;
  const runs: Record<string, unknown> = {};
  const variants: { name: string; seconds: number; make: () => ReturnType<typeof createSimulation> }[] = [
    { name: 'sandbox', seconds: SIM_SECONDS, make: () => createSimulation(layout, { company: createSandboxCompany() }) },
    { name: 'plain-seed', seconds: 12 * 3600, make: () => createSimulation(layout, { seed: 'bus-golden', settings: { flightsPerDay: 160 } }) },
  ];
  for (const v of variants) {
    const sim = v.make();
    let violations = 0;
    for (let i = 0; i < v.seconds; i++) {
      stepSimulation(sim);
      if (i % 600 === 0) violations += checkInvariants(sim).length;
    }
    const json = JSON.stringify(sim.state);
    const byReason: Record<string, number> = {};
    const arrivalByState: Record<string, number> = {};
    for (const g of Object.values(sim.state.paxGroups)) {
      if (g.state === 'missed') byReason[g.reason ?? 'none'] = (byReason[g.reason ?? 'none'] ?? 0) + g.count;
      if (g.direction === 'arrival') arrivalByState[g.state] = (arrivalByState[g.state] ?? 0) + g.count;
    }
    const tripsByPhase: Record<string, number> = {};
    for (const t of Object.values(sim.state.bus!.trips)) tripsByPhase[t.phase] = (tripsByPhase[t.phase] ?? 0) + 1;
    runs[v.name] = {
      seconds: v.seconds,
      stateSha256: sha256(json),
      stateLength: json.length,
      invariantViolations: violations,
      stats: sim.state.stats,
      paxStats: sim.state.paxStats,
      missedByReason: byReason,
      arrivalPaxByState: arrivalByState,
      bus: sim.state.bus!.stats,
      tripsByPhase,
      busRecords: sim.state.analytics.records.filter((r) => r.boarding === 'bus').length,
      kpis: JSON.parse(JSON.stringify(airportKpis(sim))),
    };
  }
  return { simModelVersion: SIM_MODEL_VERSION, runs };
}
