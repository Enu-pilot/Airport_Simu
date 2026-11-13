import type { CompanyState } from './company';

/**
 * ゲームのモデル（12B-3a Part B）の設定。会社の `game` があるときだけ有効（なければ従来と完全に同じ。docs/30）。
 * 数値はすべてゲーム用の値で、実在の運用基準・安全基準への適合をうたうものではない。
 */
export type Difficulty = 'normal' | 'hard' | 'expert';
export type Climate = 'temperate' | 'snowy' | 'humid';
export type WeatherModel = 'levels' | 'legacy';

export const DIFFICULTIES: readonly Difficulty[] = ['normal', 'hard', 'expert'];
export const CLIMATES: readonly Climate[] = ['temperate', 'snowy', 'humid'];

export interface GameSettings {
  version: 1;
  difficulty: Difficulty;
  /** levels = 5 段階の天候・予報 / legacy = 従来の 4 種の天候の障害 */
  weather: WeatherModel;
  /** 航空会社の評価要素・不満・要望（満足度を要素から計算する） */
  airlineEval: boolean;
  /** 目標・空港の格 */
  goals: boolean;
  climate: Climate;
}

export interface DifficultyDef {
  /** 悪天の出やすさの倍率 */
  weatherScale: number;
  /** ランダムな障害（天候以外）の頻度の倍率 */
  disruptionScale: number;
  /** 航空会社の求める定時運航率への加算 */
  otpAdd: number;
  /** 初期資金・建設費の倍率 */
  cashMul: number;
  costMul: number;
  /** 予報の的中率（区間ごと） */
  forecastAccuracy: number;
}

/** 難易度の表（ゲーム値。docs/30 §2） */
export const DIFFICULTY: Record<Difficulty, DifficultyDef> = {
  normal: { weatherScale: 1, disruptionScale: 0.6, otpAdd: 0, cashMul: 1, costMul: 1, forecastAccuracy: 0.9 },
  hard: { weatherScale: 1.5, disruptionScale: 1, otpAdd: 0.05, cashMul: 0.75, costMul: 1.1, forecastAccuracy: 0.8 },
  expert: { weatherScale: 2, disruptionScale: 1.5, otpAdd: 0.1, cashMul: 0.5, costMul: 1.2, forecastAccuracy: 0.65 },
};

export function defaultGame(difficulty: Difficulty = 'normal', climate: Climate = 'temperate'): GameSettings {
  return { version: 1, difficulty, weather: 'levels', airlineEval: true, goals: true, climate };
}

/** 形の検証（不正なら理由、正しければ null） */
export function checkGameSettings(g: unknown): string | null {
  if (typeof g !== 'object' || g === null || Array.isArray(g)) return 'ゲーム設定（game）がオブジェクトではありません';
  const o = g as Record<string, unknown>;
  if (o.version !== 1) return 'ゲーム設定（game）の版が不正です';
  if (!DIFFICULTIES.includes(o.difficulty as Difficulty)) return 'ゲーム設定の難易度（difficulty）が不正です';
  if (o.weather !== 'levels' && o.weather !== 'legacy') return 'ゲーム設定の天候（weather）が不正です';
  if (typeof o.airlineEval !== 'boolean' || typeof o.goals !== 'boolean') return 'ゲーム設定の airlineEval・goals が真偽値ではありません';
  if (!CLIMATES.includes(o.climate as Climate)) return 'ゲーム設定の気候（climate）が不正です';
  return null;
}

/** 会社の難易度の定義（game がなければ null） */
export const difficultyOf = (c: Pick<CompanyState, 'game'>): DifficultyDef | null => (c.game ? DIFFICULTY[c.game.difficulty] : null);

/** 建設費の倍率（game がなければ 1） */
export const costMultiplier = (c: Pick<CompanyState, 'game'>): number => difficultyOf(c)?.costMul ?? 1;

/** 航空会社の求める定時運航率への加算（game がなければ 0） */
export const otpAddOf = (c: Pick<CompanyState, 'game'>): number => difficultyOf(c)?.otpAdd ?? 0;

/**
 * 会社のゲーム関連の項目（game・airlineEval・goals）の形の厳格な検証（不正は理由の一覧）。
 * 項目がなければ何も言わない（従来の会社）。プロジェクトの読み込み（validateProject）が使う。
 */
export function checkGameFields(c: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (c.game !== undefined) {
    const e = checkGameSettings(c.game);
    if (e) errors.push(e);
  }
  return errors;
}

/** 設定に合わせて会社の評価・目標の状態を整える（無効な項目は消す。有効な項目の初期状態は各モジュールが遅延して作る） */
export function applyGameState(c: CompanyState): void {
  if (!c.game || !c.game.airlineEval) delete c.airlineEval;
  if (!c.game || !c.game.goals) delete c.goals;
}

/** 建設費を難易度で調整する（増えた分だけ。払い戻し・0 はそのまま。game がなければ従来どおり） */
export function scaleConstructionCost(c: Pick<CompanyState, 'game'>, cost: number): number {
  const m = costMultiplier(c);
  return m === 1 || cost <= 0 ? cost : Math.round(cost * m);
}

/** 新しいゲームの会社にゲーム設定を付ける（初期資金は難易度の倍率。game = null は従来のルール） */
export function startGame(c: CompanyState, game: GameSettings | null): CompanyState {
  if (!game) return c;
  c.game = game;
  c.cash = Math.round(c.cash * DIFFICULTY[game.difficulty].cashMul);
  applyGameState(c);
  return c;
}
