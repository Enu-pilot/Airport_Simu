import type { SimState } from './types';

/**
 * 工程別の処理実績（5-21: 最混雑 60 分の評価）。
 *
 * 窓口処理の開始時点で「工程・時間帯・処理人数・その工程での待ち時間」を記録する。
 * SimState の外（WeakMap）に置くため、保存形式とフィンガープリントに影響しない。
 * 日次締め（economy/ops）が当日の分を読み取って DailyReport.processPeak に集計する。
 */
export type ProcessStep = 'checkIn' | 'security' | 'emigration' | 'immigration' | 'customs' | 'transferSecurity';

export const PROCESS_STEPS: readonly ProcessStep[] = ['checkIn', 'security', 'emigration', 'immigration', 'customs', 'transferSecurity'];

export function isProcessStep(step: string | undefined): step is ProcessStep {
  return step !== undefined && (PROCESS_STEPS as readonly string[]).includes(step);
}

export interface ProcessHourStat {
  /** 絶対時間の時間帯インデックス（floor(now / 3600)） */
  hour: number;
  step: ProcessStep;
  /** その時間帯に処理を開始した人数 */
  processed: number;
  /** その工程の待ち時間の合計（人×秒ではなくグループ代表値の秒×人数換算前の秒。集計側で人数で割る） */
  waitSecTotal: number;
  /** 待ち時間を数えた人数（平均待ちの分母） */
  waitPax: number;
}

const store = new WeakMap<SimState, Map<string, ProcessHourStat>>();
const waitBase = new WeakMap<SimState, Map<string, number>>();

/** 待ち行列に入った時点の累積待ち（waitSec）を記録し、その工程だけの待ちを切り出す */
export function markProcessQueueJoin(state: SimState, groupId: string, waitSec: number): void {
  let m = waitBase.get(state);
  if (!m) waitBase.set(state, (m = new Map()));
  m.set(groupId, waitSec);
}

/** 窓口処理の開始を記録する。waitSecNow はグループの累積待ち（秒） */
export function recordProcessStart(state: SimState, step: ProcessStep, groupId: string, count: number, waitSecNow: number, now: number): void {
  const base = waitBase.get(state)?.get(groupId);
  const stepWait = base === undefined ? 0 : Math.max(0, waitSecNow - base);
  if (base !== undefined) waitBase.get(state)!.delete(groupId);
  const hour = Math.floor(now / 3600);
  const key = `${step}|${hour}`;
  let m = store.get(state);
  if (!m) store.set(state, (m = new Map()));
  const cur = m.get(key) ?? { hour, step, processed: 0, waitSecTotal: 0, waitPax: 0 };
  cur.processed += count;
  cur.waitSecTotal += stepWait * count;
  cur.waitPax += count;
  m.set(key, cur);
}

/** 指定した絶対時間帯 [fromHour, toHour) の記録を読み取り、消す。記録がなければ null */
export function takeProcessStats(state: SimState, fromHour: number, toHour: number): ProcessHourStat[] | null {
  const m = store.get(state);
  if (!m) return null;
  const out: ProcessHourStat[] = [];
  for (const [key, v] of m) {
    if (v.hour >= fromHour && v.hour < toHour) {
      out.push(v);
      m.delete(key);
    }
  }
  return out.length > 0 ? out : null;
}
