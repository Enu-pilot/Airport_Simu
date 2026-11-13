import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { defaultGame, type Difficulty } from '../../../src/core/economy/game';
import { addDisruption, weatherEffects } from '../../../src/core/sim/disruptions';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { DAY_SEC } from '../../../src/core/sim/rules';
import { cancelTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { LEVEL_EFFECTS, effectiveWx, lightningStop, weatherPlan } from '../../../src/core/sim/weather';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';

/** 12B-3a B3: 天候 5 段階の運航への組み込み（会社の game.weather === 'levels' のときだけ。従来の運航は変わらない） */
const BAD_DAY = 108; // seed 'sandbox' / temperate / normal: 7〜20 時に段階 4 が 7 時間ある（冬。雪）

function company(day: number, difficulty: Difficulty = 'normal', weather: 'levels' | 'legacy' = 'levels') {
  const c = createSandboxCompany();
  c.day = day;
  c.game = { ...defaultGame(difficulty), weather };
  return c;
}
const make = (day: number, o: { difficulty?: Difficulty; weather?: 'levels' | 'legacy'; seed?: string; random?: boolean } = {}) =>
  createSimulation(createSampleAirport(), {
    seed: o.seed ?? 'wx-test',
    company: company(day, o.difficulty, o.weather),
    ...(o.random === false ? { settings: { randomDisruptions: false } } : {}),
  });

function runTo(sim: Simulation, hour: number, check = 600): void {
  const target = Math.floor(sim.state.now / DAY_SEC) * DAY_SEC + hour * 3600;
  while (sim.state.now < target) {
    stepSimulation(sim);
    if (sim.state.now % check === 0) expect(checkInvariants(sim)).toEqual([]);
  }
}

describe('天候 5 段階: 有効化と従来の運航の不変', () => {
  it('game のない会社・会社なしの運航は state.wx も randomDisruptionScale も持たない', () => {
    for (const sim of [createSimulation(createSampleAirport(), { seed: 's', company: createSandboxCompany() }), createSimulation(createSampleAirport(), { seed: 's' })]) {
      expect('wx' in sim.state).toBe(false);
      expect('randomDisruptionScale' in sim.state.settings).toBe(false);
      expect(sim.state.settings.randomDisruptions).toBeUndefined();
      expect(JSON.stringify(sim.state)).not.toContain('"wx"');
    }
  });

  it('game.weather が levels のときだけ state.wx を作り、難易度のランダムな障害の頻度を設定する', () => {
    const a = make(3, { difficulty: 'hard' });
    expect(a.state.wx).toBeDefined();
    expect(a.state.wx!.hours).toHaveLength(24);
    expect(a.state.settings.randomDisruptions).toBe(true);
    expect(a.state.settings.randomDisruptionScale).toBe(1);
    const b = make(3, { weather: 'legacy' });
    expect(b.state.wx).toBeUndefined();
    expect(b.state.settings.randomDisruptionScale).toBe(0.6);
  });

  it('最初の日（day 0）は晴れで、wx は他の乱数列（state.rng・会社の乱数）を消費しない', () => {
    // ランダムな障害を切ると、day 0 は天候のモデルによらず運航の状態が完全に一致する（wx 以外）
    const a = make(0, { random: false });
    const b = make(0, { weather: 'legacy', random: false });
    runTo(a, 11);
    runTo(b, 11);
    expect(a.state.wx!.hours.every((h) => h.level === 0)).toBe(true);
    const strip = (s: Simulation['state']) => JSON.stringify({ ...s, wx: undefined });
    expect(strip(a.state)).toBe(strip(b.state));
    expect(a.company!.rng).toEqual(b.company!.rng);
    // ランダムな障害（天候の障害の乱数を引くが、天候 5 段階では登録しない）でも、時間の初めの判定の直後の state.rng は同じ
    const c = make(0);
    const d = make(0, { weather: 'legacy' });
    while (c.state.now <= 7 * 3600) {
      stepSimulation(c);
      stepSimulation(d);
    }
    expect(c.state.rng).toEqual(d.state.rng);
  });

  it('同じ入力なら同じ結果（悪天の日を含む）', { timeout: 120_000 }, () => {
    const a = make(BAD_DAY);
    const b = make(BAD_DAY);
    runTo(a, 14);
    runTo(b, 14);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });
});

describe('天候 5 段階: 効果', () => {
  it('間隔・走行の倍率は有効な段階の表どおり（時間ごとに計画へ追従する）', { timeout: 120_000 }, () => {
    const sim = make(BAD_DAY);
    const plan = weatherPlan('sandbox', BAD_DAY, 'temperate', 'normal');
    expect(sim.state.wx!.hours).toEqual(plan);
    for (const h of [7, 9, 12, 15]) {
      runTo(sim, h);
      stepSimulation(sim);
      const lv = plan[h]!.level;
      expect(sim.state.wx!.level).toBe(lv);
      const fx = weatherEffects(sim.state);
      expect(fx.separation).toBe(LEVEL_EFFECTS[lv].separation);
      expect(fx.taxi).toBe(plan[h]!.type === 'snow' && lv >= 3 ? Math.min(LEVEL_EFFECTS[lv].taxi, 0.7) : LEVEL_EFFECTS[lv].taxi);
    }
    // 従来の表示（state.weather.kind）へ写像される
    expect(['clear', 'rain', 'snow', 'fog']).toContain(sim.state.weather.kind);
  });

  it('悪天の日は着陸復行（理由 weather）と天候欠航が起き、不変条件を保つ。欠航は会社の補償に計上される', { timeout: 300_000 }, () => {
    const sim = make(BAD_DAY, { seed: 'bad-day' });
    runTo(sim, 23, 1200);
    const events = sim.state.events;
    const weatherCancels = events.filter((e) => e.kind === 'cannotOperate' && e.reason === 'weather');
    expect(weatherCancels.length + sim.state.stats.goArounds).toBeGreaterThan(0);
    for (const e of weatherCancels) {
      const ac = sim.state.aircraft[e.aircraftId!]!;
      expect(ac.state).toBe('cannotOperate');
      expect(sim.state.flights[ac.arrivalFlightId]!.status).toBe('cancelled');
      expect(sim.state.flights[ac.departureFlightId]!.status).toBe('cancelled');
    }
    expect(sim.state.stats.cancelled).toBeGreaterThanOrEqual(weatherCancels.length);
    const recs = sim.state.analytics.records.filter((r) => r.result === 'cancelled' && r.causes.includes('weather'));
    expect(recs.length).toBe(weatherCancels.length);
  });

  it('cancelTurnaround: 現れていない折り返しだけを欠航にし、到着・出発とも cancelled・補償を計上する（二重には作用しない）', () => {
    const sim = make(0);
    const ac = Object.values(sim.state.aircraft).find((a) => a.state === 'scheduled')!;
    const before = sim.company!.today.compensation ?? 0;
    cancelTurnaround(sim, ac, 'weather');
    expect(ac.state).toBe('cannotOperate');
    expect(ac.history[ac.history.length - 1]!.note).toBe('weather');
    expect(sim.state.flights[ac.arrivalFlightId]!.status).toBe('cancelled');
    expect(sim.state.flights[ac.departureFlightId]!.delayCauses).toContain('weather');
    expect(sim.state.stats.cancelled).toBe(1);
    expect(sim.company!.today.compensation ?? 0).toBeLessThan(before);
    cancelTurnaround(sim, ac, 'weather');
    expect(sim.state.stats.cancelled).toBe(1);
    runTo(sim, 8);
    expect(checkInvariants(sim)).toEqual([]);
  });

  it('手動の天候の障害は計画より優先し（雨 = 段階 2）、復旧すると計画に戻る。ランダムな天候の障害は登録しない', () => {
    const sim = make(0);
    runTo(sim, 7);
    expect(effectiveWx(sim.state.wx!).level).toBe(0);
    addDisruption(sim, { kind: 'weather', targetId: null, weather: 'fog', end: sim.state.now + 1800 });
    stepSimulation(sim);
    expect(effectiveWx(sim.state.wx!)).toEqual({ level: 3, type: 'fog' });
    expect(weatherEffects(sim.state).separation).toBe(LEVEL_EFFECTS[3].separation);
    expect(sim.state.weather.kind).toBe('fog');
    for (let i = 0; i < 1900; i++) stepSimulation(sim);
    expect(effectiveWx(sim.state.wx!).level).toBe(0);
    expect(sim.state.weather.kind).toBe('clear');
    runTo(sim, 20);
    expect(sim.state.disruptions.filter((d) => d.origin === 'random' && d.kind === 'weather')).toEqual([]);
  });

  it('雷雨（段階 4）の間は 20 分ごとに 5 分、屋外の地上作業が進まない', { timeout: 300_000 }, () => {
    const sim = make(0, { random: false });
    const generic = () => Object.values(sim.state.tasks).some((t) => t.state === 'inProgress' && !['deplane', 'board', 'unload', 'load', 'pushback'].includes(t.kind));
    for (let i = 0; i < 12 * 3600 && !generic(); i++) stepSimulation(sim);
    expect(generic()).toBe(true);
    sim.state.wx!.hours = Array.from({ length: 24 }, () => ({ level: 4 as const, type: 'storm' as const }));
    stepSimulation(sim);
    const work = () => Object.values(sim.state.tasks).filter((t) => !['deplane', 'board', 'unload', 'load', 'pushback'].includes(t.kind)).reduce((n, t) => n + t.doneSec, 0);
    let stopTicks = 0;
    let moved = 0;
    for (let i = 0; i < 3600; i++) {
      const stop = lightningStop(sim.state);
      const before = work();
      stepSimulation(sim);
      if (stop) {
        stopTicks++;
        expect(work()).toBe(before);
      } else if (work() > before) moved++;
    }
    expect(stopTicks).toBe(3 * 300);
    expect(moved).toBeGreaterThan(0);
    // 雷雨でない段階 4（雨）は止めない
    sim.state.wx!.hours = Array.from({ length: 24 }, () => ({ level: 4 as const, type: 'rain' as const }));
    stepSimulation(sim);
    expect(lightningStop(sim.state)).toBe(false);
  });
});
