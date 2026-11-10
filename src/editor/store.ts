import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Camera } from '../core/geometry/camera';
import { centerOn } from '../core/geometry/camera';
import type { Tile, Vec2 } from '../core/geometry/vec';
import { commit, createHistory, redo, undo, type History } from '../core/editor/history';
import type { OpResult } from '../core/layout/operations';
import { createEmptyLayout } from '../core/layout/operations';
import type { AirportLayout, BuildState, FacilityKind, RoadClass, Rotation, SizeClass, TerminalAreaKind } from '../core/model/types';
import { createSampleAirport } from '../core/sample/sampleAirport';
import { analyzeLayout, type LayoutAnalysis } from '../core/validation/validate';
import { exportLayout, importLayout } from '../core/io/serialize';
import { OP_FAILURE_LABEL } from '../i18n/ja';
import type { Simulation } from '../core/sim/simulation';
import { createCareerCompany, createSandboxCompany, importCompany, post, type CompanyState } from '../core/economy/company';
import { constructionCost } from '../core/economy/construction';
import { applyCompletedProjects, prepareCareerEdit, startClosure, syncProjects } from '../core/economy/expansion';
import { createStarterAirfield } from '../core/sample/starterAirfield';
import { CURRENCY } from '../core/economy/balance';
import {
  changeScenarioAircraft,
  changeScenarioFrequency,
  createScenario,
  duplicateScenario,
  finishScenarioRun,
  replaceScenarioLayout,
  startScenarioRun,
  stepScenarioRun,
  type Scenario,
} from '../core/scenario/scenario';
import type { SimClock } from '../core/sim/clock';

export type ToolId = 'select' | 'runway' | 'taxiway' | 'road' | 'stand' | 'land' | `facility:${FacilityKind}` | `area:${TerminalAreaKind}`;

export interface ToolOptions {
  rotation: Rotation;
  standSize: SizeClass;
  taxiWidth: SizeClass;
  oneWay: boolean;
  roadClass: RoadClass;
  runwayWidth: 30 | 45 | 60;
  buildState: BuildState;
}

/** 進行中のマウス操作 */
export type Draft =
  | { kind: 'path'; points: Tile[] }
  | { kind: 'runway'; start: Tile }
  | { kind: 'rect'; start: Tile }
  | { kind: 'move'; id: string; start: Tile }
  | null;

export interface Overlays {
  grid: boolean;
  /** ターミナル内部（選択中の階）を表示する */
  interior: boolean;
  buildable: boolean;
  network: boolean;
  issues: boolean;
  labels: boolean;
  /** 混雑マップ（運航中: 滑走路・スポット・誘導路ノード・処理施設の混雑） */
  congestion: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

export interface EditorState {
  history: History<AirportLayout>;
  selection: string | null;
  tool: ToolId;
  options: ToolOptions;
  camera: Camera;
  viewSize: { w: number; h: number };
  hover: Tile | null;
  draft: Draft;
  overlays: Overlays;
  /** ターミナル内部の表示・編集中の階（0 = 1F） */
  interiorLevel: number;
  toast: Toast | null;
  /** build: 建設（編集）モード / operate: 運航モード（レイアウトの編集は不可） */
  mode: 'build' | 'operate';
  ops: OpsState | null;
  /** 空港会社（経営）。運航中は ops.sim.company が最新で、運航終了時にここへ戻す */
  company: CompanyState;
  /**
   * 履歴の各編集で支払った建設費（history.past / future と同じ並び）。元に戻すと同額を戻す。
   * null は「金額不明」（運航をはさんだ編集）で、元に戻すときは通常の建設費・払い戻しの規則で精算する。
   */
  charges: { past: (number | null)[]; future: (number | null)[] };
  /** シナリオ（比較用の空港と運航条件の複製。プロジェクトに保存する） */
  scenarios: Scenario[];
  /** 実行中のシナリオ（ID と進捗 0〜1） */
  scenarioRun: { id: string; progress: number } | null;
  /** 表示: 2D マップ / 3D ビュー（切り替えてもシミュレーションは止めない） */
  viewMode: '2d' | '3d';
}

/**
 * 運航モードの状態。sim は毎ティック直接更新される可変オブジェクトなので、
 * React は uiVersion（約10Hz）、描画は frame（毎フレーム）の変化で再描画する。
 */
export interface OpsState {
  sim: Simulation;
  clock: SimClock;
  selectedAircraft: string | null;
  frame: number;
  uiVersion: number;
  /** 直近のフレームで処理が追いつかずティックを捨てたか */
  dropped: boolean;
}

const STORAGE_KEY = 'skyport.layout.v2';
const COMPANY_KEY = 'skyport.company.v1';

function loadInitialCompany(): CompanyState {
  try {
    const saved = globalThis.localStorage?.getItem(COMPANY_KEY);
    const c = saved ? importCompany(saved) : null;
    if (c) return c;
  } catch {
    // 破損・ストレージ無効時はサンドボックスから始める
  }
  return createSandboxCompany();
}

function loadInitialLayout(): AirportLayout {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved) return importLayout(saved);
  } catch {
    // 破損・ストレージ無効時はサンプル空港から始める
  }
  return createSampleAirport();
}

export const editorStore = createStore<EditorState>(() => ({
  history: createHistory(loadInitialLayout()),
  selection: null,
  tool: 'select',
  options: {
    rotation: 0,
    standSize: 'M',
    taxiWidth: 'M',
    oneWay: false,
    roadClass: 'public',
    runwayWidth: 45,
    buildState: 'operational',
  },
  camera: { x: 10, y: 20, zoom: 9 },
  viewSize: { w: 800, h: 600 },
  hover: null,
  draft: null,
  overlays: { grid: true, interior: false, buildable: false, network: false, issues: true, labels: true, congestion: false },
  interiorLevel: 1,
  toast: null,
  mode: 'build',
  ops: null,
  company: loadInitialCompany(),
  charges: { past: [], future: [] },
  scenarios: [],
  scenarioRun: null,
  viewMode: '2d',
}));

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useStore(editorStore, selector);
}

const set = editorStore.setState;
const get = editorStore.getState;

// ---------------------------------------------------------------- 解析結果のキャッシュ

const analysisCache = new WeakMap<AirportLayout, LayoutAnalysis>();
export function getAnalysis(layout: AirportLayout): LayoutAnalysis {
  let a = analysisCache.get(layout);
  if (!a) {
    a = analyzeLayout(layout);
    analysisCache.set(layout, a);
  }
  return a;
}

export function useLayout(): AirportLayout {
  return useEditor((s) => s.history.present);
}

export function useAnalysis(): LayoutAnalysis {
  return getAnalysis(useLayout());
}

// ---------------------------------------------------------------- 保存

let companyTimer: ReturnType<typeof setTimeout> | undefined;
editorStore.subscribe((s, prev) => {
  if (s.company === prev.company) return;
  clearTimeout(companyTimer);
  companyTimer = setTimeout(() => {
    try {
      globalThis.localStorage?.setItem(COMPANY_KEY, JSON.stringify(get().company));
    } catch {
      // 保存できなくても続けられる
    }
  }, 500);
});

let saveTimer: ReturnType<typeof setTimeout> | undefined;
editorStore.subscribe((s, prev) => {
  if (s.history.present === prev.history.present) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, exportLayout(get().history.present));
    } catch {
      // 保存できなくても編集は続けられる
    }
  }, 500);
});

// ---------------------------------------------------------------- 操作

let toastSeq = 0;
export function showToast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastSeq;
  set({ toast: { id, text, kind } });
  setTimeout(() => {
    if (get().toast?.id === id) set({ toast: null });
  }, 3000);
}

/** 編集操作の結果を履歴に確定する。失敗時は理由を通知して何もしない */
export function applyOp(result: OpResult, opts: { select?: boolean; quietNoChange?: boolean } = {}): boolean {
  if (get().mode === 'operate') {
    showToast('運航中はレイアウトを編集できません（建設モードに戻ってください）', 'error');
    return false;
  }
  if (!result.ok) {
    if (!(opts.quietNoChange && result.reason === 'NO_CHANGE')) showToast(OP_FAILURE_LABEL[result.reason], 'error');
    return false;
  }
  const s = get();
  const charged = charge(s.history.present, result.layout);
  if (charged === false) return false;
  const layout = withProjects(charged.company, s.history.present, result.layout);
  const selection =
    opts.select && result.created.length > 0
      ? result.created[0]!
      : s.selection && entityExists(layout, s.selection)
        ? s.selection
        : null;
  commitCharged(layout, charged.cost, charged.company, { selection });
  return true;
}

/** キャリアモード: 新設・改修を工事にする（docs/15 §6）。新しく始まった工事を通知する */
function withProjects(company: CompanyState, before: AirportLayout, after: AirportLayout): AirportLayout {
  const known = new Set(Object.keys(company.projects));
  const layout = prepareCareerEdit(company, before, after);
  const started = Object.values(company.projects).filter((p) => !known.has(p.id));
  if (started.length > 0) {
    const days = Math.max(...started.map((p) => p.days));
    const renovation = started.some((p) => p.kind === 'renovation');
    showToast(`${renovation ? '改修工事（工事中は閉鎖）' : '建設工事'}を始めました（工期 ${days}日。運航した日ごとに進みます）`);
  }
  return layout;
}

export const formatCr = (v: number): string => `${Math.round(v).toLocaleString('ja-JP')} ${CURRENCY}`;

/**
 * 建設費を精算する（docs/14 §2）。資金が足りなければ通知して false。
 * cost を指定しなければ、編集前後のレイアウトから建設費（増えた分）・払い戻し（減った分の25%）を求める。
 */
function charge(before: AirportLayout, after: AirportLayout, cost = constructionCost(before, after)): { cost: number; company: CompanyState } | false {
  const c = get().company;
  if (cost > 0 && c.cash < cost) {
    showToast(`資金不足: 建設費 ${formatCr(cost)} に対して所持金 ${formatCr(c.cash)}`, 'error');
    return false;
  }
  // 工事の登録でも会社を更新するので、常に複製する
  const next = structuredClone(c);
  if (cost !== 0) post(next, 'construction', -cost);
  return { cost, company: next };
}

function commitCharged(layout: AirportLayout, cost: number, company: CompanyState, extra: Partial<EditorState> = {}): void {
  set((s) => {
    const history = commit(s.history, layout);
    const past = [...s.charges.past, cost];
    return { history, company, charges: { past: past.slice(Math.max(0, past.length - history.past.length)), future: [] }, ...extra };
  });
}

/** 運航をはさむと、それ以前の編集の金額は「不明」にする（元に戻しても全額は戻らない） */
export function forgetCharges(): void {
  set((s) => ({ charges: { past: s.charges.past.map(() => null), future: s.charges.future.map(() => null) } }));
}

function entityExists(layout: AirportLayout, id: string): boolean {
  return !!(
    layout.runways[id] ||
    layout.taxiNodes[id] ||
    layout.taxiways[id] ||
    layout.roadNodes[id] ||
    layout.roads[id] ||
    layout.stands[id] ||
    layout.facilities[id] ||
    layout.terminalAreas[id]
  );
}

export function replaceLayout(layout: AirportLayout, message: string): void {
  if (get().mode === 'operate') {
    showToast('運航中はレイアウトを変更できません', 'error');
    return;
  }
  const before = get().history.present;
  const charged = charge(before, layout);
  if (charged === false) return;
  commitCharged(withProjects(charged.company, before, layout), charged.cost, charged.company, { selection: null, draft: null });
  showToast(charged.cost > 0 ? `${message}（建設費 ${formatCr(charged.cost)}）` : message);
}

/** 運航を終えたとき: 完了した工事をレイアウトに反映する（建設費はかからない） */
export function applyFinishedProjects(): void {
  const s = get();
  const company = structuredClone(s.company);
  const layout = applyCompletedProjects(company, s.history.present);
  if (!layout) return;
  commitCharged(layout, 0, company);
  showToast('工事が完了した施設を運用中にしました');
}

/** 運用中の施設を一時閉鎖する（キャリアモード、days 日） */
export function closeTemporarily(id: string, days: number): void {
  const s = get();
  if (s.mode === 'operate' || s.company.mode !== 'career') return;
  const company = structuredClone(s.company);
  const layout = startClosure(company, s.history.present, id, days);
  if (!layout) {
    showToast('運用中の施設だけ一時閉鎖できます', 'error');
    return;
  }
  commitCharged(layout, 0, company);
  showToast(`${days}日間の一時閉鎖を始めました（運航した日ごとに進みます）`);
}

/** 新しいゲーム: キャリア = 小さな飛行場と初期資金・初期契約 / サンドボックス = サンプル空港と潤沢な資金 */
export function newGame(mode: CompanyState['mode']): void {
  if (get().mode === 'operate') return;
  const layout = mode === 'career' ? createStarterAirfield() : createSampleAirport();
  const company = mode === 'career' ? createCareerCompany() : createSandboxCompany();
  set({ history: createHistory(layout), company, charges: { past: [], future: [] }, selection: null, draft: null, tool: 'select' });
  showToast(mode === 'career' ? `新しいゲーム: 小さな飛行場から（資金 ${formatCr(company.cash)}）` : 'サンドボックス: サンプル空港と潤沢な資金で始めます');
}

export const actions = {
  undo(): void {
    const s = get();
    if (s.mode === 'operate') return;
    if (s.history.past.length === 0) return;
    const history = undo(s.history);
    // 支払った建設費を戻す（金額不明なら通常の規則で精算）
    const paid = s.charges.past[s.charges.past.length - 1] ?? null;
    const charged = charge(s.history.present, history.present, paid !== null ? -paid : undefined);
    if (charged === false) return;
    syncProjects(charged.company, history.present);
    set({
      history,
      company: charged.company,
      charges: { past: s.charges.past.slice(0, -1), future: [paid, ...s.charges.future] },
      draft: null,
      selection: s.selection && entityExists(history.present, s.selection) ? s.selection : null,
    });
  },
  redo(): void {
    const s = get();
    if (s.mode === 'operate') return;
    if (s.history.future.length === 0) return;
    const history = redo(s.history);
    // 元に戻したときの金額をもう一度支払う
    const cost = s.charges.future[0] ?? null;
    const charged = charge(s.history.present, history.present, cost ?? undefined);
    if (charged === false) return;
    syncProjects(charged.company, history.present);
    set({
      history,
      company: charged.company,
      charges: { past: [...s.charges.past, cost !== null ? charged.cost : null], future: s.charges.future.slice(1) },
      draft: null,
      selection: s.selection && entityExists(history.present, s.selection) ? s.selection : null,
    });
  },
  select(id: string | null): void {
    set({ selection: id });
  },
  setTool(tool: ToolId): void {
    set((s) => ({
      tool,
      draft: null,
      ...(tool !== 'select' ? { selection: null } : {}),
      // 内部エリアのツールでは内部表示を自動で有効にする
      ...(tool.startsWith('area:') ? { overlays: { ...s.overlays, interior: true } } : {}),
    }));
  },
  setOption<K extends keyof ToolOptions>(key: K, value: ToolOptions[K]): void {
    set((s) => ({ options: { ...s.options, [key]: value } }));
  },
  rotateTool(): void {
    set((s) => ({ options: { ...s.options, rotation: ((s.options.rotation + 90) % 360) as Rotation } }));
  },
  setCamera(camera: Camera): void {
    set({ camera });
  },
  setViewSize(w: number, h: number): void {
    set({ viewSize: { w, h } });
  },
  setHover(hover: Tile | null): void {
    const cur = get().hover;
    if (cur === hover || (cur && hover && cur.x === hover.x && cur.y === hover.y)) return;
    set({ hover });
  },
  setDraft(draft: Draft): void {
    set({ draft });
  },
  setInteriorLevel(level: number): void {
    set((s) => ({ interiorLevel: level, overlays: { ...s.overlays, interior: true } }));
  },
  setViewMode(viewMode: '2d' | '3d'): void {
    set({ viewMode });
  },
  toggleOverlay(key: keyof Overlays): void {
    set((s) => ({ overlays: { ...s.overlays, [key]: !s.overlays[key] } }));
  },
  focus(p: Vec2, select?: string): void {
    const s = get();
    set({ camera: centerOn(s.camera, p, s.viewSize.w, s.viewSize.h), ...(select ? { selection: select } : {}) });
  },
  newEmpty(): void {
    replaceLayout(createEmptyLayout(get().history.present.site), '空の敷地を作成しました（元に戻す で復元できます）');
  },
  loadSample(): void {
    replaceLayout(createSampleAirport(), 'サンプル空港を生成しました（元に戻す で復元できます）');
  },
};

// ---------------------------------------------------------------- シナリオ

let scenarioSeq = 0;
const nowIso = () => new Date().toISOString();
const newScenarioId = () => {
  const used = new Set(get().scenarios.map((x) => x.id));
  let id = `sc_${++scenarioSeq}`;
  while (used.has(id)) id = `sc_${++scenarioSeq}`;
  return id;
};

function updateScenario(id: string, fn: (s: Scenario) => void): void {
  set((st) => ({
    scenarios: st.scenarios.map((x) => {
      if (x.id !== id) return x;
      const c = structuredClone(x);
      fn(c);
      return c;
    }),
  }));
}

export const scenarioActions = {
  /** 現在の空港と会社から作る */
  createFromCurrent(name: string): void {
    const s = get();
    const sc = createScenario({ id: newScenarioId(), name, createdAt: nowIso(), layout: s.history.present, company: s.company, seed: `${s.company.seed}:scenario` });
    set({ scenarios: [...s.scenarios, sc] });
    showToast(`シナリオ「${name}」を作りました`);
  },
  duplicate(id: string): void {
    const src = get().scenarios.find((x) => x.id === id);
    if (!src) return;
    set((st) => ({ scenarios: [...st.scenarios, duplicateScenario(src, newScenarioId(), `${src.name}（複製）`, nowIso())] }));
  },
  remove(id: string): void {
    set((st) => ({ scenarios: st.scenarios.filter((x) => x.id !== id) }));
  },
  rename(id: string, name: string): void {
    updateScenario(id, (s) => (s.name = name));
  },
  changeAircraft(id: string, contractId: string, typeId: string): void {
    updateScenario(id, (s) => void changeScenarioAircraft(s, contractId, typeId));
  },
  changeFrequency(id: string, contractId: string, perDay: number): void {
    updateScenario(id, (s) => void changeScenarioFrequency(s, contractId, perDay));
  },
  /** 現在編集中の空港の配置をシナリオに取り込む（施設の変更を比較する） */
  useCurrentLayout(id: string): void {
    const layout = get().history.present;
    updateScenario(id, (s) => replaceScenarioLayout(s, layout, '編集中の配置を取り込み'));
  },
  setDuration(id: string, hours: number): void {
    updateScenario(id, (s) => {
      s.durationHours = Math.max(1, Math.min(48, Math.round(hours)));
      s.results = [];
    });
  },
  /** 少しずつ進めて実行する（画面を止めない）。useCurrentCatalog = 最新カタログで再実行（旧結果と区別） */
  run(id: string, useCurrentCatalog = false): void {
    if (get().scenarioRun) return;
    const sc = get().scenarios.find((x) => x.id === id);
    if (!sc) return;
    const work = structuredClone(sc);
    const run = startScenarioRun(work, { useCurrentCatalog });
    const total = run.endAt - run.sim.state.now;
    set({ scenarioRun: { id, progress: 0 } });
    const tick = () => {
      const done = stepScenarioRun(run, 1800);
      if (!done) {
        set({ scenarioRun: { id, progress: 1 - (run.endAt - run.sim.state.now) / total } });
        setTimeout(tick, 0);
        return;
      }
      const result = finishScenarioRun(work, run, nowIso());
      updateScenario(id, (s) => s.results.push(result));
      set({ scenarioRun: null });
      showToast(`シナリオ「${sc.name}」の実行が終わりました`);
    };
    setTimeout(tick, 0);
  },
};
