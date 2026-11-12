import { CATALOG, CATALOG_VERSION, type AircraftModel } from '../aircraft/catalog';
import { AIRCRAFT_ASSETS, ASSET_VERSION } from '../assets/registry';
import { importCompany, type CompanyState } from '../economy/company';
import { SCHEMA_VERSION, type AirportLayout } from '../model/types';
import { SIM_MODEL_VERSION, modelsUsed, type Scenario } from '../scenario/scenario';
import { buildTypeTable } from '../sim/aircraftTypes';
import { createContext } from '../sim/context';
import { checkInvariants } from '../sim/invariants';
import type { Simulation } from '../sim/simulation';
import type { SimState } from '../sim/types';
import { SAVE_FORMAT, checkRunwayFields, validateLayoutData } from './serialize';
import { migrateLayout } from './migrate';

/**
 * プロジェクトの保存形式（docs/21_save_format.md）。
 *
 * 1 つのプロジェクト = 空港レイアウト・会社（契約・保有機材）・使用機種のスナップショットとカタログ版・3D アセットの参照・
 * シナリオ（結果・分析を含む）・任意で運航中の状態（便・機体・障害・分析の記録を含む SimState）。
 *
 * 版は 4 つを別々に持つ: 保存形式（PROJECT_FORMAT_VERSION）、機種カタログ（CATALOG_VERSION）、
 * 3D アセット（ASSET_VERSION）、シミュレーションのモデル（SIM_MODEL_VERSION）。
 *
 * 読み込みは「検証 → すべて通ったら適用」。検証で失敗したら呼び出し側は今のプロジェクトを一切変更しない。
 */

export const PROJECT_FORMAT = 'skyport-project';
export const PROJECT_FORMAT_VERSION = 1;

export interface CatalogPin {
  version: string;
  models: Record<string, AircraftModel>;
}

export interface SimSnapshot {
  state: SimState;
  company: CompanyState | null;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  formatVersion: number;
  name: string;
  savedAt: string;
  versions: { format: number; layoutSchema: number; catalog: string; assets: string; simModel: string };
  layout: AirportLayout;
  company: CompanyState;
  /** プロジェクトで使う機種のデータ（保存時の値。カタログが更新されても自動では変わらない） */
  catalog: CatalogPin;
  /** 機種 ID → 3D アセット ID（保存時の対応） */
  assets: { version: string; refs: Record<string, string> };
  scenarios: Scenario[];
  /** 運航中に保存したときの運航状態（建設モードでは null） */
  sim: SimSnapshot | null;
}

/** プロジェクトの有効な機種データ: 現在のカタログに、保存時のスナップショットを優先して重ねる */
export function effectiveModels(pin: CatalogPin | null): Record<string, AircraftModel> {
  return pin ? { ...CATALOG, ...pin.models } : CATALOG;
}

/** プロジェクトが使っている機種 ID（会社の契約・保有機材、運航中の機体、シナリオ） */
export function projectModelIds(company: CompanyState, sim: SimSnapshot | null, scenarios: readonly Scenario[] = []): string[] {
  const ids = new Set(modelsUsed(company));
  if (sim) {
    for (const a of Object.values(sim.state.aircraft)) ids.add(a.typeId);
    if (sim.company) for (const id of modelsUsed(sim.company)) ids.add(id);
  }
  for (const s of scenarios) for (const id of modelsUsed(s.company)) ids.add(id);
  return [...ids].sort();
}

export interface BuildInput {
  name: string;
  savedAt: string;
  layout: AirportLayout;
  company: CompanyState;
  pin: CatalogPin | null;
  scenarios: readonly Scenario[];
  sim: Simulation | null;
}

export function buildProject(i: BuildInput): ProjectFile {
  const sim: SimSnapshot | null = i.sim ? structuredClone({ state: i.sim.state, company: i.sim.company ?? null }) : null;
  const company = structuredClone(sim?.company ?? i.company);
  const models = effectiveModels(i.pin);
  const ids = projectModelIds(company, sim, i.scenarios);
  const snap = Object.fromEntries(ids.filter((id) => models[id]).map((id) => [id, structuredClone(models[id]!)]));
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    name: i.name,
    savedAt: i.savedAt,
    versions: { format: PROJECT_FORMAT_VERSION, layoutSchema: SCHEMA_VERSION, catalog: i.pin?.version ?? CATALOG_VERSION, assets: ASSET_VERSION, simModel: SIM_MODEL_VERSION },
    layout: structuredClone(i.layout),
    company,
    catalog: { version: i.pin?.version ?? CATALOG_VERSION, models: snap },
    assets: { version: ASSET_VERSION, refs: Object.fromEntries(Object.entries(snap).map(([id, m]) => [id, m.assetId])) },
    scenarios: structuredClone([...i.scenarios]),
    sim,
  };
}

export function serializeProject(p: ProjectFile): string {
  return JSON.stringify(p);
}

// ---------------------------------------------------------------- 検証

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** 移行した元の形式（旧形式のレイアウトファイルなど） */
  migratedFrom: string | null;
  project: ProjectFile | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const LAYOUT_RECORDS = ['runways', 'taxiNodes', 'taxiways', 'roadNodes', 'roads', 'stands', 'facilities', 'terminalAreas'] as const;

/** レイアウトの内容の検証（必須項目・型・ID の重複・参照切れ） */
export function checkLayout(l: unknown, where = 'レイアウト'): string[] {
  const errors = validateLayoutData(l).map((e) => `${where}: ${e}`);
  if (errors.length) return errors;
  const layout = l as AirportLayout;
  const seen = new Map<string, string>();
  for (const k of LAYOUT_RECORDS) {
    for (const [key, e] of Object.entries(layout[k] as Record<string, { id?: unknown }>)) {
      if (!isObj(e)) {
        errors.push(`${where}: ${k} の ${key} が不正です`);
        continue;
      }
      if (e.id !== key) errors.push(`${where}: ${k} の ID が一致しません（${key} / ${String(e.id)}）`);
      const prev = seen.get(key);
      if (prev) errors.push(`${where}: ID ${key} が重複しています（${prev} と ${k}）`);
      seen.set(key, k);
    }
  }
  for (const e of Object.values(layout.taxiways)) {
    if (!layout.taxiNodes[e.from] || !layout.taxiNodes[e.to]) errors.push(`${where}: 誘導路 ${e.id} の端点（${e.from} / ${e.to}）が見つかりません`);
  }
  for (const e of Object.values(layout.roads)) {
    if (!layout.roadNodes[e.from] || !layout.roadNodes[e.to]) errors.push(`${where}: 道路 ${e.id} の端点（${e.from} / ${e.to}）が見つかりません`);
  }
  for (const a of Object.values(layout.terminalAreas)) {
    if (layout.facilities[a.terminalId]?.kind !== 'terminal') errors.push(`${where}: ターミナル内エリア ${a.id} の建物 ${a.terminalId} が見つかりません`);
  }
  errors.push(...checkRunwayFields(layout, where));
  return errors;
}

function checkCompany(c: unknown, where: string): { errors: string[]; company: CompanyState | null } {
  if (!isObj(c)) return { errors: [`${where}: 会社のデータがありません`], company: null };
  const company = importCompany(JSON.stringify(c));
  if (!company) return { errors: [`${where}: 会社のデータが不正です（版・資金・契約）`], company: null };
  const errors: string[] = [];
  for (const [key, k] of Object.entries(company.contracts)) {
    if (!isObj(k) || k.id !== key) errors.push(`${where}: 契約 ${key} の ID が一致しません`);
    else if (typeof k.typeId !== 'string' || typeof k.airlineId !== 'string') errors.push(`${where}: 契約 ${key} の機種・航空会社が不正です`);
  }
  return { errors, company };
}

function checkModels(models: unknown): string[] {
  if (!isObj(models)) return ['機種データ: models がありません'];
  const errors: string[] = [];
  for (const [id, m] of Object.entries(models)) {
    if (!isObj(m) || m.id !== id) {
      errors.push(`機種データ: ${id} の ID が一致しません`);
      continue;
    }
    for (const f of ['lengthM', 'wingspanM', 'heightM', 'mtowKg', 'maxPax'] as const) {
      const v = m[f];
      if (!isObj(v) || !['official', 'game', 'unset'].includes(v.status as string) || (v.value !== null && typeof v.value !== 'number')) {
        errors.push(`機種データ: ${id} の ${f} が不正です`);
      }
    }
    if (!isObj(m.profile) || typeof m.defaultSeats !== 'number' || typeof m.assetId !== 'string') errors.push(`機種データ: ${id} のゲーム設定が不正です`);
  }
  return errors;
}

function checkSim(sim: unknown, layout: AirportLayout): string[] {
  if (!isObj(sim) || !isObj(sim.state)) return ['運航状態: state がありません'];
  const s = sim.state;
  const errors: string[] = [];
  if (s.version !== 1 || typeof s.now !== 'number' || typeof s.seed !== 'string') errors.push('運航状態: 版・時刻・シードが不正です');
  for (const k of ['flights', 'aircraft', 'standAssignments', 'paxGroups', 'units', 'tasks', 'bags', 'analytics'] as const) {
    if (!isObj(s[k])) errors.push(`運航状態: ${k} がありません`);
  }
  if (errors.length) return errors;
  const state = s as unknown as SimState;
  for (const [id, a] of Object.entries(state.aircraft)) {
    if (a.id !== id) errors.push(`運航状態: 機体 ${id} の ID が一致しません`);
    if (a.standId && !layout.stands[a.standId]) errors.push(`運航状態: 機体 ${id} のスポット ${a.standId} がレイアウトにありません`);
    if (a.runwayId && !layout.runways[a.runwayId]) errors.push(`運航状態: 機体 ${id} の滑走路 ${a.runwayId} がレイアウトにありません`);
    for (const rid of a.crossing?.alsoRunwayIds ?? []) {
      if (!layout.runways[rid]) errors.push(`運航状態: 機体 ${id} の横断の滑走路 ${rid} がレイアウトにありません`);
    }
    if (!state.flights[a.arrivalFlightId] || !state.flights[a.departureFlightId]) errors.push(`運航状態: 機体 ${id} の便が見つかりません`);
  }
  for (const [standId, acId] of Object.entries(state.standAssignments)) {
    if (!layout.stands[standId]) errors.push(`運航状態: スポット割り当て ${standId} がレイアウトにありません`);
    if (!state.aircraft[acId as string]) errors.push(`運航状態: スポット ${standId} に割り当てた機体 ${String(acId)} がありません`);
  }
  return errors;
}

/** 運航状態を復元する（文脈はレイアウトと機種データから作り直す）。不整合は violations に返す */
export function restoreSimulation(layout: AirportLayout, snap: SimSnapshot, models: Record<string, AircraftModel>): { sim: Simulation; violations: string[] } {
  const ctx = createContext(structuredClone(layout), { types: buildTypeTable(models) });
  const sim: Simulation = { ctx, state: structuredClone(snap.state), company: snap.company ? structuredClone(snap.company) : null };
  return { sim, violations: checkInvariants(sim) };
}

export interface ValidateOptions {
  /** 旧形式（レイアウトだけのファイル）を移行するときに使う会社データ */
  fallbackCompany: CompanyState;
  name?: string;
  savedAt?: string;
}

/**
 * プロジェクトファイル（または旧形式のレイアウトファイル）を検証する。
 * エラーが 1 件でもあれば project は null（呼び出し側は何も適用しない）。警告は読み込み可能な問題。
 */
export function validateProject(json: string, opts: ValidateOptions): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): ValidationReport => ({ ok: false, errors, warnings, migratedFrom: null, project: null });
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    errors.push(`JSON として読めません: ${e instanceof Error ? e.message : String(e)}`);
    return fail();
  }
  if (!isObj(data)) {
    errors.push('ファイルの中身がオブジェクトではありません');
    return fail();
  }

  // 旧形式: レイアウトだけのファイル（Phase 1〜6 の「書き出し」）
  if (data.format === SAVE_FORMAT) {
    const ver = data.schemaVersion;
    if (typeof ver !== 'number' || ver < 1 || ver > SCHEMA_VERSION) errors.push(`未対応のレイアウトの版です: ${String(ver)}`);
    const l = data.layout;
    if (ver === 1) migrateLayout(l, ver);
    if (!errors.length) errors.push(...checkLayout(l));
    if (errors.length) return fail();
    warnings.push('旧形式のレイアウトファイルです。会社（資金・契約）は現在のものを使い、機種データは現在のカタログで固定します');
    const company = structuredClone(opts.fallbackCompany);
    const project = buildProject({
      name: opts.name ?? '読み込んだレイアウト',
      savedAt: opts.savedAt ?? '',
      layout: l as unknown as AirportLayout,
      company,
      pin: null,
      scenarios: [],
      sim: null,
    });
    return { ok: true, errors, warnings, migratedFrom: SAVE_FORMAT, project };
  }

  if (data.format !== PROJECT_FORMAT) {
    errors.push('SkyPort のプロジェクトファイルではありません（format が違います）');
    return fail();
  }
  if (typeof data.formatVersion !== 'number' || data.formatVersion < 1) errors.push('保存形式の版（formatVersion）が不正です');
  else if (data.formatVersion > PROJECT_FORMAT_VERSION) errors.push(`新しい版（${data.formatVersion}）の保存形式です。このバージョンでは読み込めません`);
  if (typeof data.name !== 'string') errors.push('name（プロジェクト名）がありません');
  if (!isObj(data.versions)) errors.push('versions（版の情報）がありません');
  const lv = isObj(data.versions) ? data.versions.layoutSchema : undefined;
  if (typeof lv === 'number' && lv > SCHEMA_VERSION) errors.push(`新しい版（${lv}）のレイアウト形式です。このバージョンでは読み込めません`);
  if (errors.length) return fail();

  // レイアウト
  const v = data.versions as Record<string, unknown>;
  const l = data.layout;
  if (isObj(l) && l.schemaVersion === 1) migrateLayout(l, 1);
  errors.push(...checkLayout(l));
  const layout = l as unknown as AirportLayout;

  // 会社（旧版の会社データはここで移行される）
  const { errors: ce, company } = checkCompany(data.company, '会社');
  errors.push(...ce);

  // 機種データ
  const cat = data.catalog;
  let pin: CatalogPin | null = null;
  if (!isObj(cat) || typeof cat.version !== 'string') errors.push('catalog（機種データの版とスナップショット）がありません');
  else {
    const me = checkModels(cat.models);
    errors.push(...me);
    if (!me.length) pin = { version: cat.version, models: cat.models as Record<string, AircraftModel> };
  }

  // シナリオ
  const scenarios: Scenario[] = [];
  if (data.scenarios !== undefined && !Array.isArray(data.scenarios)) errors.push('scenarios が配列ではありません');
  else {
    const ids = new Set<string>();
    for (const [i, s] of ((data.scenarios as unknown[]) ?? []).entries()) {
      const where = `シナリオ ${i + 1}`;
      if (!isObj(s) || typeof s.id !== 'string' || typeof s.name !== 'string' || !Array.isArray(s.results)) {
        errors.push(`${where}: 形式が不正です`);
        continue;
      }
      if (ids.has(s.id)) errors.push(`${where}: ID ${s.id} が重複しています`);
      ids.add(s.id);
      errors.push(...checkLayout(s.layout, `${where}（${s.name}）`));
      const r = checkCompany(s.company, `${where}（${s.name}）`);
      errors.push(...r.errors);
      if (!isObj(s.catalog)) errors.push(`${where}: 機種データがありません`);
      else errors.push(...checkModels(s.catalog.models).map((e) => `${where}: ${e}`));
      if (r.company) scenarios.push({ ...(s as unknown as Scenario), company: r.company });
    }
  }

  // 運航状態
  let sim: SimSnapshot | null = null;
  if (data.sim !== null && data.sim !== undefined) {
    if (v.simModel !== SIM_MODEL_VERSION) {
      warnings.push(`運航状態はシミュレーションの版 ${String(v.simModel)} で保存されています（現在 ${SIM_MODEL_VERSION}）。運航状態は復元せず、建設モードで開きます`);
    } else if (!errors.length) {
      const se = checkSim(data.sim, layout);
      errors.push(...se);
      if (!se.length) {
        const raw = data.sim as Record<string, unknown>;
        const sc = raw.company === null || raw.company === undefined ? { errors: [], company: null } : checkCompany(raw.company, '運航中の会社');
        errors.push(...sc.errors);
        sim = { state: raw.state as unknown as SimState, company: sc.company };
      }
    }
  }
  if (errors.length || !company) return fail();

  // 機種 ID・アセットの参照（読み込みはできる問題は警告）
  const models = effectiveModels(pin);
  for (const id of projectModelIds(company, sim, scenarios)) {
    if (!models[id]) warnings.push(`不明な機種 ID「${id}」: 保存データにもカタログにもありません。未解決の機種として汎用の値で扱います`);
  }
  if (pin && pin.version !== CATALOG_VERSION) warnings.push(`保存時の機種データ（カタログ版 ${pin.version}）で開きます。最新カタログ（${CATALOG_VERSION}）は差分を確認してから適用できます`);
  const assets = data.assets;
  if (isObj(assets) && isObj(assets.refs)) {
    for (const [mid, aid] of Object.entries(assets.refs)) {
      if (typeof aid !== 'string' || !AIRCRAFT_ASSETS[aid]) warnings.push(`機種 ${mid} の 3D アセット「${String(aid)}」は登録されていません（代替の形で表示します）`);
    }
    if (assets.version !== ASSET_VERSION) warnings.push(`3D アセットの版が保存時（${String(assets.version)}）と異なります（現在 ${ASSET_VERSION}）。表示だけに影響します`);
  }

  // 運航状態は実際に復元して不変条件を確かめる
  if (sim) {
    const { violations } = restoreSimulation(layout, sim, models);
    if (violations.length) {
      errors.push(...violations.slice(0, 10).map((x) => `運航状態の不整合: ${x}`));
      return fail();
    }
  }

  const project: ProjectFile = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    name: data.name as string,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : '',
    versions: {
      format: PROJECT_FORMAT_VERSION,
      layoutSchema: SCHEMA_VERSION,
      catalog: pin?.version ?? CATALOG_VERSION,
      assets: ASSET_VERSION,
      simModel: SIM_MODEL_VERSION,
    },
    layout,
    company,
    catalog: pin ?? { version: CATALOG_VERSION, models: {} },
    assets: isObj(assets) && isObj(assets.refs) ? { version: String(assets.version), refs: assets.refs as Record<string, string> } : { version: ASSET_VERSION, refs: {} },
    scenarios,
    sim,
  };
  return { ok: true, errors, warnings, migratedFrom: data.formatVersion !== PROJECT_FORMAT_VERSION ? `${PROJECT_FORMAT} v${String(data.formatVersion)}` : null, project };
}
