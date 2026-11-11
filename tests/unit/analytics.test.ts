import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import type { AirportLayout } from '../../src/core/model/types';
import { createSandboxCompany, type CompanyState } from '../../src/core/economy/company';
import { aggregate, airportKpis, bottlenecks, MIN_SAMPLE } from '../../src/core/analytics/kpi';
import {
  catalogDiff,
  changeScenarioAircraft,
  compareResults,
  createScenario,
  duplicateScenario,
  runScenario,
  SIM_MODEL_VERSION,
} from '../../src/core/scenario/scenario';
import { CATALOG_VERSION } from '../../src/core/aircraft/catalog';
import { createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { checkInvariants } from '../../src/core/sim/invariants';
import { DAY_SEC } from '../../src/core/sim/rules';

function runDay(sim: Simulation): void {
  const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
  while (sim.state.now < target) {
    stepSimulation(sim);
    const v = checkInvariants(sim);
    if (v.length) throw new Error(`t=${sim.state.now}: ${v.join(' / ')}`);
  }
}

const NOW = '2026-11-10T00:00:00Z';

describe('運営分析（実績からの集計）', { timeout: 180_000 }, () => {
  const c = createSandboxCompany();
  const sim = createSimulation(createSampleAirport(), { company: c });
  runDay(sim);
  const recs = sim.state.analytics.records;

  it('運航を終えた機体ごとに1件ずつ記録し、機種IDで 777-300ER と A350-900 を区別して集計する', () => {
    const finished = Object.values(sim.state.aircraft).filter((a) => ['departed', 'diverted', 'cannotOperate'].includes(a.state));
    expect(recs.length).toBe(finished.length);
    expect(new Set(recs.map((r) => r.aircraftId)).size).toBe(recs.length);
    const byModel = aggregate(recs, 'model', sim.ctx.types);
    const keys = byModel.map((g) => g.key);
    expect(keys).toContain('B777-300ER');
    expect(keys).toContain('A350-900');
    expect(byModel.reduce((s, g) => s + g.n, 0)).toBe(recs.length);
    // 1日1便の機種はデータ不足として扱う
    expect(byModel.find((g) => g.key === 'B777-300ER')!.lowSample).toBe(true);
    expect(byModel.find((g) => g.key === 'A320-200')!.lowSample).toBe(byModel.find((g) => g.key === 'A320-200')!.n < MIN_SAMPLE);
  });

  it('メーカー・ファミリー・航空会社・スポットの切り口でも合計が一致する', () => {
    for (const key of ['manufacturer', 'family', 'airline', 'stand'] as const) {
      const g = aggregate(recs, key, sim.ctx.types);
      expect(g.reduce((s, x) => s + x.n, 0)).toBe(recs.filter((r) => key !== 'stand' || r.standId !== null).length);
    }
    expect(aggregate(recs, 'manufacturer', sim.ctx.types).map((g) => g.key).sort()).toEqual(['Airbus', 'Boeing', '汎用']);
  });

  it('便に帰属させた収入は、会社の収支（着陸料・駐機料・使用料・地上支援料）と一致する', () => {
    const attributed = recs.reduce((s, r) => s + r.revenue, 0) + Object.values(sim.state.analytics.live).reduce((s, l) => s + l.revenue, 0);
    const cats = ['landing', 'parking', 'terminal', 'groundHandling'] as const;
    const ledger =
      c.reports.reduce((s, r) => s + cats.reduce((t, k) => t + (r.revenue[k] ?? 0), 0), 0) + cats.reduce((t, k) => t + (c.today[k] ?? 0), 0);
    // 記帳は1件ごとに円未満を丸めるので、件数分の誤差を許す
    expect(Math.abs(attributed - ledger)).toBeLessThanOrEqual(recs.length * 4 + 50);
  });

  it('空港全体の指標: 滑走路・スポットの使用率は 0〜1、旅客の時間帯別集計は記録と一致する', () => {
    const k = airportKpis(sim);
    for (const r of k.runways) expect(r.util).toBeGreaterThanOrEqual(0);
    for (const r of k.runways) expect(r.util).toBeLessThanOrEqual(1);
    for (const s of k.stands) expect(s.util).toBeLessThanOrEqual(1);
    expect(k.hourlyPax.reduce((s, h) => s + h.dep, 0)).toBe(recs.reduce((s, r) => s + (r.takeoffAt !== null ? r.paxBoarded : 0), 0));
    expect(k.departures).toBe(recs.filter((r) => r.takeoffAt !== null).length);
  });
});

describe('ボトルネックの推定', { timeout: 180_000 }, () => {
  it('保安検査のレーンが少ないと、待ち時間・待ち人数を根拠に保安検査がボトルネックとして挙がる', () => {
    const l: AirportLayout = structuredClone(createSampleAirport());
    const sec = Object.values(l.terminalAreas).find((a) => a.kind === 'security')!;
    sec.props.lanes = 1;
    const sim = createSimulation(l, { company: createSandboxCompany() });
    for (let i = 0; i < 10 * 3600; i++) stepSimulation(sim);
    const b = bottlenecks(sim).find((x) => x.target === sec.id);
    expect(b).toBeDefined();
    expect(b!.area).toBe('security');
    expect(b!.evidence.map((e) => e.label)).toContain('平均待ち');
    expect(b!.rule).toContain('10分');

    const normal = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    for (let i = 0; i < 10 * 3600; i++) stepSimulation(normal);
    expect(bottlenecks(normal).some((x) => x.area === 'security')).toBe(false);
  });
});

describe('シナリオ比較', { timeout: 300_000 }, () => {
  const base = (company: CompanyState = createSandboxCompany()) =>
    createScenario({ id: 'sc_1', name: '基準', createdAt: NOW, layout: createSampleAirport(), company, seed: 's', durationHours: 18 });

  it('同じ条件で再実行すると同じ結果になる（再現性）。使った条件・機種データ・版を保持する', () => {
    const s = base();
    const a = runScenario(s, NOW);
    const b = runScenario(s, NOW);
    expect(b.kpis).toEqual(a.kpis);
    expect(s.results).toHaveLength(2);
    expect(a.simModelVersion).toBe(SIM_MODEL_VERSION);
    expect(a.catalogVersion).toBe(CATALOG_VERSION);
    expect(Object.keys(s.catalog.models)).toContain('B777-300ER');
  });

  it('機材変更のシナリオ: A350-900 を 777-300 に変えると機種別の集計・座席数が変わり、元のシナリオは変わらない', () => {
    const s = base();
    const k = Object.values(s.company.contracts).find((x) => x.typeId === 'A350-900')!;
    const d = duplicateScenario(s, 'sc_2', '777-300 に変更', NOW);
    expect(changeScenarioAircraft(d, k.id, 'B777-300')).toEqual({ ok: true });
    expect(s.company.contracts[k.id]!.typeId).toBe('A350-900');
    expect(d.catalog.models['B777-300']).toBeDefined();
    const ra = runScenario(s, NOW);
    const rb = runScenario(d, NOW);
    expect(ra.byModel.some((g) => g.key === 'A350-900')).toBe(true);
    expect(rb.byModel.some((g) => g.key === 'A350-900')).toBe(false);
    expect(rb.byModel.some((g) => g.key === 'B777-300')).toBe(true);
    expect(rb.kpis.seats).not.toBe(ra.kpis.seats);
    const rows = compareResults(ra.kpis, rb.kpis);
    expect(rows.find((r) => r.metric === 'seats')!.verdict).toBe(rb.kpis.seats > ra.kpis.seats ? 'improved' : 'worse');
    // 改善・悪化の両方が判定される（同じ・判定不能も区別）
    expect(rows.every((r) => ['improved', 'worse', 'same', 'n/a'].includes(r.verdict))).toBe(true);
    expect(d.changes.some((x) => x.includes('B777-300'))).toBe(true);
  });

  it('保存した機種データで実行し、カタログが更新されても過去の結果は変わらない。最新カタログでの再実行は区別される', () => {
    const s = base();
    // 保存時のデータ（例: 古い版の座席数）を表すスナップショット
    s.catalog.models['B777-300ER']!.defaultSeats = 290;
    s.catalog.version = '2025.01.0';
    delete s.company.fleets.SK; // 航空会社の座席構成を使わず、機種の既定座席を使う
    const old = runScenario(s, NOW);
    const cur = runScenario(s, NOW, { useCurrentCatalog: true });
    const seatsOf = (r: typeof old) => r.byModel.find((g) => g.key === 'B777-300ER')!;
    expect(seatsOf(old).seats / Math.max(1, seatsOf(old).completed)).toBe(290);
    expect(seatsOf(cur).seats / Math.max(1, seatsOf(cur).completed)).toBe(370);
    expect(old.catalogUsed).toBe('snapshot');
    expect(old.catalogVersion).toBe('2025.01.0');
    expect(cur.catalogUsed).toBe('current');
    expect(catalogDiff(s.catalog.models).some((d) => d.id === 'B777-300ER' && d.field === 'defaultSeats')).toBe(true);
    // 旧結果は上書きされずに残る
    expect(s.results[0]!.catalogUsed).toBe('snapshot');
  });
});
