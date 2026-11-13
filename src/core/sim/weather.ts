import { Rng } from '../rng';
import { DIFFICULTY, type Climate, type Difficulty } from '../economy/game';
import type { SimState, WeatherKind, WxHour, WxLevel, WxRuntime, WxType } from './types';

/**
 * 天候 5 段階・予報（12B-3a Part B。docs/30 §1）。数値はすべてゲーム用の値で、実在の運用基準・気象の統計ではない。
 *
 * - 計画（weatherPlan）は **会社のシードと暦の日だけ** から決まる純関数（プレイヤーの操作に依存しない）。翌日の予報も同じ関数で作る。
 * - 乱数は専用の列（`${seed}:wx:${day}`・`${seed}:fc:${day}`・運航中は `${state.seed}:wx`）で、他の乱数列を消費しない。
 * - 会社の `game.weather === 'levels'` のときだけ運航状態 `state.wx` を持つ（ないときは従来の 4 種の天候）。
 */
export type { WxHour, WxLevel, WxRuntime, WxType };

export const WX_LEVELS: readonly WxLevel[] = [0, 1, 2, 3, 4];
export const DAYS_PER_SEASON = 30;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;
export const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = 0 | 1 | 2 | 3;

/** 暦の日の季節（1 年 = 120 日、30 日ごとに春・夏・秋・冬） */
export const seasonOf = (day: number): Season => Math.floor((((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR) / DAYS_PER_SEASON) as Season;

/** 悪天の出やすさの基準（春・夏・秋・冬。ゲーム値） */
export const WX_BASE: Record<Climate, readonly [number, number, number, number]> = {
  temperate: [0.2, 0.24, 0.2, 0.24],
  snowy: [0.2, 0.16, 0.24, 0.4],
  humid: [0.24, 0.4, 0.3, 0.16],
};

/** 0 時の段階の分布（段階 0〜3。難易度の倍率が高いほど悪い側に寄る） */
const START_CUM = [0.5, 0.8, 0.95, 1] as const;
/** 段階が上がる確率 = 悪天の出やすさ × 0.55（UP_FACTOR）、下がる確率 = 0.35（時間ごとのマルコフ連鎖。ゲーム値） */
const UP_FACTOR = 0.55;
const DOWN_PROB = 0.35;

const isNight = (h: number) => h < 6 || h >= 20;

/** 時間帯・季節による悪天の出やすさの補正（霧は早朝、雷雨は夏の午後、雪は冬の夜に出やすい。ゲーム値） */
function hourFactor(h: number, season: Season): number {
  let f = 1;
  if (h >= 5 && h < 10) f *= 1.3;
  if (season === 1 && h >= 14 && h < 20) f *= 1.5;
  if (season === 3 && isNight(h)) f *= 1.2;
  return f;
}

function typeFor(level: WxLevel, h: number, season: Season, climate: Climate, fogRoll: number): WxType {
  if (level === 0) return 'clear';
  if (level === 1) return 'cloud';
  if (season === 3 || (climate === 'snowy' && season === 2 && isNight(h))) return 'snow';
  if (h >= 5 && h < 10 && fogRoll < 0.3) return 'fog';
  if (season === 1 && h >= 14 && h < 20 && level >= 3) return 'storm';
  return 'rain';
}

/**
 * 暦の日の 24 時間分の天候の計画。day 0（最初の日）はゲームの導入として全時間が晴れ。
 */
export function weatherPlan(seed: string, day: number, climate: Climate, difficulty: Difficulty): WxHour[] {
  if (day <= 0) return Array.from({ length: 24 }, () => ({ level: 0 as WxLevel, type: 'clear' as WxType }));
  const rng = new Rng(`${seed}:wx:${day}`);
  const scale = DIFFICULTY[difficulty].weatherScale;
  const season = seasonOf(day);
  const base = WX_BASE[climate][season] * scale;
  // 0 時の段階: 難易度が高いほど悪い側に寄せる（u を u^(1/scale) で上へ）
  const u0 = Math.pow(rng.next(), 1 / scale);
  let level: WxLevel = u0 < START_CUM[0] ? 0 : u0 < START_CUM[1] ? 1 : u0 < START_CUM[2] ? 2 : 3;
  const hours: WxHour[] = [];
  for (let h = 0; h < 24; h++) {
    const u = rng.next();
    const fogRoll = rng.next();
    if (h > 0) {
      const up = Math.min(0.5, base * hourFactor(h, season) * UP_FACTOR);
      if (u < up) level = Math.min(4, level + 1) as WxLevel;
      else if (u > 1 - DOWN_PROB) level = Math.max(0, level - 1) as WxLevel;
    }
    hours.push({ level, type: typeFor(level, h, season, climate, fogRoll) });
  }
  return hours;
}

export interface WxBlock {
  fromH: number;
  toH: number;
  level: WxLevel;
  type: WxType;
}

export interface WeatherForecast {
  /** 予報の対象の暦の日 */
  day: number;
  /** 6〜12・12〜18・18〜24 時の最大段階と代表の種類 */
  blocks: WxBlock[];
  /** 予報の的中率（区間ごと） */
  accuracy: number;
  /** 一行の要約（表示用） */
  summary: string;
}

export const WX_TYPE_NAME: Record<WxType, string> = { clear: '晴れ', cloud: '曇り', rain: '雨', snow: '雪', fog: '霧', storm: '雷雨' };
/** 段階の呼び名（ゲーム用の区分） */
export const WX_LEVEL_NAME: Record<WxLevel, string> = { 0: '晴れ', 1: '曇り・小雨', 2: '雨', 3: '荒天', 4: '悪天' };
export const FORECAST_BLOCKS: readonly (readonly [number, number])[] = [
  [6, 12],
  [12, 18],
  [18, 24],
];

/** 段階に合う種類（予報が段階をずらしたとき） */
function typeAtLevel(level: WxLevel, from: WxType): WxType {
  if (level === 0) return 'clear';
  if (level === 1) return 'cloud';
  return from === 'clear' || from === 'cloud' ? 'rain' : from;
}

/**
 * 予報: 計画から区間ごとの最大段階を作り、各区間を確率 `1 − accuracy` で ±1 ずらす（決定的。乱数は `${seed}:fc:${day}`）。
 */
export function forecast(plan: readonly WxHour[], accuracy: number, seed: string, day: number): WeatherForecast {
  const rng = new Rng(`${seed}:fc:${day}`);
  const blocks: WxBlock[] = FORECAST_BLOCKS.map(([fromH, toH]) => {
    let best = plan[fromH]!;
    for (let h = fromH; h < toH; h++) if (plan[h]!.level > best.level) best = plan[h]!;
    let level = best.level;
    let type = best.type;
    const hit = rng.next() < accuracy;
    const dir = rng.next() < 0.5 ? -1 : 1;
    if (!hit) {
      level = Math.min(4, Math.max(0, level + dir)) as WxLevel;
      type = typeAtLevel(level, type);
    }
    return { fromH, toH, level, type };
  });
  const summary = blocks.map((b) => `${b.fromH}〜${b.toH}時 ${WX_TYPE_NAME[b.type]}（段階 ${b.level}）`).join(' / ');
  return { day, blocks, accuracy, summary };
}

/** 日の計画から作る、その日の予報 */
export function forecastForDay(seed: string, day: number, game: { climate: Climate; difficulty: Difficulty }): WeatherForecast {
  return forecast(weatherPlan(seed, day, game.climate, game.difficulty), DIFFICULTY[game.difficulty].forecastAccuracy, seed, day);
}

// ---------------------------------------------------------------- 効果の表

export interface WxEffects {
  /** 離着陸間隔の倍率 */
  separation: number;
  /** 地上走行速度の倍率 */
  taxi: number;
  /** 着陸の瞬間の着陸復行の確率 */
  goAround: number;
  /** 段階 3 以上の時間の初めに、2 時間以内に到着予定の便を欠航にする確率 */
  cancelPerHour: number;
  /** 段階 2: 到着の遅れ（時間の初めに、次の 1 時間の到着便へ） */
  arrivalDelay: { prob: number; maxMin: number } | null;
}

/** 段階ごとの効果（ゲーム値。docs/30 §1） */
export const LEVEL_EFFECTS: Record<WxLevel, WxEffects> = {
  0: { separation: 1, taxi: 1, goAround: 0, cancelPerHour: 0, arrivalDelay: null },
  1: { separation: 1.1, taxi: 0.95, goAround: 0.005, cancelPerHour: 0, arrivalDelay: null },
  2: { separation: 1.25, taxi: 0.9, goAround: 0.015, cancelPerHour: 0, arrivalDelay: { prob: 0.2, maxMin: 10 } },
  3: { separation: 1.5, taxi: 0.75, goAround: 0.04, cancelPerHour: 0.02, arrivalDelay: null },
  4: { separation: 1.9, taxi: 0.6, goAround: 0.1, cancelPerHour: 0.08, arrivalDelay: null },
};

/** 雷雨（段階 4）の地上作業の停止: 20 分ごとに 5 分 */
export const LIGHTNING_PERIOD_SEC = 20 * 60;
export const LIGHTNING_STOP_SEC = 5 * 60;

/** 現在の（有効な）段階と種類。手動・シナリオの天候の障害があればそれを優先する */
export function effectiveWx(wx: WxRuntime): { level: WxLevel; type: WxType } {
  return wx.override ? { level: wx.override.level, type: wx.override.type } : { level: wx.level, type: wx.type };
}

/** 段階・種類を含めた効果（雪は走行がさらに遅い） */
export function wxEffects(wx: WxRuntime): WxEffects {
  const { level, type } = effectiveWx(wx);
  const e = LEVEL_EFFECTS[level];
  if (type === 'snow' && level >= 3) return { ...e, taxi: Math.min(e.taxi, 0.7) };
  return e;
}

/** 雷雨による地上作業の停止中か */
export function lightningStop(state: SimState): boolean {
  const wx = state.wx;
  if (!wx) return false;
  const { level, type } = effectiveWx(wx);
  return level >= 4 && type === 'storm' && state.now % LIGHTNING_PERIOD_SEC < LIGHTNING_STOP_SEC;
}

/** 従来の天候の表示（state.weather.kind）への写像 */
export function legacyKindOf(type: WxType): WeatherKind {
  return type === 'clear' || type === 'cloud' ? 'clear' : type === 'storm' ? 'rain' : type;
}

/** 手動・シナリオの天候の障害の段階 */
export function overrideOf(w: WeatherKind): { level: WxLevel; type: WxType } {
  return w === 'rain' ? { level: 2, type: 'rain' } : w === 'snow' ? { level: 3, type: 'snow' } : w === 'fog' ? { level: 3, type: 'fog' } : { level: 0, type: 'clear' };
}

// ---------------------------------------------------------------- 検証

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const WX_TYPES: readonly string[] = ['clear', 'cloud', 'rain', 'snow', 'fog', 'storm'];
const okHour = (h: unknown): boolean => isObj(h) && Number.isInteger(h.level) && (h.level as number) >= 0 && (h.level as number) <= 4 && WX_TYPES.includes(h.type as string);

/** 運航状態の wx の形の厳格な検証（不正は理由の一覧） */
export function checkWxState(raw: unknown): string[] {
  if (!isObj(raw)) return ['運航状態: 天候（wx）の形が不正です'];
  const errors: string[] = [];
  if (!Number.isInteger(raw.day)) errors.push('運航状態: wx.day が整数ではありません');
  if (!Array.isArray(raw.hours) || raw.hours.length !== 24 || !raw.hours.every(okHour)) errors.push('運航状態: wx.hours が 24 時間分の段階（0〜4）・種類ではありません');
  if (!Number.isInteger(raw.level) || (raw.level as number) < 0 || (raw.level as number) > 4 || !WX_TYPES.includes(raw.type as string)) errors.push('運航状態: wx.level・wx.type が不正です');
  if (raw.override !== null && !(isObj(raw.override) && okHour(raw.override) && typeof raw.override.until === 'number')) errors.push('運航状態: wx.override が不正です');
  if (!Array.isArray(raw.rng) || raw.rng.length !== 4 || !raw.rng.every((n) => typeof n === 'number' && Number.isFinite(n))) errors.push('運航状態: wx.rng が不正です');
  return errors;
}
