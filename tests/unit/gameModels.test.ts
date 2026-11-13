import { describe, expect, it } from 'vitest';
import { stepSimulation } from '../../src/core/sim/simulation';
import { createCareerCompany, createSandboxCompany, importCompany } from '../../src/core/economy/company';
import { DIFFICULTY, applyGameState, checkGameSettings, costMultiplier, defaultGame, otpAddOf } from '../../src/core/economy/game';
import { buildProject, serializeProject, validateProject } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';

const NOW = '2026-11-13T00:00:00Z';
const opts = { fallbackCompany: createSandboxCompany() };
const build = (company = createSandboxCompany()) => buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company, pin: null, scenarios: [], sim: null });

describe('12B-3a B1: ゲーム設定（game）', () => {
  it('コア関数が作る会社には game がなく、倍率は従来と同じ', () => {
    for (const c of [createSandboxCompany(), createCareerCompany()]) {
      expect('game' in c).toBe(false);
      expect(costMultiplier(c)).toBe(1);
      expect(otpAddOf(c)).toBe(0);
    }
    expect(createCareerCompany().cash).toBe(4_000_000);
  });

  it('難易度の表: normal は従来の値（資金・建設費 ×1、定時率の加算なし）、難しいほど厳しい', () => {
    expect(DIFFICULTY.normal).toMatchObject({ cashMul: 1, costMul: 1, otpAdd: 0, forecastAccuracy: 0.9 });
    expect(DIFFICULTY.hard.weatherScale).toBeGreaterThan(DIFFICULTY.normal.weatherScale);
    expect(DIFFICULTY.expert.weatherScale).toBeGreaterThan(DIFFICULTY.hard.weatherScale);
    expect(DIFFICULTY.expert.cashMul).toBeLessThan(DIFFICULTY.hard.cashMul);
    expect(DIFFICULTY.expert.forecastAccuracy).toBeLessThan(DIFFICULTY.normal.forecastAccuracy);
  });

  it('形の検証: 正しい設定は通り、不正な値はそれぞれ理由が返る', () => {
    expect(checkGameSettings(defaultGame())).toBeNull();
    expect(checkGameSettings(defaultGame('expert', 'snowy'))).toBeNull();
    for (const bad of [null, 1, [], { ...defaultGame(), version: 2 }, { ...defaultGame(), difficulty: 'easy' }, { ...defaultGame(), weather: 'x' }, { ...defaultGame(), goals: 1 }, { ...defaultGame(), climate: 'arid' }]) {
      expect(checkGameSettings(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it('applyGameState: game がなければ評価・目標の状態を消す', () => {
    const c = createSandboxCompany();
    c.airlineEval = {};
    c.goals = { done: {}, streaks: {}, tier: 0, grants: [], boostUntil: 0 };
    applyGameState(c);
    expect('airlineEval' in c || 'goals' in c).toBe(false);
  });

  it('importCompany は不正な game を捨て、正しい game は残す（読み込みは止めない）', () => {
    const c = createSandboxCompany();
    c.game = defaultGame('hard');
    expect(importCompany(JSON.stringify(c))!.game?.difficulty).toBe('hard');
    const bad = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
    bad.game = { version: 1, difficulty: 'nope' };
    expect('game' in importCompany(JSON.stringify(bad))!).toBe(false);
  });

  it('プロジェクト: game があると保存形式は 2、ないと 1。不正な game は読み込みを拒否する', () => {
    expect(build().formatVersion).toBe(1);
    const c = createSandboxCompany();
    c.game = defaultGame();
    const p = build(c);
    expect(p.formatVersion).toBe(2);
    const r = validateProject(serializeProject(p), opts);
    expect(r.errors).toEqual([]);
    expect(r.project!.company.game).toEqual(defaultGame());
    const bad = JSON.parse(serializeProject(p)) as { company: { game: unknown } };
    bad.company.game = { ...defaultGame(), climate: 'x' };
    const rb = validateProject(JSON.stringify(bad), opts);
    expect(rb.ok).toBe(false);
    expect(rb.errors.join('\n')).toContain('気候');
  });
});

import { forecast, forecastForDay, seasonOf, weatherPlan, LEVEL_EFFECTS, type WxLevel } from '../../src/core/sim/weather';

describe('12B-3a B2: 天候の計画・予報（純関数）', () => {
  const avg = (climate: 'temperate' | 'snowy' | 'humid', diff: 'normal' | 'hard' | 'expert', days = 120) => {
    let sum = 0;
    let n = 0;
    let l4 = 0;
    for (let d = 1; d <= days; d++) for (const h of weatherPlan('seed-A', d, climate, diff)) { sum += h.level; n++; if (h.level === 4) l4++; }
    return { mean: sum / n, l4: l4 / n };
  };

  it('同じ入力は同じ出力（計画・予報とも）。シード・日が違えば変わる', () => {
    expect(weatherPlan('s', 12, 'temperate', 'normal')).toEqual(weatherPlan('s', 12, 'temperate', 'normal'));
    expect(weatherPlan('s', 12, 'temperate', 'normal')).not.toEqual(weatherPlan('s', 13, 'temperate', 'normal'));
    expect(weatherPlan('s', 12, 'temperate', 'normal')).not.toEqual(weatherPlan('t', 12, 'temperate', 'normal'));
    const p = weatherPlan('s', 12, 'snowy', 'hard');
    expect(forecast(p, 0.8, 's', 12)).toEqual(forecast(p, 0.8, 's', 12));
    expect(forecastForDay('s', 12, { climate: 'snowy', difficulty: 'hard' })).toEqual(forecast(p, 0.8, 's', 12));
  });

  it('day 0（最初の日）は全時間が晴れ。24 時間分で段階は 0〜4', () => {
    for (const diff of ['normal', 'hard', 'expert'] as const) expect(weatherPlan('x', 0, 'humid', diff).every((h) => h.level === 0 && h.type === 'clear')).toBe(true);
    for (let d = 1; d < 60; d++) {
      const p = weatherPlan('x', d, 'temperate', 'expert');
      expect(p).toHaveLength(24);
      expect(p.every((h) => h.level >= 0 && h.level <= 4 && Number.isInteger(h.level))).toBe(true);
    }
  });

  it('分布: temperate/normal の 120 日の平均段階が 0.5〜1.3、段階 4 は 3% 未満。難しいほど悪天が多い', () => {
    const n = avg('temperate', 'normal');
    expect(n.mean).toBeGreaterThan(0.5);
    expect(n.mean).toBeLessThan(1.3);
    expect(n.l4).toBeLessThan(0.03);
    const h = avg('temperate', 'hard');
    const e = avg('temperate', 'expert');
    expect(h.mean).toBeGreaterThan(n.mean);
    expect(e.mean).toBeGreaterThan(h.mean);
    expect(e.l4).toBeGreaterThan(n.l4);
  });

  it('季節: 1 年 = 120 日（30 日ごと）。冬の悪天は雪、夏の午後の荒天は雷雨になりうる', () => {
    expect([1, 31, 61, 91, 121].map(seasonOf)).toEqual([0, 1, 2, 3, 0]);
    let snow = 0;
    let storm = 0;
    for (let d = 91; d < 120; d++) for (const h of weatherPlan('w', d, 'snowy', 'expert')) if (h.level >= 2 && h.type === 'snow') snow++;
    for (let d = 31; d < 60; d++) for (const h of weatherPlan('w', d, 'humid', 'expert')) if (h.type === 'storm') storm++;
    expect(snow).toBeGreaterThan(0);
    expect(storm).toBeGreaterThan(0);
  });

  it('予報: 6〜12・12〜18・18〜24 時の 3 区間。的中率 1 なら区間の最大段階と一致、低いと外れる区間が出る', () => {
    const p = weatherPlan('f', 40, 'humid', 'hard');
    const exact = forecast(p, 1, 'f', 40);
    expect(exact.blocks.map((b) => [b.fromH, b.toH])).toEqual([[6, 12], [12, 18], [18, 24]]);
    for (const b of exact.blocks) expect(b.level).toBe(Math.max(...p.slice(b.fromH, b.toH).map((h) => h.level)));
    let misses = 0;
    let total = 0;
    for (let d = 1; d <= 200; d++) {
      const pl = weatherPlan('f', d, 'humid', 'hard');
      const ex = forecast(pl, 1, 'f', d);
      const fc = forecast(pl, 0.65, 'f', d);
      ex.blocks.forEach((b, i) => {
        total++;
        if (fc.blocks[i]!.level !== b.level) misses++;
      });
    }
    // 外すと ±1 ずれる（端の段階では動かないことがあるので、外す確率 0.35 より少し少ない）
    expect(misses / total).toBeGreaterThan(0.15);
    expect(misses / total).toBeLessThan(0.4);
  });

  it('効果の表: 段階が上がるほど間隔・走行・復行・欠航が悪化する（段階 0 は影響なし）', () => {
    const lv: WxLevel[] = [0, 1, 2, 3, 4];
    expect(LEVEL_EFFECTS[0]).toEqual({ separation: 1, taxi: 1, goAround: 0, cancelPerHour: 0, arrivalDelay: null });
    for (let i = 1; i < lv.length; i++) {
      expect(LEVEL_EFFECTS[lv[i]!].separation).toBeGreaterThan(LEVEL_EFFECTS[lv[i - 1]!].separation);
      expect(LEVEL_EFFECTS[lv[i]!].taxi).toBeLessThan(LEVEL_EFFECTS[lv[i - 1]!].taxi);
      expect(LEVEL_EFFECTS[lv[i]!].goAround).toBeGreaterThan(LEVEL_EFFECTS[lv[i - 1]!].goAround);
    }
    expect(LEVEL_EFFECTS[2].arrivalDelay).not.toBeNull();
    expect(LEVEL_EFFECTS[3].cancelPerHour).toBe(0.02);
    expect(LEVEL_EFFECTS[4].cancelPerHour).toBe(0.08);
  });
});

import { updateContracts, type AirlineDayResult } from '../../src/core/economy/company';
import { scaleConstructionCost, startGame } from '../../src/core/economy/game';
import { cancelFlightEarly, createSimulation } from '../../src/core/sim/simulation';
import { stepDisruptions } from '../../src/core/sim/disruptions';
import { checkInvariants } from '../../src/core/sim/invariants';

describe('12B-3a B4: 難易度の効果', () => {
  it('初期資金・建設費: normal は従来と同じ、hard/expert は倍率。game なし・null は従来のまま', () => {
    expect(startGame(createCareerCompany(), defaultGame('normal')).cash).toBe(4_000_000);
    expect(startGame(createCareerCompany(), defaultGame('hard')).cash).toBe(3_000_000);
    expect(startGame(createCareerCompany(), defaultGame('expert')).cash).toBe(2_000_000);
    const legacy = startGame(createCareerCompany(), null);
    expect(legacy.cash).toBe(4_000_000);
    expect('game' in legacy).toBe(false);
    const n = startGame(createCareerCompany(), defaultGame('normal'));
    const h = startGame(createCareerCompany(), defaultGame('hard'));
    const e = startGame(createCareerCompany(), defaultGame('expert'));
    expect(scaleConstructionCost(legacy, 100_000)).toBe(100_000);
    expect(scaleConstructionCost(n, 100_000)).toBe(100_000);
    expect(scaleConstructionCost(h, 100_000)).toBe(110_000);
    expect(scaleConstructionCost(e, 100_000)).toBe(120_000);
    // 払い戻し（負）と 0 はそのまま
    expect(scaleConstructionCost(e, -25_000)).toBe(-25_000);
    expect(scaleConstructionCost(e, 0)).toBe(0);
  });

  it('要求する定時率: game がなければ従来どおり、hard は +5pt・expert は +10pt（満足度の変化が厳しくなる）', () => {
    const result: Record<string, AirlineDayResult> = { SK: { flights: 20, onTime: 17, paxBoarded: 0, missedPax: 0, leftBags: 0, cancelled: 0 } }; // 定時率 85%（SK の要求 85%）
    const sat = (game: ReturnType<typeof defaultGame> | null) => {
      const c = createSandboxCompany();
      if (game) c.game = game;
      c.fees = { ...c.fees };
      updateContracts(c, structuredClone(result));
      return c.airlines.SK!.satisfaction;
    };
    const base = sat(null);
    expect(sat(defaultGame('normal'))).toBe(base);
    expect(sat(defaultGame('hard'))).toBeLessThan(base);
    expect(sat(defaultGame('expert'))).toBeLessThan(sat(defaultGame('hard')));
  });

  it('欠航の満足度ペナルティ: 天候欠航は通常の 1/4、先行欠航は 1/10（便あたり）', () => {
    const sat = (extra: Partial<AirlineDayResult>) => {
      const c = createSandboxCompany();
      updateContracts(c, { SK: { flights: 10, onTime: 10, paxBoarded: 100, missedPax: 0, leftBags: 0, cancelled: 2, ...extra } });
      return c.airlines.SK!.satisfaction;
    };
    const none = sat({ cancelled: 0 });
    const normal = none - sat({});
    expect(normal).toBeCloseTo(10, 6);
    expect(none - sat({ weatherCancelled: 2 })).toBeCloseTo(2.5, 6);
    expect(none - sat({ earlyCancelled: 2 })).toBeCloseTo(1, 6);
  });

  it('先行欠航: まだ現れていない折り返しだけ。補償なし・満足度 −1（日の締めで）。game がなければ操作できない', () => {
    const c = createSandboxCompany();
    c.game = defaultGame();
    const sim = createSimulation(createSampleAirport(), { seed: 'early', company: c });
    const ac = Object.values(sim.state.aircraft).find((a) => a.state === 'scheduled')!;
    const airline = sim.state.flights[ac.departureFlightId]!.airlineId!;
    const sat = sim.company!.airlines[airline]!.satisfaction;
    const comp = sim.company!.today.compensation ?? 0;
    expect(cancelFlightEarly(sim, ac.id)).toEqual({ ok: true });
    expect(ac.state).toBe('cannotOperate');
    expect(sim.state.flights[ac.arrivalFlightId]!.status).toBe('cancelled');
    // 満足度は日の締めで 1 回だけ引く（先行欠航の時点では動かさない。二重に引かない）
    expect(sim.company!.airlines[airline]!.satisfaction).toBe(sat);
    expect(sim.company!.today.compensation ?? 0).toBe(comp);
    expect(cancelFlightEarly(sim, ac.id)).toEqual({ ok: false, reason: 'TOO_LATE' });
    expect(checkInvariants(sim)).toEqual([]);
    const plain = createSimulation(createSampleAirport(), { seed: 'early', company: createSandboxCompany() });
    expect(cancelFlightEarly(plain, Object.values(plain.state.aircraft)[0]!.id)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('ランダムな障害の頻度は難易度の倍率で変わる（expert > normal。同じ乱数列の引き方）', () => {
    const count = (difficulty: 'normal' | 'expert') => {
      const c = createSandboxCompany();
      c.game = defaultGame(difficulty);
      const sim = createSimulation(createSampleAirport(), { seed: 'rand', company: c, settings: { autoSchedule: false, flightsPerDay: 0 } });
      let n = 0;
      for (let h = 1; h <= 2000; h++) {
        sim.state.now = h * 3600;
        stepDisruptions(sim);
        n = sim.state.disruptions.filter((d) => d.origin === 'random').length;
      }
      return n;
    };
    const normal = count('normal');
    const expert = count('expert');
    expect(normal).toBeGreaterThan(0);
    expect(expert).toBeGreaterThan(normal * 1.5);
  });
});

describe('先行欠航の満足度ペナルティは 1 日を通して −1（二重に引かない）', () => {
  it('同じ空港・シードで、先行欠航した日と何もしない日の航空会社の満足度の差が 1', { timeout: 300_000 }, () => {
    const run = (cancel: boolean) => {
      const c = createSandboxCompany('early-day');
      c.game = { ...defaultGame(), airlineEval: false, goals: false, weather: 'legacy' } as typeof c.game;
      const sim = createSimulation(createSampleAirport(), { seed: 'early-day', company: c });
      const ac = Object.values(sim.state.aircraft).find((a) => a.state === 'scheduled')!;
      const airline = sim.state.flights[ac.departureFlightId]!.airlineId!;
      if (cancel) expect(cancelFlightEarly(sim, ac.id)).toEqual({ ok: true });
      const day = sim.company!.day;
      for (let i = 0; i < 2 * 86400 && sim.company!.day === day; i++) stepSimulation(sim);
      expect(sim.company!.day).toBe(day + 1);
      return { sat: sim.company!.airlines[airline]!.satisfaction, rep: sim.company!.reports.at(-1)! };
    };
    const base = run(false);
    const cancelled = run(true);
    expect(base.sat - cancelled.sat).toBeCloseTo(1, 6);
  });
});

describe('12B 審査 R2: 目標の報酬は日の締めの資金・評価に含まれる', () => {
  it('日報の cashEnd・kpi.rating は報酬を加えたあとの値で、報酬は grants に別掲され営業利益に入らない', { timeout: 300_000 }, () => {
    const c = createSandboxCompany('r2');
    c.game = { ...defaultGame(), weather: 'legacy', airlineEval: false, goals: true };
    c.goals = { done: {}, streaks: {}, tier: 0, grants: [], boostUntil: 0 };
    const sim = createSimulation(createSampleAirport(), { seed: 'r2', company: c });
    const cash0 = c.cash;
    while (sim.company!.day === 0) stepSimulation(sim);
    const co = sim.company!;
    const r = co.reports[co.reports.length - 1]!;
    expect(r.grants ?? 0).toBeGreaterThan(0);
    expect(r.cashEnd).toBe(co.cash);
    expect(r.kpi.rating).toBe(co.rating);
    expect(r.cashEnd).toBeCloseTo(cash0 + r.operatingProfit + r.construction + (r.grants ?? 0), 0);
  });
});
