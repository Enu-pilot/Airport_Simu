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

export type Tier = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface GoalState {
  /** 達成した目標 ID → 達成した日（0 始まり） */
  done: Record<string, number>;
  /** 連続日数を数える目標・格の昇格の連続 */
  streaks: Record<string, number>;
  /**
   * 最長の連続記録（2026-GOALS。キーは streaks と同じ: 目標 ID・`tier`・`chain`）。
   * 日次の評価で連続が伸びたときだけ更新する（表示・記録専用で、判定には使わない）。
   * 欠落 = 未記録（旧セーブは読み込み時に現在の streaks から種付けする。表示側も現在の連続で下限を取る）。
   */
  bestStreaks?: Record<string, number>;
  /** 空港の格（0 飛行場 〜 7 メガハブ空港。5-20 で 8 段階化） */
  tier: Tier;
  /**
   * 格の尺度の版（5-20）。2 = 8 段階尺度。欠落 = 旧 4 段階尺度で、
   * 読み込み時に一度だけ新尺度へ移行する（旧 3 → 新 5、他は同値）。
   */
  tierScale?: 2;
  /** 報酬の記録（日報の営業収支には入れない。直近 100 件） */
  grants: GoalGrant[];
  /** 契約提案の確率が上がる期限（日） */
  boostUntil: number;
  /** 最後に格が上がった日（なければ欠落） */
  tierDay?: number;
  /** 目標の連鎖（5-07）: 固定 12 個をすべて達成した後に続く生成目標の進み具合。欠落 = 未開始 */
  chain?: { index: number; streak: number };
}

export const initialGoals = (): GoalState => ({ done: {}, streaks: {}, tier: 0, tierScale: 2, grants: [], boostUntil: 0 });

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

// ---------------------------------------------------------------- 目標の連鎖（5-07 / docs/39 E1）

/**
 * 固定 12 個をすべて達成した後に続く生成目標。3 種（発着・旅客・定時率の連続）が順に現れ、
 * 1 周ごとに目標値が上がる。達成するたびに次の 1 つだけが出る（連鎖）。
 */
export interface ChainGoalInfo { kind: 'movements' | 'pax' | 'otp'; target: number; streakDays: number; cash: number }

export function chainGoalInfo(index: number): ChainGoalInfo {
  const cycle = index % 3;
  const level = Math.floor(index / 3);
  const cash = 2_000_000 * (index + 1);
  if (cycle === 0) return { kind: 'movements', target: 600 + 400 * level, streakDays: 0, cash };
  if (cycle === 1) return { kind: 'pax', target: 20_000 + 15_000 * level, streakDays: 0, cash };
  return { kind: 'otp', target: level >= 1 ? 0.95 : 0.92, streakDays: level >= 1 ? 7 : 5, cash };
}

export function chainGoalAt(index: number): GoalDef {
  const info = chainGoalInfo(index);
  const base: GoalDef = {
    id: `chain-${index}`,
    tier: 3,
    check: (x) => (info.kind === 'movements' ? mov(x) >= info.target : info.kind === 'pax' ? pax(x) >= info.target : x.report.kpi.otp !== null && x.report.kpi.otp >= info.target),
    reward: { cash: info.cash, ...(info.kind === 'otp' ? { rating: 1 } : {}) },
  };
  if (info.kind === 'otp') base.streak = info.streakDays;
  return base;
}

/** 空港の格の条件（5-20 で 8 段階化。その日の実績で判定し、満たす日が streakDays 日続くと昇格。降格しない） */
export const TIER_STREAK = 3;
export const TIER_NAMES = ['飛行場', '地方空港', '地域拠点空港', '国内主要空港', '国際空港', '国際ハブ空港', '広域ハブ空港', 'メガハブ空港'] as const;

export interface TierReq {
  movements: number;
  pax: number;
  rating: number;
  /** L 区分の機種が運航できること */
  heavy: boolean;
  /** 条件を満たし続ける日数 */
  streakDays: number;
  /** 国際線の実運航実績（完了した国際線の記録）がその日にあること */
  intlOps?: boolean;
  /** 乗継の実績（乗継旅客を運んだ記録）がその日にあること */
  transferOps?: boolean;
}

/** 格 1・2 の要件は旧尺度と同一。格 3 以降は 5-20 計画 §3.2 の仮案（ゲーム値） */
export const TIER_REQ: Record<1 | 2 | 3 | 4 | 5 | 6 | 7, TierReq> = {
  1: { movements: 20, pax: 2_000, rating: 0, heavy: false, streakDays: 3 },
  2: { movements: 80, pax: 10_000, rating: 60, heavy: false, streakDays: 3 },
  3: { movements: 200, pax: 30_000, rating: 70, heavy: true, streakDays: 5 },
  4: { movements: 300, pax: 45_000, rating: 75, heavy: true, streakDays: 7 },
  5: { movements: 450, pax: 75_000, rating: 78, heavy: true, streakDays: 7, intlOps: true },
  6: { movements: 650, pax: 120_000, rating: 82, heavy: true, streakDays: 10, transferOps: true },
  7: { movements: 900, pax: 180_000, rating: 85, heavy: true, streakDays: 14 },
};

function meetsTier(t: 1 | 2 | 3 | 4 | 5 | 6 | 7, x: GoalCtx): boolean {
  const r = TIER_REQ[t];
  if (mov(x) < r.movements || pax(x) < r.pax || x.c.rating < r.rating) return false;
  if (r.heavy && !x.largeOperable) return false;
  if (r.intlOps && !x.records.some((rec) => rec.result === 'completed' && rec.international)) return false;
  if (r.transferOps && !x.records.some((rec) => (rec.transferPax ?? 0) > 0)) return false;
  return true;
}

/**
 * 旧尺度（4 段階）の格を新尺度（8 段階）へ移す対応（5-20 §3.7）。
 * 旧 3 は国際・ハブ機能の解放済み範囲を保つため新 5 へ移す。それ以外は同値。
 */
export const LEGACY_TIER_MAP: Record<number, Tier> = { 0: 0, 1: 1, 2: 2, 3: 5 };

export interface GoalResult {
  /** 今回達成した目標 ID */
  completed: string[];
  /** 昇格した格（なければ null） */
  tierUp: Tier | null;
  /** 付与した現金の合計 */
  cash: number;
}

/** 連続日数を 1 日分進め（ok で +1、外れたら 0）、最長記録も保つ。新しい連続日数を返す */
function bumpStreak(g: GoalState, key: string, ok: boolean): number {
  const next = ok ? (g.streaks[key] ?? 0) + 1 : 0;
  g.streaks[key] = next;
  if (next > (g.bestStreaks?.[key] ?? 0)) (g.bestStreaks ??= {})[key] = next;
  return next;
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
      if (bumpStreak(g, def.id, ok) < def.streak) continue;
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
  // 目標の連鎖: 固定 12 個をすべて達成したら、生成目標を 1 つずつ評価する
  if (GOALS.every((d) => g.done[d.id] !== undefined)) {
    const ch = (g.chain ??= { index: 0, streak: 0 });
    const def = chainGoalAt(ch.index);
    const ok = def.check(ctx);
    if (def.streak) {
      ch.streak = ok ? ch.streak + 1 : 0;
      // 連鎖の連続は chain 側に持つため、最長記録だけ bestStreaks に写す（達成で 0 に戻る前に残す）
      if (ch.streak > (g.bestStreaks?.chain ?? 0)) (g.bestStreaks ??= {}).chain = ch.streak;
    }
    const complete = def.streak ? ch.streak >= def.streak : ok;
    if (complete) {
      completed.push(def.id);
      const r = def.reward;
      if (r.cash) {
        c.cash += r.cash;
        cash += r.cash;
      }
      g.grants.push({ day, id: def.id, amount: r.cash ?? 0 });
      if (r.rating) c.rating = Math.min(100, Math.round((c.rating + r.rating) * 10) / 10);
      ch.index += 1;
      ch.streak = 0;
    }
  }
  if (g.grants.length > GRANT_LIMIT) g.grants.splice(0, g.grants.length - GRANT_LIMIT);
  // 空港の格: 次の格の条件を満たす日が続くと昇格（降格しない。1 日に 1 段）
  let tierUp: Tier | null = null;
  if (g.tier < 7) {
    const next = (g.tier + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
    bumpStreak(g, 'tier', meetsTier(next, ctx));
    if ((g.streaks.tier ?? 0) >= TIER_REQ[next].streakDays) {
      g.tier = next;
      g.tierDay = day;
      g.streaks.tier = 0;
      tierUp = next;
    }
  }
  return { completed, tierUp, cash };
}

/** 次の格の要件ごとの到達度（表示用。判定は meetsTier と同じ定義で値を読むだけ） */
export interface TierProgressItem {
  key: 'movements' | 'pax' | 'rating' | 'heavy' | 'intlOps' | 'transferOps';
  /** 数値要件（発着・旅客・評価のみ。それ以外は null） */
  required: number | null;
  /** 現在値（発着・旅客は直近の日報、評価は現在の会社評価。それ以外は null） */
  current: number | null;
  /** 達成しているか。判定材料が渡されていない場合は null（不明） */
  met: boolean | null;
  /** 数値要件の不足分（達成済みは 0） */
  shortfall: number | null;
}

export interface NextTierProgress {
  /** 現在の格 */
  tier: Tier;
  /** 次の格（最高格では null） */
  next: 1 | 2 | 3 | 4 | 5 | 6 | 7 | null;
  /** 次の格の要件（next が null のときは null） */
  req: TierReq | null;
  /** 要件ごとの到達度（数値 3 軸は常時、大型機・国際線・乗継は要件にあるときだけ） */
  items: TierProgressItem[];
  /** 連続達成の進捗（next が null のときは null） */
  streak: { current: number; required: number } | null;
  /** 現在値の根拠にした日報の日（日報がまだない場合は null。その場合の発着・旅客は 0） */
  reportDay: number | null;
}

/** ある格の要件ごとの到達度（表示専用。現在値の定義は meetsTier と同じ） */
function tierProgressItems(
  req: TierReq,
  c: CompanyState,
  facts?: { largeOperable?: boolean; records?: readonly FlightRecord[] },
): TierProgressItem[] {
  const report = c.reports[c.reports.length - 1];
  const numeric = (key: 'movements' | 'pax' | 'rating', required: number, current: number): TierProgressItem => ({
    key,
    required,
    current,
    met: current >= required,
    shortfall: Math.max(0, required - current),
  });
  const items: TierProgressItem[] = [
    numeric('movements', req.movements, report?.kpi.movements ?? 0),
    numeric('pax', req.pax, report ? report.kpi.paxDeparted + report.kpi.paxArrived : 0),
    numeric('rating', req.rating, c.rating),
  ];
  if (req.heavy) {
    items.push({ key: 'heavy', required: null, current: null, met: facts?.largeOperable ?? null, shortfall: null });
  }
  if (req.intlOps) {
    items.push({
      key: 'intlOps', required: null, current: null, shortfall: null,
      met: facts?.records ? facts.records.some((r) => r.result === 'completed' && r.international) : null,
    });
  }
  if (req.transferOps) {
    items.push({
      key: 'transferOps', required: null, current: null, shortfall: null,
      met: facts?.records ? facts.records.some((r) => (r.transferPax ?? 0) > 0) : null,
    });
  }
  return items;
}

/**
 * 次の格までの到達度（5-20 T6。表示専用で、判定・昇格には使わない）。
 * 現在値は meetsTier と同じ定義: 発着・旅客は直近の日報、評価は現在の会社評価、
 * 大型機は空港で L 区分が運航できるか、国際線・乗継は直近の締め日の記録に実績があるか。
 * 大型機と記録は会社の外の情報なので facts で渡す（渡されなければ met は null = 不明）。
 * goals を持たない会社（サンドボックス等）は対象外として null を返す。
 */
export function nextTierProgress(
  c: CompanyState,
  facts?: { largeOperable?: boolean; records?: readonly FlightRecord[] },
): NextTierProgress | null {
  const g = c.goals;
  if (!g) return null;
  if (g.tier >= 7) return { tier: g.tier, next: null, req: null, items: [], streak: null, reportDay: c.reports[c.reports.length - 1]?.day ?? null };
  const next = (g.tier + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
  const req = TIER_REQ[next];
  return {
    tier: g.tier,
    next,
    req,
    items: tierProgressItems(req, c, facts),
    streak: { current: g.streaks.tier ?? 0, required: req.streakDays },
    reportDay: c.reports[c.reports.length - 1]?.day ?? null,
  };
}

// ---------------------------------------------------------------- 格のロードマップ（2026-GOALS）

export type TierRoadmapStatus = 'achieved' | 'current' | 'next' | 'locked';

export interface TierRoadmapEntry {
  /** 対象の格（0〜7） */
  tier: Tier;
  /** 現在の格との関係（下 = 達成済み、同じ = 現在、+1 = 次、それより上 = 未到達） */
  status: TierRoadmapStatus;
  /** その格の要件（格 0 は要件なしで null） */
  req: TierReq | null;
  /** 要件ごとの現在の達成状況（定義は nextTierProgress と同じ。格 0 は空） */
  items: TierProgressItem[];
  /** その格へ昇格した日（現在の格のみ、tierDay 由来。過去の格の分は保持していないので null） */
  reachedDay: number | null;
}

export interface TierRoadmap {
  /** 現在の格 */
  tier: Tier;
  /** 格 0〜7 の全行（ロードマップ） */
  entries: TierRoadmapEntry[];
  /**
   * 次の格への連続達成の要約（最高格では null）。
   * best は最長記録（bestStreaks 由来。未記録の旧データでは現在の連続が下限）。
   */
  streak: { current: number; required: number; best: number } | null;
  /** 現在値の根拠にした日報の日（日報がまだない場合は null） */
  reportDay: number | null;
}

/**
 * 全ての格のロードマップ（2026-GOALS。表示専用で、判定・昇格には使わない）。
 * 各格の要件と、nextTierProgress と同じ定義の「現在の達成状況」を並べる。
 * 達成済みの格でも現在値で判定し直すため、評価の低下などで未達表示になることがある
 * （格そのものは降格しない。要件を満たし続けているかの目安として読む）。
 * goals を持たない会社は対象外として null を返す。
 */
export function tierRoadmap(
  c: CompanyState,
  facts?: { largeOperable?: boolean; records?: readonly FlightRecord[] },
): TierRoadmap | null {
  const g = c.goals;
  if (!g) return null;
  const entries: TierRoadmapEntry[] = ([0, 1, 2, 3, 4, 5, 6, 7] as const).map((t) => {
    const status: TierRoadmapStatus = t < g.tier ? 'achieved' : t === g.tier ? 'current' : t === g.tier + 1 ? 'next' : 'locked';
    if (t === 0) return { tier: t, status, req: null, items: [], reachedDay: null };
    const req = TIER_REQ[t];
    return {
      tier: t,
      status,
      req,
      items: tierProgressItems(req, c, facts),
      reachedDay: t === g.tier ? (g.tierDay ?? null) : null,
    };
  });
  const current = g.streaks.tier ?? 0;
  return {
    tier: g.tier,
    entries,
    streak: g.tier >= 7 ? null : {
      current,
      required: TIER_REQ[(g.tier + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7].streakDays,
      best: Math.max(g.bestStreaks?.tier ?? 0, current),
    },
    reportDay: c.reports[c.reports.length - 1]?.day ?? null,
  };
}

/** 次に目指す目標（未達成を、格の低い順・登録順に最大 n 個）。固定をすべて達成したら連鎖の現在分 */
export function nextGoals(g: GoalState | undefined, n = 3): GoalDef[] {
  const rest = GOALS.filter((d) => g?.done[d.id] === undefined)
    .sort((a, b) => a.tier - b.tier)
    .slice(0, n);
  if (rest.length > 0) return rest;
  return [chainGoalAt(g?.chain?.index ?? 0)];
}

// ---------------------------------------------------------------- 検証

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 会社の goals の形の厳格な検証（不正は理由の一覧） */
export function checkGoals(raw: unknown): string[] {
  if (!isObj(raw)) return ['目標（goals）がオブジェクトではありません'];
  const errors: string[] = [];
  if (!isObj(raw.done) || Object.entries(raw.done).some(([k, v]) => !GOAL_IDS.includes(k) || !Number.isInteger(v))) errors.push('目標: done が不正です（目標 ID・日）');
  if (!isObj(raw.streaks) || Object.values(raw.streaks).some((v) => !Number.isInteger(v) || (v as number) < 0)) errors.push('目標: streaks が不正です');
  if (raw.bestStreaks !== undefined && (!isObj(raw.bestStreaks) || Object.values(raw.bestStreaks).some((v) => !Number.isInteger(v) || (v as number) < 0))) errors.push('目標: bestStreaks（最長記録）が不正です');
  if (!Number.isInteger(raw.tier) || (raw.tier as number) < 0 || (raw.tier as number) > 7) errors.push('目標: tier（空港の格）が 0〜7 ではありません');
  if (raw.tierScale !== undefined && raw.tierScale !== 2) errors.push('目標: tierScale（格の尺度）が不正です');
  if (!Array.isArray(raw.grants) || raw.grants.some((x) => !isObj(x) || !Number.isInteger(x.day) || !(GOAL_IDS.includes(x.id as string) || /^chain-\d+$/.test(x.id as string)) || typeof x.amount !== 'number' || !Number.isFinite(x.amount))) errors.push('目標: grants が不正です');
  if (raw.chain !== undefined && (!isObj(raw.chain) || !Number.isInteger(raw.chain.index) || (raw.chain.index as number) < 0 || !Number.isInteger(raw.chain.streak) || (raw.chain.streak as number) < 0)) errors.push('目標: chain が不正です');
  if (typeof raw.boostUntil !== 'number' || !Number.isFinite(raw.boostUntil)) errors.push('目標: boostUntil が数値ではありません');
  if (raw.tierDay !== undefined && !Number.isInteger(raw.tierDay)) errors.push('目標: tierDay が整数ではありません');
  return errors;
}
