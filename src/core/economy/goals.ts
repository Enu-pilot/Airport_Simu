import type { FlightRecord } from '../analytics/records';
import type { AirportLayout } from '../model/types';
import { resolveType, type TypeTable } from '../sim/aircraftTypes';
import type { CompanyState, DailyReport } from './company';

/**
 * 目標・マイルストーンと空港の格（12B-3a B6。docs/30 §4）。数値はすべてゲーム用の値。
 * 会社の `game.goals` があるときだけ、日次の締めの最後（日報を積んだ後、日を進める前）に評価する（決定的）。
 * 報酬の現金は `goals.grants` に記録して会社の現金に足し、その日の営業収支（日報の収入・費用）には入れない。
 */
export interface GoalGrant {
  day: number;
  id: string;
  amount: number;
}

export type Tier = 0 | 1 | 2 | 3;

export interface GoalState {
  /** 達成した目標 ID → 達成した日（0 始まり） */
  done: Record<string, number>;
  /** 連続日数を数える目標・格の昇格の連続 */
  streaks: Record<string, number>;
  /** 空港の格（0 飛行場 / 1 地方空港 / 2 拠点空港 / 3 国際ハブ） */
  tier: Tier;
  /** 報酬の記録（日報の営業収支には入れない。直近 100 件） */
  grants: GoalGrant[];
  /** 契約提案の確率が上がる期限（日） */
  boostUntil: number;
}

export const initialGoals = (): GoalState => ({ done: {}, streaks: {}, tier: 0, grants: [], boostUntil: 0 });

export const GRANT_LIMIT = 100;

export interface GoalCtx {
  c: CompanyState;
  /** 締めた日の日報 */
  report: DailyReport;
  layout: AirportLayout;
  /** 締めた日の実績の記録 */
  records: readonly FlightRecord[];
  types: TypeTable;
  /** 現在の空港で L 区分の機種が運航できる */
  largeOperable: boolean;
}

export interface GoalReward {
  cash?: number;
  rating?: number;
  /** 契約提案の確率が上がる日数 */
  offerBoostDays?: number;
}

export interface GoalDef {
  id: string;
  /** 難しさの段階（目標カードの並びと、どの格から出すか） */
  tier: Tier;
  /** その日の日報・記録での判定 */
  check(x: GoalCtx): boolean;
  /** 連続日数が必要な目標（check が真の日が連続した回数） */
  streak?: number;
  reward: GoalReward;
}

const mov = (x: GoalCtx) => x.report.kpi.movements;
const pax = (x: GoalCtx) => x.report.kpi.paxDeparted + x.report.kpi.paxArrived;

/** 目標の登録表（12 個。ゲーム値） */
export const GOALS: readonly GoalDef[] = [
  { id: 'flights10', tier: 0, check: (x) => x.report.kpi.flights >= 10, reward: { cash: 300_000 } },
  { id: 'otp85x3', tier: 0, check: (x) => x.report.kpi.otp !== null && x.report.kpi.otp >= 0.85, streak: 3, reward: { rating: 2 } },
  { id: 'mov50', tier: 1, check: (x) => mov(x) >= 50, reward: { cash: 1_000_000 } },
  { id: 'firstHeavy', tier: 1, check: (x) => x.records.some((r) => r.result === 'completed' && resolveType(x.types, r.typeId).size === 'L'), reward: { offerBoostDays: 30 } },
  { id: 'firstBus', tier: 1, check: (x) => x.records.some((r) => r.result === 'completed' && r.boarding === 'bus'), reward: { cash: 200_000 } },
  { id: 'rail', tier: 1, check: (x) => Object.values(x.layout.facilities).some((f) => f.kind === 'railStation' && f.buildState === 'operational'), reward: { rating: 2 } },
  { id: 'noMiss', tier: 1, check: (x) => x.report.kpi.flights >= 20 && x.report.kpi.missedPax === 0, reward: { rating: 1 } },
  { id: 'pax10k', tier: 2, check: (x) => pax(x) >= 10_000, reward: { cash: 2_000_000 } },
  { id: 'mov200', tier: 2, check: (x) => mov(x) >= 200, reward: { cash: 5_000_000 } },
  { id: 'rating80', tier: 2, check: (x) => x.c.rating >= 80, reward: { offerBoostDays: 30 } },
  { id: 'mov500', tier: 3, check: (x) => mov(x) >= 500, reward: { cash: 10_000_000 } },
  { id: 'otp95x7', tier: 3, check: (x) => x.report.kpi.otp !== null && x.report.kpi.otp >= 0.95, streak: 7, reward: { cash: 3_000_000, rating: 2 } },
];

export const GOAL_IDS: readonly string[] = GOALS.map((g) => g.id);

/** 空港の格の条件（その日の実績で判定し、満たす日が TIER_STREAK 日続くと昇格。降格しない） */
export const TIER_STREAK = 3;
export const TIER_NAMES = ['飛行場', '地方空港', '拠点空港', '国際ハブ'] as const;
export const TIER_REQ: Record<1 | 2 | 3, { movements: number; pax: number; rating: number; heavy: boolean }> = {
  1: { movements: 20, pax: 2_000, rating: 0, heavy: false },
  2: { movements: 80, pax: 10_000, rating: 60, heavy: false },
  3: { movements: 200, pax: 30_000, rating: 70, heavy: true },
};

function meetsTier(t: 1 | 2 | 3, x: GoalCtx): boolean {
  const r = TIER_REQ[t];
  return mov(x) >= r.movements && pax(x) >= r.pax && x.c.rating >= r.rating && (!r.heavy || x.largeOperable);
}

export interface GoalResult {
  /** 今回達成した目標 ID */
  completed: string[];
  /** 昇格した格（なければ null） */
  tierUp: Tier | null;
  /** 付与した現金の合計 */
  cash: number;
}

/**
 * 日次の評価。目標の判定 → 報酬（現金・評価・提案ブースト）→ 空港の格の昇格。c.goals を更新する。
 * 会社の現金への加算は `post` を使わず直接足す（日報の営業収支に入れない）。
 */
export function evaluateGoals(c: CompanyState, x: Omit<GoalCtx, 'c'>): GoalResult {
  const g = (c.goals ??= initialGoals());
  const ctx: GoalCtx = { c, ...x };
  const day = x.report.day;
  const completed: string[] = [];
  let cash = 0;
  for (const def of GOALS) {
    if (g.done[def.id] !== undefined) continue;
    const ok = def.check(ctx);
    if (def.streak) {
      g.streaks[def.id] = ok ? (g.streaks[def.id] ?? 0) + 1 : 0;
      if ((g.streaks[def.id] ?? 0) < def.streak) continue;
    } else if (!ok) continue;
    g.done[def.id] = day;
    completed.push(def.id);
    const r = def.reward;
    if (r.cash) {
      c.cash += r.cash;
      cash += r.cash;
      g.grants.push({ day, id: def.id, amount: r.cash });
    } else g.grants.push({ day, id: def.id, amount: 0 });
    if (r.rating) c.rating = Math.min(100, Math.round((c.rating + r.rating) * 10) / 10);
    if (r.offerBoostDays) g.boostUntil = Math.max(g.boostUntil, c.day + 1 + r.offerBoostDays);
  }
  if (g.grants.length > GRANT_LIMIT) g.grants.splice(0, g.grants.length - GRANT_LIMIT);
  // 空港の格: 次の格の条件を満たす日が続くと昇格（降格しない。1 日に 1 段）
  let tierUp: Tier | null = null;
  if (g.tier < 3) {
    const next = (g.tier + 1) as 1 | 2 | 3;
    g.streaks.tier = meetsTier(next, ctx) ? (g.streaks.tier ?? 0) + 1 : 0;
    if ((g.streaks.tier ?? 0) >= TIER_STREAK) {
      g.tier = next;
      g.streaks.tier = 0;
      tierUp = next;
    }
  }
  return { completed, tierUp, cash };
}

/** 次に目指す目標（未達成を、格の低い順・登録順に最大 n 個） */
export function nextGoals(g: GoalState | undefined, n = 3): GoalDef[] {
  return GOALS.filter((d) => g?.done[d.id] === undefined)
    .sort((a, b) => a.tier - b.tier)
    .slice(0, n);
}

// ---------------------------------------------------------------- 検証

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 会社の goals の形の厳格な検証（不正は理由の一覧） */
export function checkGoals(raw: unknown): string[] {
  if (!isObj(raw)) return ['目標（goals）がオブジェクトではありません'];
  const errors: string[] = [];
  if (!isObj(raw.done) || Object.entries(raw.done).some(([k, v]) => !GOAL_IDS.includes(k) || !Number.isInteger(v))) errors.push('目標: done が不正です（目標 ID・日）');
  if (!isObj(raw.streaks) || Object.values(raw.streaks).some((v) => !Number.isInteger(v) || (v as number) < 0)) errors.push('目標: streaks が不正です');
  if (raw.tier !== 0 && raw.tier !== 1 && raw.tier !== 2 && raw.tier !== 3) errors.push('目標: tier（空港の格）が 0〜3 ではありません');
  if (!Array.isArray(raw.grants) || raw.grants.some((x) => !isObj(x) || !Number.isInteger(x.day) || !GOAL_IDS.includes(x.id as string) || typeof x.amount !== 'number' || !Number.isFinite(x.amount))) errors.push('目標: grants が不正です');
  if (typeof raw.boostUntil !== 'number' || !Number.isFinite(raw.boostUntil)) errors.push('目標: boostUntil が数値ではありません');
  return errors;
}
