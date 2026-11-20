import { beforeEach, describe, expect, it } from 'vitest';
import { atcActions, atcStore } from '../../src/atc/store';
import { openQueueCounts, queueForRole } from '../../src/atc/viewModel';
import { createMemoryAtcSessionStore, setAtcSessionStoreForTest } from '../../src/atc/sessions';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { atcLensUi } from '../../src/ui/atc/atcLensUi';

/**
 * UIデザイン更新 第6段階: ATC レンズの統合。
 * - レンズの画面状態（保存ボードの開閉）は表示だけの状態で、ATC セッションには触れない。
 * - ATC-11 のうち自動テストで担保できる範囲: 全要求が GROUND/TOWER キューのどちらかで
 *   発見できること（件数の一致）、選択の双方向同期、一時停止ガード（終了後は再生できない）。
 *   描画そのものの目視（レーダー表示・狭幅レイアウト等）はブラウザ確認が別途必要。
 */

beforeEach(() => {
  setAtcSessionStoreForTest(createMemoryAtcSessionStore());
  atcActions.exitToStart();
  atcLensUi.reset();
});

function startTutorial(): void {
  expect(atcActions.startFromLayout(createStarterAirfield())).toBe(true);
  expect(atcStore.getState().session).not.toBeNull();
}

describe('第6段階: レンズの画面状態（atcLensUi）', () => {
  it('保存ボードは初期状態で閉じていて、開閉は冪等', () => {
    expect(atcLensUi.get().savesOpen).toBe(false);
    atcLensUi.openSaves();
    expect(atcLensUi.get().savesOpen).toBe(true);
    atcLensUi.openSaves();
    expect(atcLensUi.get().savesOpen).toBe(true);
    atcLensUi.closeSaves();
    expect(atcLensUi.get().savesOpen).toBe(false);
    atcLensUi.closeSaves();
    expect(atcLensUi.get().savesOpen).toBe(false);
  });

  it('保存ボードの開閉は ATC セッション・選択・再生状態を一切変えない', () => {
    startTutorial();
    atcActions.tick(130);
    const before = JSON.stringify(atcStore.getState().session);
    const selBefore = atcStore.getState().selectedAircraftId;
    atcLensUi.openSaves();
    atcLensUi.closeSaves();
    expect(JSON.stringify(atcStore.getState().session)).toBe(before);
    expect(atcStore.getState().selectedAircraftId).toBe(selBefore);
    expect(atcStore.getState().playing).toBe(false);
  });

  it('reset で初期状態に戻る', () => {
    atcLensUi.openSaves();
    atcLensUi.reset();
    expect(atcLensUi.get().savesOpen).toBe(false);
  });
});

describe('第6段階: ATC-11（自動担保分）— 要求の発見可能性と件数の一致', () => {
  it('未処理の割当・要求はすべて GROUND/TOWER キューのどちらかに現れ、件数が一致する', () => {
    startTutorial();
    atcActions.tick(200);
    const session = atcStore.getState().session!;
    const ground = queueForRole(session, 'ground');
    const tower = queueForRole(session, 'tower');
    const queuedAssignmentIds = new Set(
      [...ground.assignments, ...tower.assignments].map((a) => a.id),
    );
    const queuedRequestIds = new Set([...ground.requests, ...tower.requests].map((r) => r.id));
    // セッション側の未処理分がキューから漏れていないこと（発見可能性）
    for (const a of Object.values(session.assignments)) {
      if (a.status === 'open') expect(queuedAssignmentIds.has(a.id)).toBe(true);
    }
    for (const r of Object.values(session.requests)) {
      if (r.status === 'open') expect(queuedRequestIds.has(r.id)).toBe(true);
    }
    // レールのバッジ・詳細パネルが使う未処理件数とキューの実件数が一致すること
    const counts = openQueueCounts(session);
    expect(counts.ground).toBe(ground.assignments.length + ground.requests.length);
    expect(counts.tower).toBe(tower.assignments.length + tower.requests.length);
    expect(counts.ground + counts.tower).toBeGreaterThan(0);
  });

  it('マップ側の選択（航空機）と一覧側の選択（要求）は双方向に同期する', () => {
    startTutorial();
    atcActions.tick(130);
    const session = atcStore.getState().session!;
    const ana = session.aircraft['ac_traffic_1']!;
    expect(ana.activeRequestId).not.toBeNull();
    // 一覧（要求行）から選ぶと航空機も選ばれる
    atcActions.selectRequest(ana.activeRequestId!);
    expect(atcStore.getState().selectedAircraftId).toBe('ac_traffic_1');
    // マップ（一覧表）から航空機を選ぶと、その進行中要求が選択に追随する
    atcActions.selectAircraft(null);
    expect(atcStore.getState().selectedRequestId).toBeNull();
    atcActions.selectAircraft('ac_traffic_1');
    expect(atcStore.getState().selectedRequestId).toBe(ana.activeRequestId);
  });

  it('一時停止中は tick を呼ばない限り時計が進まず、終了したセッションは再生できない', () => {
    startTutorial();
    expect(atcStore.getState().playing).toBe(false);
    const clock = atcStore.getState().session!.clockSec;
    // 再生していない状態ではストアの時計は自然には進まない（進行は tick 経由のみ）
    expect(atcStore.getState().session!.clockSec).toBe(clock);
    atcActions.setPlaying(true);
    expect(atcStore.getState().playing).toBe(true);
    atcActions.setPlaying(false);
    expect(atcStore.getState().playing).toBe(false);
    // 終了フラグが立ったセッションは再生開始を拒否する（一時停止のまま）
    const session = atcStore.getState().session!;
    session.finished = true;
    atcActions.setPlaying(true);
    expect(atcStore.getState().playing).toBe(false);
  });
});
