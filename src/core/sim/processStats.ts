import type { SimState } from './types';
import { recordStepWait } from './journeyStats';

/**
 * 工程別の処理実績（5-21: 最混雑 60 分の評価）。
 *
 * 窓口処理の開始時点で「工程・分バケット・処理人数・その工程での待ち時間」を記録する。
 * 分バケットで保持し、日次締め側で連続するローリング 60 分の最大値を算出する
 * （時計の 00 分に固定した 1 時間ではない。5-21 T3）。
 * SimState の外（WeakMap）に置くため、保存形式とフィンガープリントに影響しない。
 * 日次締め（economy/ops）が当日の分を読み取って DailyReport.processPeak に集計する。
 *
 * 工程の追加分（5-21 残件、2026-11-19）:
 * - restroom: 窓口処理と同じ経路で記録する（能力は fixtures から算出できる）。
 * - apronBus: バス運行の完了時点で運んだ人数を記録する。能力は算出しない
 *   （車両台数・定員だけから人/時へ恣意的に換算しない。計画 §3.2）。
 * - access: 出発グループがアクセスを終えて入口に着いた時点で記録する。
 *   能力は空港全体の共有能力のため算出しない（同上）。
 */
export type ProcessStep = 'checkIn' | 'security' | 'emigration' | 'immigration' | 'customs' | 'transferSecurity' | 'restroom' | 'apronBus' | 'access';

export const PROCESS_STEPS: readonly ProcessStep[] = ['checkIn', 'security', 'emigration', 'immigration', 'customs', 'transferSecurity', 'restroom', 'apronBus', 'access'];

export function isProcessStep(step: string | undefined): step is ProcessStep {
  return step !== undefined && (PROCESS_STEPS as readonly string[]).includes(step);
}

export interface ProcessBucketStat {
  /** 絶対時間の分バケットインデックス（floor(now / 60)） */
  minute: number;
  step: ProcessStep;
  /** 処理エリアの所属ターミナル（5-21 T5: ターミナル別内訳用。不明は ''） */
  terminalId: string;
  /** その分に処理を開始した（工程を通過した）人数 */
  processed: number;
  /** その工程の待ち時間の合計（人×秒ではなくグループ代表値の秒×人数換算前の秒。集計側で人数で割る） */
  waitSecTotal: number;
  /** 待ち時間を数えた人数（平均待ちの分母） */
  waitPax: number;
}

const store = new WeakMap<SimState, Map<string, ProcessBucketStat>>();
const waitBase = new WeakMap<SimState, Map<string, number>>();

function bucket(state: SimState, step: ProcessStep, minute: number, terminalId: string): ProcessBucketStat {
  let m = store.get(state);
  if (!m) store.set(state, (m = new Map()));
  const key = `${step}|${terminalId}|${minute}`;
  const cur = m.get(key) ?? { minute, step, terminalId, processed: 0, waitSecTotal: 0, waitPax: 0 };
  m.set(key, cur);
  return cur;
}

/** 待ち行列に入った時点の累積待ち（waitSec）を記録し、その工程だけの待ちを切り出す */
export function markProcessQueueJoin(state: SimState, groupId: string, waitSec: number): void {
  let m = waitBase.get(state);
  if (!m) waitBase.set(state, (m = new Map()));
  m.set(groupId, waitSec);
}

/** 窓口処理の開始を記録する。waitSecNow はグループの累積待ち（秒） */
export function recordProcessStart(state: SimState, step: ProcessStep, groupId: string, count: number, waitSecNow: number, now: number, terminalId = ''): void {
  const base = waitBase.get(state)?.get(groupId);
  const stepWait = base === undefined ? 0 : Math.max(0, waitSecNow - base);
  if (base !== undefined) {
    waitBase.get(state)!.delete(groupId);
    // 5-23: 工程別パーセンタイル用に、切り出した工程内待ちを旅程統計にも渡す
    // （行列参加の基準がある場合だけ。基準なしは待ち不明として数えない）
    recordStepWait(state, step, stepWait, count);
  }
  const cur = bucket(state, step, Math.floor(now / 60), terminalId);
  cur.processed += count;
  cur.waitSecTotal += stepWait * count;
  cur.waitPax += count;
}

/** 窓口を持たない工程（アクセス到着・バス運行完了）の通過人数を記録する。待ちは数えない */
export function recordSimpleProcess(state: SimState, step: ProcessStep, count: number, now: number, terminalId = ''): void {
  if (count <= 0) return;
  const cur = bucket(state, step, Math.floor(now / 60), terminalId);
  cur.processed += count;
}

export interface RollingPeak {
  /** 窓の開始（絶対分バケット） */
  startMinute: number;
  processed: number;
  waitSecTotal: number;
  waitPax: number;
}

/**
 * 分バケット列から連続するローリング 60 分の最大窓を返す（5-21 T3）。
 * 時計の 00 分境界に縛られない。同数の場合は開始時刻の早い窓を採る。
 */
export function rollingPeak60(rows: readonly ProcessBucketStat[]): RollingPeak | null {
  if (rows.length === 0) return null;
  const byMinute = new Map<number, { processed: number; waitSecTotal: number; waitPax: number }>();
  for (const r of rows) {
    const cur = byMinute.get(r.minute) ?? { processed: 0, waitSecTotal: 0, waitPax: 0 };
    cur.processed += r.processed;
    cur.waitSecTotal += r.waitSecTotal;
    cur.waitPax += r.waitPax;
    byMinute.set(r.minute, cur);
  }
  const minutes = [...byMinute.keys()].sort((a, b) => a - b);
  let best: RollingPeak | null = null;
  let lo = 0;
  let processed = 0;
  let waitSecTotal = 0;
  let waitPax = 0;
  for (let hi = 0; hi < minutes.length; hi++) {
    const m = minutes[hi]!;
    const v = byMinute.get(m)!;
    processed += v.processed;
    waitSecTotal += v.waitSecTotal;
    waitPax += v.waitPax;
    while (minutes[lo]! <= m - 60) {
      const out = byMinute.get(minutes[lo]!)!;
      processed -= out.processed;
      waitSecTotal -= out.waitSecTotal;
      waitPax -= out.waitPax;
      lo++;
    }
    // 窓は [minutes[lo], minutes[lo]+60)。実績のない分は 0 なので、開始は実績のある分に置く
    if (!best || processed > best.processed) {
      best = { startMinute: minutes[lo]!, processed, waitSecTotal, waitPax };
    }
  }
  return best;
}

/** 指定した絶対分バケット [fromMinute, toMinute) の記録を読み取り、消す。記録がなければ null */
export function takeProcessStats(state: SimState, fromMinute: number, toMinute: number): ProcessBucketStat[] | null {
  const m = store.get(state);
  if (!m) return null;
  const out: ProcessBucketStat[] = [];
  for (const [key, v] of m) {
    if (v.minute >= fromMinute && v.minute < toMinute) {
      out.push(v);
      m.delete(key);
    }
  }
  return out.length > 0 ? out : null;
}
