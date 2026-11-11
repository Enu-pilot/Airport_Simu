/**
 * 円弧。内部表現は `p(t) = c + r (cos θ, sin θ)`、θ = theta0 + sweep·t（ラジアン）。
 * World フレームは y 下向きなので θ 増加（sweep > 0）= 画面上で時計回り = 右旋回。
 * 方位（0 = 北 = -y、時計回り）との関係は θ = bearingRad − π/2。θ は外に出さず、
 * 作成関数は「始点・終点・接線方位・半径」で受け渡す。
 */
import { bearingToDir, dirToBearing } from './angle';
import type { ArcCurve, LineCurve } from './curve';
import { ANGLE_EPS_RAD, POS_EPS_T } from './tolerance';
import { cross, dot, normalize, perp, sub, type Vec2 } from './vec';

const TWO_PI = 2 * Math.PI;
const norm2pi = (a: number): number => {
  const m = ((a % TWO_PI) + TWO_PI) % TWO_PI;
  return m === 0 ? 0 : m;
};

export const arcPoint = (a: ArcCurve, t: number): Vec2 => {
  const th = a.theta0 + a.sweep * t;
  return { x: a.c.x + a.r * Math.cos(th), y: a.c.y + a.r * Math.sin(th) };
};

/** dP/dt */
export const arcDerivative = (a: ArcCurve, t: number): Vec2 => {
  const th = a.theta0 + a.sweep * t;
  return { x: -a.r * a.sweep * Math.sin(th), y: a.r * a.sweep * Math.cos(th) };
};

/** 進行方向の単位接線 */
export const arcTangent = (a: ArcCurve, t: number): Vec2 => {
  const th = a.theta0 + a.sweep * t;
  const sg = a.sweep < 0 ? -1 : 1;
  return { x: -sg * Math.sin(th), y: sg * Math.cos(th) };
};

export const arcTangentBearing = (a: ArcCurve, t: number): number => {
  const d = arcTangent(a, t);
  return dirToBearing(d.x, d.y);
};

/** 符号付き曲率（正 = 画面時計回り）。厳密に ±1/r */
export const arcCurvature = (a: ArcCurve): number => (a.sweep < 0 ? -1 : 1) / a.r;

/** 弧長（厳密） */
export const arcLength = (a: ArcCurve): number => a.r * Math.abs(a.sweep);

/**
 * 弦と bulge（= tan(中心角 / 4)。正 = 時計回り = sweep 正）から円弧を作る。
 * 点が一致する・bulge が 0（直線）の場合は null（呼び出し側で線分として扱う）。
 */
export function arcFromBulge(p0: Vec2, p1: Vec2, bulge: number): ArcCurve | null {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const chord = Math.hypot(dx, dy);
  if (chord <= POS_EPS_T) return null;
  const sweep = 4 * Math.atan(bulge);
  if (Math.abs(sweep) <= ANGLE_EPS_RAD) return null;
  const r = chord / (2 * Math.abs(Math.sin(sweep / 2)));
  const phi = Math.atan2(dy, dx);
  const theta0 = phi - sweep / 2 - Math.sign(sweep) * (Math.PI / 2);
  return { kind: 'arc', c: { x: p0.x - r * Math.cos(theta0), y: p0.y - r * Math.sin(theta0) }, r, theta0, sweep };
}

/** 3 点（始点・弧上の中間点・終点）を通る円弧。一直線上なら null */
export function arcFromThreePoints(p0: Vec2, pm: Vec2, p1: Vec2): ArcCurve | null {
  const a = sub(pm, p0);
  const b = sub(p1, p0);
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la <= POS_EPS_T || lb <= POS_EPS_T) return null;
  const d = 2 * cross(a, b);
  if (Math.abs(d) <= ANGLE_EPS_RAD * la * lb * 2) return null;
  const ua = dot(a, a);
  const ub = dot(b, b);
  const c = { x: p0.x + (b.y * ua - a.y * ub) / d, y: p0.y + (a.x * ub - b.x * ua) / d };
  const r = Math.hypot(p0.x - c.x, p0.y - c.y);
  const th0 = Math.atan2(p0.y - c.y, p0.x - c.x);
  const thm = Math.atan2(pm.y - c.y, pm.x - c.x);
  const th1 = Math.atan2(p1.y - c.y, p1.x - c.x);
  const dm = norm2pi(thm - th0);
  const d1 = norm2pi(th1 - th0);
  const sweep = dm < d1 ? d1 : d1 - TWO_PI;
  return { kind: 'arc', c, r, theta0: th0, sweep };
}

/**
 * 始点・始点での進行方位（度）・半径・掃引角（ラジアン、正 = 右旋回 = 時計回り）から円弧を作る。
 * radius ≤ 0・sweep = 0・|sweep| ≥ 2π・非有限の sweep は null（ArcCurve の不変条件 |sweep| < 2π）。
 */
export function arcFromTangent(start: Vec2, bearingDeg: number, radius: number, sweep: number): ArcCurve | null {
  if (!(radius > 0) || !(Math.abs(sweep) > 0) || !(Math.abs(sweep) < TWO_PI)) return null;
  const d = bearingToDir(bearingDeg);
  const n = perp(d); // 右（時計回り側）の法線
  const sg = sweep < 0 ? -1 : 1;
  const c = { x: start.x + sg * n.x * radius, y: start.y + sg * n.y * radius };
  const theta0 = Math.atan2(start.y - c.y, start.x - c.x);
  return { kind: 'arc', c, r: radius, theta0, sweep };
}

export interface FilletResult {
  arc: ArcCurve;
  /** コーナー手前までに切り詰めた線分 a / コーナーから始まる線分 b */
  a: LineCurve;
  b: LineCurve;
}

/**
 * 2 本の線分（a の終点と b の始点が同じコーナー）の角を半径 r の円弧で丸める。
 * 接線長がどちらかの線分長を超える・ほぼ一直線・折り返しは null。
 */
export function fillet(a: LineCurve, b: LineCurve, r: number): FilletResult | null {
  if (!(r > 0)) return null;
  const v = a.p1;
  if (Math.hypot(b.p0.x - v.x, b.p0.y - v.y) > POS_EPS_T) return null;
  const back = sub(a.p0, v);
  const fwd = sub(b.p1, v);
  const lb = Math.hypot(back.x, back.y);
  const lf = Math.hypot(fwd.x, fwd.y);
  if (lb <= POS_EPS_T || lf <= POS_EPS_T) return null;
  const u1 = normalize(back);
  const u2 = normalize(fwd);
  const cosPhi = Math.max(-1, Math.min(1, dot(u1, u2)));
  const phi = Math.acos(cosPhi); // 2 辺のなす内角
  if (phi <= 1e-6 || phi >= Math.PI - 1e-6) return null;
  const L = r / Math.tan(phi / 2);
  if (L > lb + POS_EPS_T || L > lf + POS_EPS_T) return null;
  const t1 = { x: v.x + u1.x * L, y: v.y + u1.y * L };
  const t2 = { x: v.x + u2.x * L, y: v.y + u2.y * L };
  const heading = dirToBearing(-u1.x, -u1.y);
  const turn = cross({ x: -u1.x, y: -u1.y }, u2) > 0 ? 1 : -1;
  const arc = arcFromTangent(t1, heading, r, turn * (Math.PI - phi));
  if (!arc) return null;
  return {
    arc,
    a: { kind: 'line', p0: a.p0, p1: t1 },
    b: { kind: 'line', p0: t2, p1: b.p1 },
  };
}
