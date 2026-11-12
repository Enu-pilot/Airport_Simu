/**
 * 帯（ストローク）の外形生成。滑走路・誘導路・道路の帯、フィレット部の帯に使う。
 * 自己交差は Phase 11 ではクリップしない（内側の join で短い辺が半幅より短いと外形が自己交差しうる）。
 */
import { bearingToDir } from './angle';
import { evaluate, derivative, flatten, tangentBearingDeg, type Curve } from './curve';
import { arcSegmentCount, arcStepRad, FLATTEN_TOL_RENDER_T, POS_EPS_T } from './tolerance';
import type { Vec2 } from './vec';

/**
 * 単位方向 u を与えて、中心線 a→b を extend だけ両端に延ばし、直交方向に halfW だけ広げた矩形。
 * 旧 `layout/runway.ts runwayRect` と同一の演算順（頂点の順序も同一）。
 */
export function rectAlongDir(a0: Vec2, b0: Vec2, u: Vec2, halfW: number, extend: number): Vec2[] {
  const n = { x: -u.y, y: u.x };
  const a = { x: a0.x - u.x * extend, y: a0.y - u.y * extend };
  const b = { x: b0.x + u.x * extend, y: b0.y + u.y * extend };
  return [
    { x: a.x + n.x * halfW, y: a.y + n.y * halfW },
    { x: b.x + n.x * halfW, y: b.y + n.y * halfW },
    { x: b.x - n.x * halfW, y: b.y - n.y * halfW },
    { x: a.x - n.x * halfW, y: a.y - n.y * halfW },
  ];
}

/**
 * 中心線 a→b（単位方向は (b − a)/|b − a|）の矩形。a = b の場合は空配列。
 * 旧 runwayRect は単位方向を「1 ステップのベクトル / その長さ」で作るため、斜め方位では
 * (b − a)/|b − a| と最下位ビットが異なりうる。ビット同一が必要な呼び出しは rectAlongDir を使う。
 */
export function rectAlong(a: Vec2, b: Vec2, halfW: number, extend: number): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [];
  return rectAlongDir(a, b, { x: dx / len, y: dy / len }, halfW, extend);
}

export type JoinStyle = 'miter' | 'bevel' | 'round';
export type CapStyle = 'butt' | 'square' | 'round';
export interface StrokeOptions {
  join?: JoinStyle;
  cap?: CapStyle;
  /** miter の長さ（半幅に対する比）の上限。超えると bevel（既定 4） */
  miterLimit?: number;
  /** round の折れ線化の弦高誤差（タイル） */
  tol?: number;
}

const unit = (dx: number, dy: number): Vec2 => {
  const l = Math.hypot(dx, dy);
  return { x: dx / l, y: dy / l };
};

/** 中心 c から角度 a0 → a1（ラジアン、a1 − a0 の符号に従う）の円弧上の点列（端点を除く内側のみ） */
function arcPoints(c: Vec2, r: number, a0: number, a1: number, tol: number): Vec2[] {
  const n = arcSegmentCount(a1 - a0, arcStepRad(r, tol));
  const out: Vec2[] = [];
  for (let i = 1; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}

/**
 * 折れ線を太らせた外形（1 つの多角形）。点順: +n 側を始点→終点、終点のキャップ、−n 側を終点→始点、始点のキャップ。
 * n = (−dy, dx)。2 点・butt の場合は rectAlong(extend = 0) と同じ頂点順。
 * 連続する重複点（≤ POS_EPS_T）は除く。有効な点が 2 未満なら空配列。
 */
export function strokePolyline(points: readonly Vec2[], halfW: number, opts: StrokeOptions = {}): Vec2[] {
  const join = opts.join ?? 'miter';
  const cap = opts.cap ?? 'butt';
  const miterLimit = opts.miterLimit ?? 4;
  const tol = opts.tol ?? FLATTEN_TOL_RENDER_T;
  const pts: Vec2[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > POS_EPS_T) pts.push(p);
  }
  if (pts.length < 2) return [];
  const m = pts.length;
  const dirs: Vec2[] = [];
  for (let i = 0; i + 1 < m; i++) dirs.push(unit(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y));
  const nrm = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });

  /** side = +1（+n 側）/ -1（−n 側）の頂点 i のオフセット点列（進行順） */
  const sidePoints = (i: number, side: number): Vec2[] => {
    const p = pts[i]!;
    if (i === 0) {
      const n = nrm(dirs[0]!);
      return [{ x: p.x + side * n.x * halfW, y: p.y + side * n.y * halfW }];
    }
    if (i === m - 1) {
      const n = nrm(dirs[m - 2]!);
      return [{ x: p.x + side * n.x * halfW, y: p.y + side * n.y * halfW }];
    }
    const d0 = dirs[i - 1]!;
    const d1 = dirs[i]!;
    const n0 = nrm(d0);
    const n1 = nrm(d1);
    const dotv = d0.x * d1.x + d0.y * d1.y;
    const crs = d0.x * d1.y - d0.y * d1.x;
    if (Math.abs(crs) <= 1e-12 && dotv > 0) return [{ x: p.x + side * n0.x * halfW, y: p.y + side * n0.y * halfW }];
    const a = { x: p.x + side * n0.x * halfW, y: p.y + side * n0.y * halfW };
    const b = { x: p.x + side * n1.x * halfW, y: p.y + side * n1.y * halfW };
    // +n 側は crs > 0 で内側（d が +n 方向へ曲がる）
    const inner = side * crs > 0;
    if (inner && dotv > -1 + 1e-9) {
      const k = 1 + (n0.x * n1.x + n0.y * n1.y);
      return [{ x: p.x + (side * halfW * (n0.x + n1.x)) / k, y: p.y + (side * halfW * (n0.y + n1.y)) / k }];
    }
    if (join === 'bevel') return [a, b];
    if (join === 'round' || dotv <= -1 + 1e-9) {
      const a0 = Math.atan2(a.y - p.y, a.x - p.x);
      let a1 = Math.atan2(b.y - p.y, b.x - p.x);
      // 外側は side * crs < 0。+n 側の外側は −crs 方向へ回る
      const want = dotv <= -1 + 1e-9 || side * crs < 0 ? -side : side;
      if (want > 0) while (a1 < a0) a1 += 2 * Math.PI;
      else while (a1 > a0) a1 -= 2 * Math.PI;
      return [a, ...arcPoints(p, halfW, a0, a1, tol), b];
    }
    // miter（外側）。長さ比 = 1 / sin(内角/2) = 1 / sqrt((1 + n0·n1)/2)
    const k = 1 + (n0.x * n1.x + n0.y * n1.y);
    const ratio = 1 / Math.sqrt(k / 2);
    if (ratio > miterLimit) return [a, b];
    return [{ x: p.x + (side * halfW * (n0.x + n1.x)) / k, y: p.y + (side * halfW * (n0.y + n1.y)) / k }];
  };

  const out: Vec2[] = [];
  for (let i = 0; i < m; i++) out.push(...sidePoints(i, 1));
  // 終点のキャップ（+n → −n）
  const dEnd = dirs[m - 2]!;
  const pe = pts[m - 1]!;
  const ne = nrm(dEnd);
  if (cap === 'square') {
    out.push({ x: pe.x + ne.x * halfW + dEnd.x * halfW, y: pe.y + ne.y * halfW + dEnd.y * halfW });
    out.push({ x: pe.x - ne.x * halfW + dEnd.x * halfW, y: pe.y - ne.y * halfW + dEnd.y * halfW });
  } else if (cap === 'round') {
    const a0 = Math.atan2(ne.y, ne.x);
    // +n → 前方 → −n（進行方向側の半円）。回転方向は d から n への向きの逆
    out.push(...arcPoints(pe, halfW, a0, a0 - Math.PI, tol));
  }
  const back: Vec2[] = [];
  for (let i = m - 1; i >= 0; i--) back.push(...sidePoints(i, -1).reverse());
  // −n 側は終点→始点の順に（各頂点で進行順を逆にしたものを並べる）
  out.push(...back);
  // 始点のキャップ（−n → +n）
  const dS = dirs[0]!;
  const ps = pts[0]!;
  const ns = nrm(dS);
  if (cap === 'square') {
    out.push({ x: ps.x - ns.x * halfW - dS.x * halfW, y: ps.y - ns.y * halfW - dS.y * halfW });
    out.push({ x: ps.x + ns.x * halfW - dS.x * halfW, y: ps.y + ns.y * halfW - dS.y * halfW });
  } else if (cap === 'round') {
    const a0 = Math.atan2(-ns.y, -ns.x);
    out.push(...arcPoints(ps, halfW, a0, a0 - Math.PI, tol));
  }
  return out;
}

/**
 * 曲線を法線方向（+n = (−dy, dx) 側が正）に d だけずらした折れ線。誤差（弦と真のオフセット曲線の
 * 距離）が tol 以下になるまでパラメータ区間を二分する（中点判定）。
 * d が曲率半径を超える内側ではカスプ・自己交差が生じうる（クリップしない）。
 */
export function offsetCurve(c: Curve, d: number, tol: number = FLATTEN_TOL_RENDER_T): Vec2[] {
  const at = (t: number): Vec2 => {
    const p = evaluate(c, t);
    const dv = derivative(c, t);
    const l = Math.hypot(dv.x, dv.y);
    const dir = l > 0 ? { x: dv.x / l, y: dv.y / l } : bearingToDir(tangentBearingDeg(c, t));
    return { x: p.x - dir.y * d, y: p.y + dir.x * d };
  };
  if (c.kind === 'line') return [at(0), at(1)];
  const ts: number[] = flatten(c, Math.max(tol, 1e-9)).map((q) => q.t);
  const out: Vec2[] = [at(ts[0]!)];
  const rec = (t0: number, p0: Vec2, t1: number, p1: Vec2, depth: number): void => {
    const tm = (t0 + t1) / 2;
    const pm = at(tm);
    const cx = (p0.x + p1.x) / 2;
    const cy = (p0.y + p1.y) / 2;
    if (depth >= 12 || Math.hypot(pm.x - cx, pm.y - cy) <= tol) {
      out.push(p1);
      return;
    }
    rec(t0, p0, tm, pm, depth + 1);
    rec(tm, pm, t1, p1, depth + 1);
  };
  let prevT = ts[0]!;
  let prevP = out[0]!;
  for (let i = 1; i < ts.length; i++) {
    const p = at(ts[i]!);
    rec(prevT, prevP, ts[i]!, p, 0);
    prevT = ts[i]!;
    prevP = p;
  }
  return out;
}
