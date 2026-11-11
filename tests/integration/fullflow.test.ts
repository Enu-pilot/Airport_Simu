/**
 * Phase 10 総合テスト（docs/08_test_plan.md の 14 手順）。
 * 9（2D/3D 表示）と 10 の画面操作は E2E（tests/e2e/view3d.spec.ts, tests/e2e/project.spec.ts）で確認する。
 */
import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { analyzeLayout } from '../../src/core/validation/validate';
import { createSandboxCompany, changeContractAircraft, importCompany, type CompanyState } from '../../src/core/economy/company';
import { CATALOG } from '../../src/core/aircraft/catalog';
import { checkAirport } from '../../src/core/aircraft/compat';
import { buildAirsideNetwork } from '../../src/core/airside/network';
import { AIRCRAFT_TYPES, buildTypeTable, resolveType } from '../../src/core/sim/aircraftTypes';
import { createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { checkInvariants } from '../../src/core/sim/invariants';
import { DAY_SEC } from '../../src/core/sim/rules';
import { aggregate, airportKpis } from '../../src/core/analytics/kpi';
import { changeScenarioAircraft, compareResults, createScenario, duplicateScenario, runScenario, catalogDiff } from '../../src/core/scenario/scenario';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../src/core/io/project';
import { exportLayout } from '../../src/core/io/serialize';

const NOW = '2026-11-10T00:00:00Z';

function step(sim: Simulation, sec: number): void {
  for (let i = 0; i < sec; i++) {
    stepSimulation(sim);
    if (i % 60 === 0) {
      const v = checkInvariants(sim);
      if (v.length) throw new Error(`t=${sim.state.now}: ${v.join(' / ')}`);
    }
  }
}

describe('総合テスト: 新規作成 → 建設 → 機種割り当て → 運航 → 分析 → シナリオ → 保存・復元 → カタログ更新 → 旧形式 → 不正データ', { timeout: 300_000 }, () => {
  // 1〜2. 空の敷地から編集操作（滑走路・誘導路・スポット・ターミナル・ターミナル内部）を順に適用して空港を作る
  const layout = createSampleAirport('fullflow');
  // 3〜4. 航空会社と便（契約）を設定し、具体的な機種を割り当てる: SK = 777-300ER、NP の長距離便 = 777-300
  const company: CompanyState = createSandboxCompany();
  const npLong = Object.values(company.contracts).find((k) => k.airlineId === 'NP' && k.typeId === 'A350-900')!;
  let sim: Simulation;
  let day1: ReturnType<typeof airportKpis>;

  it('1〜2. 空港を新規作成・建設し、配置エラーがない', () => {
    const a = analyzeLayout(layout);
    expect(a.counts.error).toBe(0);
    expect(Object.keys(layout.runways).length).toBeGreaterThan(0);
    expect(Object.keys(layout.stands).length).toBeGreaterThan(0);
    expect(Object.values(layout.facilities).some((f) => f.kind === 'terminal')).toBe(true);
    expect(Object.keys(layout.terminalAreas).length).toBeGreaterThan(0);
  });

  it('3〜4. 便に 777-300 と 777-300ER を別の機種 ID として割り当てる', () => {
    expect(changeContractAircraft(company, npLong.id, 'B777-300')).toEqual({ ok: true });
    const types = Object.values(company.contracts).map((k) => k.typeId);
    expect(types).toContain('B777-300');
    expect(types).toContain('B777-300ER');
  });

  it('5. 機種と施設の適合性を検証する（理由つき）', () => {
    const net = buildAirsideNetwork(layout);
    for (const id of ['B777-300', 'B777-300ER']) {
      const c = checkAirport(AIRCRAFT_TYPES[id]!, layout, net);
      expect(c.status, id).toBe('ok');
      expect(c.stands.some((s) => s.status === 'ok')).toBe(true);
      expect(c.stands.some((s) => s.status === 'ng' && s.reasons.length > 0)).toBe(true);
    }
    // コード F の A380 はこの空港では使えない（理由が出る）
    const a380 = checkAirport(AIRCRAFT_TYPES['A380-800']!, layout, net);
    expect(a380.status).toBe('ng');
    expect(a380.reasons.length).toBeGreaterThan(0);
  });

  it('6. 1日運航し、旅客・手荷物・地上支援を処理する（不変条件を検査しながら）', () => {
    sim = createSimulation(layout, { company });
    step(sim, DAY_SEC - (sim.state.now % DAY_SEC));
    day1 = airportKpis(sim);
    expect(sim.state.stats.departures).toBeGreaterThan(10);
    expect(sim.state.paxStats.boarded).toBeGreaterThan(1000);
    expect(sim.state.groundStats.tasksDone).toBeGreaterThan(50);
    expect(Object.keys(sim.state.bags).length).toBeGreaterThan(0);
  });

  it('7. 機種別の運航実績（777-300 と 777-300ER を分けて）と経営指標を分析する', () => {
    const by = aggregate(sim.state.analytics.records, 'model', sim.ctx.types);
    const k3 = by.find((g) => g.key === 'B777-300');
    const k3er = by.find((g) => g.key === 'B777-300ER');
    expect(k3).toBeDefined();
    expect(k3er).toBeDefined();
    // 機種の座席数が実績に反映される（NP の 777-300 は 400 席、SK の 777-300ER は 316 席）
    expect(k3!.seats / k3!.n).toBe(400);
    expect(k3er!.seats / k3er!.n).toBe(316);
    // 便数が少ないのでデータ不足として扱う
    expect(k3!.lowSample).toBe(true);
    expect(day1.departures).toBe(sim.state.analytics.records.filter((r) => r.takeoffAt !== null).length);
    // 経営指標: 当日の収入（着陸料・旅客施設使用料など）が便に帰属した収入と一致する
    const ledger = (['landing', 'parking', 'terminal', 'groundHandling'] as const).reduce((t, k) => t + (sim.company!.today[k] ?? 0), 0);
    const attributed = sim.state.analytics.records.reduce((t, r) => t + r.revenue, 0) + Object.values(sim.state.analytics.live).reduce((t, l) => t + l.revenue, 0);
    expect(ledger).toBeGreaterThan(0);
    expect(Math.abs(ledger - attributed)).toBeLessThanOrEqual(sim.state.analytics.records.length * 4 + 50);
  });

  it('8. 機種の割り当てを変更したシナリオを比較し、改善・悪化の両方を判定する', () => {
    const base = createScenario({ id: 'sc_1', name: '基準', createdAt: NOW, layout, company: createSandboxCompany(), seed: 'ff', durationHours: 18 });
    const alt = duplicateScenario(base, 'sc_2', '777-300 に変更', NOW);
    const k = Object.values(alt.company.contracts).find((x) => x.typeId === 'A350-900')!;
    expect(changeScenarioAircraft(alt, k.id, 'B777-300')).toEqual({ ok: true });
    const ra = runScenario(base, NOW);
    const rb = runScenario(alt, NOW);
    expect(rb.byModel.some((g) => g.key === 'B777-300')).toBe(true);
    expect(rb.kpis.seats).not.toBe(ra.kpis.seats);
    const rows = compareResults(ra.kpis, rb.kpis);
    expect(rows.some((r) => r.verdict === 'improved' || r.verdict === 'worse')).toBe(true);
    // 再実行で同じ結果
    expect(runScenario(alt, NOW).kpis).toEqual(rb.kpis);
  });

  it('10〜11. 運航中に保存・再読み込みし、施設・機種・運航・旅客・経営の状態が一致し、続きも同じ結果になる', () => {
    step(sim, 3 * 3600);
    const p = buildProject({ name: '総合テスト', savedAt: NOW, layout, company: sim.company!, pin: null, scenarios: [], sim });
    const r = validateProject(serializeProject(p), { fallbackCompany: createSandboxCompany() });
    expect(r.errors).toEqual([]);
    const loaded = r.project!;
    expect(loaded.layout).toEqual(layout);
    expect(loaded.company.contracts[npLong.id]!.typeId).toBe('B777-300');
    expect(Object.keys(loaded.catalog.models)).toEqual(expect.arrayContaining(['B777-300', 'B777-300ER']));
    const { sim: b, violations } = restoreSimulation(loaded.layout, loaded.sim!, effectiveModels(loaded.catalog));
    expect(violations).toEqual([]);
    expect(b.state.paxStats).toEqual(sim.state.paxStats);
    expect(b.state.standAssignments).toEqual(sim.state.standAssignments);
    expect(b.company!.cash).toBe(sim.company!.cash);
    step(sim, 3600);
    step(b, 3600);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(sim.state));
    expect(b.company!.cash).toBe(sim.company!.cash);
  });

  it('12. 機種カタログが更新されても、保存済みプロジェクト・シナリオ結果は変わらず、最新での再実行は区別される', () => {
    const sc = createScenario({ id: 'sc_c', name: 'カタログ固定', createdAt: NOW, layout, company: createSandboxCompany(), seed: 'cat', durationHours: 18 });
    delete sc.company.fleets.SK; // 機種の既定座席を使う
    const before = runScenario(sc, NOW);
    const saved = serializeProject(buildProject({ name: 'p', savedAt: NOW, layout, company: sc.company, pin: null, scenarios: [sc], sim: null }));
    const original = structuredClone(CATALOG['B777-300ER']!);
    try {
      // カタログの更新（例: 既定座席数の見直し）
      CATALOG['B777-300ER']!.defaultSeats = 999;
      const r = validateProject(saved, { fallbackCompany: createSandboxCompany() });
      expect(r.ok).toBe(true);
      // 保存したプロジェクトの機種データは変わらない
      expect(buildTypeTable(effectiveModels(r.project!.catalog))['B777-300ER']!.seats).toBe(370);
      // 差分として確認できる
      expect(catalogDiff(r.project!.catalog.models).some((d) => d.id === 'B777-300ER' && d.field === 'defaultSeats')).toBe(true);
      // 保存済みシナリオを再実行しても同じ結果、最新カタログでの再実行は別の結果として残る（保存前の結果も残っている）
      const sc2 = r.project!.scenarios[0]!;
      expect(sc2.results).toHaveLength(1);
      expect(runScenario(sc2, NOW).kpis).toEqual(before.kpis);
      const cur = runScenario(sc2, NOW, { useCurrentCatalog: true });
      expect(cur.catalogUsed).toBe('current');
      expect(cur.kpis.seats).not.toBe(before.kpis.seats);
      expect(sc2.results.map((x) => x.catalogUsed)).toEqual(['snapshot', 'snapshot', 'current']);
      expect(sc2.results[0]!.kpis).toEqual(before.kpis);
    } finally {
      CATALOG['B777-300ER'] = original;
    }
  });

  it('13. 古い形式（レイアウトだけのファイル、保有機材のない旧会社データ・汎用機材）を移行する', () => {
    const old = createSandboxCompany() as unknown as Record<string, unknown>;
    delete old.fleets;
    for (const k of Object.values((old as unknown as CompanyState).contracts)) k.typeId = k.typeId.startsWith('B777') ? 'wide300' : 'narrow180';
    const company = importCompany(JSON.stringify(old))!;
    const r = validateProject(exportLayout(layout), { fallbackCompany: company });
    expect(r.ok).toBe(true);
    expect(r.migratedFrom).toBe('skyport-layout');
    // 汎用機材は実在機種に置き換えず、そのまま保持する
    const ids = Object.values(r.project!.company.contracts).map((k) => k.typeId);
    expect(ids).toContain('wide300');
    expect(ids.every((id) => CATALOG[id])).toBe(true);
    expect(r.project!.catalog.models.wide300!.generic).toBe(true);
    // 移行後も運航できる
    const s = createSimulation(r.project!.layout, { company: r.project!.company, types: buildTypeTable(effectiveModels(r.project!.catalog)) });
    step(s, 4 * 3600);
    expect(s.state.stats.arrivals).toBeGreaterThan(0);
  });

  it('14. 存在しない機種 ID・参照できないアセットを含むデータは、データを保持したまま警告し、未解決として扱う', () => {
    const p = JSON.parse(serializeProject(buildProject({ name: 'x', savedAt: NOW, layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: null })));
    const k = Object.values(p.company.contracts as Record<string, { typeId: string }>)[0]!;
    k.typeId = 'B999-1';
    p.assets.refs['B777-300ER'] = 'no-such-asset';
    const r = validateProject(JSON.stringify(p), { fallbackCompany: createSandboxCompany() });
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/B999-1/);
    expect(r.warnings.join('\n')).toMatch(/no-such-asset/);
    expect(Object.values(r.project!.company.contracts).some((c) => c.typeId === 'B999-1')).toBe(true);
    expect(resolveType(buildTypeTable(effectiveModels(r.project!.catalog)), 'B999-1').unresolved).toBe(true);
    // 参照切れ（誘導路の端点）はエラーで、読み込まない
    const broken = JSON.parse(JSON.stringify(p));
    (Object.values(broken.layout.taxiways)[0] as { to: string }).to = 'tn_gone';
    const rb = validateProject(JSON.stringify(broken), { fallbackCompany: createSandboxCompany() });
    expect(rb.ok).toBe(false);
    expect(rb.project).toBeNull();
  });
});
