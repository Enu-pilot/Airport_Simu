/**
 * 角度規約。
 * データは度・真方位（0 = 北 = -y、時計回り、[0, 360)）。内部計算はラジアン。
 */
import type { Heading } from '../model/types';
import type { Tile, Vec2 } from './vec';

/** [0, 360) に正規化（-0 は 0） */
export function normalizeDeg(d: number): number {
  const m = ((d % 360) + 360) % 360;
  return m === 0 ? 0 : m;
}

const S = Math.SQRT1_2;

/**
 * 方位 → 単位方向ベクトル `{ x: sin, y: -cos }`。
 * 90° の倍数は厳密値（sin(π) ≈ 1.2e-16 を避ける）、45° の奇数倍は ±√½。
 */
export function bearingToDir(deg: number): Vec2 {
  const d = normalizeDeg(deg);
  switch (d) {
    case 0:
      return { x: 0, y: -1 };
    case 45:
      return { x: S, y: -S };
    case 90:
      return { x: 1, y: 0 };
    case 135:
      return { x: S, y: S };
    case 180:
      return { x: 0, y: 1 };
    case 225:
      return { x: -S, y: S };
    case 270:
      return { x: -1, y: 0 };
    case 315:
      return { x: -S, y: -S };
  }
  const rad = (d * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

/** 方向ベクトル → 方位 [0, 360)。`sim/routes.ts headingOf` と同一式。(0, 0) は 0 */
export function dirToBearing(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/** 2 方位の差（0〜180）。`sim/routes.ts turnAngleAt` の式 */
export function turnAngleDeg(h1: number, h2: number): number {
  const d = Math.abs(h2 - h1) % 360;
  return d > 180 ? 360 - d : d;
}

/** a から b への符号付き差 ∈ (-180, 180]（正 = 時計回り） */
export function signedAngleDiffDeg(a: number, b: number): number {
  const d = normalizeDeg(b - a);
  return d > 180 ? d - 360 : d;
}

/** 8 方位 → 1 ステップのタイル差分（0 = 北 = -y） */
export const GRID8_STEP: Record<Heading, Tile> = {
  0: { x: 0, y: -1 },
  45: { x: 1, y: -1 },
  90: { x: 1, y: 0 },
  135: { x: 1, y: 1 },
  180: { x: 0, y: 1 },
  225: { x: -1, y: 1 },
  270: { x: -1, y: 0 },
  315: { x: -1, y: -1 },
};

export function isGrid8Heading(n: number): n is Heading {
  return Number.isInteger(n) && n >= 0 && n < 360 && n % 45 === 0;
}

/**
 * 真方位 → 磁方位。偏差は東偏差を正とする（真 090°、偏差 10°E → 磁 080°）。
 * 磁北が真北より東にあるとき、磁方位 = 真方位 − 東偏差。
 */
export function magneticFromTrue(trueDeg: number, variationEastDeg: number): number {
  return normalizeDeg(trueDeg - variationEastDeg);
}

/**
 * 滑走路番号（1〜36）。10° 単位に四捨五入（.5 は切り上げ、0 は 36）。
 * 浮動小数点の 22.4999999 型の揺れを避けるため 1e-6 度に丸めてから判定する
 * （整数入力では恒等）。
 */
export function designatorNumber(magDeg: number): number {
  const r = normalizeDeg(Math.round(magDeg * 1e6) / 1e6);
  const n = Math.round(r / 10) % 36;
  return n === 0 ? 36 : n;
}

export const formatDesignator = (n: number): string => String(n).padStart(2, '0');
