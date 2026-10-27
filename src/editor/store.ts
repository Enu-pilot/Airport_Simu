import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Camera } from '../core/geometry/camera';
import { centerOn } from '../core/geometry/camera';
import type { Tile, Vec2 } from '../core/geometry/vec';
import { commit, createHistory, redo, undo, type History } from '../core/editor/history';
import type { OpResult } from '../core/layout/operations';
import { createEmptyLayout } from '../core/layout/operations';
import type { AirportLayout, BuildState, FacilityKind, RoadClass, Rotation, SizeClass } from '../core/model/types';
import { createSampleAirport } from '../core/sample/sampleAirport';
import { analyzeLayout, type LayoutAnalysis } from '../core/validation/validate';
import { exportLayout, importLayout } from '../core/io/serialize';
import { OP_FAILURE_LABEL } from '../i18n/ja';
import type { Simulation } from '../core/sim/simulation';
import type { SimClock } from '../core/sim/clock';

export type ToolId = 'select' | 'runway' | 'taxiway' | 'road' | 'stand' | `facility:${FacilityKind}`;

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
  buildable: boolean;
  network: boolean;
  issues: boolean;
  labels: boolean;
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
  toast: Toast | null;
  /** build: 建設（編集）モード / operate: 運航モード（レイアウトの編集は不可） */
  mode: 'build' | 'operate';
  ops: OpsState | null;
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

const STORAGE_KEY = 'skyport.layout.v1';

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
  overlays: { grid: true, buildable: false, network: false, issues: true, labels: true },
  toast: null,
  mode: 'build',
  ops: null,
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
  const selection =
    opts.select && result.created.length > 0
      ? result.created[0]!
      : s.selection && entityExists(result.layout, s.selection)
        ? s.selection
        : null;
  set({ history: commit(s.history, result.layout), selection });
  return true;
}

function entityExists(layout: AirportLayout, id: string): boolean {
  return !!(
    layout.runways[id] ||
    layout.taxiNodes[id] ||
    layout.taxiways[id] ||
    layout.roadNodes[id] ||
    layout.roads[id] ||
    layout.stands[id] ||
    layout.facilities[id]
  );
}

export function replaceLayout(layout: AirportLayout, message: string): void {
  if (get().mode === 'operate') {
    showToast('運航中はレイアウトを変更できません', 'error');
    return;
  }
  set((s) => ({ history: commit(s.history, layout), selection: null, draft: null }));
  showToast(message);
}

export const actions = {
  undo(): void {
    const s = get();
    if (s.mode === 'operate') return;
    if (s.history.past.length === 0) return;
    const history = undo(s.history);
    set({ history, draft: null, selection: s.selection && entityExists(history.present, s.selection) ? s.selection : null });
  },
  redo(): void {
    const s = get();
    if (s.mode === 'operate') return;
    if (s.history.future.length === 0) return;
    const history = redo(s.history);
    set({ history, draft: null, selection: s.selection && entityExists(history.present, s.selection) ? s.selection : null });
  },
  select(id: string | null): void {
    set({ selection: id });
  },
  setTool(tool: ToolId): void {
    set({ tool, draft: null, ...(tool !== 'select' ? { selection: null } : {}) });
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
