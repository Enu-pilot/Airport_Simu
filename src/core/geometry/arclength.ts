/**
 * 弧長テーブル（累積長 LUT + Newton 補正で s → t）。
 * 速さ関数 `speed(t) = |dP/dt|` を受け取る汎用実装（曲線の種類に依存しない）。
 */
import { integrateAdaptive } from './integrate';
import { LENGTH_REL_TOL } from './tolerance';

export interface ArcLengthTable {
  /** t の分割点（0 .. 1、n + 1 個） */
  readonly ts: readonly number[];
  /** 各分割点までの累積長 */
  readonly ss: readonly number[];
  readonly total: number;
  readonly speed: (t: number) => number;
  /** 速さが一定（線分・円弧）なら s と t は比例する */
  readonly uniform: boolean;
}

export function buildArcLengthTable(speed: (t: number) => number, n = 64, uniform = false, knownTotal?: number): ArcLengthTable {
  const ts: number[] = [];
  const ss: number[] = [];
  let acc = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    ts.push(t);
    if (i > 0) acc += integrateAdaptive(speed, ts[i - 1]!, t, LENGTH_REL_TOL);
    ss.push(acc);
  }
  const total = knownTotal ?? acc;
  if (uniform) {
    for (let i = 0; i <= n; i++) ss[i] = total * (i / n);
  }
  return { ts, ss, total, speed, uniform };
}

/** 長さ s（[0, total] にクランプ）に対応する t */
export function tAtLength(tbl: ArcLengthTable, s: number): number {
  if (!(s > 0)) return 0;
  if (s >= tbl.total) return 1;
  if (tbl.uniform) return s / tbl.total;
  // 区間の特定（二分探索: ss[lo] <= s < ss[lo+1]）
  let lo = 0;
  let hi = tbl.ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tbl.ss[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const a0 = tbl.ts[lo]!;
  let a = a0;
  let b = tbl.ts[hi]!;
  const sa = tbl.ss[lo]!;
  const sb = tbl.ss[hi]!;
  const span = sb - sa;
  let t = span > 0 ? a + ((b - a) * (s - sa)) / span : a;
  const tol = LENGTH_REL_TOL * Math.max(tbl.total, 1e-12);
  // Newton（区間内に保持、外れたら二分）。g(t) = ∫_{a0}^t speed − (s − sa)
  for (let i = 0; i < 8; i++) {
    const g = integrateAdaptive(tbl.speed, a0, t, LENGTH_REL_TOL) - (s - sa);
    if (Math.abs(g) <= tol) return t;
    if (g > 0) b = t;
    else a = t;
    const sp = tbl.speed(t);
    let next = sp > 1e-300 ? t - g / sp : NaN;
    if (!(next > a && next < b)) next = (a + b) / 2;
    t = next;
  }
  // 二分法フォールバック
  for (let i = 0; i < 60 && b - a > 1e-15; i++) {
    const m = (a + b) / 2;
    const g = integrateAdaptive(tbl.speed, a0, m, LENGTH_REL_TOL) - (s - sa);
    if (g > 0) b = m;
    else a = m;
  }
  return (a + b) / 2;
}
