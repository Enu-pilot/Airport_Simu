/**
 * 曲線の共用体と共通ディスパッチ。全関数は純関数・入力非破壊・決定的。
 * 位置は World フレーム（タイル単位）。曲率は 1/タイル、正 = 画面時計回り。
 */
import {
  arcCurvature,
  arcDerivative,
  arcLength,
  arcPoint,
  arcTangentBearing,
} from './arc';
import { dirToBearing } from './angle';
import { buildArcLengthTable, tAtLength as tableTAtLength, type ArcLengthTable } from './arclength';
import { bboxOf, type Bbox } from './bbox';
import {
  bezierBbox,
  bezierCurvature,
  bezierDerivative,
  bezierPoint,
  bezierSplit,
  bezierTangentBearing,
} from './bezier';
import { integrateAdaptive } from './integrate';
import { closestPointOnSegment } from './segment';
import { LENGTH_REL_TOL, MAX_SUBDIV_DEPTH } from './tolerance';
import type { Vec2 } from './vec';
import type { WorldPoint } from './frames';

export interface LineCurve {
  kind: 'line';
  p0: WorldPoint;
  p1: WorldPoint;
}
/** 円弧（sweep ≠ 0、|sweep| < 2π。split の端（t = 0 / 1）に限り sweep = 0 の退化片を返す） */
export interface ArcCurve {
  kind: 'arc';
  c: WorldPoint;
  r: number;
  theta0: number;
  sweep: number;
}
export interface QuadCurve {
  kind: 'quad';
  p0: WorldPoint;
  p1: WorldPoint;
  p2: WorldPoint;
}
export interface CubicCurve {
  kind: 'cubic';
  p0: WorldPoint;
  p1: WorldPoint;
  p2: WorldPoint;
  p3: WorldPoint;
}
export type Curve = LineCurve | ArcCurve | QuadCurve | CubicCurve;
export interface CurvePoint {
  p: WorldPoint;
  t: number;
  s?: number;
}
/** 連続（G0）を前提とした複合曲線 */
export type Path = readonly Curve[];

const ctrl = (c: QuadCurve | CubicCurve): WorldPoint[] => (c.kind === 'quad' ? [c.p0, c.p1, c.p2] : [c.p0, c.p1, c.p2, c.p3]);
const fromCtrl = (kind: 'quad' | 'cubic', p: readonly Vec2[]): Curve =>
  kind === 'quad'
    ? { kind: 'quad', p0: p[0]!, p1: p[1]!, p2: p[2]! }
    : { kind: 'cubic', p0: p[0]!, p1: p[1]!, p2: p[2]!, p3: p[3]! };

export function evaluate(c: Curve, t: number): WorldPoint {
  switch (c.kind) {
    case 'line':
      return { x: c.p0.x + (c.p1.x - c.p0.x) * t, y: c.p0.y + (c.p1.y - c.p0.y) * t };
    case 'arc':
      return arcPoint(c, t);
    default:
      return bezierPoint(ctrl(c), t);
  }
}

/** dP/dt（パラメータ微分。速さ = 長さ要素ではなく曲線の t に対する速度） */
export function derivative(c: Curve, t: number): Vec2 {
  switch (c.kind) {
    case 'line':
      return { x: c.p1.x - c.p0.x, y: c.p1.y - c.p0.y };
    case 'arc':
      return arcDerivative(c, t);
    default:
      return bezierDerivative(ctrl(c), t);
  }
}

/** 進行方向の真方位（度） */
export function tangentBearingDeg(c: Curve, t: number): number {
  switch (c.kind) {
    case 'line':
      return dirToBearing(c.p1.x - c.p0.x, c.p1.y - c.p0.y);
    case 'arc':
      return arcTangentBearing(c, t);
    default:
      return bezierTangentBearing(ctrl(c), t);
  }
}

/** 符号付き曲率（1/タイル、正 = 画面時計回り）。線分は 0、円弧は ±1/r 厳密 */
export function curvature(c: Curve, t: number): number {
  switch (c.kind) {
    case 'line':
      return 0;
    case 'arc':
      return arcCurvature(c);
    default:
      return bezierCurvature(ctrl(c), t);
  }
}

/** 弧長（タイル）。線分 hypot、円弧 r|sweep|（厳密）、Bezier は適応 Gauss–Legendre */
export function length(c: Curve): number {
  switch (c.kind) {
    case 'line':
      return Math.hypot(c.p1.x - c.p0.x, c.p1.y - c.p0.y);
    case 'arc':
      return arcLength(c);
    default: {
      const pts = ctrl(c);
      return integrateAdaptive((t) => {
        const d = bezierDerivative(pts, t);
        return Math.hypot(d.x, d.y);
      }, 0, 1, LENGTH_REL_TOL);
    }
  }
}

export function reverse(c: Curve): Curve {
  switch (c.kind) {
    case 'line':
      return { kind: 'line', p0: c.p1, p1: c.p0 };
    case 'arc':
      return { kind: 'arc', c: c.c, r: c.r, theta0: c.theta0 + c.sweep, sweep: -c.sweep };
    default:
      return fromCtrl(c.kind, ctrl(c).reverse());
  }
}

/** t で 2 分割。前半は元の始点側 */
export function split(c: Curve, t: number): [Curve, Curve] {
  switch (c.kind) {
    case 'line': {
      const m = evaluate(c, t);
      return [{ kind: 'line', p0: c.p0, p1: m }, { kind: 'line', p0: m, p1: c.p1 }];
    }
    case 'arc':
      return [
        { kind: 'arc', c: c.c, r: c.r, theta0: c.theta0, sweep: c.sweep * t },
        { kind: 'arc', c: c.c, r: c.r, theta0: c.theta0 + c.sweep * t, sweep: c.sweep * (1 - t) },
      ];
    default: {
      const [l, r] = bezierSplit(ctrl(c), t);
      return [fromCtrl(c.kind, l), fromCtrl(c.kind, r)];
    }
  }
}

/** 厳密な境界ボックス（Bezier は導関数の根、円弧は軸方向の極値を含める） */
export function bbox(c: Curve): Bbox {
  switch (c.kind) {
    case 'line':
      return bboxOf([c.p0, c.p1])!;
    case 'arc': {
      const cand: Vec2[] = [arcPoint(c, 0), arcPoint(c, 1)];
      const lo = Math.min(c.theta0, c.theta0 + c.sweep);
      const hi = Math.max(c.theta0, c.theta0 + c.sweep);
      for (let k = Math.ceil(lo / (Math.PI / 2)); k * (Math.PI / 2) <= hi; k++) {
        const th = k * (Math.PI / 2);
        cand.push({ x: c.c.x + c.r * Math.cos(th), y: c.c.y + c.r * Math.sin(th) });
      }
      return bboxOf(cand)!;
    }
    default:
      return bezierBbox(ctrl(c));
  }
}

/**
 * 折れ線化。弦高誤差（曲線上の任意の点から折れ線までの距離）≤ tol を保証する。端点を必ず含む。
 * 円弧は角度刻みを解析的に決め、Bezier は制御点の弦までの距離で再帰細分する。
 */
export function flatten(c: Curve, tol: number): CurvePoint[] {
  const e = Math.max(tol, 1e-12);
  switch (c.kind) {
    case 'line':
      return [{ p: c.p0, t: 0 }, { p: c.p1, t: 1 }];
    case 'arc': {
      // 弦高 r(1 − cos(dθ/2)) ≤ tol
      const ratio = 1 - e / c.r;
      const dth = ratio <= -1 ? 2 * Math.PI : 2 * Math.acos(Math.max(-1, ratio));
      const n = Math.max(1, Math.ceil(Math.abs(c.sweep) / dth - 1e-12));
      const out: CurvePoint[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        out.push({ p: i === 0 ? arcPoint(c, 0) : arcPoint(c, t), t });
      }
      return out;
    }
    default: {
      const out: CurvePoint[] = [{ p: c.p0, t: 0 }];
      const rec = (pts: readonly Vec2[], t0: number, t1: number, depth: number): void => {
        const a = pts[0]!;
        const b = pts[pts.length - 1]!;
        let flat = true;
        for (let i = 1; i < pts.length - 1; i++) {
          if (closestPointOnSegment(pts[i]!, a, b).dist > e) {
            flat = false;
            break;
          }
        }
        if (flat || depth >= MAX_SUBDIV_DEPTH) {
          out.push({ p: b, t: t1 });
          return;
        }
        const [l, r] = bezierSplit(pts, 0.5);
        const tm = (t0 + t1) / 2;
        rec(l, t0, tm, depth + 1);
        rec(r, tm, t1, depth + 1);
      };
      rec(ctrl(c), 0, 1, 0);
      return out;
    }
  }
}

/** 点 p に最も近い曲線上の点。同距離は小さい t を返す */
export function closestPoint(c: Curve, p: Vec2): { t: number; p: WorldPoint; dist: number } {
  switch (c.kind) {
    case 'line': {
      const r = closestPointOnSegment(p, c.p0, c.p1);
      return { t: r.t, p: r.p, dist: r.dist };
    }
    case 'arc': {
      const dx = p.x - c.c.x;
      const dy = p.y - c.c.y;
      const best = (t: number) => {
        const q = arcPoint(c, t);
        return { t, p: q, dist: Math.hypot(p.x - q.x, p.y - q.y) };
      };
      if (dx === 0 && dy === 0) return best(0);
      const ang = Math.atan2(dy, dx);
      const TWO_PI = 2 * Math.PI;
      // 掃引方向に沿った θ0 からの角度 [0, 2π)
      let rel = c.sweep >= 0 ? ang - c.theta0 : c.theta0 - ang;
      rel = ((rel % TWO_PI) + TWO_PI) % TWO_PI;
      const span = Math.abs(c.sweep);
      if (rel <= span) return best(span === 0 ? 0 : rel / span);
      const a = best(0);
      const b = best(1);
      return b.dist < a.dist ? b : a;
    }
    default:
      return closestOnBezier(c, p);
  }
}

function closestOnBezier(c: QuadCurve | CubicCurve, p: Vec2): { t: number; p: WorldPoint; dist: number } {
  const pts = ctrl(c);
  const poly = flatten(c, 0.01);
  const segDist: number[] = [];
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const d = closestPointOnSegment(p, poly[i]!.p, poly[i + 1]!.p).dist;
    segDist.push(d);
    if (d < best) best = d;
  }
  const dist2 = (t: number): number => {
    const q = bezierPoint(pts, t);
    return Math.hypot(p.x - q.x, p.y - q.y);
  };
  let res = { t: 0, d: Infinity };
  const consider = (t: number): void => {
    const d = dist2(t);
    if (d < res.d - 1e-12 || (Math.abs(d - res.d) <= 1e-12 && t < res.t)) res = { t, d };
  };
  for (let i = 0; i < segDist.length; i++) {
    if (segDist[i]! > best + 0.02) continue;
    const lo = poly[Math.max(0, i - 1)]!.t;
    const hi = poly[Math.min(poly.length - 1, i + 2)]!.t;
    const cp = closestPointOnSegment(p, poly[i]!.p, poly[i + 1]!.p);
    const t0 = poly[i]!.t + (poly[i + 1]!.t - poly[i]!.t) * cp.t;
    // f(t) = (B − p)·B'、根が最小距離の候補。Newton + 二分法（区間 [lo, hi]）
    let a = lo;
    let b = hi;
    let t = t0;
    const f = (u: number): number => {
      const q = bezierPoint(pts, u);
      const d = bezierDerivative(pts, u);
      return (q.x - p.x) * d.x + (q.y - p.y) * d.y;
    };
    for (let k = 0; k < 40; k++) {
      const fv = f(t);
      if (fv === 0) break;
      if (fv > 0) b = t;
      else a = t;
      const h = 1e-6;
      const df = (f(Math.min(1, t + h)) - f(Math.max(0, t - h))) / (Math.min(1, t + h) - Math.max(0, t - h));
      let next = df > 1e-300 ? t - fv / df : NaN;
      if (!(next > a && next < b)) next = (a + b) / 2;
      if (Math.abs(next - t) < 1e-14) {
        t = next;
        break;
      }
      t = next;
    }
    consider(Math.max(lo, Math.min(hi, t)));
    consider(lo);
    consider(hi);
  }
  const q = bezierPoint(pts, res.t);
  return { t: res.t, p: q, dist: res.d };
}

/** 弧長テーブル（Bezier の s → t 変換用。線分・円弧は比例なので軽量） */
export function arcLengthTable(c: Curve, n = 64): ArcLengthTable {
  if (c.kind === 'line' || c.kind === 'arc') {
    const L = length(c);
    return buildArcLengthTable(() => L, n, true, L);
  }
  const pts = ctrl(c);
  return buildArcLengthTable((t) => {
    const d = bezierDerivative(pts, t);
    return Math.hypot(d.x, d.y);
  }, n);
}

/** 長さ s（[0, L] にクランプ）に対応する t */
export function tAtLength(tbl: ArcLengthTable, s: number): number {
  return tableTAtLength(tbl, s);
}

/** 始点から長さ s の点（s は [0, L] にクランプ）。table を渡すと Bezier の再計算を省ける */
export function pointAtLength(c: Curve, s: number, tbl?: ArcLengthTable): CurvePoint {
  const table = tbl ?? arcLengthTable(c);
  const sc = Math.max(0, Math.min(table.total, s));
  const t = tableTAtLength(table, sc);
  return { p: evaluate(c, t), t, s: sc };
}
