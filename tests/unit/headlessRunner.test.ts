import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHistory } from '../../src/core/editor/history';
import { createSandboxCompany } from '../../src/core/economy/company';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { MemoryHistoryStore, setHistoryStoreForTest } from '../../src/editor/dayHistoryStore';
import { ops } from '../../src/editor/simRunner';
import { editorStore, initialDayFlow, setOpsPrefs } from '../../src/editor/store';

/**
 * 無描画運行モード（性能改善計画 第5弾）のランナー検証。
 * requestAnimationFrame を捕まえて合成タイムスタンプでフレームを駆動し、
 * - store への公開（ops の差し替え）回数が約1秒間隔まで間引かれること
 * - 公開を間引いても sim の進行（状態・会社の JSON）が通常モードと完全一致すること
 *   （advanceClock の端数を pendingClock に保持する設計の検証を含む）
 * - 運航中の速度変更・一時停止/再開（clock を外から書き換える操作）を挟んでも一致すること
 * を確認する。
 */
const hist = new MemoryHistoryStore();
const get = editorStore.getState;

let rafCb: FrameRequestCallback | null = null;

function setup(): void {
  editorStore.setState({
    history: createHistory(createSampleAirport()),
    company: createSandboxCompany('hl'),
    mode: 'build',
    ops: null,
    projectId: null,
    projectName: 'テスト',
    dayFlow: initialDayFlow(),
  });
}

/** フレームを n 回駆動する。actions には「そのフレームの直前に行う操作」をフレーム番号で渡す */
function drive(frames: number, actions?: Map<number, () => void>): { publishes: number } {
  let publishes = 0;
  let prev = get().ops;
  const unsub = editorStore.subscribe((s) => {
    if (s.ops !== prev) {
      prev = s.ops;
      publishes++;
    }
  });
  try {
    for (let i = 0; i < frames; i++) {
      actions?.get(i)?.();
      const cb = rafCb;
      rafCb = null;
      if (!cb) throw new Error(`frame ${i}: rAF が登録されていない`);
      cb(i * 16.7);
    }
  } finally {
    unsub();
  }
  return { publishes };
}

function runScenario(noRender: boolean, frames: number, actions?: Map<number, () => void>): { publishes: number; json: string; now: number } {
  setup();
  setOpsPrefs({ noRender, noMap: false, pauseAtDayClose: true });
  ops.start();
  const { publishes } = drive(frames, actions);
  const o = get().ops!;
  const json = JSON.stringify({ s: o.sim.state, c: o.sim.company });
  const now = o.sim.state.now;
  ops.stop();
  return { publishes, json, now };
}

beforeEach(() => {
  rafCb = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCb = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  setHistoryStoreForTest(hist);
});

afterEach(() => {
  if (get().ops) ops.stop();
  setOpsPrefs({ noRender: false });
  vi.unstubAllGlobals();
});

describe('無描画運行モードのランナー', () => {
  it('公開が約1秒間隔に間引かれ、sim の進行は通常モードと完全一致する', { timeout: 300_000 }, () => {
    const frames = 1800; // 約30秒分（16.7ms × 1800）。速度60で約1,800 tick
    const off = runScenario(false, frames);
    const on = runScenario(true, frames);
    console.log(`[headless-runner] frames=${frames} publishes off=${off.publishes} on=${on.publishes}`);
    expect(on.now).toBe(off.now);
    expect(on.now).toBeGreaterThan(1000); // 実際に運航が進んでいること
    expect(on.json).toBe(off.json);
    // 通常モードは毎フレーム公開、無描画は約1秒（=約60フレーム）に1回
    expect(off.publishes).toBeGreaterThan(frames * 0.9);
    expect(on.publishes).toBeGreaterThan(10);
    expect(on.publishes).toBeLessThan(frames / 30);
  });

  it('速度変更と一時停止/再開を挟んでも進行が一致する', { timeout: 300_000 }, () => {
    const actions = new Map<number, () => void>([
      [600, () => ops.togglePause()],
      [900, () => ops.togglePause()],
      [1200, () => ops.setSpeed(240)],
    ]);
    const off = runScenario(false, 1800, actions);
    const on = runScenario(true, 1800, actions);
    expect(on.now).toBe(off.now);
    expect(on.json).toBe(off.json);
  });
});
