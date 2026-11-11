/**
 * 許容誤差の定数（新しい幾何ライブラリ用）。
 *
 * 既存の述語（vec.ts の `EPS` = 1e-9、`pointOnSegmentInterior` / `isIntegerPoint` の 1e-7）は
 * 既存結果のビット同一性のために変更しない。新コードは本ファイルの定数だけを使う。
 */

/** 点の一致・ノード併合（タイル。1e-6 タイル = 25 µm） */
export const POS_EPS_T = 1e-6;
/** 曲線パラメータ t の端点判定 */
export const PARAM_EPS = 1e-9;
/** 平行判定（単位ベクトルの外積） */
export const ANGLE_EPS_RAD = 1e-9;
/** 弧長積分の相対誤差 */
export const LENGTH_REL_TOL = 1e-10;
/** 描画用の折れ線化の弦高誤差（タイル。0.01 タイル = 0.25 m） */
export const FLATTEN_TOL_RENDER_T = 0.01;
/** クリアランス・干渉判定用の折れ線化の弦高誤差（タイル。0.002 タイル = 5 cm） */
export const FLATTEN_TOL_CHECK_T = 0.002;
/** 曲線交差の再帰上限（決定性のため固定） */
export const MAX_SUBDIV_DEPTH = 48;

/** 折れ線化（flatten / 円弧の帯）が返す区間数の上限。超える場合は誤差保証を捨てて区間数を打ち切る */
export const MAX_FLATTEN_POINTS = 4096;

/**
 * 弦高誤差 ≤ tol を満たす円弧の最大角度刻み（ラジアン、(0, 2π]）。
 * r(1 − cos(dθ/2)) = tol を 1 − cos x = 2 sin²(x/2) で解く（r ≫ tol でも桁落ちしない）。
 * r が正でない・非有限のときは 2π。
 */
export function arcStepRad(r: number, tol: number): number {
  if (!(r > 0) || !Number.isFinite(r)) return 2 * Math.PI;
  const x = Math.max(tol, 1e-12) / r;
  if (!(x < 2)) return 2 * Math.PI;
  return 4 * Math.asin(Math.min(1, Math.sqrt(x / 2)));
}

/** 角度 span（ラジアン）を刻み step 以下で分ける区間数。有限・1 以上・MAX_FLATTEN_POINTS 以下に収める（NaN は 1） */
export function arcSegmentCount(span: number, step: number): number {
  const n = Math.ceil(Math.abs(span) / step - 1e-12);
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(n, MAX_FLATTEN_POINTS);
}

/** 2 つの実数が abs 許容内で等しいか */
export const nearlyEqual = (a: number, b: number, eps: number = POS_EPS_T): boolean => Math.abs(a - b) <= eps;
