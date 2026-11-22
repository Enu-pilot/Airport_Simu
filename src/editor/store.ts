import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Camera } from '../core/geometry/camera';
import { centerOn } from '../core/geometry/camera';
import type { Tile, Vec2 } from '../core/geometry/vec';
import type { WorldPoint } from '../core/geometry/frames';
import { commit, createHistory, redo, undo, type History } from '../core/editor/history';
import type { OpResult } from '../core/layout/operations';
import { createEmptyLayout, bulkPlaceBoardingBridges } from '../core/layout/operations';
import type { AirportLayout, BuildState, FacilityKind, RoadClass, Rotation, SizeClass, TaxiwayWidthClass, TerminalAreaKind } from '../core/model/types';
import type { PbbBridgeType, PbbDeck } from '../core/model/catalog';
import { createSampleAirport } from '../core/sample/sampleAirport';
import { facilityOutline, facilityTiles } from '../core/layout/footprint';
import { terminalFloorRange } from '../core/layout/levelRules';
import { facilityLevel } from '../core/model/levels';
import { createSite, siteSizeById } from '../core/model/site';
import { analyzeLayout, intlLockedIssues, overnightStandIssues, type LayoutAnalysis } from '../core/validation/validate';
import { exportLayout, importLayout } from '../core/io/serialize';
import { OP_FAILURE_LABEL } from '../i18n/ja';
import type { Simulation } from '../core/sim/simulation';
import type { CatalogPin } from '../core/io/project';
import { createCareerCompany, createSandboxCompany, importCompany, post, type CompanyState } from '../core/economy/company';
import { constructionCost } from '../core/economy/construction';
import { applyGameState, defaultGame, scaleConstructionCost, startGame, type GameSettings } from '../core/economy/game';
import { applyNoiseContribution, applySoundproofPurchase, canMakeNoiseContribution, cityEventCost, nextSoundproofCost, soundproofLevelOf, type CityConfig, type CityEvent } from '../core/economy/city';
import { applyCompletedProjects, prepareCareerEdit, startClosure, syncProjects } from '../core/economy/expansion';
import { createStarterAirfield } from '../core/sample/starterAirfield';
import type { DayReview } from '../core/analytics/review';
import { createJournal, type Journal } from '../core/analytics/journal';
import { clearUnsavedHistory } from './dayHistoryStore';
import { BALANCE, CURRENCY } from '../core/economy/balance';
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
import type { ServiceGranularity } from '../core/sim/serviceAggregate';

export type ToolId = 'select' | 'runway' | 'taxiway' | 'road' | 'stand' | 'land' | 'pbb' | 'agt' | `facility:${FacilityKind}` | `area:${TerminalAreaKind}`;

export interface ToolOptions {
  rotation: Rotation;
  standSize: SizeClass;
  taxiWidth: TaxiwayWidthClass;
  oneWay: boolean;
  roadClass: RoadClass;
  roadLevel: number;
  roadCapacityPerHour: number;
  interiorParentId: string | null;
  interiorFloorIndex: number;
  /** ターミナル配置時の絶対階の範囲（機能G）。最下階が基底階（mapLevel）になり、最上階 − 最下階 + 1 が階数になる */
  terminalFloorMin: number;
  terminalFloorMax: number;
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
  /** 搭乗橋（PBB）ツールの型式とデッキ（機能H） */
  pbbType: PbbBridgeType;
  pbbDeck: PbbDeck;
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
  /** 外形（フットプリント）編集中の頂点ドラッグ（5-15 T3） */
  | { kind: 'fpVertex'; index: number }
  | { kind: 'rect'; start: Tile }
  | { kind: 'move'; id: string; start: Tile }
  /** 搭乗橋（PBB）ツールの2クリック配置: 先に選んだ側（スポットまたはゲート）を保持する */
  | { kind: 'pbb'; standId?: string; gateId?: string }
  /** AGT セグメント接続ツール（機能I）の2クリック接続: 先に選んだ駅を保持する */
  | { kind: 'agt'; fromStationId?: string }
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
  /** 便名（コールサイン）ラベル（運航中のみ。表示レイヤ復活で切替可能にした。従来はズーム条件だけで表示） */
  flightNames: boolean;
  /** ランプバスの乗車人数ラベル（運航中のみ。表示レイヤ復活で切替可能にした。従来はズーム条件だけで表示） */
  busPax: boolean;
  /** 貨物便の搭載量ラベル（運航中のみ。従来の地図には無かった表示のため、初期表示を変えないよう既定 OFF） */
  cargoCounts: boolean;
}

/** 表示レイヤの既定値（従来の初期表示と同一: 便名・バス人数は表示、貨物数は従来表示が無いため OFF） */
export const DEFAULT_OVERLAYS: Overlays = {
  grid: true,
  interior: false,
  buildable: false,
  network: false,
  issues: true,
  labels: true,
  congestion: false,
  daylight: true,
  flightNames: true,
  busPax: true,
  cargoCounts: false,
};

const OVERLAYS_KEY = 'skyport.overlays.v1';
/** 表示レイヤ設定の読み込み（localStorage。欠けた項目・壊れた値は既定値に寄せる後方互換つき） */
export function loadOverlays(): Overlays {
  const d = DEFAULT_OVERLAYS;
  try {
    const raw = globalThis.localStorage?.getItem(OVERLAYS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Overlays>;
      const pick = (k: keyof Overlays) => (typeof p[k] === 'boolean' ? p[k] : d[k]);
      return {
        grid: pick('grid'),
        interior: pick('interior'),
        buildable: pick('buildable'),
        network: pick('network'),
        issues: pick('issues'),
        labels: pick('labels'),
        congestion: pick('congestion'),
        daylight: pick('daylight'),
        flightNames: pick('flightNames'),
        busPax: pick('busPax'),
        cargoCounts: pick('cargoCounts'),
      };
    }
  } catch {
    // 既定値を使う
  }
  return { ...d };
}

/** 表示レイヤ設定の保存（表示だけの設定で、プロジェクトには保存しない） */
export function saveOverlays(overlays: Overlays): void {
  try {
    globalThis.localStorage?.setItem(OVERLAYS_KEY, JSON.stringify(overlays));
  } catch {
    // 保存できなくても設定は今の画面では有効
  }
}

export interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

/** ワークスペースのレンズ（UIデザイン更新 第1段階。ATC は App 側の appMode で表す） */
export type Lens = 'build' | 'manage' | 'operate';

/** 建設レンズの左パネルに表示するタブ（UIデザイン更新 第2段階。UI 状態のみ） */
export type BuildPanel = 'tools' | 'facilities' | 'inbox';

export interface EditorState {
  history: History<AirportLayout>;
  selection: string | null;
  /** 直近のクリックで重なっていた選択候補（優先順。2 つ以上のときだけプロパティに選択欄を出す） */
  pickCandidates: string[];
  tool: ToolId;
  options: ToolOptions;
  camera: Camera;
  viewSize: { w: number; h: number };
  hover: Tile | null;
  /** カーソルの World 座標（丸めない）。自由形の操作中だけ精密で、それ以外は hover のタイル中心 */
  hoverW: WorldPoint | null;
  draft: Draft;
  overlays: Overlays;
  /**
   * ターミナル内部の表示・編集中の階（絶対階層。mapLevel が数値のときは常に同じ値に同期する）。
   * 建物内階そのものではなく、エリア・内包施設の判定は実効階層（親の地図階層＋建物内階）で行う。
   */
  interiorLevel: number;
  /** 2D/3D の交通レイヤ表示。地上=0、地下<0、高架>0。数値を選ぶと interiorLevel も同じ値になる。 */
  mapLevel: number | 'all';
  toast: Toast | null;
  /** build: 建設（編集）モード / operate: 運航モード（レイアウトの編集は不可） */
  mode: 'build' | 'operate';
  /** 投資効果プレビューの基準レイアウト（建設モードに入った時点の敷地。5-04 / B4） */
  buildBaseline: AirportLayout | null;
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
  /**
   * UIデザイン更新 第1段階: ワークスペースのレンズ（建設/経営/運航）。
   * 画面の置き場所を示す UI 状態で、保存データには入れない。
   * ATC は専用ストア・画面で完結する設計（air_traffic_control_mode_plan.md §3.1）のため、
   * ここには含めず、App 側の appMode と併せて「レンズ」として扱う。
   */
  lens: Lens;
  /** 建設レンズの左パネルのタブ（ツールボックス／施設一覧／要対応インボックス。UI 状態のみ） */
  buildPanel: BuildPanel;
  /**
   * ターミナル専用設計 Workspace（5-18）を開いている対象ターミナル（UI 状態のみ。
   * レイアウト・保存データには入れない。開閉で history / charges / tool には触らない）
   */
  terminalWorkspace: { terminalId: string } | null;
  /**
   * 外形（フットプリント）編集中の作業コピー（5-15 T3。UI 状態のみで、確定するまで
   * レイアウト・保存データには入れない。確定は setFacilityFootprint を applyOp で通す）
   */
  footprintEdit: { facilityId: string; points: Tile[] } | null;
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
  /**
   * 店舗・旅客サービス施設のシミュレーション粒度（5-19 T12）。
   * 運航開始時に createSimulation へ渡す実行時オプションで、プロジェクトには保存しない
   * （localStorage にだけ保存する）。'aggregate' = カテゴリ×ターミナルの集約方式（1B で既定化）/
   * 'detailed' = 店舗ごと（従来方式）。
   */
  serviceGranularity: ServiceGranularity;
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
  /** 地図なしモード（運航画面で地図を描画せず運行表を主表示にする。表示だけの設定で、プロジェクトには保存しない） */
  noMap: boolean;
  /**
   * 無描画運行モード（性能改善計画 第5弾。地図・運行表・カードを描画せず、状態表示は約1秒間隔に間引く。
   * 表示だけの設定で、プロジェクトには保存しない。ON の間は noMap より優先される）
   */
  noRender: boolean;
  /** 機種の表示モード（2026-CODE）: 'full' = 全文（型式名）、'code' = 略号のみ（788（内）など）。表示だけの設定で、プロジェクトには保存しない */
  typeLabelMode: 'full' | 'code';
}

export const initialDayFlow = (): DayFlow => ({ phase: 'none', review: null, viewing: null, atClose: false, skip: null, historyOpen: false });

const PREFS_KEY = 'skyport.opsPrefs.v1';
function loadPrefs(): OpsPrefs {
  const d: OpsPrefs = { pauseAtDayClose: true, skipAutoStop: true, noMap: false, noRender: false, typeLabelMode: 'full' };
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OpsPrefs>;
      return { pauseAtDayClose: typeof p.pauseAtDayClose === 'boolean' ? p.pauseAtDayClose : d.pauseAtDayClose, skipAutoStop: typeof p.skipAutoStop === 'boolean' ? p.skipAutoStop : d.skipAutoStop, noMap: typeof p.noMap === 'boolean' ? p.noMap : d.noMap, noRender: typeof p.noRender === 'boolean' ? p.noRender : d.noRender, typeLabelMode: p.typeLabelMode === 'code' ? 'code' : 'full' };
    }
  } catch {
    // 既定値を使う
  }
  return d;
}

const GRANULARITY_KEY = 'skyport.serviceGranularity.v1';
function loadServiceGranularity(): ServiceGranularity {
  try {
    // 1B: 未設定時の既定は集約方式（createSimulation の既定と同じ）。'detailed' の保存値だけが従来方式になる
    return globalThis.localStorage?.getItem(GRANULARITY_KEY) === 'detailed' ? 'detailed' : 'aggregate';
  } catch {
    return 'aggregate';
  }
}

/** 店舗シミュレーション粒度を変えて保存する（次回の運航開始から適用。プロジェクトには保存しない） */
export function setServiceGranularity(value: ServiceGranularity): void {
  editorStore.setState({ serviceGranularity: value });
  try {
    globalThis.localStorage?.setItem(GRANULARITY_KEY, value);
  } catch {
    // 保存できなくても設定は今の画面では有効
  }
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
  pickCandidates: [],
  tool: 'select',
  options: {
    rotation: 0,
    standSize: 'M',
    taxiWidth: 'M',
    oneWay: false,
    roadClass: 'public',
    roadLevel: 0,
    roadCapacityPerHour: 0,
    interiorParentId: null,
    interiorFloorIndex: 0,
    terminalFloorMin: 0,
    terminalFloorMax: 1,
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
    pbbType: 'tunnel1',
    pbbDeck: 'main',
  },
  camera: { x: 10, y: 20, zoom: 9 },
  viewSize: { w: 800, h: 600 },
  hover: null,
  hoverW: null,
  draft: null,
  overlays: loadOverlays(),
  interiorLevel: 0,
  mapLevel: 0,
  toast: null,
  mode: 'build',
  buildBaseline: null,
  ops: null,
  company: loadInitialCompany(),
  charges: { past: [], future: [] },
  scenarios: [],
  scenarioRun: null,
  viewMode: '2d',
  lens: 'build',
  buildPanel: 'tools',
  terminalWorkspace: null,
  footprintEdit: null,
  dayFlow: initialDayFlow(),
  opsPrefs: loadPrefs(),
  serviceGranularity: loadServiceGranularity(),
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
  const layout = useLayout();
  const company = useEditor((s) => s.company);
  const base = getAnalysis(layout);
  // フェーズ 4: 滞泊の記録と国際の解放状態は会社側の状態なので、レイアウト解析へここで重ねる
  const extra = [...overnightStandIssues(layout, company), ...intlLockedIssues(layout, company)];
  if (extra.length === 0) return base;
  return { ...base, issues: [...base.issues, ...extra] };
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

export function entityExists(layout: AirportLayout, id: string): boolean {
  return !!(
    layout.runways[id] ||
    layout.taxiNodes[id] ||
    layout.taxiways[id] ||
    layout.roadNodes[id] ||
    layout.roads[id] ||
    layout.stands[id] ||
    layout.facilities[id] ||
    layout.terminalAreas[id] ||
    // 複合連絡施設（J-2）も選択対象として扱う（一体選択・ハイライトのため）
    layout.connectionFacilities?.[id]
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
 * 全コンタクトゲートに搭乗橋（PBB）を一括で付ける（合成の橋の実データ化）。
 * 通常の applyOp は使わない: withProjects → prepareCareerEdit が新規 PBB を
 * 全て「建設中」に変えてしまうため。applyFinishedProjects / closeTemporarily
 * と同じく、履歴1件として直接コミットする。
 *
 * 建設費は中立（0）で精算する。constructionCost(before, after) は 0 には
 * ならない: ゲート側の jetBridge 上乗せ 150,000cr が外れる分は「減った分」
 * として払い戻し率 25% でしか戻らず、PBB 側の 150,000cr は全額かかるため、
 * 1ゲートあたり 112,500cr × 規模係数が請求されてしまう。だが橋はゲート建設
 * 時に上乗せとして既に支払い済みで、資産額の合計は変わらない（付け替えで
 * あって新設ではない）ため、ここでは明示的に 0 で精算する。
 */
export function bulkAttachBoardingBridges(): void {
  const s = get();
  if (s.mode === 'operate') {
    showToast('運航中はレイアウトを編集できません（建設モードに戻ってください）', 'error');
    return;
  }
  const before = s.history.present;
  const result = bulkPlaceBoardingBridges(before);
  const attached = result.attachedGateIds.length;
  const skipped = result.skipped.length;
  if (attached === 0) {
    showToast(`付ける搭乗橋がありませんでした（スキップ ${skipped}件）`, 'info');
    return;
  }
  // 付け替えであって新設ではないため、建設費は 0 で精算する（上記コメント参照）
  const charged = charge(before, result.layout, 0);
  if (charged === false) return;
  commitCharged(result.layout, charged.cost, charged.company);
  showToast(`搭乗橋を ${attached}件付けました（スキップ ${skipped}件）`);
}

/**
 * 新しいゲーム: キャリア = 小さな飛行場と初期資金・初期契約 / サンドボックス = サンプル空港と潤沢な資金。
 * game を省くと新しいルール（天候 5 段階・評価・目標。難易度は標準）、null を渡すと従来のルール。
 * 初期資金は難易度の倍率を掛ける（標準は ×1 で従来と同じ）。
 */
export function newGame(mode: CompanyState['mode'], game: GameSettings | null = defaultGame(), city?: CityConfig | null, sizeId?: string): void {
  if (get().mode === 'operate') return;
  const layout = mode === 'career' ? createStarterAirfield(undefined, sizeId) : createSampleAirport(undefined, sizeId);
  const company = mode === 'career' ? createCareerCompany() : createSandboxCompany();
  startGame(company, game);
  if (city) company.city = structuredClone(city);
  set({ history: createHistory(layout), buildBaseline: layout, company, charges: { past: [], future: [] }, selection: null, draft: null, tool: 'select', scenarios: [], projectId: null, projectName: '無題のプロジェクト', catalogPin: null, journal: createJournal(), dayFlow: initialDayFlow() });
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

/** フェーズ 4 の機能の有効化を付け外しする（建設モード。解放の判定は unlocks.ts） */
export function setCompanyFeatures(features: { overnight?: true; based?: true; international?: true; hub?: true; cargo?: true } | null): void {
  const s = get();
  if (s.mode === 'operate') return;
  const company = structuredClone(s.company);
  if (features && Object.keys(features).length > 0) company.features = features;
  else delete company.features;
  set({ company });
  showToast(features ? '新しい運航の仕組みの設定を更新しました' : '新しい運航の仕組みをすべて停止しました');
}

/** 路線需要モデル（フェーズ 3 の market）を付け外しする（建設モード。city が必要） */
export function setCompanyMarket(enabled: boolean): void {
  const s = get();
  if (s.mode === 'operate') return;
  const company = structuredClone(s.company);
  if (enabled && company.city) company.market = { version: 1, routes: {} };
  else delete company.market;
  set({ company });
  showToast(enabled && company.city ? '路線需要モデルを有効にしました' : '路線需要モデルを停止しました');
}

export function addCityEvent(event: Omit<CityEvent, 'id' | 'wagered'>): void {
  const s = get();
  if (s.mode === 'operate' || !s.company.city) return;
  // 5-07: イベントは協力費を払う判断にする。資金が足りなければ予定できない
  const cost = cityEventCost(event);
  if (s.company.cash < cost) {
    showToast(`資金が不足しています（協力費 ${formatCr(cost)}）`);
    return;
  }
  const company = structuredClone(s.company);
  const events = company.city!.events ?? [];
  let n = 1;
  while (events.some((existing) => existing.id === `city-event-${n}`)) n++;
  events.push({ ...event, id: `city-event-${n}`, wagered: true });
  company.city!.events = events.sort((a, b) => a.day - b.day || a.id.localeCompare(b.id));
  company.cash -= cost;
  set({ company });
  showToast(`都市イベントを予定に追加しました（協力費 ${formatCr(cost)}）`);
}

export function removeCityEvent(eventId: string): void {
  const s = get();
  if (s.mode === 'operate' || !s.company.city?.events) return;
  const company = structuredClone(s.company);
  const target = company.city!.events!.find((event) => event.id === eventId);
  company.city!.events = company.city!.events!.filter((event) => event.id !== eventId);
  // 開催前なら協力費を全額戻す。始まってからは戻らない
  if (target?.wagered && target.day > company.day) company.cash += cityEventCost(target);
  set({ company });
  showToast('都市イベントを予定から削除しました');
}

/**
 * 防音工事助成の実施（機能E、建設モードのみ）。費用を払ってレベルを 1 つ上げ、
 * 住民満足度を即時回復させる。イベント協力費と同じく現金から直接差し引く（台帳には載せない）。
 */
export function purchaseSoundproofing(): void {
  const s = get();
  if (s.mode === 'operate' || !s.company.city) return;
  const cost = nextSoundproofCost(s.company.city);
  if (cost === null) {
    showToast('防音工事はすでに最大レベルです');
    return;
  }
  if (s.company.cash < cost) {
    showToast(`資金が不足しています（防音工事 ${formatCr(cost)}）`);
    return;
  }
  const company = structuredClone(s.company);
  const applied = applySoundproofPurchase(company.city!);
  if (!applied) return;
  company.cash -= cost;
  set({ company });
  showToast(`防音工事助成を実施しました（Lv${applied.level}、住民満足度 +${applied.recovery}）`);
}

/** 現在の防音工事レベル（UI 表示用） */
export function soundproofLevel(company: CompanyState): number {
  return company.city ? soundproofLevelOf(company.city) : 0;
}

/**
 * 騒音対策費の拠出（機能E拡張2、建設モードのみ・1 日 1 回まで）。費用を払って
 * 住民満足度を即時回復させる。防音工事と同じく現金から直接差し引く（台帳には載せない）。
 */
export function contributeNoiseFund(): void {
  const s = get();
  if (s.mode === 'operate' || !s.company.city) return;
  const cost = BALANCE.noise.contribution.cost;
  if (!canMakeNoiseContribution(s.company.city, s.company.day)) {
    showToast('騒音対策費は 1 日 1 回までです');
    return;
  }
  if (s.company.cash < cost) {
    showToast(`資金が不足しています（騒音対策費 ${formatCr(cost)}）`);
    return;
  }
  const company = structuredClone(s.company);
  if (!applyNoiseContribution(company.city!, company.day)) return;
  company.cash -= cost;
  set({ company });
  showToast(`騒音対策費を拠出しました（住民満足度 +${BALANCE.noise.contribution.recovery}）`);
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
  select(id: string | null, candidates: string[] = []): void {
    set({ selection: id, pickCandidates: candidates });
  },
  setTool(tool: ToolId): void {
    set((s) => ({
      tool,
      draft: null,
      ...(tool !== 'select' ? { selection: null } : {}),
      // 外形編集中に別ツールへ移ったら編集は取り消す（作業コピーは保存しない）
      ...(tool !== 'select' ? { footprintEdit: null } : {}),
      // 内部エリアのツールでは内部表示を自動で有効にする
      ...(tool.startsWith('area:') ? { overlays: { ...s.overlays, interior: true } } : {}),
    }));
  },
  /** 外形（フットプリント）編集を開始する。初期頂点は現在の外形（footprint があればそれ、なければ矩形リング） */
  startFootprintEdit(facilityId: string): void {
    const s = get();
    const f = s.history.present.facilities[facilityId];
    if (!f || s.mode === 'operate') return;
    set({ footprintEdit: { facilityId, points: facilityOutline(f).map((p) => ({ ...p })) }, selection: facilityId, tool: 'select', draft: null });
  },
  /** 外形編集中の頂点列を差し替える（UI 状態のみ） */
  setFootprintPoints(points: Tile[]): void {
    const s = get();
    if (!s.footprintEdit) return;
    set({ footprintEdit: { ...s.footprintEdit, points } });
  },
  /** 外形編集を終える（確定・取り消しのどちらでも作業コピーを破棄する） */
  endFootprintEdit(): void {
    const s = get();
    set({ footprintEdit: null, draft: s.draft?.kind === 'fpVertex' ? null : s.draft });
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
    // 表示階は建物の内と外で 1 つに統一する: 内部の階を変えたら地図の階層（と配置先の階）も同じ値にする
    set((s) => ({ interiorLevel: level, mapLevel: level, options: { ...s.options, roadLevel: level }, overlays: { ...s.overlays, interior: true } }));
  },
  setMapLevel(level: number | 'all'): void {
    // 「全レイヤ」は表示だけの切り替えで、配置先の階は最後に選んだ階のままにする（5-09 / W-11 で確定）
    // 数値を選んだときは内部の表示階も同じ値に同期し、建物の内外で表示階が食い違わないようにする
    set((s) => (level === 'all' ? { mapLevel: level } : { mapLevel: level, interiorLevel: level, options: { ...s.options, roadLevel: level } }));
  },
  setViewMode(viewMode: '2d' | '3d'): void {
    set({ viewMode });
  },
  /** レンズの切り替え（UI 状態のみ。レイアウト・会社・保存データには触らない） */
  setLens(lens: Lens): void {
    if (get().lens === lens) return;
    set({ lens });
  },
  /** 建設レンズの左パネルのタブ切り替え（UI 状態のみ。保存データには触らない） */
  setBuildPanel(buildPanel: BuildPanel): void {
    if (get().buildPanel === buildPanel) return;
    set({ buildPanel });
  },
  /**
   * ターミナル専用設計 Workspace を開く（5-18 T2。UI 状態のみ）。
   * 対象をセットし、選択をそのターミナルに移し、内部表示を有効にして、表示階を
   * そのターミナルの有効な階（既存エリアのある最小の建物内階、無ければ 1F = 0 を
   * B3〜階数-1 でクランプ）へ合わせ、カメラをターミナル中心へ寄せる。
   * history / charges / tool / draft には触らない。運航中は開かない。
   */
  openTerminalWorkspace(terminalId: string): void {
    const s = get();
    if (s.mode === 'operate') return;
    const layout = s.history.present;
    const f = layout.facilities[terminalId];
    if (!f || f.kind !== 'terminal') return;
    const levels = Math.max(1, Number(f.props.levels ?? 1));
    const areaFloors = Object.values(layout.terminalAreas)
      .filter((a) => a.terminalId === terminalId)
      .map((a) => a.level);
    const floorRange = terminalFloorRange(layout, terminalId);
    const floor = Math.min(
      Math.max(areaFloors.length > 0 ? Math.min(...areaFloors) : 0, floorRange.min),
      Math.min(levels - 1, floorRange.max),
    );
    const displayLevel = facilityLevel(f) + floor;
    const tiles = facilityTiles(f);
    const center = tiles.length > 0
      ? {
          x: Math.round(tiles.reduce((sum, t) => sum + t.x, 0) / tiles.length),
          y: Math.round(tiles.reduce((sum, t) => sum + t.y, 0) / tiles.length),
        }
      : { x: f.origin.x, y: f.origin.y };
    set((st) => ({
      terminalWorkspace: { terminalId },
      selection: terminalId,
      interiorLevel: displayLevel,
      mapLevel: displayLevel,
      options: { ...st.options, roadLevel: displayLevel },
      overlays: { ...st.overlays, interior: true },
      camera: centerOn(st.camera, center, st.viewSize.w, st.viewSize.h),
    }));
  },
  /** ターミナル専用設計 Workspace を閉じる。対象を外すだけで、他の状態は一切触らない */
  closeTerminalWorkspace(): void {
    if (!get().terminalWorkspace) return;
    set({ terminalWorkspace: null });
  },
  toggleOverlay(key: keyof Overlays): void {
    const next = { ...get().overlays, [key]: !get().overlays[key] };
    set({ overlays: next });
    saveOverlays(next);
  },
  focus(p: Vec2, select?: string): void {
    const s = get();
    set({ camera: centerOn(s.camera, p, s.viewSize.w, s.viewSize.h), ...(select ? { selection: select } : {}) });
  },
  newEmpty(sizeId?: string): void {
    const current = get().history.present.site;
    const size = sizeId ? siteSizeById(sizeId) : undefined;
    const site = size && (size.width !== current.width || size.height !== current.height)
      ? createSite({ width: size.width, height: size.height, seed: current.seed })
      : current;
    replaceLayout(createEmptyLayout(site), '空の敷地を作成しました（元に戻す で復元できます）');
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
