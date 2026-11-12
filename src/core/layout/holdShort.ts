import { TILE_M } from '../model/catalog';
import { distPointSegment, type Vec2 } from '../geometry/vec';

/**
 * 自由形の滑走路の停止位置の幾何（Phase 12 M1）。
 * 停止位置は「滑走路の中心線（線分）からの距離が H（実寸の停止位置）以上になる最初の点」。
 * 誘導路が滑走路に浅い角度で入る・エッジが短いなど、単純な換算（H / sinθ をエッジ長で頭打ち）では H に届かない場合に、
 * 経路に沿って先（または手前）まで進んで求める。sim（routes.ts）と検証（validate.ts）で共有する純粋関数。
 */

/** 停止位置の対象の滑走路（中心線の端点はタイル、H は m） */
export interface HoldRunway {
  a: Vec2;
  b: Vec2;
  holdM: number;
}

/** 点（タイル）から滑走路の中心線（線分）までの距離（m）から H を引いた余裕。負 = 保護区域の中 */
export function holdSlackM(p: Vec2, runways: readonly HoldRunway[]): number {
  let g = Infinity;
  for (const r of runways) g = Math.min(g, distPointSegment(p, r.a, r.b).dist * TILE_M - r.holdM);
  return g;
}

export interface HoldWalk {
  /** 起点（ノード）から余裕 ≥ 0 になる最初の点までの、折れ線に沿った距離（m）。届かなければ null */
  clearM: number | null;
  /** 折れ線上（各頂点）での余裕の最大値（m）。clearM が null のとき、H にどれだけ届かなかったかの目安 */
  bestSlackM: number;
}

/**
 * 折れ線 points（先頭が起点のノード。タイル）に沿って進み、余裕（holdSlackM）が初めて 0 以上になる距離を返す。
 * 頂点で 0 以上になる区間は、その区間の始点（負）と終点（≥ 0）のあいだを固定 40 回の二分法で求める（決定的）。
 * limitM を超えた先は見ない（超える区間は limitM で切る）。
 */
export function walkToClear(points: readonly Vec2[], runways: readonly HoldRunway[], limitM: number): HoldWalk {
  let best = holdSlackM(points[0]!, runways);
  if (best >= 0) return { clearM: 0, bestSlackM: best };
  let acc = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    const segM = Math.hypot(q.x - p.x, q.y - p.y) * TILE_M;
    if (segM === 0) continue;
    const len = Math.min(segM, limitM - acc);
    if (len <= 0) break;
    const t1 = len / segM;
    const at = (t: number): Vec2 => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const gEnd = holdSlackM(at(t1), runways);
    best = Math.max(best, gEnd);
    if (gEnd >= 0) {
      let lo = 0;
      let hi = t1;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (holdSlackM(at(mid), runways) >= 0) hi = mid;
        else lo = mid;
      }
      return { clearM: acc + hi * segM, bestSlackM: best };
    }
    acc += len;
    if (acc >= limitM) break;
  }
  return { clearM: null, bestSlackM: best };
}

/** 探索の上限（m）: max(3 H, 300 m) */
export const holdWalkLimitM = (holdM: number): number => Math.max(3 * holdM, 300);
