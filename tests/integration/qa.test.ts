/**
 * 品質・性能の検証（docs/08_test_plan.md）: 長時間運航、大量の便・旅客・手荷物、保存・復元の繰り返し。
 * 計測値は test-results/perf-sim.json に書き出す（実行環境によって変わる）。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany } from '../../src/core/economy/company';
import { createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { checkInvariants } from '../../src/core/sim/invariants';
import { DAY_SEC } from '../../src/core/sim/rules';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../src/core/io/project';

const PERF_FILE = 'test-results/perf-sim.json';
function record(key: string, value: unknown): void {
  mkdirSync('test-results', { recursive: true });
  const cur = existsSync(PERF_FILE) ? (JSON.parse(readFileSync(PERF_FILE, 'utf8')) as Record<string, unknown>) : {};
  cur[key] = value;
  cur.measuredAt = new Date().toISOString();
  writeFileSync(PERF_FILE, JSON.stringify(cur, null, 2));
}

function run(sim: Simulation, sec: number, checkEvery = 60): void {
  for (let i = 0; i < sec; i++) {
    stepSimulation(sim);
    if (i % checkEvery === 0) {
      const v = checkInvariants(sim);
      if (v.length) throw new Error(`t=${sim.state.now}: ${v.join(' / ')}`);
    }
  }
}

describe('長時間の運航', { timeout: 600_000 }, () => {
  it('3日間、ランダムな障害ありで運航しても不変条件を保ち、毎日の締めが行われる', () => {
    const sim = createSimulation(createSampleAirport(), { company: createSandboxCompany(), settings: { randomDisruptions: true } });
    const t0 = performance.now();
    const perDay: number[] = [];
    for (let d = 0; d < 3; d++) {
      const before = sim.state.stats.departures;
      run(sim, (d + 1) * DAY_SEC - sim.state.now + 600);
      perDay.push(sim.state.stats.departures - before);
    }
    const ms = performance.now() - t0;
    // 毎日、便が出発している（障害で止まりきらない）
    for (const n of perDay) expect(n).toBeGreaterThan(0);
    expect(sim.state.disruptions && Object.keys(sim.state.disruptions).length).toBeGreaterThan(0);
    expect(sim.company!.reports.length).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(sim.company!.cash)).toBe(true);
    record('longRun3Days', { simSec: sim.state.now, wallMs: Math.round(ms), departuresPerDay: perDay, disruptions: Object.keys(sim.state.disruptions).length });
  });
});

describe('大量の便・旅客・手荷物', { timeout: 600_000 }, () => {
  it('乱数のスケジュール 90 往復/日の過密日でも不変条件を保ち、処理速度を計測する', () => {
    // 会社なしの運航は乱数のスケジュール（flightsPerDay 往復）で、契約の上限に縛られずに混ませられる
    const sim = createSimulation(createSampleAirport(), { settings: { flightsPerDay: 90 } });
    const t0 = performance.now();
    run(sim, 12 * 3600, 300);
    const ms = performance.now() - t0;
    const pax = sim.state.paxStats.spawned;
    const bags = Object.keys(sim.state.bags).length;
    const flights = Object.keys(sim.state.flights).length;
    expect(flights).toBeGreaterThan(100);
    expect(pax).toBeGreaterThan(5000);
    expect(bags).toBeGreaterThan(1000);
    // 運航モードの最大倍率（×600）に足りる速度か
    const speed = (12 * 3600) / (ms / 1000);
    record('bulkDay12h', { flights, paxSpawned: pax, bags, wallMs: Math.round(ms), simSecPerWallSec: Math.round(speed) });
    expect(speed).toBeGreaterThan(600);
  });
});

describe('保存・復元の繰り返し', { timeout: 600_000 }, () => {
  it('30 分ごとに 10 回、保存 → 検証 → 復元を繰り返しても、中断しなかった運航と同一になる', () => {
    const a = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    let b = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    let maxBytes = 0;
    let validateMs = 0;
    for (let i = 0; i < 10; i++) {
      run(a, 1800, 600);
      run(b, 1800, 600);
      const json = serializeProject(buildProject({ name: `loop${i}`, savedAt: '', layout: b.ctx.layout, company: b.company!, pin: null, scenarios: [], sim: b }));
      maxBytes = Math.max(maxBytes, json.length);
      const t0 = performance.now();
      const r = validateProject(json, { fallbackCompany: createSandboxCompany() });
      validateMs = Math.max(validateMs, performance.now() - t0);
      expect(r.errors).toEqual([]);
      const restored = restoreSimulation(r.project!.layout, r.project!.sim!, effectiveModels(r.project!.catalog));
      expect(restored.violations).toEqual([]);
      b = restored.sim;
    }
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
    expect(b.company).toEqual(a.company);
    record('saveLoadLoop', { cycles: 10, maxProjectKB: Math.round(maxBytes / 1024), maxValidateMs: Math.round(validateMs) });
  });
});
