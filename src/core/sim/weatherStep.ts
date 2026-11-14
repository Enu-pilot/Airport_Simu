import { Rng } from '../rng';
import { sortedValues } from '../model/ids';
import { DIFFICULTY } from '../economy/game';
import { DAY_SEC } from './rules';
import type { Simulation } from './simulation';
import type { Aircraft, SimState, WxRuntime } from './types';
import { effectiveWx, legacyKindOf, overrideOf, weatherPlan, wxEffects } from './weather';
import { addExternalDelay } from '../economy/delayEvaluation';

/**
 * 天候 5 段階の運航への組み込み（12B-3a。docs/30 §1）。会社の game.weather === 'levels' の運航（state.wx がある）だけが使う。
 * 乱数は state.wx.rng（`${state.seed}:wx`）だけを使い、state.rng・会社の乱数を消費しない。
 */

const hourOf = (now: number) => Math.floor((now % DAY_SEC) / 3600);
/** 運航状態の秒から会社の暦の日（運航の日 + 日のずれ） */
const calendarDay = (state: SimState) => Math.floor(state.now / DAY_SEC) + (state.economy?.dayOffset ?? 0);

/** 運航の開始時の天候の状態（会社の game から。ない・levels でなければ undefined） */
export function createWx(sim: Simulation): WxRuntime | undefined {
  const c = sim.company;
  const game = c?.game;
  if (!c || !game || game.weather !== 'levels') return undefined;
  const { state } = sim;
  const day = calendarDay(state);
  const hours = weatherPlan(c.seed, day, game.climate, game.difficulty);
  const h = hours[hourOf(state.now)]!;
  return { day, hours, level: h.level, type: h.type, override: null, rng: new Rng(`${state.seed}:wx`).state() };
}

/** 毎ティック（stepDisruptions の後）: 計画の更新・手動の天候の上書き・時間の初めの効果 */
export function stepWeather(sim: Simulation, cancelTurnaround: (sim: Simulation, ac: Aircraft, reason: 'weather') => void): void {
  const { state } = sim;
  const wx = state.wx;
  const c = sim.company;
  if (!wx || !c?.game) return;
  const day = calendarDay(state);
  if (wx.day !== day) {
    wx.day = day;
    wx.hours = weatherPlan(c.seed, day, c.game.climate, c.game.difficulty);
  }
  const cur = wx.hours[hourOf(state.now)]!;
  wx.level = cur.level;
  wx.type = cur.type;
  // 手動・シナリオの天候の障害（発生中のうち最後のもの）は計画より優先する
  let active: { w: Parameters<typeof overrideOf>[0]; until: number } | null = null;
  for (const d of state.disruptions) if (d.status === 'active' && d.kind === 'weather') active = { w: d.weather ?? 'rain', until: d.end ?? Number.POSITIVE_INFINITY };
  wx.override = active ? { ...overrideOf(active.w), until: Number.isFinite(active.until) ? active.until : state.now + 3600 } : null;
  const eff = effectiveWx(wx);
  const kind = legacyKindOf(eff.type);
  if (state.weather.kind !== kind) state.weather = { kind, since: state.now };
  if (state.now % 3600 === 0) hourlyEffects(sim, cancelTurnaround);
}

function hourlyEffects(sim: Simulation, cancelTurnaround: (sim: Simulation, ac: Aircraft, reason: 'weather') => void): void {
  const { state } = sim;
  const wx = state.wx!;
  const fx = wxEffects(wx);
  const rng = new Rng(wx.rng);
  // 段階 2: 次の 1 時間に到着予定の便の一部が遅れる
  if (fx.arrivalDelay) {
    for (const f of sortedValues(state.flights)) {
      if (f.direction !== 'arrival' || f.status !== 'scheduled' || f.estimated < state.now || f.estimated >= state.now + 3600) continue;
      if (rng.next() >= fx.arrivalDelay.prob) continue;
      const delaySec = rng.int(0, fx.arrivalDelay.maxMin) * 60;
      f.estimated += delaySec;
      addExternalDelay(f, 'weather', delaySec);
      if (!f.delayCauses.includes('weather')) f.delayCauses.push('weather');
    }
  }
  // 段階 3 以上: 2 時間以内に到着予定でまだ現れていない機体の一部を欠航にする
  if (fx.cancelPerHour > 0) {
    const list = sortedValues(state.aircraft).filter((ac) => ac.state === 'scheduled' && state.flights[ac.arrivalFlightId]!.estimated <= state.now + 2 * 3600);
    for (const ac of list) if (rng.next() < fx.cancelPerHour) cancelTurnaround(sim, ac, 'weather');
  }
  wx.rng = rng.state();
}

/** 着陸の瞬間の着陸復行の判定（段階 0 は乱数を引かない） */
export function rollWeatherGoAround(state: SimState): boolean {
  const wx = state.wx;
  if (!wx) return false;
  const p = wxEffects(wx).goAround;
  if (p <= 0) return false;
  const rng = new Rng(wx.rng);
  const hit = rng.next() < p;
  wx.rng = rng.state();
  return hit;
}

/** 会社の難易度に応じた、運航のランダムな障害の設定 */
export function disruptionScaleFor(difficulty: keyof typeof DIFFICULTY): number {
  return DIFFICULTY[difficulty].disruptionScale;
}
