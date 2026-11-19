import { CATALOG, CATALOG_VERSION, type AircraftModel } from '../aircraft/catalog';
import type { AirportLayout } from '../model/types';
import { buildTypeTable } from '../sim/aircraftTypes';
import { createSimulation, stepSimulation, type Simulation } from '../sim/simulation';
import { addDisruption, type DisruptionInput } from '../sim/disruptions';
import { SIM_START_SEC } from '../sim/rules';
import type { CompanyState } from '../economy/company';
import { settleDay } from '../economy/ops';
import { aggregate, metricsOf, type GroupMetrics } from '../analytics/kpi';

/**
 * シナリオ（docs/18_analytics.md §5）: 空港と運航条件を複製して、同じ条件で再実行・比較する。
 *
 * シナリオには再現に必要なものをすべて保存する: レイアウト、会社（航空会社・契約・保有機材・料金・運用時間）、
 * 使った機種のデータ（スナップショット）とカタログの版、障害・天候の条件、乱数シード、シミュレーションモデルの版。
 * 実行は保存した機種データで行う（カタログが更新されても結果は変わらない）。最新のカタログで再実行した結果は区別して記録する。
 * 状態はすべて複製して使い、シナリオ間・編集中の空港と混ざらない。
 */

/** シミュレーションモデルの版（運航・旅客・地上支援・経営の計算規則を変えたら上げる） */
export const SIM_MODEL_VERSION = 'skyport-sim-10.7';

export interface ScenarioDisruption extends DisruptionInput {
  /** 運航開始からの秒（start/end の代わりに保存する） */
  offsetSec: number;
  durationSec: number | null;
}

export interface ScenarioKpis {
  flights: number;
  completed: number;
  failed: number;
  otp: number | null;
  avgDepDelayMin: number | null;
  paxBoarded: number;
  seats: number;
  loadFactor: number | null;
  missedPax: number;
  avgTurnMin: number | null;
  avgPaxWaitMin: number | null;
  bagsLeft: number;
  revenue: number;
  cost: number;
  operatingProfit: number;
}

export interface ScenarioResult {
  ranAt: string;
  simModelVersion: string;
  catalogVersion: string;
  /** 保存した機種データで実行したか、最新のカタログで実行したか */
  catalogUsed: 'snapshot' | 'current';
  kpis: ScenarioKpis;
  byModel: GroupMetrics[];
}

export interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  /** 元にしたシナリオ（複製したとき） */
  baseId: string | null;
  layout: AirportLayout;
  company: CompanyState;
  catalog: { version: string; models: Record<string, AircraftModel> };
  seed: string;
  /** 実行する時間（運航開始 06:00 から） */
  durationHours: number;
  disruptions: ScenarioDisruption[];
  simModelVersion: string;
  /** 変更履歴 */
  changes: string[];
  results: ScenarioResult[];
}

/** 会社の契約・保有機材で使っている機種（スナップショットに含める） */
export function modelsUsed(company: CompanyState): string[] {
  const ids = new Set<string>();
  for (const k of Object.values(company.contracts)) ids.add(k.typeId);
  for (const f of Object.values(company.fleets ?? {})) for (const e of f) ids.add(e.typeId);
  return [...ids].sort();
}

export function snapshotModels(ids: readonly string[], source: Record<string, AircraftModel> = CATALOG): Record<string, AircraftModel> {
  return Object.fromEntries(ids.filter((id) => source[id]).map((id) => [id, structuredClone(source[id]!)]));
}

export function createScenario(input: {
  id: string;
  name: string;
  createdAt: string;
  layout: AirportLayout;
  company: CompanyState;
  seed?: string;
  durationHours?: number;
  disruptions?: ScenarioDisruption[];
  /** プロジェクトが保存時の機種データで固定されているときはその値で作る */
  pin?: { version: string; models: Record<string, AircraftModel> } | null;
}): Scenario {
  const company = structuredClone(input.company);
  const pinned = input.pin ? { ...CATALOG, ...input.pin.models } : CATALOG;
  return {
    id: input.id,
    name: input.name,
    createdAt: input.createdAt,
    baseId: null,
    layout: structuredClone(input.layout),
    company,
    catalog: { version: input.pin?.version ?? CATALOG_VERSION, models: snapshotModels(modelsUsed(company), pinned) },
    seed: input.seed ?? 'scenario',
    durationHours: input.durationHours ?? 18,
    disruptions: structuredClone(input.disruptions ?? []),
    simModelVersion: SIM_MODEL_VERSION,
    changes: [],
    results: [],
  };
}

/** 複製（結果は引き継がない） */
export function duplicateScenario(s: Scenario, id: string, name: string, createdAt: string): Scenario {
  const c = structuredClone(s);
  return { ...c, id, name, createdAt, baseId: s.id, changes: [...c.changes, `「${s.name}」から複製`], results: [] };
}

export type ScenarioEditResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'UNKNOWN_TYPE' };

/**
 * 機材変更（シナリオの中だけ）。新しい機種のデータを、カタログの現在の版からスナップショットに加える。
 * 表示名だけでなく、旅客定員・地上作業・適合性・着陸料の計算がこの機種のデータで行われる。
 */
export function changeScenarioAircraft(s: Scenario, contractId: string, typeId: string): ScenarioEditResult {
  const k = s.company.contracts[contractId];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  const model = s.catalog.models[typeId] ?? CATALOG[typeId];
  if (!model) return { ok: false, reason: 'UNKNOWN_TYPE' };
  s.catalog.models[typeId] ??= structuredClone(model);
  const fleet = (s.company.fleets[k.airlineId] ??= []);
  if (!fleet.some((e) => e.typeId === typeId)) fleet.push({ typeId, seats: model.defaultSeats });
  s.changes.push(`機材変更: ${k.id}（${k.airlineId}）${k.typeId} → ${typeId}`);
  k.typeId = typeId;
  s.results = [];
  return { ok: true };
}

/** 契約の便数の変更（シナリオの中だけ） */
export function changeScenarioFrequency(s: Scenario, contractId: string, perDay: number): ScenarioEditResult {
  const k = s.company.contracts[contractId];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  s.changes.push(`便数変更: ${k.id} ${k.perDay} → ${perDay}便/日`);
  k.perDay = Math.max(1, Math.round(perDay));
  s.results = [];
  return { ok: true };
}

/** レイアウトの差し替え（施設の変更を比較する） */
export function replaceScenarioLayout(s: Scenario, layout: AirportLayout, note: string): void {
  s.layout = structuredClone(layout);
  s.changes.push(`配置変更: ${note}`);
  s.results = [];
}

// ---------------------------------------------------------------- 実行

export interface ScenarioRun {
  sim: Simulation;
  endAt: number;
  done: boolean;
  catalogUsed: 'snapshot' | 'current';
}

/** 実行の準備（保存した機種データ、または最新カタログで機種テーブルを作る） */
export function startScenarioRun(s: Scenario, opts: { useCurrentCatalog?: boolean } = {}): ScenarioRun {
  const models = opts.useCurrentCatalog ? { ...s.catalog.models, ...snapshotModels(Object.keys(s.catalog.models)) } : s.catalog.models;
  // スナップショットにない機種（汎用機材など）は現在のカタログから補う
  const all = { ...snapshotModels(modelsUsed(s.company)), ...models };
  const company = structuredClone(s.company);
  const sim = createSimulation(structuredClone(s.layout), { company, seed: s.seed, types: buildTypeTable(all) });
  for (const d of s.disruptions) {
    const { offsetSec, durationSec, ...rest } = d;
    addDisruption(sim, { ...rest, start: SIM_START_SEC + offsetSec, end: durationSec === null ? null : SIM_START_SEC + offsetSec + durationSec, origin: 'scenario' });
  }
  return { sim, endAt: SIM_START_SEC + s.durationHours * 3600, done: false, catalogUsed: opts.useCurrentCatalog ? 'current' : 'snapshot' };
}

/** n ティック進める（UI では少しずつ進めて画面を止めない）。終わったら true */
export function stepScenarioRun(run: ScenarioRun, ticks: number): boolean {
  for (let i = 0; i < ticks && run.sim.state.now < run.endAt; i++) stepSimulation(run.sim);
  run.done = run.sim.state.now >= run.endAt;
  return run.done;
}

/** 実行結果をまとめる（途中で締めて収支を確定する） */
export function finishScenarioRun(s: Scenario, run: ScenarioRun, ranAt: string): ScenarioResult {
  const { sim } = run;
  const report = settleDay(sim, true);
  const recs = sim.state.analytics.records;
  const all = metricsOf('all', recs, sim.ctx.types);
  const ps = sim.state.paxStats;
  const result: ScenarioResult = {
    ranAt,
    simModelVersion: SIM_MODEL_VERSION,
    catalogVersion: run.catalogUsed === 'snapshot' ? s.catalog.version : CATALOG_VERSION,
    catalogUsed: run.catalogUsed,
    kpis: {
      flights: all.n,
      completed: all.completed,
      failed: all.failed,
      otp: all.otp,
      avgDepDelayMin: all.avgDepDelayMin,
      paxBoarded: all.paxBoarded,
      seats: all.seats,
      loadFactor: all.loadFactor,
      missedPax: ps.missed,
      avgTurnMin: all.avgTurnMin,
      avgPaxWaitMin: ps.finished ? Math.round((ps.waitTotal / ps.finished / 60) * 10) / 10 : null,
      bagsLeft: sim.state.groundStats.bagsLeftBehind,
      revenue: report?.totalRevenue ?? 0,
      cost: report?.totalCost ?? 0,
      operatingProfit: report?.operatingProfit ?? 0,
    },
    byModel: aggregate(recs, 'model', sim.ctx.types),
  };
  s.results.push(result);
  return result;
}

/** 一気に実行する（テスト・ヘッドレス用） */
export function runScenario(s: Scenario, ranAt: string, opts: { useCurrentCatalog?: boolean } = {}): ScenarioResult {
  const run = startScenarioRun(s, opts);
  stepScenarioRun(run, Number.MAX_SAFE_INTEGER);
  return finishScenarioRun(s, run, ranAt);
}

// ---------------------------------------------------------------- 比較

export type Direction = 'higher' | 'lower';

export const KPI_DIRECTION: Record<keyof ScenarioKpis, Direction> = {
  flights: 'higher',
  completed: 'higher',
  failed: 'lower',
  otp: 'higher',
  avgDepDelayMin: 'lower',
  paxBoarded: 'higher',
  seats: 'higher',
  loadFactor: 'higher',
  missedPax: 'lower',
  avgTurnMin: 'lower',
  avgPaxWaitMin: 'lower',
  bagsLeft: 'lower',
  revenue: 'higher',
  cost: 'lower',
  operatingProfit: 'higher',
};

export interface CompareRow {
  metric: keyof ScenarioKpis;
  a: number | null;
  b: number | null;
  diff: number | null;
  verdict: 'improved' | 'worse' | 'same' | 'n/a';
}

/** a（基準）に対する b の比較。改善した指標だけでなく悪化した指標も返す */
export function compareResults(a: ScenarioKpis, b: ScenarioKpis): CompareRow[] {
  return (Object.keys(KPI_DIRECTION) as (keyof ScenarioKpis)[]).map((metric) => {
    const x = a[metric];
    const y = b[metric];
    if (x === null || y === null) return { metric, a: x, b: y, diff: null, verdict: 'n/a' };
    const diff = Math.round((y - x) * 1000) / 1000;
    const verdict = Math.abs(diff) < 1e-9 ? 'same' : (diff > 0) === (KPI_DIRECTION[metric] === 'higher') ? 'improved' : 'worse';
    return { metric, a: x, b: y, diff, verdict };
  });
}

/** 機種データのスナップショットと最新カタログの差分（カタログ更新の影響の確認） */
export function catalogDiff(models: Record<string, AircraftModel>): { id: string; field: string; saved: unknown; current: unknown }[] {
  const out: { id: string; field: string; saved: unknown; current: unknown }[] = [];
  for (const [id, m] of Object.entries(models)) {
    const cur = CATALOG[id];
    if (!cur) {
      out.push({ id, field: '(機種)', saved: m.name, current: null });
      continue;
    }
    for (const k of Object.keys(m) as (keyof AircraftModel)[]) {
      const a = JSON.stringify(m[k]);
      const b = JSON.stringify(cur[k]);
      if (a !== b) out.push({ id, field: k, saved: m[k], current: cur[k] });
    }
  }
  return out;
}
