import { describe, expect, it } from 'vitest';
import { compareIds, sortedValues, sortedValuesCached } from '../../src/core/model/ids';
import { frameSimBudgetFor, frameTickLimitFor, FRAME_SIM_BUDGET_MS, FRAME_SIM_SHARE } from '../../src/editor/simRunner';
import { DEFAULT_MAX_TICKS_PER_FRAME } from '../../src/core/sim/clock';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany } from '../../src/core/economy/company';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { deriveAlerts, deriveAlertsShared } from '../../src/ui/operate/alerts';

/**
 * 性能改善 第8弾（docs/implementation/active/performance_improvement_plan.md §3.7）:
 * 結果を変えない軽量化の同値性と、描画フレームの tick 上限の境界。
 * 運航結果そのものの同一性はゴールデン・legacyFingerprint・実セーブ 1 日の状態ハッシュで確認している。
 */

/** 従来の実装（比較の正本） */
const legacySorted = <T extends { id: string }>(rec: Record<string, T>): T[] => Object.values(rec).sort((a, b) => compareIds(a.id, b.id));

describe('sortedValues（比較キーの前計算）', () => {
  it('通常の ID・桁数の違う ID・接頭辞違い・数値部が同じで表記違い・アンダースコアなしでも従来と同じ順', () => {
    const ids = ['ac_10', 'ac_2', 'ac_1', 'bt_3', 'ac_01', 'ac_001', 'zz', 'a', 'ac_x', 'ac_', 'tn_5_t10', 'tn_5', 'tn_5_t2', 'fac_100', 'fac_20'];
    const rec = Object.fromEntries(ids.map((id) => [id, { id }]));
    expect(sortedValues(rec).map((v) => v.id)).toEqual(legacySorted(rec).map((v) => v.id));
  });

  it('乱数の ID 集合 200 通りで従来と一致（seed 固定の線形合同法）', () => {
    let x = 12345;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let t = 0; t < 200; t++) {
      const rec: Record<string, { id: string }> = {};
      const n = Math.floor(rnd() * 40);
      for (let i = 0; i < n; i++) {
        const id = `${['ac', 'pg', 'b'][Math.floor(rnd() * 3)]}_${Math.floor(rnd() * 50)}${rnd() < 0.2 ? 'x' : ''}`;
        rec[id] = { id };
      }
      expect(sortedValues(rec).map((v) => v.id), `trial ${t}`).toEqual(legacySorted(rec).map((v) => v.id));
    }
  });

  it('0 件・1 件', () => {
    expect(sortedValues({})).toEqual([]);
    expect(sortedValues({ a_1: { id: 'a_1' } }).map((v) => v.id)).toEqual(['a_1']);
  });
});

describe('sortedValuesCached（検証付きの使い回し）', () => {
  it('変化がなければ同じ配列、追加・削除・置換・入れ替え（件数同じ）では作り直して従来と一致', () => {
    const rec: Record<string, { id: string }> = { ac_2: { id: 'ac_2' }, ac_1: { id: 'ac_1' } };
    const a = sortedValuesCached(rec);
    expect(sortedValuesCached(rec)).toBe(a);
    rec.ac_3 = { id: 'ac_3' };
    expect(sortedValuesCached(rec).map((v) => v.id)).toEqual(['ac_1', 'ac_2', 'ac_3']);
    delete rec.ac_1;
    expect(sortedValuesCached(rec).map((v) => v.id)).toEqual(['ac_2', 'ac_3']);
    const replaced = { id: 'ac_2' };
    rec.ac_2 = replaced;
    expect(sortedValuesCached(rec)[0]).toBe(replaced);
    // 件数が同じまま別のキーに入れ替わる
    delete rec.ac_3;
    rec.ac_0 = { id: 'ac_0' };
    expect(sortedValuesCached(rec).map((v) => v.id)).toEqual(legacySorted(rec).map((v) => v.id));
  });
});

describe('描画フレームの tick 上限（frameTickLimitFor）', () => {
  it('計測前・軽い tick は従来の上限、重い tick は予算内、極端に重くても 1 以上', () => {
    expect(frameTickLimitFor(0)).toBe(DEFAULT_MAX_TICKS_PER_FRAME);
    expect(frameTickLimitFor(Number.NaN)).toBe(DEFAULT_MAX_TICKS_PER_FRAME);
    expect(frameTickLimitFor(0.1)).toBe(DEFAULT_MAX_TICKS_PER_FRAME);
    expect(frameTickLimitFor(FRAME_SIM_BUDGET_MS / DEFAULT_MAX_TICKS_PER_FRAME)).toBe(DEFAULT_MAX_TICKS_PER_FRAME);
    expect(frameTickLimitFor(3)).toBe(Math.floor(FRAME_SIM_BUDGET_MS / 3));
    expect(frameTickLimitFor(1000)).toBe(1);
  });

  it('予算は描画・画面更新の実測に比例（tick の割合 FRAME_SIM_SHARE）し、最低保証を下回らない', () => {
    expect(frameSimBudgetFor(0)).toBe(FRAME_SIM_BUDGET_MS);
    expect(frameSimBudgetFor(5)).toBe(FRAME_SIM_BUDGET_MS);
    expect(frameSimBudgetFor(100)).toBeCloseTo(100 * (FRAME_SIM_SHARE / (1 - FRAME_SIM_SHARE)));
    // 描画が重い（200ms）なら予算 800ms → 1 tick 3ms でも従来の上限 120 に収まる（従来と同じ進み方）
    expect(frameTickLimitFor(3, frameSimBudgetFor(200))).toBe(DEFAULT_MAX_TICKS_PER_FRAME);
  });
});

describe('deriveAlertsShared（画面間の共有）', () => {
  it('同じ入力では deriveAlerts と同一の内容、版・時刻・閉じたアラートが変われば計算し直す', () => {
    const sim = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    for (let i = 0; i < 4 * 3600; i++) stepSimulation(sim);
    const shared = deriveAlertsShared(sim, sim.company, [], 1);
    expect(shared).toEqual(deriveAlerts(sim, sim.company));
    expect(deriveAlertsShared(sim, sim.company, [], 1)).toBe(shared);
    expect(deriveAlertsShared(sim, sim.company, [], 2)).not.toBe(shared);
    const dismissed = shared.keys.slice(0, 1);
    expect(deriveAlertsShared(sim, sim.company, dismissed, 2)).toEqual(deriveAlerts(sim, sim.company, dismissed));
    stepSimulation(sim);
    expect(deriveAlertsShared(sim, sim.company, [], 2)).toEqual(deriveAlerts(sim, sim.company));
    // 版を省略した呼び出しは共有しない（従来どおり）
    expect(deriveAlertsShared(sim, sim.company)).not.toBe(deriveAlertsShared(sim, sim.company));
  });
});
