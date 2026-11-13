import { CATALOG, CATALOG_VERSION, type AircraftModel } from '../aircraft/catalog';
import { AIRCRAFT_ASSETS, ASSET_VERSION } from '../assets/registry';
import { importCompany, type CompanyState } from '../economy/company';
import { SCHEMA_VERSION, type AirportLayout } from '../model/types';
import { SIM_MODEL_VERSION, modelsUsed, type Scenario } from '../scenario/scenario';
import { buildTypeTable } from '../sim/aircraftTypes';
import { createContext } from '../sim/context';
import { checkInvariants, repairCrossingState } from '../sim/invariants';
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
/** 基本の版。新しい項目（バスゲート・独立ゲート・ランプバス・運航中のバスの状態など）を使わないファイルはこの版で書く */
export const PROJECT_FORMAT_VERSION = 1;
/** 新しい項目を使うファイルの版（12B-3a）。このバージョンは 2 までを読める */
export const PROJECT_FORMAT_VERSION_2 = 2;
export const PROJECT_FORMAT_MAX_READABLE = PROJECT_FORMAT_VERSION_2;

const hasKey = (o: unknown, k: string): boolean => typeof o === 'object' && o !== null && k in (o as Record<string, unknown>);

/** レイアウトが保存形式 2 の項目（ゲートの boardingMode 'bus'・connectedTo、GSE 基地の apronBuses > 0）を使っているか */
export function layoutUsesFormat2(l: AirportLayout): boolean {
  for (const f of Object.values(l.facilities)) {
    if (f.kind === 'gate' && (f.props.boardingMode === 'bus' || (f.props.connectedTo !== undefined && f.props.connectedTo !== null))) return true;
    if (f.kind === 'gseBase' && typeof f.props.apronBuses === 'number' && f.props.apronBuses > 0) return true;
  }
  return false;
}

function companyUsesFormat2(c: CompanyState | null | undefined): boolean {
  return !!c && (hasKey(c, 'game') || hasKey(c, 'airlineEval') || hasKey(c, 'goals'));
}

/**
 * このプロジェクトを書くときの保存形式の版。新しい項目を 1 つでも使うときだけ 2（旧アプリが読み違えないため）、
 * 使わないときは 1 のまま（従来のファイル・ゴールデンの出力が変わらない）。
 */
export function formatVersionOf(p: { layout: AirportLayout; company: CompanyState; scenarios: readonly Scenario[]; sim: SimSnapshot | null }): number {
  if (layoutUsesFormat2(p.layout) || companyUsesFormat2(p.company)) return PROJECT_FORMAT_VERSION_2;
  for (const s of p.scenarios) if (layoutUsesFormat2(s.layout) || companyUsesFormat2(s.company)) return PROJECT_FORMAT_VERSION_2;
  if (p.sim) {
    if (hasKey(p.sim.state, 'bus') || hasKey(p.sim.state, 'wx') || companyUsesFormat2(p.sim.company)) return PROJECT_FORMAT_VERSION_2;
  }
  return PROJECT_FORMAT_VERSION;
}

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
  const fv = formatVersionOf({ layout: i.layout, company, scenarios: i.scenarios, sim });
  return {
    format: PROJECT_FORMAT,
    formatVersion: fv,
    name: i.name,
    savedAt: i.savedAt,
    versions: { format: fv, layoutSchema: SCHEMA_VERSION, catalog: i.pin?.version ?? CATALOG_VERSION, assets: ASSET_VERSION, simModel: SIM_MODEL_VERSION },
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
  errors.push(...checkBusProps(layout, where));
  return errors;
}

/** 12B-3a の新しいプロパティの形（ゲートの boardingMode・connectedTo、GSE 基地の apronBuses）。欠落は従来どおりで許す */
function checkBusProps(layout: AirportLayout, where: string): string[] {
  const errors: string[] = [];
  for (const f of Object.values(layout.facilities)) {
    const props = f.props;
    if (!isObj(props)) continue;
    if (f.kind === 'gate') {
      const bm = props.boardingMode;
      if (bm !== undefined && bm !== 'contact' && bm !== 'bus') errors.push(`${where}: ゲート ${f.id} の搭乗方式（boardingMode）が不正です`);
      const ct = props.connectedTo;
      if (ct !== undefined && ct !== null && (typeof ct !== 'string' || layout.facilities[ct]?.kind !== 'terminal')) errors.push(`${where}: ゲート ${f.id} の接続先（connectedTo）がターミナルではありません`);
    }
    if (f.kind === 'gseBase') {
      const n = props.apronBuses;
      if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 30)) errors.push(`${where}: GSE 基地 ${f.id} のランプバス台数（apronBuses）が不正です`);
    }
  }
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
    // heldCrossings（連続横断・先の許可。空のときはキーを書かない）
    if (a.heldCrossings !== undefined) {
      if (!Array.isArray(a.heldCrossings) || a.heldCrossings.length === 0) errors.push(`運航状態: 機体 ${id} の heldCrossings が不正です`);
      else {
        for (const c of a.heldCrossings) {
          if (!isObj(c) || typeof c.index !== 'number' || typeof c.runwayId !== 'string' || !layout.runways[c.runwayId]) {
            errors.push(`運航状態: 機体 ${id} の heldCrossings の滑走路・位置が不正です`);
            continue;
          }
          for (const rid of c.alsoRunwayIds ?? []) if (!layout.runways[rid]) errors.push(`運航状態: 機体 ${id} の横断の滑走路 ${rid} がレイアウトにありません`);
        }
      }
    }
    if (!state.flights[a.arrivalFlightId] || !state.flights[a.departureFlightId]) errors.push(`運航状態: 機体 ${id} の便が見つかりません`);
  }
  errors.push(...checkBusState(state, layout));
  for (const [standId, acId] of Object.entries(state.standAssignments)) {
    if (!layout.stands[standId]) errors.push(`運航状態: スポット割り当て ${standId} がレイアウトにありません`);
    if (!state.aircraft[acId as string]) errors.push(`運航状態: スポット ${standId} に割り当てた機体 ${String(acId)} がありません`);
  }
  return errors;
}

const BUS_PHASES = ['waiting', 'toPickup', 'loading', 'driving', 'unloading', 'stalled', 'done', 'cancelled'];

/** ランプバスの運行の状態の形（state.bus・便の p.bus・バスの trip・旅客の busTrip/waitingBus/onBus）。従来の運航は何も持たない */
function checkBusState(state: SimState, layout: AirportLayout): string[] {
  const errors: string[] = [];
  const raw = (state as unknown as Record<string, unknown>).bus;
  const isGate = (id: unknown): boolean => typeof id === 'string' && layout.facilities[id]?.kind === 'gate';
  if (raw === undefined) {
    for (const f of Object.values(state.flights)) if (f.pax.bus !== undefined) errors.push(`運航状態: 便 ${f.id} が p.bus を持つのにバスの運行（bus）がありません`);
    for (const u of Object.values(state.units)) if (u.trip !== undefined) errors.push(`運航状態: ユニット ${u.id} が運行 ${u.trip} を持つのにバスの運行（bus）がありません`);
    for (const g of Object.values(state.paxGroups)) {
      if (g.busTrip !== undefined || g.state === 'waitingBus' || g.state === 'onBus') errors.push(`運航状態: 旅客グループ ${g.id} がバスの状態なのにバスの運行（bus）がありません`);
    }
    return errors;
  }
  if (!isObj(raw) || !isObj(raw.trips) || !Array.isArray(raw.active) || !isObj(raw.stats)) return ['運航状態: バスの運行（bus）の形が不正です'];
  const bus = raw as unknown as NonNullable<SimState['bus']>;
  for (const k of ['trips', 'pax', 'waitSec', 'shortageSec', 'rescues'] as const) {
    if (typeof bus.stats[k] !== 'number') errors.push(`運航状態: bus.stats.${k} が数値ではありません`);
  }
  for (const [id, t] of Object.entries(bus.trips)) {
    if (!isObj(t) || t.id !== id) {
      errors.push(`運航状態: バスの運行 ${id} の ID が一致しません`);
      continue;
    }
    if (t.dir !== 'dep' && t.dir !== 'arr') errors.push(`運航状態: 運行 ${id} の方向が不正です`);
    if (!BUS_PHASES.includes(t.phase)) errors.push(`運航状態: 運行 ${id} の段階が不正です`);
    if (!state.flights[t.flightId]) errors.push(`運航状態: 運行 ${id} の便 ${String(t.flightId)} がありません`);
    if (!isGate(t.gateId)) errors.push(`運航状態: 運行 ${id} のゲート ${String(t.gateId)} がレイアウトにありません`);
    if (typeof t.standId !== 'string' || !layout.stands[t.standId]) errors.push(`運航状態: 運行 ${id} のスポット ${String(t.standId)} がレイアウトにありません`);
    if (t.busId !== null && state.units[t.busId]?.kind !== 'apronBus') errors.push(`運航状態: 運行 ${id} のバス ${String(t.busId)} がありません`);
    if (!Array.isArray(t.groups) || t.groups.some((g) => !state.paxGroups[g])) errors.push(`運航状態: 運行 ${id} の旅客グループが見つかりません`);
    if (typeof t.pax !== 'number' || typeof t.createdAt !== 'number' || typeof t.phaseSince !== 'number') errors.push(`運航状態: 運行 ${id} の数値項目が不正です`);
  }
  for (const id of bus.active) if (!bus.trips[id]) errors.push(`運航状態: 未完了の運行 ${String(id)} がありません`);
  for (const f of Object.values(state.flights)) {
    const b = f.pax.bus;
    if (b === undefined) continue;
    if (!isObj(b) || (b.gateId !== null && !isGate(b.gateId)) || (b.gateClosedAt !== null && typeof b.gateClosedAt !== 'number')) errors.push(`運航状態: 便 ${f.id} の p.bus が不正です`);
  }
  for (const u of Object.values(state.units)) if (u.trip !== undefined && !bus.trips[u.trip]) errors.push(`運航状態: ユニット ${u.id} の運行 ${u.trip} がありません`);
  for (const g of Object.values(state.paxGroups)) if (g.busTrip !== undefined && !bus.trips[g.busTrip]) errors.push(`運航状態: 旅客グループ ${g.id} の運行 ${g.busTrip} がありません`);
  return errors;
}

/** 運航状態を復元する（文脈はレイアウトと機種データから作り直す）。不整合は violations に返す */
export function restoreSimulation(
  layout: AirportLayout,
  snap: SimSnapshot,
  models: Record<string, AircraftModel>,
): { sim: Simulation; violations: string[]; repaired: string[] } {
  const ctx = createContext(structuredClone(layout), { types: buildTypeTable(models) });
  const sim: Simulation = { ctx, state: structuredClone(snap.state), company: snap.company ? structuredClone(snap.company) : null };
  // 横断の占有が漏れた状態（修正前の版で保存されたもの）は、厳しくした R2 を通る前に修復する
  const repaired = repairCrossingState(sim.state);
  return { sim, violations: checkInvariants(sim), repaired };
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
  else if (data.formatVersion > PROJECT_FORMAT_MAX_READABLE) errors.push(`新しい版（${data.formatVersion}）の保存形式です。このバージョンでは読み込めません`);
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
    const { violations, repaired } = restoreSimulation(layout, sim, models);
    if (repaired.length > 0) {
      warnings.push(`運航状態の横断の占有に不整合（以前の版の不具合で漏れた占有）があったため修復しました（${repaired.length} 件。例: ${repaired[0]}）`);
    }
    if (violations.length) {
      errors.push(...violations.slice(0, 10).map((x) => `運航状態の不整合: ${x}`));
      return fail();
    }
  }

  const fv = formatVersionOf({ layout, company, scenarios, sim });
  const project: ProjectFile = {
    format: PROJECT_FORMAT,
    formatVersion: fv,
    name: data.name as string,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : '',
    versions: {
      format: fv,
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
  return { ok: true, errors, warnings, migratedFrom: data.formatVersion !== PROJECT_FORMAT_VERSION && data.formatVersion !== PROJECT_FORMAT_VERSION_2 ? `${PROJECT_FORMAT} v${String(data.formatVersion)}` : null, project };
}
