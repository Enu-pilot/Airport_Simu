/** 数値積分: 適応 Gauss–Legendre（5 点、区間二分）。純関数・決定的 */
import { LENGTH_REL_TOL } from './tolerance';

const X1 = 0.5384693101056831;
const X2 = 0.906179845938664;
const W0 = 0.5688888888888889;
const W1 = 0.47862867049936647;
const W2 = 0.23692688505618908;

/** [a, b] の 5 点 Gauss–Legendre 積分 */
export function gauss5(f: (t: number) => number, a: number, b: number): number {
  const c = (a + b) / 2;
  const h = (b - a) / 2;
  return h * (W0 * f(c) + W1 * (f(c - h * X1) + f(c + h * X1)) + W2 * (f(c - h * X2) + f(c + h * X2)));
}

/**
 * 適応積分。区間を二分し、1 区間の結果と 2 分割の和の差が許容内なら採用する。
 * 許容は 全体の概算 × relTol（+ absTol）を深さごとに半分ずつ配分する。
 * 先頭で 4 等分してから適応を始める（局所的な特徴の見落とし防止）。
 * 区間端・被積分値が非有限（NaN / ±Infinity）なら、有限時間で NaN を返す（深さ上限まで再帰しない）。
 */
export function integrateAdaptive(
  f: (t: number) => number,
  a: number,
  b: number,
  relTol: number = LENGTH_REL_TOL,
  maxDepth = 24,
  absTol = 1e-15,
): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  if (a === b) return 0;
  const N0 = 4;
  const parts: [number, number, number][] = [];
  let total = 0;
  for (let i = 0; i < N0; i++) {
    const lo = a + ((b - a) * i) / N0;
    const hi = i === N0 - 1 ? b : a + ((b - a) * (i + 1)) / N0;
    const v = gauss5(f, lo, hi);
    parts.push([lo, hi, v]);
    total += Math.abs(v);
  }
  if (!Number.isFinite(total)) return NaN;
  const eps = (relTol * total + absTol) / N0;
  const rec = (lo: number, hi: number, whole: number, e: number, depth: number): number => {
    const m = (lo + hi) / 2;
    const l = gauss5(f, lo, m);
    const r = gauss5(f, m, hi);
    if (!Number.isFinite(l + r)) return NaN;
    if (depth >= maxDepth || Math.abs(l + r - whole) <= e) return l + r;
    return rec(lo, m, l, e / 2, depth + 1) + rec(m, hi, r, e / 2, depth + 1);
  };
  let sum = 0;
  for (const [lo, hi, v] of parts) sum += rec(lo, hi, v, eps, 0);
  return sum; // 途中で NaN があれば NaN が伝播する
}
