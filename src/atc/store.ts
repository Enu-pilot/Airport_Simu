import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AirportLayout } from '../core/model/types';
import { createSampleAirport } from '../core/sample/sampleAirport';
import {
  approveCrossing,
  assignRunway,
  assignStand,
  cancelClearance,
  createAtcAirportSnapshot,
  createAtcSession,
  createSessionSafetyProvider,
  createTutorialScenario,
  diagnoseAtcAirport,
  goAroundAircraft,
  holdAircraft,
  issueClearance,
  maybeAutosave,
  moveArrivalInSequence,
  rejectRequest,
  rerouteAircraft,
  resumeAircraft,
  serializeAtcSession,
  tickAtcSession,
  type AtcSafetyProvider,
  type AtcScenarioDefinition,
  type AtcSessionState,
} from '../core/atc/index';
import { autosaveSlotId, getAtcSessionStore, type AtcSessionSummary } from './sessions';

/**
 * ATC-08: ATC専用アプリストア（editor ストアと同じ zustand パターン）。
 *
 * - セッション状態は core/atc のエンジンが正本であり、本ストアは
 *   「進行・選択・再生・保存まわり」のアプリ状態だけを持つ。
 * - エンジンの進行は tick アクション経由でのみ行い、公開関数だけを使う。
 * - セッションオブジェクトはエンジンが直接書き換えるため、再描画は
 *   revision カウンタで駆動する（コンポーネントは revision を購読し、
 *   本体は atcStore.getState() から読む）。
 * - 経営モードの editorStore / EditorState とは状態を共有しない。
 */

export interface AtcNotice {
  ok: boolean;
  text: string;
}

export interface AtcUiState {
  scenario: AtcScenarioDefinition | null;
  session: AtcSessionState | null;
  playing: boolean;
  /** 再生速度（ゲーム秒 / 実秒） */
  speed: number;
  selectedAircraftId: string | null;
  selectedRequestId: string | null;
  /** 最後に（手動/自動で）保存した時点のセッション時計。自動保存判定に使う */
  lastSavedClockSec: number | null;
  lastAutosaveIso: string | null;
  notice: AtcNotice | null;
  summaries: AtcSessionSummary[];
  storageKind: 'indexeddb' | 'memory' | null;
  revision: number;
}

export const ATC_SPEEDS = [1, 2, 4, 10] as const;

const safety: AtcSafetyProvider = createSessionSafetyProvider();

export const atcStore = createStore<AtcUiState>(() => ({
  scenario: null,
  session: null,
  playing: false,
  speed: 1,
  selectedAircraftId: null,
  selectedRequestId: null,
  lastSavedClockSec: null,
  lastAutosaveIso: null,
  notice: null,
  summaries: [],
  storageKind: null,
  revision: 0,
}));

export function useAtc<T>(selector: (s: AtcUiState) => T): T {
  return useStore(atcStore, selector);
}

const get = atcStore.getState;
const set = atcStore.setState;

function bump(patch: Partial<AtcUiState> = {}): void {
  set({ ...patch, revision: get().revision + 1 });
}

function notify(ok: boolean, text: string): void {
  bump({ notice: { ok, text } });
}

function resultNotice(ok: boolean, okText: string, reasons: string[]): void {
  notify(ok, ok ? okText : `実行できません: ${reasons.join(', ') || 'unknown'}`);
}

/** セッション開始の共通処理。診断エラーがある場合は開始せず理由を返す */
function startScenario(scenario: AtcScenarioDefinition): boolean {
  const diagnostics = diagnoseAtcAirport(scenario.airport);
  if (diagnostics.errors.length > 0) {
    notify(false, `開始できません: ${diagnostics.errors.join(', ')}`);
    return false;
  }
  const session = createAtcSession(scenario);
  bump({
    scenario,
    session,
    playing: false,
    selectedAircraftId: null,
    selectedRequestId: null,
    lastSavedClockSec: null,
    lastAutosaveIso: null,
    notice: { ok: true, text: `シナリオ「${scenario.name}」を開始しました` },
  });
  return true;
}

async function persistAutosave(file: ReturnType<typeof serializeAtcSession>): Promise<void> {
  try {
    const store = await getAtcSessionStore();
    const res = await store.importJson(JSON.stringify(file), {
      id: autosaveSlotId(file.scenario.id),
      kind: 'autosave',
    });
    if (res.ok) await atcActions.refreshSummaries();
  } catch {
    // 自動保存の失敗はプレイを止めない（次回 tick で再試行される）
  }
}

export const atcActions = {
  /** 任意の経営レイアウト（スナップショット化して）チュートリアルシナリオを開始する */
  startFromLayout(layout: AirportLayout): boolean {
    const snapshot = createAtcAirportSnapshot(layout, {
      id: `snap_${layout.name}`,
      capturedAtIso: new Date().toISOString(),
    });
    const diagnostics = diagnoseAtcAirport(snapshot);
    if (diagnostics.errors.length > 0) {
      notify(false, `この空港では開始できません: ${diagnostics.errors.join(', ')}`);
      return false;
    }
    return startScenario(createTutorialScenario(snapshot, diagnostics));
  },

  /** サンプル空港でチュートリアルを即開始する */
  startTutorial(): boolean {
    return atcActions.startFromLayout(createSampleAirport());
  },

  /** セッションを破棄して開始画面へ戻る（保存済みデータは消えない） */
  exitToStart(): void {
    bump({
      scenario: null,
      session: null,
      playing: false,
      selectedAircraftId: null,
      selectedRequestId: null,
      lastSavedClockSec: null,
      lastAutosaveIso: null,
      notice: null,
    });
  },

  setPlaying(playing: boolean): void {
    const s = get();
    if (playing && (!s.session || s.session.finished)) return;
    bump({ playing });
  },

  togglePlaying(): void {
    atcActions.setPlaying(!get().playing);
  },

  setSpeed(speed: number): void {
    bump({ speed });
  },

  /** 一時停止中に手動で進める */
  step(dtSec: number): void {
    atcActions.tick(dtSec);
  },

  /**
   * エンジン進行の唯一の入口。tick のたびに自動保存判定（autosave.ts）を行い、
   * 保存すべきときは保存済み時計を先に進めてから非同期で書き込む。
   */
  tick(dtSec: number): void {
    const s = get();
    if (!s.session || !s.scenario || dtSec <= 0) return;
    if (s.session.finished) {
      if (s.playing) bump({ playing: false });
      return;
    }
    tickAtcSession(s.session, s.scenario, dtSec, {
      safety,
      airport: s.scenario.airport,
    });
    let patch: Partial<AtcUiState> = {};
    const auto = maybeAutosave(s.scenario, s.session, s.lastSavedClockSec);
    if (auto) {
      patch = { lastSavedClockSec: auto.savedClockSec, lastAutosaveIso: new Date().toISOString() };
      void persistAutosave(auto.file);
    }
    if (s.session.finished) patch.playing = false;
    // 選択中機が消えることはないが、要求選択は実在チェックをして外す
    if (s.selectedRequestId && !s.session.requests[s.selectedRequestId]) {
      patch.selectedRequestId = null;
    }
    bump(patch);
  },

  selectAircraft(aircraftId: string | null): void {
    const s = get();
    const aircraft = aircraftId ? s.session?.aircraft[aircraftId] : undefined;
    bump({
      selectedAircraftId: aircraftId,
      selectedRequestId: aircraft?.activeRequestId ?? null,
    });
  },

  /** 要求を選ぶと対象機の選択にも同期する（マップ/一覧との双方向同期） */
  selectRequest(requestId: string | null): void {
    const s = get();
    const request = requestId ? s.session?.requests[requestId] : undefined;
    bump({
      selectedRequestId: requestId,
      ...(request ? { selectedAircraftId: request.aircraftId } : {}),
    });
  },

  issue(requestId: string): void {
    const s = get();
    if (!s.session || !s.scenario) return;
    const request = s.session.requests[requestId];
    if (!request) return notify(false, '要求が見つかりません');
    const res = issueClearance(s.session, s.scenario.airport, safety, {
      aircraftId: request.aircraftId,
      requestId,
    });
    bump({ selectedRequestId: requestId, selectedAircraftId: request.aircraftId });
    resultNotice(res.ok, '許可を発行しました（復唱→実行は自動で進みます）', res.reasons);
  },

  reject(requestId: string): void {
    const s = get();
    if (!s.session) return;
    const res = rejectRequest(s.session, requestId);
    resultNotice(res.ok, '要求を却下しました（航空機は待機し、一定時間後に再要求します）', res.reasons);
    bump();
  },

  cancel(clearanceId: string): void {
    const s = get();
    if (!s.session) return;
    const res = cancelClearance(s.session, clearanceId);
    resultNotice(res.ok, '指示を取り消しました', res.reasons);
    bump();
  },

  approveCrossing(requestId: string): void {
    const s = get();
    if (!s.session || !s.scenario) return;
    const res = approveCrossing(s.session, s.scenario.airport, safety, { requestId });
    resultNotice(res.ok, '滑走路横断を承認しました', res.reasons);
    bump();
  },

  assign(assignmentId: string, targetId: string): void {
    const s = get();
    if (!s.session || !s.scenario) return;
    const assignment = s.session.assignments[assignmentId];
    if (!assignment) return notify(false, '割当要求が見つかりません');
    const res =
      assignment.kind === 'standAssignment'
        ? assignStand(s.session, s.scenario.airport, assignmentId, targetId)
        : assignRunway(s.session, s.scenario.airport, assignmentId, targetId);
    resultNotice(res.ok, '割当を確定しました', res.reasons);
    bump();
  },

  hold(aircraftId: string): void {
    const s = get();
    if (!s.session || !s.scenario) return;
    const res = holdAircraft(s.session, s.scenario.airport, aircraftId);
    resultNotice(res.ok, '停止指示を出しました', res.reasons);
    bump();
  },

  resume(aircraftId: string): void {
    const s = get();
    if (!s.session) return;
    const res = resumeAircraft(s.session, aircraftId);
    resultNotice(res.ok, '再開指示を出しました', res.reasons);
    bump();
  },

  reroute(aircraftId: string): void {
    const s = get();
    if (!s.session || !s.scenario) return;
    const res = rerouteAircraft(s.session, s.scenario.airport, aircraftId);
    resultNotice(
      res.ok,
      res.changed ? '経路を再計画しました' : '経路は現在のものが最適でした（変更なし）',
      res.reasons,
    );
    bump();
  },

  goAround(aircraftId: string): void {
    const s = get();
    if (!s.session) return;
    const res = goAroundAircraft(s.session, aircraftId);
    resultNotice(res.ok, '復行を指示しました', res.reasons);
    bump();
  },

  moveSequence(aircraftId: string, offset: number): void {
    const s = get();
    if (!s.session) return;
    const res = moveArrivalInSequence(s.session, aircraftId, offset);
    resultNotice(res.ok, '到着順序を変更しました', res.reasons);
    bump();
  },

  async refreshSummaries(): Promise<void> {
    try {
      const store = await getAtcSessionStore();
      const summaries = await store.list();
      bump({ summaries, storageKind: store.kind });
    } catch {
      // 一覧が取れない場合は現状維持（プレイには影響しない）
    }
  },

  async saveManual(): Promise<void> {
    const s = get();
    if (!s.session || !s.scenario) return;
    const store = await getAtcSessionStore();
    const res = await store.save({ scenario: s.scenario, session: s.session, kind: 'manual' });
    if (res.ok) {
      bump({ lastSavedClockSec: s.session.clockSec });
      notify(true, '保存しました');
      await atcActions.refreshSummaries();
    } else {
      notify(false, `保存できません: ${res.errors.join(', ')}`);
    }
  },

  async loadSaved(id: string): Promise<void> {
    const store = await getAtcSessionStore();
    const res = await store.load(id);
    if (!res.ok) {
      notify(false, `読み込めません: ${res.errors.join(', ')}`);
      return;
    }
    bump({
      scenario: res.file.scenario,
      session: res.file.session,
      playing: false,
      selectedAircraftId: null,
      selectedRequestId: null,
      lastSavedClockSec: res.file.session.clockSec,
      notice: { ok: true, text: `「${res.file.scenario.name}」を読み込みました` },
    });
  },

  async removeSaved(id: string): Promise<void> {
    const store = await getAtcSessionStore();
    await store.remove(id);
    await atcActions.refreshSummaries();
    notify(true, '保存データを削除しました');
  },

  exportJson(): string | null {
    const s = get();
    if (!s.session || !s.scenario) return null;
    return JSON.stringify(serializeAtcSession(s.scenario, s.session), null, 2);
  },

  async importJson(text: string): Promise<void> {
    const store = await getAtcSessionStore();
    const res = await store.importJson(text, { kind: 'manual' });
    if (!res.ok) {
      notify(false, `取り込めません: ${res.errors.join(', ')}`);
      return;
    }
    await atcActions.loadSaved(res.summary.id);
  },
};
