import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHistory } from '../../src/core/editor/history';
import { createSandboxCompany } from '../../src/core/economy/company';
import { validateProject } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { TERMINAL_STATES } from '../../src/core/sim/types';
import { DAY_SEC } from '../../src/core/sim/rules';
import { dayMarker, nightEndAt } from '../../src/core/sim/dayloop';
import { MemoryHistoryStore, setHistoryStoreForTest } from '../../src/editor/dayHistoryStore';
import { projectActions } from '../../src/editor/project';
import { ops } from '../../src/editor/simRunner';
import { editorStore, initialDayFlow, setOpsPrefs } from '../../src/editor/store';

/**
 * 1 日のループ（editor 層）: 1 日スキップの結果がライブ（連続実行）と同一、締めの直後に建設へ戻っても二重に締めない、
 * 履歴の保存と復元（メモリの保存先）。requestAnimationFrame は使わないので空に置き換える。
 */
const hist = new MemoryHistoryStore();
const get = editorStore.getState;
const until = async (cond: () => boolean, ms = 120_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  setHistoryStoreForTest(hist);
  editorStore.setState({ history: createHistory(createSampleAirport()), company: createSandboxCompany('df'), mode: 'build', ops: null, projectId: null, projectName: 'テスト', dayFlow: initialDayFlow() });
});
afterEach(() => {
  ops.stop();
  vi.unstubAllGlobals();
});

describe('1 日スキップと締め', () => {
  it('スキップの結果が連続実行と同一で、締めの直後に建設へ戻っても日報は 1 件・日は 1 だけ進む。履歴から戻せる', { timeout: 300_000 }, async () => {
    setOpsPrefs({ skipAutoStop: false });
    ops.skipDay(); // 建設モードからは運航を始めてすぐ進める
    expect(get().mode).toBe('operate');
    expect(get().dayFlow.phase).toBe('skipping');
    await until(() => get().dayFlow.phase === 'review');
    const o = get().ops!;
    expect(o.clock.speed).toBe(0);
    expect(get().dayFlow.atClose).toBe(true);

    // 基準: 同じ入力の連続実行（stepSimulation の繰り返し）
    const base = createSimulation(createSampleAirport(), { company: createSandboxCompany('df') });
    const m = dayMarker(base);
    do stepSimulation(base);
    while (dayMarker(base) === m);
    expect(JSON.stringify({ s: o.sim.state, c: o.sim.company })).toBe(JSON.stringify({ s: base.state, c: base.company }));

    const review = get().dayFlow.review!;
    expect(review.day).toBe(0);
    expect(review.report.totalRevenue).toBe(base.company!.reports[0]!.totalRevenue);

    // 履歴: 締めの直後（2 日目の朝）の復元点が 1 件。運航状態なしで検証に通る
    await new Promise((r) => setTimeout(r, 50));
    const rows = await hist.list('unsaved');
    expect(rows.map((r) => r.day)).toEqual([1]);
    const e = (await hist.get('unsaved', 1))!;
    const v = validateProject(e.projectJson, { fallbackCompany: get().company });
    expect(v.ok).toBe(true);
    expect(v.project!.sim).toBeNull();
    expect(v.project!.company.day).toBe(1);
    expect(v.project!.scenarios).toEqual([]);

    // 次の日へ: 夜間をヘッドレスで早送りして元の倍率で再開する（結果は 1 tick ずつ進めた場合と同一）
    const night = nightEndAt(base);
    ops.nextDay();
    expect(get().dayFlow.phase).toBe('skipping');
    await until(() => get().dayFlow.phase === 'none');
    expect(get().ops!.sim.state.now).toBe(night);
    expect(get().ops!.clock.speed).toBe(60);
    while (base.state.now < night) stepSimulation(base);
    expect(JSON.stringify({ s: get().ops!.sim.state, c: get().ops!.sim.company })).toBe(JSON.stringify({ s: base.state, c: base.company }));
    expect(night).toBeGreaterThan(DAY_SEC);
    expect(Object.values(get().ops!.sim.state.aircraft).every((a) => a.state === 'scheduled' || TERMINAL_STATES.includes(a.state))).toBe(true);

    // 次の締め（2 日目）まで、もう一度スキップして戻る。ここでは 1 日目の締めの直後に戻った場合を調べるため、いったん元の状態を作り直す
    ops.stop();
    expect(get().company.reports.length).toBe(2);
    expect(get().company.reports[1]!.partial).toBe(true);
    editorStore.setState({ company: createSandboxCompany('df'), mode: 'build', ops: null });
    ops.skipDay();
    await until(() => get().dayFlow.phase === 'review');

    // 締めの直後に建設へ戻る: 空の日報を作らない
    ops.stop();
    expect(get().mode).toBe('build');
    expect(get().company.day).toBe(1);
    expect(get().company.reports.length).toBe(1);
    expect(get().company.reports[0]!.partial).toBe(false);
    expect(get().company.reports[0]!.totalRevenue).toBe(review.report.totalRevenue);

    // 途中の締め（従来どおり）: 運航を始めてすぐ止めると部分的な日報が 1 件増える
    ops.start();
    ops.stop();
    expect(get().company.reports.length).toBe(2);
    expect(get().company.reports[1]!.partial).toBe(true);

    // 履歴から 2 日目の朝に戻す（現在のシナリオは保つ）
    editorStore.setState({ scenarios: [] });
    const r = await projectActions.restoreHistory(1);
    expect(r.ok).toBe(true);
    expect(get().company.day).toBe(1);
    expect(get().company.reports.length).toBe(1);
  });

  it('壊れた履歴は読み込まず、開いているプロジェクトを変えない', async () => {
    await hist.put({ projectKey: 'unsaved', day: 77, savedAt: 'x', cash: 0, rating: 0, operatingProfit: 0, review: {} as never, projectJson: '{ broken' }, 77);
    const before = JSON.stringify(get().company) + JSON.stringify(get().history.present);
    const r = await projectActions.restoreHistory(77);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(get().company) + JSON.stringify(get().history.present)).toBe(before);
    expect((await projectActions.restoreHistory(5)).ok).toBe(false);
  });

  it('スキップの中止: その時刻で一時停止の運航になり、振り返りは出ない', { timeout: 60_000 }, async () => {
    ops.start();
    ops.skipDay();
    ops.cancelSkip();
    await until(() => get().dayFlow.phase === 'none');
    expect(get().ops!.clock.speed).toBe(0);
    expect(get().dayFlow.review).toBeNull();
    expect(get().ops!.sim.company!.day).toBe(0);
  });
});
