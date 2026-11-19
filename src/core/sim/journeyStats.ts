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
  /** 工程別の待ち時間 [待ち秒, 人数] の列（5-23 残件: 工程別パーセンタイル） */
  stepWaits: Map<string, [number, number][]>;
  /**
   * グループ ID → 外部境界の出現時刻（5-23 残件）。出発グループはアクセス遅延で
   * appearAt が後ろへずれるため、ずれる前の元の出現時刻をここに保持し、
   * アクセス移動を含む所要時間を測る。SimState の外に置くのは、状態 JSON
   * （フィンガープリント・保存形式）を変えないため（本モジュールの既存方針）。
   * 再読込で失われる場合は appearAt にフォールバックする。
   */
  journeyStarts: Map<string, number>;
  stepFreeCompleted: number;
  stepFreeMissed: number;
}

const store = new WeakMap<SimState, JourneyStore>();

function of(state: SimState): JourneyStore {
  let s = store.get(state);
  if (!s) store.set(state, (s = { durations: { departure: [], arrival: [], transfer: [] }, stepWaits: new Map(), journeyStarts: new Map(), stepFreeCompleted: 0, stepFreeMissed: 0 }));
  return s;
}

/** グループの出現時に外部境界の起点を記録する（addGroup から呼ぶ） */
export function recordJourneyStart(state: SimState, groupId: string, at: number): void {
  of(state).journeyStarts.set(groupId, at);
}

/**
 * グループの完了（搭乗・退出）時に呼ぶ。
 * 起点は外部境界（5-23 残件）: 出発はアクセス移動を含む元の出現時刻、
 * 到着・乗継は降機時刻（= appearAt、起点の記録と同値）。
 */
export function recordJourneyFinish(state: SimState, g: PaxGroup): void {
  const start = of(state).journeyStarts.get(g.id) ?? g.appearAt;
  of(state).journeyStarts.delete(g.id);
  const duration = state.now - start;
  if (duration < 0) return;
  const kind: JourneyKind = g.transfer ? 'transfer' : g.direction === 'departure' ? 'departure' : 'arrival';
  of(state).durations[kind].push([duration, g.count]);
  if (g.stepFree) of(state).stepFreeCompleted += g.count;
}

/** Step-free が必要なグループの乗り遅れ確定時に呼ぶ */
export function recordJourneyStepFreeMiss(state: SimState, count: number): void {
  of(state).stepFreeMissed += count;
}

/**
 * 工程別の待ち時間を記録する（5-23 残件）。processStats の recordProcessStart が
 * 工程内待ちを切り出したときに呼ぶ。待ちの分位点は「どの工程で待たされるか」を
 * 示すためのもので、処理時間そのものではない（ラベルは表示側で待ちと明示する）。
 */
export function recordStepWait(state: SimState, step: string, waitSec: number, count: number): void {
  if (count <= 0 || waitSec < 0) return;
  const s = of(state);
  const arr = s.stepWaits.get(step) ?? [];
  arr.push([waitSec, count]);
  s.stepWaits.set(step, arr);
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
  /** 工程別の待ち時間の分位点（5-23 残件。記録のある工程だけ） */
  stepWaits?: Record<string, JourneySummary>;
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
  const stepWaits: Record<string, JourneySummary> = {};
  for (const [step, pairs] of s.stepWaits) {
    const summary = summarize(pairs);
    if (summary) stepWaits[step] = summary;
  }
  return {
    departure,
    arrival,
    transfer,
    stepFree: {
      completed: s.stepFreeCompleted,
      missed: s.stepFreeMissed,
      rate: sfTotal > 0 ? Math.round((s.stepFreeCompleted / sfTotal) * 1000) / 1000 : null,
    },
    ...(Object.keys(stepWaits).length > 0 ? { stepWaits } : {}),
  };
}
