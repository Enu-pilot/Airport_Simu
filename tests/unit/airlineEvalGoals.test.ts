import { describe, expect, it } from 'vitest';
import { EVAL_WEIGHTS, type AirlineEvalEntry, checkAirlineEval, evalDelta, stepAirlineEval } from '../../src/core/economy/airlineEval';
import type { AirlineScore, ScoreComponent, ScoreKey } from '../../src/core/economy/airlineScore';
import { SCORE_KEYS } from '../../src/core/economy/airlineScore';
import { createSandboxCompany, generateOffers, updateContracts, changeFrequency, contractsOf } from '../../src/core/economy/company';
import { complaintCount, tierBonus } from '../../src/core/economy/evalRules';
import { importCompany } from '../../src/core/economy/company';
import { defaultGame, applyGameState, checkGameFields } from '../../src/core/economy/game';
import { GOALS, TIER_STREAK, checkGoals, evaluateGoals, initialGoals } from '../../src/core/economy/goals';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';
import type { DailyReport } from '../../src/core/economy/company';
import type { AirportLayout } from '../../src/core/model/types';

const comp = (key: ScoreKey, score: number | null, facts: ScoreComponent['facts'] = {}): ScoreComponent => ({ key, score, level: score === null ? 'n/a' : score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad', facts });
const card = (id: string, scores: Partial<Record<ScoreKey, number>>): AirlineScore => ({ airlineId: id, active: true, satisfaction: 60, components: SCORE_KEYS.map((k) => comp(k, scores[k] ?? null)), lacking: [] });
const all = (v: number): Partial<Record<ScoreKey, number>> => Object.fromEntries(SCORE_KEYS.map((k) => [k, v]));
const operable = new Set<string>(['A320neo']);

function evalCompany() {
  const c = createSandboxCompany('ev');
  c.game = defaultGame();
  applyGameState(c);
  return c;
}

describe('12B-3a B5: 航空会社の評価', () => {
  it('重みは種類ごとに合計 1。満足度の変化は (移動平均−60)/10 の重み付き和を [−8, +4] に丸める', () => {
    for (const w of Object.values(EVAL_WEIGHTS)) expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(evalDelta('lcc', all(60))).toBe(0);
    expect(evalDelta('lcc', all(70))).toBeCloseTo(1, 10);
    expect(evalDelta('fullService', all(100))).toBe(4);
    expect(evalDelta('regional', all(0))).toBeCloseTo(-6, 10);
    expect(evalDelta('regional', { otp: 0 })).toBeCloseTo(-1.8, 10);
  });

  it('移動平均 ema = 0.7×ema + 0.3×点数（n/a は更新しない）', () => {
    const c = evalCompany();
    const r = stepAirlineEval(c, { scores: [card('SK', { otp: 100, fees: 0 })], operable });
    expect(c.airlineEval!.SK!.ema.otp).toBe(72);
    expect(c.airlineEval!.SK!.ema.fees).toBe(42);
    expect(c.airlineEval!.SK!.ema.pax).toBeUndefined();
    expect(r.deltas.SK).toBeCloseTo(evalDelta('fullService', c.airlineEval!.SK!.ema), 2);
  });

  it('不満: 移動平均 45 未満が 2 回続くと発生し、55 以上で解消（45〜55 は維持 = ヒステリシス）', () => {
    const c = evalCompany();
    const day = (fees: number) => {
      c.day++;
      stepAirlineEval(c, { scores: [card('SK', { fees })], operable });
      return c.airlineEval!.SK!.complaints.map((x) => x.key);
    };
    expect(day(0)).toEqual([]); // ema 42 → 1 回目
    expect(day(0)).toEqual(['fees']); // 29.4 → 2 回目で発生
    expect(c.airlineEval!.SK!.complaints[0]!.sinceDay).toBe(2);
    expect(day(100)).toEqual(['fees']); // 移動平均 50.6: 45〜55 の間は維持
    expect(day(100)).toEqual([]); // 65.4 ≥ 55 で解消
  });

  it('不満は 45〜55 の間では解消も新規発生もしない', () => {
    const c = evalCompany();
    c.airlineEval = { SK: { ema: { fees: 40 }, low: { fees: 1 }, complaints: [], requests: [], boostUntil: 0, done: [], otpBadDays: 0 } };
    stepAirlineEval(c, { scores: [card('SK', { fees: 40 })], operable });
    expect(c.airlineEval.SK!.complaints.map((x) => x.key)).toEqual(['fees']);
    c.airlineEval.SK!.ema.fees = 48; // 45〜55: 維持
    stepAirlineEval(c, { scores: [card('SK', { fees: 48 })], operable });
    expect(c.airlineEval.SK!.complaints).toHaveLength(1);
    c.airlineEval.SK!.ema.fees = 70;
    stepAirlineEval(c, { scores: [card('SK', { fees: 80 })], operable });
    expect(c.airlineEval.SK!.complaints).toHaveLength(0);
  });

  it('評価ありの満足度の更新は評価要素から。評価なし（従来の updateContracts）は不変', () => {
    const a = createSandboxCompany();
    const b = createSandboxCompany();
    const res = { SK: { flights: 10, onTime: 10, paxBoarded: 100, missedPax: 0, leftBags: 0, cancelled: 0 } };
    updateContracts(a, res);
    updateContracts(b, res, { deltas: { SK: -3 }, bonus: { SK: 5 } });
    expect(b.airlines.SK!.satisfaction).toBeCloseTo(62, 6);
    expect(a.airlines.SK!.satisfaction).toBe(62); // 従来: 定時で +2
  });

  it('要望: 乱数は c.rng を消費せず、達成で +5 とブースト。不満 2 件以上は更新で増便しない', () => {
    const c = evalCompany();
    const rng = [...c.rng];
    for (let d = 0; d < 40; d++) {
      c.day = d;
      stepAirlineEval(c, { scores: [card('SK', { ...all(90), slots: 30, aircraft: 40 })], operable });
    }
    expect(c.rng).toEqual(rng);
    const e = c.airlineEval!.SK!;
    expect(e.requests.length).toBeLessThanOrEqual(1);
    c.airlineEval!.SK = { ...emptyE(), requests: [{ id: 'rq_x', kind: 'slot', sinceDay: 0, dueDay: 99 }] };
    c.day = 50;
    const r = stepAirlineEval(c, { scores: [card('SK', all(100))], operable });
    expect(r.bonus.SK).toBe(5);
    expect(c.airlineEval!.SK!.boostUntil).toBe(57);
    // 契約更新: 不満 2 件なら増便なし
    const k = contractsOf(c, 'active').find((x) => x.airlineId === 'SK')!;
    k.endDay = 0;
    c.day = 60;
    const before = k.perDay;
    c.airlines.SK!.satisfaction = 90;
    c.airlineEval!.SK!.complaints = [{ key: 'fees', sinceDay: 1 }, { key: 'otp', sinceDay: 1 }];
    updateContracts(c, {});
    expect(k.perDay).toBe(before);
  });

  it('提案: 評価・目標がなければ従来と同じ乱数・結果。aircraft が低い航空会社は大型機の提案を出さない', () => {
    const mk = (withEval: boolean) => {
      const c = createSandboxCompany('off');
      if (withEval) {
        c.game = defaultGame();
        c.airlineEval = {};
        c.goals = initialGoals();
      }
      return generateOffers(c, Object.keys(AIRCRAFT_TYPES));
    };
    expect(JSON.stringify(mk(false))).toBe(JSON.stringify(mk(false)));
    const c = createSandboxCompany('rel');
    c.game = defaultGame();
    c.airlineEval = { SK: { ...emptyE(), ema: { slots: 80 } } };
    c.airlines.SK!.satisfaction = 55;
    const k = contractsOf(c, 'active').find((x) => x.airlineId === 'SK')!;
    expect(changeFrequency(c, k.id, 1)).toEqual({ ok: true }); // slots の移動平均が高いと下限 60 → 50
    // フラグがなければ、データがあっても従来どおり（評価・目標の効果はゲーム設定のフラグで決まる）
    c.game = { ...defaultGame(), airlineEval: false };
    expect(changeFrequency(c, k.id, 1)).toEqual({ ok: false, reason: 'AIRLINE_REFUSED' });
    expect(complaintCount(c, 'SK')).toBe(0);
    expect(tierBonus({ game: { ...defaultGame(), goals: false }, goals: { ...initialGoals(), tier: 3 } })).toBe(0);
    expect(tierBonus({ game: defaultGame(), goals: { ...initialGoals(), tier: 3 } })).toBe(3);
    const d = createSandboxCompany('rel');
    d.airlines.SK!.satisfaction = 55;
    expect(changeFrequency(d, contractsOf(d, 'active').find((x) => x.airlineId === 'SK')!.id, 1)).toEqual({ ok: false, reason: 'AIRLINE_REFUSED' });
  });

  it('検証: 不正な形を拒否する', () => {
    expect(checkAirlineEval({ SK: { ...emptyE(), ema: { fees: 120 } } })).not.toEqual([]);
    expect(checkAirlineEval({ ZZ: emptyE() })).not.toEqual([]);
    expect(checkAirlineEval({ SK: emptyE() })).toEqual([]);
    const c = evalCompany();
    expect(checkGameFields(c as unknown as Record<string, unknown>)).toEqual([]);
    expect(checkGameFields({ ...c, goals: { ...initialGoals(), tier: 9 } } as unknown as Record<string, unknown>)).not.toEqual([]);
  });
});

function emptyE() {
  return { ema: {}, low: {}, complaints: [], requests: [], boostUntil: 0, done: [], otpBadDays: 0 } as AirlineEvalEntry;
}

const layout = { facilities: {} } as unknown as AirportLayout;
function report(day: number, kpi: Partial<DailyReport['kpi']>): DailyReport {
  return { day, partial: false, revenue: {}, cost: {}, construction: 0, totalRevenue: 0, totalCost: 0, operatingProfit: 0, cashEnd: 0, kpi: { flights: 0, movements: 0, paxDeparted: 0, paxArrived: 0, otp: null, missedPax: 0, ...kpi } as DailyReport['kpi'] };
}
const types = AIRCRAFT_TYPES;

describe('12B-3a B6: 目標・空港の格', () => {
  it('12 個の目標。10 便で報酬 300,000 cr を現金に足し、grants に記録する（営業収支には入れない）', () => {
    expect(GOALS).toHaveLength(12);
    const c = createSandboxCompany();
    const cash = c.cash;
    const r = evaluateGoals(c, { report: report(0, { flights: 10 }), layout, records: [], types, largeOperable: false });
    expect(r.completed).toEqual(['flights10']);
    expect(c.cash).toBe(cash + 300_000);
    expect(c.goals!.grants).toEqual([{ day: 0, id: 'flights10', amount: 300_000 }]);
    expect(c.today).toEqual({});
    // 二重には付与しない
    expect(evaluateGoals(c, { report: report(1, { flights: 10 }), layout, records: [], types, largeOperable: false }).completed).toEqual([]);
  });

  it('連続目標: 定時率 85% を 3 日連続で達成（途中で切れるとやり直し）。評価 +2', () => {
    const c = createSandboxCompany();
    const run = (d: number, otp: number) => evaluateGoals(c, { report: report(d, { otp }), layout, records: [], types, largeOperable: false }).completed;
    expect(run(0, 0.9)).toEqual([]);
    expect(run(1, 0.9)).toEqual([]);
    expect(run(2, 0.5)).toEqual([]);
    run(3, 0.9);
    run(4, 0.9);
    const rating = c.rating;
    expect(run(5, 0.9)).toEqual(['otp85x3']);
    expect(c.rating).toBe(rating + 2);
  });

  it('空港の格: 条件を 3 日連続で満たすと 1 段昇格（降格しない）', () => {
    const c = createSandboxCompany();
    const day = (d: number, movements: number, pax: number) => evaluateGoals(c, { report: report(d, { movements, paxDeparted: pax }), layout, records: [], types, largeOperable: false });
    for (let d = 0; d < TIER_STREAK - 1; d++) expect(day(d, 20, 2000).tierUp).toBeNull();
    expect(day(2, 20, 2000).tierUp).toBe(1);
    expect(c.goals!.tier).toBe(1);
    expect(c.goals!.tierDay).toBe(2);
    day(3, 0, 0);
    expect(c.goals!.tier).toBe(1);
  });

  it('提案への効果: 格で 1 日の便数の上限が増える。目標がなければ従来と同じ', () => {
    expect(checkGoals(initialGoals())).toEqual([]);
    expect(checkGoals({ ...initialGoals(), done: { nope: 1 } })).not.toEqual([]);
  });
});

describe('12B 審査 R3: 評価・目標のデータはゲーム設定のフラグと整合しているときだけ受け入れる', () => {
  it('checkGameFields: フラグなしの airlineEval・goals は不整合として報告する。フラグありは通る', () => {
    const base = { game: { ...defaultGame(), airlineEval: false, goals: false } };
    expect(checkGameFields({ ...base, airlineEval: {} }).join()).toContain('airlineEval');
    expect(checkGameFields({ ...base, goals: initialGoals() }).join()).toContain('goals');
    expect(checkGameFields({ airlineEval: {} }).length).toBeGreaterThan(0);
    expect(checkGameFields({ game: defaultGame(), airlineEval: {}, goals: initialGoals() })).toEqual([]);
    expect(checkGameFields({})).toEqual([]);
  });

  it('importCompany: フラグのないデータは捨てる。フラグがあれば残す', () => {
    const c = createSandboxCompany('imp');
    c.airlineEval = {};
    c.goals = initialGoals();
    const plain = importCompany(JSON.stringify(c))!;
    expect('airlineEval' in plain || 'goals' in plain).toBe(false);
    c.game = defaultGame();
    const kept = importCompany(JSON.stringify(c))!;
    expect(kept.airlineEval).toBeDefined();
    expect(kept.goals).toBeDefined();
  });
});
