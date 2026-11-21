/**
 * 運航シミュレーションの性能計測（perf-audit.md §7 の実施分）。
 *
 * stepSimulation のサブステップ所要時間、描画（MapRenderer.draw）の所要時間、
 * フレームあたり tick 数・dropped を集計する。**計測は読み取り専用**で、
 * シミュレーションの状態・乱数・処理順には一切触らない（結果は変わらない）。
 *
 * 集計は「直近ウィンドウ」方式: takePerfSnapshot() が前回取得以降の平均を返して
 * アキュムレータをリセットする。性能パネルが数秒ごとにリセットし、表示は peek で読む。
 * 時刻の呼び出しはサブステップ境界だけに抑える（tick あたり十数回）。
 *
 * core は実時間に依存できないため、時計は外から注入する（setPerfClock）。
 * 注入元は editor 層（simRunner が performance.now を渡す）。未注入時は常に 0 を返し、
 * 計測値はすべて 0 になる（テスト・ヘッドレス実行では結果に影響しない）。
 */

/** stepSimulation のサブステップ区分 */
export type PerfStepKey =
  | 'economy'
  | 'disruptions'
  | 'runwayTaxi'
  | 'aircraft'
  | 'passengers'
  | 'accessBus'
  | 'baggage'
  | 'ground'
  | 'conflicts'
  | 'analytics'
  | 'other';

export const PERF_STEP_KEYS: readonly PerfStepKey[] = [
  'economy',
  'disruptions',
  'runwayTaxi',
  'aircraft',
  'passengers',
  'accessBus',
  'baggage',
  'ground',
  'conflicts',
  'analytics',
  'other',
];

/** 規模カウンタ（重さが何に比例するかを見るための併記） */
export interface PerfScale {
  /** 処理中の旅客グループ数（state.activePax） */
  paxGroups: number;
  /** 機体数（state.aircraft の総数） */
  aircraft: number;
  /** 処理中の手荷物数（state.activeBags） */
  bags: number;
  /** 旅客の走査対象グループ数（stepPassengers が毎 tick 処理する数。PERF4-0） */
  paxScan?: number;
  /** 出現待ち（pending）グループ数（PERF4-0） */
  paxPending?: number;
  /** イベント駆動化で眠っているグループ数（PERF4-1 以降） */
  paxSleeping?: number;
  /** 毎 tick 処理されるグループ数 = 歩行中＋タイマー到来（PERF4-1 以降） */
  paxAwake?: number;
}

/** stepPassengers のサブフェーズ区分（PERF4-0: passengers バケットの内訳） */
export type PaxDetailKey = 'flight' | 'occupancy' | 'groups' | 'facility';

export const PAX_DETAIL_KEYS: readonly PaxDetailKey[] = ['flight', 'occupancy', 'groups', 'facility'];

export interface PaxDetailAvg {
  key: PaxDetailKey;
  /** tick あたり平均 ms */
  avgMs: number;
}

export interface PerfStepAvg {
  key: PerfStepKey;
  /** tick あたり平均 ms */
  avgMs: number;
  /** tick 合計に対する割合（0〜1） */
  share: number;
}

export interface PerfSnapshot {
  /** ウィンドウ内の tick 数 */
  ticks: number;
  /** tick 合計の tick あたり平均 ms */
  tickAvgMs: number;
  /** サブステップ内訳（avgMs の降順） */
  steps: PerfStepAvg[];
  /** ウィンドウ内の描画回数と1回あたり平均 ms */
  drawCount: number;
  drawAvgMs: number;
  /** ウィンドウ内のフレーム数とフレームあたり平均 tick 数 */
  frames: number;
  ticksPerFrame: number;
  /** ウィンドウ内で dropped（tick を捨てた）が起きたフレーム数 */
  droppedFrames: number;
  /** 直近に記録された規模カウンタ */
  scale: PerfScale;
  /** passengers サブフェーズ内訳（有効化されていた tick の平均。計測されていない場合は空） */
  paxDetail: PaxDetailAvg[];
  /** サブフェーズ計測が有効だった tick 数 */
  paxDetailTicks: number;
}

interface Accumulator {
  ticks: number;
  tickTotalMs: number;
  stepMs: Record<PerfStepKey, number>;
  paxDetailMs: Record<PaxDetailKey, number>;
  paxDetailTicks: number;
  drawCount: number;
  drawTotalMs: number;
  frames: number;
  frameTicks: number;
  droppedFrames: number;
  scale: PerfScale;
}

const emptyAccumulator = (): Accumulator => ({
  ticks: 0,
  tickTotalMs: 0,
  stepMs: Object.fromEntries(PERF_STEP_KEYS.map((k) => [k, 0])) as Record<PerfStepKey, number>,
  paxDetailMs: Object.fromEntries(PAX_DETAIL_KEYS.map((k) => [k, 0])) as Record<PaxDetailKey, number>,
  paxDetailTicks: 0,
  drawCount: 0,
  drawTotalMs: 0,
  frames: 0,
  frameTicks: 0,
  droppedFrames: 0,
  scale: { paxGroups: 0, aircraft: 0, bags: 0 },
});

let acc = emptyAccumulator();

/** 注入された時計（ミリ秒）。未注入時は 0 固定で、計測はすべて 0 になる */
let nowFn: () => number = () => 0;

/** 実時間の時計を注入する（editor 層の simRunner が performance.now を渡す） */
export function setPerfClock(fn: () => number): void {
  nowFn = fn;
}

const now = (): number => nowFn();

/**
 * tick 内のサブステップ計測チェーン。開始時点で1回、mark のたびに1回だけ時刻を読む。
 * mark(key) は「前回 mark（または開始）から今までの経過」を key の所要として加算する。
 */
export interface PerfChain {
  mark(key: PerfStepKey): void;
  /** 最後の区間を加算し、tick 合計と規模カウンタを記録する */
  finish(key: PerfStepKey, scale: PerfScale): void;
}

export function perfChainStart(): PerfChain {
  let last = now();
  let total = 0;
  const add = (key: PerfStepKey): void => {
    const t = now();
    const ms = t - last;
    last = t;
    total += ms;
    acc.stepMs[key] += ms;
  };
  return {
    mark: add,
    finish(key: PerfStepKey, scale: PerfScale): void {
      add(key);
      acc.ticks += 1;
      acc.tickTotalMs += total;
      acc.scale = { ...paxScaleNote, ...scale };
    },
  };
}

/**
 * passengers サブフェーズ計測（PERF4-0）。
 *
 * 有効化されている間だけ stepPassengers 内で時刻を読む。無効時は paxDetailStart() が
 * null を返し、呼び出し側は追加の時計呼び出しを一切しない（計測オーバーヘッドで
 * 結果も性能特性も変えない）。有効化するのは性能パネルを開いている間とベンチテスト。
 */
let paxDetailEnabled = false;

export function setPaxDetailEnabled(on: boolean): void {
  paxDetailEnabled = on;
}

export function isPaxDetailEnabled(): boolean {
  return paxDetailEnabled;
}

export interface PaxDetailChain {
  mark(key: PaxDetailKey): void;
  finish(key: PaxDetailKey): void;
}

export function paxDetailStart(): PaxDetailChain | null {
  if (!paxDetailEnabled) return null;
  let last = now();
  const add = (key: PaxDetailKey): void => {
    const t = now();
    acc.paxDetailMs[key] += t - last;
    last = t;
  };
  return {
    mark: add,
    finish(key: PaxDetailKey): void {
      add(key);
      acc.paxDetailTicks += 1;
    },
  };
}

/** 旅客側の規模カウンタ（走査対象・pending・睡眠/覚醒）を記録する。finish の scale と合成される */
let paxScaleNote: Partial<PerfScale> = {};

export function notePaxScale(note: Partial<PerfScale>): void {
  paxScaleNote = { ...paxScaleNote, ...note };
}

/** 描画1回の所要時間を記録する（MapView の draw 呼び出し側が実時間で測って渡す） */
export function recordDraw(ms: number): void {
  acc.drawCount += 1;
  acc.drawTotalMs += ms;
}

/** フレーム1回分（simRunner）を記録する: 進めた tick 数と dropped の有無 */
export function recordFrame(ticks: number, dropped: boolean): void {
  acc.frames += 1;
  acc.frameTicks += ticks;
  if (dropped) acc.droppedFrames += 1;
}

/** 前回取得以降の平均を返し、アキュムレータをリセットする（規模カウンタは保持） */
export function takePerfSnapshot(): PerfSnapshot {
  const snap = buildSnapshot(acc);
  const scale = acc.scale;
  acc = emptyAccumulator();
  acc.scale = scale;
  return snap;
}

/** リセットせずに現在の平均を覗く（テスト・診断用） */
export function peekPerfSnapshot(): PerfSnapshot {
  return buildSnapshot(acc);
}

/** 集計をすべて捨てる（テスト用） */
export function resetPerfStats(): void {
  acc = emptyAccumulator();
  paxScaleNote = {};
}

function buildSnapshot(a: Accumulator): PerfSnapshot {
  const ticks = a.ticks;
  const tickAvgMs = ticks > 0 ? a.tickTotalMs / ticks : 0;
  const steps = PERF_STEP_KEYS.map((key) => {
    const avgMs = ticks > 0 ? a.stepMs[key] / ticks : 0;
    return { key, avgMs, share: tickAvgMs > 0 ? avgMs / tickAvgMs : 0 };
  }).sort((x, y) => y.avgMs - x.avgMs);
  return {
    ticks,
    tickAvgMs,
    steps,
    drawCount: a.drawCount,
    drawAvgMs: a.drawCount > 0 ? a.drawTotalMs / a.drawCount : 0,
    frames: a.frames,
    ticksPerFrame: a.frames > 0 ? a.frameTicks / a.frames : 0,
    droppedFrames: a.droppedFrames,
    scale: { ...a.scale },
    paxDetail: a.paxDetailTicks > 0
      ? PAX_DETAIL_KEYS.map((key) => ({ key, avgMs: a.paxDetailMs[key] / a.paxDetailTicks }))
      : [],
    paxDetailTicks: a.paxDetailTicks,
  };
}
