import { Rng } from '../rng';
import type { AirlineScore, ScoreKey } from './airlineScore';
import { SCORE_KEYS } from './airlineScore';
import type { CompanyState } from './company';
import { contractsOf } from './company';
import { AIRLINES, type AirlineType } from './registry';
import { COMPLAINTS_BLOCK_INCREASE, REQUEST_BOOST_DAYS } from './evalRules';

/**
 * 航空会社の評価要素・不満・要望（12B-3a B5。docs/30 §3）。値はすべてゲーム用。
 * 12B-1 の評価カード（airlineScore.ts）の 7 要素の点数を入力に、移動平均 → 満足度の変化 → 不満（ヒステリシス）→ 要望を更新する。
 * 会社の `game.airlineEval` があるときだけ日次の締め（ops.ts の settleDay）から呼ばれる。なければ従来の updateContracts のまま。
 */
export type RequestKind = 'standFor' | 'slot' | 'contactGate' | 'otp';

export interface Complaint {
  key: ScoreKey;
  sinceDay: number;
}

export interface AirlineRequest {
  id: string;
  kind: RequestKind;
  /** standFor: 機種 ID */
  arg?: string;
  sinceDay: number;
  dueDay: number;
}

export interface AirlineEvalEntry {
  /** 要素ごとの指数移動平均（0〜100）。観測のない要素は持たない（中立の 60 として扱う） */
  ema: Partial<Record<ScoreKey, number>>;
  /** 要素ごとの「移動平均が不満の水準を下回った」締めの連続回数 */
  low: Partial<Record<ScoreKey, number>>;
  complaints: Complaint[];
  requests: AirlineRequest[];
  /** 提案の確率が上がる期限（日）。要望を達成すると 7 日 */
  boostUntil: number;
  /** 達成した要望（直近 10 件） */
  done: { day: number; kind: RequestKind }[];
  /** 定時率の要素が良くない日の連続回数（要望 otp の条件） */
  otpBadDays: number;
}

export type AirlineEvalState = Record<string, AirlineEvalEntry>;

/** 移動平均の係数（新しい点数の重み）と、中立の点数 */
export const EMA_ALPHA = 0.3;
export const NEUTRAL = 60;
/** 満足度の変化の範囲（1 日あたり） */
export const DELTA_MIN = -8;
export const DELTA_MAX = 4;
/** 不満: 移動平均がこの値未満の締めが COMPLAINT_DAYS 回続くと発生、この値以上で解消（ヒステリシス） */
export const COMPLAINT_ON = 45;
export const COMPLAINT_OFF = 55;
export const COMPLAINT_DAYS = 2;
/** 要望: 1 日あたりの発生確率・期限（日）・達成の満足度ボーナス */
export const REQUEST_PROB = 0.15;
export const REQUEST_DAYS = 14;
export const REQUEST_BONUS = 5;
export const DONE_LIMIT = 10;

/** 航空会社の種類ごとの重み（各行の合計は 1。ゲーム値） */
export const EVAL_WEIGHTS: Record<AirlineType, Record<ScoreKey, number>> = {
  regional: { otp: 0.3, turnaround: 0.1, stand: 0.15, fees: 0.15, slots: 0.1, aircraft: 0.1, pax: 0.1 },
  lcc: { otp: 0.3, turnaround: 0.15, stand: 0.1, fees: 0.25, slots: 0.1, aircraft: 0.05, pax: 0.05 },
  fullService: { otp: 0.3, turnaround: 0.05, stand: 0.15, fees: 0.1, slots: 0.1, aircraft: 0.15, pax: 0.15 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const emptyEntry = (): AirlineEvalEntry => ({ ema: {}, low: {}, complaints: [], requests: [], boostUntil: 0, done: [], otpBadDays: 0 });

/** 満足度の変化 = Σ 重み × (移動平均 − 60) ÷ 10 を [−8, +4] に丸めた値 */
export function evalDelta(type: AirlineType, ema: Partial<Record<ScoreKey, number>>): number {
  const w = EVAL_WEIGHTS[type];
  let d = 0;
  for (const k of SCORE_KEYS) d += w[k] * (((ema[k] ?? NEUTRAL) - NEUTRAL) / 10);
  return clamp(d, DELTA_MIN, DELTA_MAX);
}

export interface EvalStepInput {
  /** 当日の評価カード（全航空会社） */
  scores: readonly AirlineScore[];
  /** 現在の空港で運航できる機種 */
  operable: ReadonlySet<string>;
}

export interface EvalStepResult {
  /** 航空会社 ID → 満足度の変化（要望の達成ボーナスは含まない） */
  deltas: Record<string, number>;
  /** 要望の達成ボーナス */
  bonus: Record<string, number>;
  events: string[];
}

function nextRequestId(c: CompanyState): string {
  const n = (c.counters.rq ?? 0) + 1;
  c.counters.rq = n;
  return `rq_${n}`;
}

function requestFulfilled(r: AirlineRequest, s: AirlineScore, operable: ReadonlySet<string>): boolean {
  const comp = (k: ScoreKey) => s.components.find((x) => x.key === k);
  switch (r.kind) {
    case 'standFor':
      return r.arg !== undefined && operable.has(r.arg);
    case 'slot':
      return comp('slots')?.level === 'good';
    case 'contactGate':
      return (comp('stand')?.facts.busShare ?? 0) <= 0.3;
    case 'otp':
      return comp('otp')?.level === 'good';
  }
}

/** 今日の状況から、出せる要望の候補（固定の順） */
function requestCandidates(a: (typeof AIRLINES)[number], s: AirlineScore, entry: AirlineEvalEntry): { kind: RequestKind; arg?: string }[] {
  const out: { kind: RequestKind; arg?: string }[] = [];
  const comp = (k: ScoreKey) => s.components.find((x) => x.key === k);
  const names = comp('aircraft')?.facts.names;
  if (comp('aircraft')?.level !== 'good' && comp('aircraft')?.level !== 'n/a' && names?.[0]) out.push({ kind: 'standFor', arg: names[0] });
  const slots = comp('slots');
  if (slots && slots.level !== 'good' && slots.level !== 'n/a') out.push({ kind: 'slot' });
  if (a.type === 'fullService' && (comp('stand')?.facts.busShare ?? 0) > 0.3) out.push({ kind: 'contactGate' });
  if (entry.otpBadDays >= 3) out.push({ kind: 'otp' });
  return out;
}

/**
 * 日次の締めの評価の更新。移動平均 → 満足度の変化 → 不満（ヒステリシス）→ 要望の期限・達成・新規。
 * 乱数は `${c.seed}:req:${day}:${airlineId}`（c.rng を消費しない）。c.airlineEval を更新して、満足度の変化を返す（満足度への反映は updateContracts）。
 */
export function stepAirlineEval(c: CompanyState, input: EvalStepInput): EvalStepResult {
  const state = (c.airlineEval ??= {});
  const deltas: Record<string, number> = {};
  const bonus: Record<string, number> = {};
  const events: string[] = [];
  for (const a of AIRLINES) {
    const s = input.scores.find((x) => x.airlineId === a.id);
    if (!s) continue;
    const hasContract = contractsOf(c, 'active').some((k) => k.airlineId === a.id);
    // 契約も実績もない航空会社は評価しない（従来の満足度の更新と同じ条件）
    if (!hasContract && s.components.every((x) => x.score === null)) continue;
    const e = (state[a.id] ??= emptyEntry());
    for (const comp of s.components) {
      if (comp.score === null) continue;
      e.ema[comp.key] = Math.round(((1 - EMA_ALPHA) * (e.ema[comp.key] ?? NEUTRAL) + EMA_ALPHA * comp.score) * 100) / 100;
    }
    deltas[a.id] = Math.round(evalDelta(a.type, e.ema) * 1000) / 1000;
    // 不満（ヒステリシス）
    for (const k of SCORE_KEYS) {
      const v = e.ema[k];
      if (v === undefined) continue;
      if (v < COMPLAINT_ON) {
        e.low[k] = (e.low[k] ?? 0) + 1;
        if ((e.low[k] ?? 0) >= COMPLAINT_DAYS && !e.complaints.some((x) => x.key === k)) {
          e.complaints.push({ key: k, sinceDay: c.day });
          events.push(`${a.name} に不満が生じました（${k}）`);
        }
      } else {
        // 45 以上の締めで「続く」回数を戻す（帯 45〜55 でも。1-21 S-4）。すでにある不満は帯の間は維持し、55 以上で解消する
        e.low[k] = 0;
        if (v >= COMPLAINT_OFF && e.complaints.some((x) => x.key === k)) {
          e.complaints = e.complaints.filter((x) => x.key !== k);
          events.push(`${a.name} の不満が解消しました（${k}）`);
        }
      }
    }
    // 定時率が良くない日の連続
    const otp = s.components.find((x) => x.key === 'otp');
    if (otp && otp.level !== 'n/a') e.otpBadDays = otp.level === 'good' ? 0 : e.otpBadDays + 1;
    // 要望: 期限切れ → 達成 → 新規（未達の要望は 1 件まで）
    e.requests = e.requests.filter((r) => r.dueDay > c.day);
    for (const r of [...e.requests]) {
      if (!requestFulfilled(r, s, input.operable)) continue;
      e.requests = e.requests.filter((x) => x.id !== r.id);
      e.done.push({ day: c.day, kind: r.kind });
      if (e.done.length > DONE_LIMIT) e.done.splice(0, e.done.length - DONE_LIMIT);
      e.boostUntil = c.day + REQUEST_BOOST_DAYS;
      bonus[a.id] = (bonus[a.id] ?? 0) + REQUEST_BONUS;
      events.push(`${a.name} の要望を達成しました`);
    }
    if (hasContract && e.requests.length === 0) {
      const rng = new Rng(`${c.seed}:req:${c.day}:${a.id}`);
      if (rng.next() < REQUEST_PROB) {
        const cand = requestCandidates(a, s, e);
        if (cand.length > 0) {
          const pick = cand[rng.int(0, cand.length - 1)]!;
          e.requests.push({ id: nextRequestId(c), kind: pick.kind, ...(pick.arg ? { arg: pick.arg } : {}), sinceDay: c.day, dueDay: c.day + REQUEST_DAYS });
          events.push(`${a.name} から要望があります`);
        }
      }
    }
  }
  return { deltas, bonus, events };
}

/** 不満が多く、契約の更新で増便しない航空会社か */
export const blocksIncrease = (c: Pick<CompanyState, 'airlineEval'>, airlineId: string): boolean => (c.airlineEval?.[airlineId]?.complaints.length ?? 0) >= COMPLAINTS_BLOCK_INCREASE;

// ---------------------------------------------------------------- 検証

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEYS: readonly string[] = SCORE_KEYS;
const KINDS: readonly string[] = ['standFor', 'slot', 'contactGate', 'otp'];
const num = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** 会社の airlineEval の形の厳格な検証（不正は理由の一覧） */
export function checkAirlineEval(raw: unknown): string[] {
  if (!isObj(raw)) return ['航空会社の評価（airlineEval）がオブジェクトではありません'];
  const errors: string[] = [];
  const ids = new Set(AIRLINES.map((a) => a.id));
  for (const [id, e] of Object.entries(raw)) {
    const where = `航空会社の評価 ${id}`;
    if (!ids.has(id) || !isObj(e)) {
      errors.push(`${where}: 航空会社が不明か、形が不正です`);
      continue;
    }
    for (const f of ['ema', 'low'] as const) {
      const m = e[f];
      if (!isObj(m) || Object.entries(m).some(([k, v]) => !KEYS.includes(k) || !num(v, 0, f === 'ema' ? 100 : 1e6))) errors.push(`${where}: ${f} が不正です（要素名・値）`);
    }
    if (!Array.isArray(e.complaints) || e.complaints.some((x) => !isObj(x) || !KEYS.includes(x.key as string) || !Number.isInteger(x.sinceDay))) errors.push(`${where}: complaints が不正です`);
    if (!Array.isArray(e.requests) || e.requests.some((x) => !isObj(x) || typeof x.id !== 'string' || !KINDS.includes(x.kind as string) || !Number.isInteger(x.sinceDay) || !Number.isInteger(x.dueDay) || (x.arg !== undefined && typeof x.arg !== 'string'))) errors.push(`${where}: requests が不正です`);
    if (!num(e.boostUntil, 0, 1e9)) errors.push(`${where}: boostUntil が不正です`);
    if (!Array.isArray(e.done) || e.done.some((x) => !isObj(x) || !Number.isInteger(x.day) || !KINDS.includes(x.kind as string))) errors.push(`${where}: done が不正です`);
    if (!num(e.otpBadDays, 0, 1e6)) errors.push(`${where}: otpBadDays が不正です`);
  }
  return errors;
}
