import { beforeEach, describe, expect, it } from 'vitest';
import { atcActions, atcStore } from '../../src/atc/store';
import {
  aircraftCurrentWaitSec,
  arrivalSequenceEntries,
  canGoAround,
  formatAtcClock,
  formatDuration,
  queueForRole,
} from '../../src/atc/viewModel';
import { autosaveSlotId, createMemoryAtcSessionStore, setAtcSessionStoreForTest } from '../../src/atc/sessions';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createEmptyLayout } from '../../src/core/layout/operations';

const flush = () => new Promise((r) => setTimeout(r, 20));

function startTutorial(): void {
  expect(atcActions.startFromLayout(createStarterAirfield())).toBe(true);
  expect(atcStore.getState().session).not.toBeNull();
}

beforeEach(() => {
  setAtcSessionStoreForTest(createMemoryAtcSessionStore());
  atcActions.exitToStart();
});

describe('ATC-08 viewModel: 表示整形と導出', () => {
  it('時計と時間の表示が決定的', () => {
    expect(formatAtcClock(0)).toBe('00:00:00');
    expect(formatAtcClock(3661)).toBe('01:01:01');
    expect(formatAtcClock(36000 + 61)).toBe('10:01:01');
    expect(formatDuration(45)).toBe('45秒');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('開始できない空港（滑走路なし）は理由付きで拒否し、セッションを作らない', () => {
    expect(atcActions.startFromLayout(createEmptyLayout())).toBe(false);
    expect(atcStore.getState().session).toBeNull();
    expect(atcStore.getState().notice?.ok).toBe(false);
  });
});

describe('ATC-08 store: 開始・キュー・選択同期', () => {
  it('チュートリアル開始でセッションができ、出現に合わせて GROUND/TOWER キューへ割当が入る', () => {
    startTutorial();
    atcActions.tick(1);
    let session = atcStore.getState().session!;
    expect(session.aircraft['ac_traffic_1']?.callsign).toBe('ANA101');
    // 出発機の離陸滑走路割当は TOWER キュー
    const tower1 = queueForRole(session, 'tower');
    expect(tower1.assignments.map((a) => a.kind)).toContain('takeoffRunway');
    expect(queueForRole(session, 'ground').assignments).toHaveLength(0);

    atcActions.tick(129); // clock 130: 到着機 JAL202 が出現済み
    session = atcStore.getState().session!;
    expect(session.aircraft['ac_traffic_2']?.callsign).toBe('JAL202');
    const ground = queueForRole(session, 'ground');
    expect(ground.assignments.map((a) => a.kind)).toContain('standAssignment');
    const tower = queueForRole(session, 'tower');
    expect(tower.assignments.map((a) => a.kind)).toContain('landingRunway');
    // 到着順序パネルの対象に JAL202 が入り、進入開始前は復行できない
    expect(arrivalSequenceEntries(session).map((a) => a.callsign)).toContain('JAL202');
    expect(canGoAround(session, 'ac_traffic_2')).toBe(false);
    // ANA101 は準備完了後にプッシュバック要求を出し、待機時間が積み上がる
    const ana = session.aircraft['ac_traffic_1']!;
    expect(ana.activeRequestId).not.toBeNull();
    expect(session.requests[ana.activeRequestId!]!.kind).toBe('pushback');
    expect(aircraftCurrentWaitSec(session, ana)).toBeGreaterThan(0);
  });

  it('要求の選択は対象機の選択へ同期し、航空機の選択は進行中要求へ同期する', () => {
    startTutorial();
    atcActions.tick(130);
    const session = atcStore.getState().session!;
    const ana = session.aircraft['ac_traffic_1']!;
    atcActions.selectRequest(ana.activeRequestId!);
    expect(atcStore.getState().selectedAircraftId).toBe('ac_traffic_1');
    expect(atcStore.getState().selectedRequestId).toBe(ana.activeRequestId);

    atcActions.selectAircraft('ac_traffic_2');
    expect(atcStore.getState().selectedAircraftId).toBe('ac_traffic_2');
    // JAL202 は割当未確定で許可要求を持たないため要求選択は外れる
    expect(atcStore.getState().selectedRequestId).toBeNull();
  });
});

describe('ATC-08 store: 指示フローと自動保存', () => {
  it('ストア経由の許可発行で、エンジン側の復唱→実行が自動で進む', () => {
    startTutorial();
    atcActions.tick(70);
    const session = atcStore.getState().session!;
    const ana = session.aircraft['ac_traffic_1']!;
    const requestId = ana.activeRequestId!;
    expect(session.requests[requestId]!.kind).toBe('pushback');
    atcActions.issue(requestId);
    const after = atcStore.getState().session!;
    const clearance = Object.values(after.clearances).find((c) => c.requestId === requestId);
    expect(clearance?.status).toBe('issued');
    expect(atcStore.getState().notice?.ok).toBe(true);
    atcActions.tick(7);
    const later = atcStore.getState().session!;
    expect(later.clearances[clearance!.id]!.status).toBe('executing');
    expect(later.aircraft['ac_traffic_1']!.movement).not.toBeNull();
  });

  it('tick 中の自動保存が間隔ごとに autosave スロットへ1回だけ書かれる', async () => {
    startTutorial();
    atcActions.tick(60);
    expect(atcStore.getState().lastSavedClockSec).toBe(60);
    await flush();
    await atcActions.refreshSummaries();
    const summaries = atcStore.getState().summaries;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.kind).toBe('autosave');
    expect(summaries[0]!.id).toBe(autosaveSlotId('atc-tutorial-1'));

    atcActions.tick(30); // 間隔未満: 追加保存しない
    await flush();
    await atcActions.refreshSummaries();
    expect(atcStore.getState().summaries).toHaveLength(1);
    expect(atcStore.getState().lastSavedClockSec).toBe(60);

    atcActions.tick(30); // 合計120秒: 再び保存（スロットは上書きで1件のまま）
    await flush();
    await atcActions.refreshSummaries();
    expect(atcStore.getState().summaries).toHaveLength(1);
    expect(atcStore.getState().lastSavedClockSec).toBe(120);
  });

  it('手動保存→開始画面へ戻る→再開で同じセッションに戻る', async () => {
    startTutorial();
    atcActions.tick(90);
    const digestClock = atcStore.getState().session!.clockSec;
    await atcActions.saveManual();
    const manual = atcStore.getState().summaries.find((s) => s.kind === 'manual');
    expect(manual).toBeDefined();
    atcActions.exitToStart();
    expect(atcStore.getState().session).toBeNull();
    await atcActions.loadSaved(manual!.id);
    expect(atcStore.getState().session!.clockSec).toBe(digestClock);
    expect(atcStore.getState().scenario!.id).toBe('atc-tutorial-1');
  });
});
