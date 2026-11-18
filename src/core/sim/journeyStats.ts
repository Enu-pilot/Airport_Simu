import type { PaxGroup, SimState } from './types';

/**
 * 旅客 Door-to-Door KPI の記録（5-23）。
 *
 * 完了した旅客グループについて「出現（入口/降機）→ 完了（搭乗/退出）」の所要時間を
 * 人数重みつきで集める。SimState の外（WeakMap）に置き、保存形式と
 * フィンガープリントに影響しない。日次締めが分位点に集計して日報に載せる。
 */
export type JourneyKind = 'departure' | 'arrival' | 'transfer';

interface JourneyStore {
  /** [所要時間（秒）, 人数] の列 */
  durations: Record<JourneyKind, [number, number][]>;
  stepFreeCompleted: number;
  stepFreeMissed: number;
}

const store = new WeakMap<SimState, JourneyStore>();

function of(state: SimState): JourneyStore {
  let s = store.get(state);
  if (!s) store.set(state, (s = { durations: { departure: [], arrival: [], transfer: [] }, stepFreeCompleted: 0, stepFreeMissed: 0 }));
  return s;
}

/** グループの完了（搭乗・退出）時に呼ぶ。appearAt は入口出現（出発）/降機（到着・乗継）の時刻 */
export function recordJourneyFinish(state: SimState, g: PaxGroup): void {
  const duration = state.now - g.appearAt;
  if (duration < 0) return;
  const kind: JourneyKind = g.transfer ? 'transfer' : g.direction === 'departure' ? 'departure' : 'arrival';
  of(state).durations[kind].push([duration, g.count]);
  if (g.stepFree) of(state).stepFreeCompleted += g.count;
}

/** Step-free が必要なグループの乗り遅れ確定時に呼ぶ */
export function recordJourneyStepFreeMiss(state: SimState, count: number): void {
  of(state).stepFreeMissed += count;
}

/** 人数重みつき分位点: 累積人数が total × q に達した最初の所要時間 */
export function weightedPercentile(pairs: readonly [number, number][], q: number): number | null {
  if (pairs.length === 0) return null;
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, n]) => s + n, 0);
  if (total <= 0) return null;
  const target = total * q;
  let acc = 0;
  for (const [v, n] of sorted) {
    acc += n;
    if (acc >= target) return v;
  }
  return sorted[sorted.length - 1]![0];
}

export interface JourneySummary {
  p50Sec: number;
  p95Sec: number;
  pax: number;
}

export interface JourneyStats {
  departure: JourneySummary | null;
  arrival: JourneySummary | null;
  transfer: JourneySummary | null;
  stepFree: { completed: number; missed: number; rate: number | null };
}

function summarize(pairs: readonly [number, number][]): JourneySummary | null {
  const pax = pairs.reduce((s, [, n]) => s + n, 0);
  if (pax <= 0) return null;
  return { p50Sec: weightedPercentile(pairs, 0.5)!, p95Sec: weightedPercentile(pairs, 0.95)!, pax };
}

/** 記録を読み取って消す。何もなければ null */
export function takeJourneyStats(state: SimState): JourneyStats | null {
  const s = store.get(state);
  if (!s) return null;
  store.delete(state);
  const departure = summarize(s.durations.departure);
  const arrival = summarize(s.durations.arrival);
  const transfer = summarize(s.durations.transfer);
  const sfTotal = s.stepFreeCompleted + s.stepFreeMissed;
  if (!departure && !arrival && !transfer && sfTotal === 0) return null;
  return {
    departure,
    arrival,
    transfer,
    stepFree: {
      completed: s.stepFreeCompleted,
      missed: s.stepFreeMissed,
      rate: sfTotal > 0 ? Math.round((s.stepFreeCompleted / sfTotal) * 1000) / 1000 : null,
    },
  };
}
