import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Camera } from '../core/geometry/camera';
import { centerOn } from '../core/geometry/camera';
import type { Tile, Vec2 } from '../core/geometry/vec';
import type { WorldPoint } from '../core/geometry/frames';
import { commit, createHistory, redo, undo, type History } from '../core/editor/history';
import type { OpResult } from '../core/layout/operations';
import { createEmptyLayout } from '../core/layout/operations';
import type { AirportLayout, BuildState, FacilityKind, RoadClass, Rotation, SizeClass, TerminalAreaKind } from '../core/model/types';
import { createSampleAirport } from '../core/sample/sampleAirport';
import { analyzeLayout, type LayoutAnalysis } from '../core/validation/validate';
import { exportLayout, importLayout } from '../core/io/serialize';
import { OP_FAILURE_LABEL } from '../i18n/ja';
import type { Simulation } from '../core/sim/simulation';
import type { CatalogPin } from '../core/io/project';
import { createCareerCompany, createSandboxCompany, importCompany, post, type CompanyState } from '../core/economy/company';
import { constructionCost } from '../core/economy/construction';
import { applyGameState, defaultGame, scaleConstructionCost, startGame, type GameSettings } from '../core/economy/game';
import type { CityConfig, CityEvent } from '../core/economy/city';
import { applyCompletedProjects, prepareCareerEdit, startClosure, syncProjects } from '../core/economy/expansion';
import { createStarterAirfield } from '../core/sample/starterAirfield';
import type { DayReview } from '../core/analytics/review';
import { createJournal, type Journal } from '../core/analytics/journal';
import { clearUnsavedHistory } from './dayHistoryStore';
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
  /** 滑走路ツールの方式。既定は従来形（8 方向のグリッド）。自由形は任意方位・実寸（Phase 12） */
  runwayAlignment: 'grid8' | 'free';
  /** 自由形の始点の格子への吸着（タイル = 整数、半タイル、なし） */
  gridSnap: 'tile' | 'half' | 'off';
  /** 自由形の方位の吸着（度）。0 = 吸着なし */
  angleSnapDeg: 0 | 1 | 5 | 10 | 15 | 45;
  /** 自由形の長さの吸着（m）。0 = 吸着なし */
  lengthSnapM: 0 | 10 | 50 | 100;
  /** 自由形の配置方法: ドラッグ（始点→終点）/ 数値入力（方位・長さを入力してクリックで置く） */
  freeInput: 'drag' | 'numeric';
  /** 数値入力: 真方位（度）、長さ（m）、クリックした点が滑走路の始点 / 中点 */
  freeHeadingDeg: number;
  freeLengthM: number;
  freeAnchor: 'start' | 'mid';
}

/** 進行中のマウス操作 */
export type Draft =
  | { kind: 'path'; points: Tile[] }
  | { kind: 'runway'; start: Tile }
  /** 自由形の滑走路: 始点（吸着済みの実数の World 座標）からドラッグ */
  | { kind: 'freeRunway'; start: WorldPoint }
  /** 選択中の自由形の端のハンドル: 端をドラッグして中点まわりに回転（fixOpposite = 反対の端を固定して方位・長さを変える） */
  | { kind: 'rwyHandle'; id: string; which: 'start' | 'end'; fixOpposite: boolean }
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
  /** ゲーム時刻に応じた昼夜 tint（表示のみ） */
  daylight: boolean;
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
  /** カーソルの World 座標（丸めない）。自由形の操作中だけ精密で、それ以外は hover のタイル中心 */
  hoverW: WorldPoint | null;
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
  /** 開いているプロジェクト（保存スロットの ID。未保存なら null）と名前 */
  projectId: string | null;
  projectName: string;
  /** 保存時の機種データ（プロジェクトを開いたときに固定。null なら現在のカタログ） */
  catalogPin: CatalogPin | null;
  /** 日次の実運航ログから作る任意の記録 */
  journal: Journal;
  /** 1 日のループの UI の状態（保存しない。docs/06 §9）。phase: 通常 / スキップ中 / 振り返りを表示中 */
  dayFlow: DayFlow;
  /** 運航の設定（localStorage に保存。表示・進め方だけで、シミュレーションの結果には関係しない） */
  opsPrefs: OpsPrefs;
}

export interface DayFlow {
  phase: 'none' | 'skipping' | 'review';
  /** 直近に締めた日の振り返り（運航を始めるか締めを行うと更新。「前日の振り返り」から見直せる） */
  review: DayReview | null;
  /** 履歴から開いた過去の振り返り（読み取り専用。運航とは無関係） */
  viewing: DayReview | null;
  /** 締めの直後で運航を止めている（次の日へ進める・建設へ戻る前の状態） */
  atClose: boolean;
  skip: { progress: number; label: 'day' | 'night'; stopReason: string | null } | null;
  /** 履歴のオーバーレイを開いている */
  historyOpen: boolean;
}

export interface OpsPrefs {
  /** 0:00 の締めで運航を止めて振り返りを表示する（既定 ON） */
  pauseAtDayClose: boolean;
  /** 1 日スキップを重大な障害（滑走路の閉鎖・整備、ダイバート）で止める（既定 ON） */
  skipAutoStop: boolean;
}

export const initialDayFlow = (): DayFlow => ({ phase: 'none', review: null, viewing: null, atClose: false, skip: null, historyOpen: false });

const PREFS_KEY = 'skyport.opsPrefs.v1';
function loadPrefs(): OpsPrefs {
  const d: OpsPrefs = { pauseAtDayClose: true, skipAutoStop: true };
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OpsPrefs>;
      return { pauseAtDayClose: typeof p.pauseAtDayClose === 'boolean' ? p.pauseAtDayClose : d.pauseAtDayClose, skipAutoStop: typeof p.skipAutoStop === 'boolean' ? p.skipAutoStop : d.skipAutoStop };
    }
  } catch {
    // 既定値を使う
  }
  return d;
}

/** 運航の設定を変えて保存する */
export function setOpsPrefs(patch: Partial<OpsPrefs>): void {
  const next = { ...editorStore.getState().opsPrefs, ...patch };
  editorStore.setState({ opsPrefs: next });
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // 保存できなくても設定は今の画面では有効
  }
}

/**
 * 日次の締めのオートセーブ: 運航中の会社（最新）を、ストアの会社を変えずに保存先のキーにだけ書く。
 * 別のタブ・再読み込みで、締めた日までの経営が残る。
 */
export function saveCompanyAutosave(company: CompanyState): void {
  try {
    globalThis.localStorage?.setItem(COMPANY_KEY, JSON.stringify(company));
  } catch {
    // 保存できなくても続けられる
  }
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
const META_KEY = 'skyport.projectMeta.v1';

type ProjectMeta = Pick<EditorState, 'projectId' | 'projectName' | 'catalogPin'>;

function loadInitialMeta(): ProjectMeta {
  try {
    const saved = globalThis.localStorage?.getItem(META_KEY);
    if (saved) {
      const m = JSON.parse(saved) as ProjectMeta;
      if (typeof m.projectName === 'string') return { projectId: m.projectId ?? null, projectName: m.projectName, catalogPin: m.catalogPin ?? null };
    }
  } catch {
    // 破損時は未保存のプロジェクトとして始める
  }
  return { projectId: null, projectName: '無題のプロジェクト', catalogPin: null };
}
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
    runwayAlignment: 'grid8',
    gridSnap: 'tile',
    angleSnapDeg: 1,
    lengthSnapM: 10,
    freeInput: 'drag',
    freeHeadingDeg: 90,
    freeLengthM: 2000,
    freeAnchor: 'start',
  },
  camera: { x: 10, y: 20, zoom: 9 },
  viewSize: { w: 800, h: 600 },
  hover: null,
  hoverW: null,
  draft: null,
  overlays: { grid: true, interior: false, buildable: false, network: false, issues: true, labels: true, congestion: false, daylight: true },
  interiorLevel: 1,
  toast: null,
  mode: 'build',
  ops: null,
  company: loadInitialCompany(),
  charges: { past: [], future: [] },
  scenarios: [],
  scenarioRun: null,
  viewMode: '2d',
  dayFlow: initialDayFlow(),
  opsPrefs: loadPrefs(),
  journal: createJournal(),
  ...loadInitialMeta(),
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

editorStore.subscribe((s, prev) => {
  if (s.projectId === prev.projectId && s.projectName === prev.projectName && s.catalogPin === prev.catalogPin) return;
  try {
    globalThis.localStorage?.setItem(META_KEY, JSON.stringify({ projectId: s.projectId, projectName: s.projectName, catalogPin: s.catalogPin }));
  } catch {
    // 保存できなくても続けられる
  }
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

/** 難易度で建設費を調整する（増えた分だけ。払い戻しは従来どおり） */
export const scaledConstructionCost = scaleConstructionCost;

export const formatCr = (v: number): string => `${Math.round(v).toLocaleString('ja-JP')} ${CURRENCY}`;

/**
 * 建設費を精算する（docs/14 §2）。資金が足りなければ通知して false。
 * cost を指定しなければ、編集前後のレイアウトから建設費（増えた分）・払い戻し（減った分の25%）を求める。
 */
function charge(before: AirportLayout, after: AirportLayout, cost?: number): { cost: number; company: CompanyState } | false {
  const c = get().company;
  // 難易度の建設費の倍率（game があるときだけ。normal は ×1 で従来と同じ）。取り消し・やり直しの金額（cost 指定）はそのまま
  cost ??= scaledConstructionCost(c, constructionCost(before, after));
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

/**
 * 新しいゲーム: キャリア = 小さな飛行場と初期資金・初期契約 / サンドボックス = サンプル空港と潤沢な資金。
 * game を省くと新しいルール（天候 5 段階・評価・目標。難易度は標準）、null を渡すと従来のルール。
 * 初期資金は難易度の倍率を掛ける（標準は ×1 で従来と同じ）。
 */
export function newGame(mode: CompanyState['mode'], game: GameSettings | null = defaultGame(), city?: CityConfig | null): void {
  if (get().mode === 'operate') return;
  const layout = mode === 'career' ? createStarterAirfield() : createSampleAirport();
  const company = mode === 'career' ? createCareerCompany() : createSandboxCompany();
  startGame(company, game);
  if (city) company.city = structuredClone(city);
  set({ history: createHistory(layout), company, charges: { past: [], future: [] }, selection: null, draft: null, tool: 'select', scenarios: [], projectId: null, projectName: '無題のプロジェクト', catalogPin: null, journal: createJournal(), dayFlow: initialDayFlow() });
  void clearUnsavedHistory();
  showToast(mode === 'career' ? `新しいゲーム: 小さな飛行場から（資金 ${formatCr(company.cash)}）` : 'サンドボックス: サンプル空港と潤沢な資金で始めます');
}

/** 既存の会社のゲーム設定を付け外しする（建設モード。以後の運航から効く）。null = 従来のルールに戻す */
export function setGameSettings(game: GameSettings | null): void {
  const s = get();
  if (s.mode === 'operate') return;
  const company = structuredClone(s.company);
  if (game) company.game = game;
  else delete company.game;
  applyGameState(company);
  set({ company });
  showToast(game ? 'ゲーム設定を更新しました（次の運航から反映されます）' : '従来のルールに戻しました');
}

/** 都市モデルを有効化・更新する（建設モード。null は従来の需要モデルに戻す） */
export function setCompanyCity(city: CityConfig | null): void {
  const s = get();
  if (s.mode === 'operate') return;
  const company = structuredClone(s.company);
  if (city) company.city = structuredClone(city);
  else delete company.city;
  set({ company });
  showToast(city ? '都市と空港需要の設定を更新しました' : '都市モデルを停止し、従来の需要に戻しました');
}

export function addCityEvent(event: Omit<CityEvent, 'id'>): void {
  const s = get();
  if (s.mode === 'operate' || !s.company.city) return;
  const company = structuredClone(s.company);
  const events = company.city!.events ?? [];
  let n = 1;
  while (events.some((existing) => existing.id === `city-event-${n}`)) n++;
  events.push({ ...event, id: `city-event-${n}` });
  company.city!.events = events.sort((a, b) => a.day - b.day || a.id.localeCompare(b.id));
  set({ company });
  showToast('都市イベントを予定に追加しました');
}

export function removeCityEvent(eventId: string): void {
  const s = get();
  if (s.mode === 'operate' || !s.company.city?.events) return;
  const company = structuredClone(s.company);
  company.city!.events = company.city!.events!.filter((event) => event.id !== eventId);
  set({ company });
  showToast('都市イベントを予定から削除しました');
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
  /** hoverW を省略するとタイル中心（World では (x, y)） */
  setHover(hover: Tile | null, hoverW?: WorldPoint | null): void {
    const cur = get();
    const w = hoverW === undefined ? (hover ? { x: hover.x, y: hover.y } : null) : hoverW;
    const sameTile = cur.hover === hover || (cur.hover && hover && cur.hover.x === hover.x && cur.hover.y === hover.y);
    const sameW = cur.hoverW === w || (cur.hoverW && w && cur.hoverW.x === w.x && cur.hoverW.y === w.y);
    if (sameTile && sameW) return;
    set({ hover, hoverW: w });
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
    const sc = createScenario({ id: newScenarioId(), name, createdAt: nowIso(), layout: s.history.present, company: s.company, seed: `${s.company.seed}:scenario`, pin: s.catalogPin });
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
