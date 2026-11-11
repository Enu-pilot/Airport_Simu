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

/** 2 つの実数が abs 許容内で等しいか */
export const nearlyEqual = (a: number, b: number, eps: number = POS_EPS_T): boolean => Math.abs(a - b) <= eps;
