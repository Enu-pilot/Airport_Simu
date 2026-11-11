import { describe, expect, it } from 'vitest';
import {
  GRID8_STEP,
  bearingToDir,
  designatorNumber,
  dirToBearing,
  formatDesignator,
  isGrid8Heading,
  magneticFromTrue,
  normalizeDeg,
  signedAngleDiffDeg,
  turnAngleDeg,
} from '../../../src/core/geometry/angle';
import { runwayDesignators } from '../../../src/core/layout/runway';
import { headingOf, turnAngleAt } from '../../../src/core/sim/routes';
import type { Heading } from '../../../src/core/model/types';
import { Rng } from '../../../src/core/rng';

const H8: Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];

// ---- オラクル（旧コードの式をそのまま複製）
const oracleHeadingVector = (h: number) => {
  const rad = (h * Math.PI) / 180;
  return { x: Math.round(Math.sin(rad)), y: Math.round(-Math.cos(rad)) };
};
const oracleHeadingOf = (dx: number, dy: number) => {
  if (dx === 0 && dy === 0) return 0;
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
};
const oracleTurn = (h1: number, h2: number) => {
  const d = Math.abs(h2 - h1) % 360;
  return d > 180 ? 360 - d : d;
};
const oracleDesignator = (deg: number) => {
  const n = Math.round(deg / 10) % 36;
  return String(n === 0 ? 36 : n).padStart(2, '0');
};

describe('angle: 旧式とのオラクル比較', () => {
  it('GRID8_STEP は旧 headingVector と 8 方位すべてで === 一致する', () => {
    for (const h of H8) {
      expect(GRID8_STEP[h].x === oracleHeadingVector(h).x).toBe(true);
      expect(GRID8_STEP[h].y === oracleHeadingVector(h).y).toBe(true);
    }
  });

  it('dirToBearing は headingOf と === 一致する（8 方位・(0,0)・乱数 10,000 方向）', () => {
    expect(dirToBearing(0, 0)).toBe(0);
    for (const h of H8) {
      const v = GRID8_STEP[h];
      expect(dirToBearing(v.x, v.y) === oracleHeadingOf(v.x, v.y)).toBe(true);
      expect(dirToBearing(v.x, v.y) === headingOf(v.x, v.y)).toBe(true);
    }
    const rng = new Rng('dir');
    for (let i = 0; i < 10000; i++) {
      const dx = rng.next() * 200 - 100;
      const dy = rng.next() * 200 - 100;
      expect(dirToBearing(dx, dy) === oracleHeadingOf(dx, dy)).toBe(true);
      expect(dirToBearing(dx, dy) === headingOf(dx, dy)).toBe(true);
    }
  });

  it('turnAngleDeg は旧 turnAngleAt の式と === 一致する（乱数 10,000 組）', () => {
    const rng = new Rng('turn');
    for (let i = 0; i < 10000; i++) {
      const a = rng.next() * 360;
      const b = rng.next() * 360;
      expect(turnAngleDeg(a, b) === oracleTurn(a, b)).toBe(true);
    }
    expect(typeof turnAngleAt).toBe('function');
  });

  it('designatorNumber は旧 runwayDesignators の式と 0〜359 の整数・0.5 刻みで一致する', () => {
    for (let d = 0; d < 360; d++) {
      expect(formatDesignator(designatorNumber(d))).toBe(oracleDesignator(d));
    }
    for (const h of H8) {
      expect([formatDesignator(designatorNumber(h)), formatDesignator(designatorNumber((h + 180) % 360))]).toEqual(runwayDesignators(h));
    }
  });
});

describe('angle: 基本', () => {
  it('normalizeDeg は [0,360) に入り -0 を作らない', () => {
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(-90)).toBe(270);
    expect(normalizeDeg(725)).toBe(5);
    expect(Object.is(normalizeDeg(-0), 0)).toBe(true);
    expect(Object.is(normalizeDeg(-360), 0)).toBe(true);
    expect(normalizeDeg(-1e-20)).toBeLessThan(360);
  });

  it('bearingToDir: 90° の倍数は厳密、45° の奇数倍は ±√½、一般角は sin/-cos', () => {
    expect(bearingToDir(0)).toEqual({ x: 0, y: -1 });
    expect(bearingToDir(90)).toEqual({ x: 1, y: 0 });
    expect(bearingToDir(180)).toEqual({ x: 0, y: 1 });
    expect(bearingToDir(270)).toEqual({ x: -1, y: 0 });
    expect(bearingToDir(-90)).toEqual({ x: -1, y: 0 });
    expect(bearingToDir(45)).toEqual({ x: Math.SQRT1_2, y: -Math.SQRT1_2 });
    expect(bearingToDir(225)).toEqual({ x: -Math.SQRT1_2, y: Math.SQRT1_2 });
    const d = bearingToDir(30);
    expect(d.x).toBeCloseTo(0.5, 12);
    expect(d.y).toBeCloseTo(-Math.sqrt(3) / 2, 12);
  });

  it('bearingToDir と dirToBearing は往復する', () => {
    const rng = new Rng('rt');
    for (let i = 0; i < 2000; i++) {
      const deg = rng.next() * 360;
      const v = bearingToDir(deg);
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 12);
      const back = dirToBearing(v.x, v.y);
      expect(Math.abs(signedAngleDiffDeg(deg, back))).toBeLessThan(1e-9);
    }
    for (const h of H8) {
      const v = bearingToDir(h);
      expect(dirToBearing(v.x, v.y)).toBeCloseTo(h, 10);
    }
  });

  it('signedAngleDiffDeg ∈ (-180, 180]', () => {
    expect(signedAngleDiffDeg(350, 10)).toBe(20);
    expect(signedAngleDiffDeg(10, 350)).toBe(-20);
    expect(signedAngleDiffDeg(0, 180)).toBe(180);
    expect(signedAngleDiffDeg(180, 0)).toBe(180);
    expect(signedAngleDiffDeg(90, 90)).toBe(0);
  });

  it('isGrid8Heading', () => {
    for (const h of H8) expect(isGrid8Heading(h)).toBe(true);
    for (const n of [-45, 360, 30, 44.5, NaN, 405]) expect(isGrid8Heading(n)).toBe(false);
  });

  it('磁方位: 東偏差を正（10°E → 真 090° は磁 080° = "08"、7°W → 磁 097° = "10"）', () => {
    expect(magneticFromTrue(90, 10)).toBe(80);
    expect(formatDesignator(designatorNumber(magneticFromTrue(90, 10)))).toBe('08');
    expect(magneticFromTrue(90, -7)).toBe(97);
    expect(formatDesignator(designatorNumber(magneticFromTrue(90, -7)))).toBe('10');
    expect(magneticFromTrue(5, 10)).toBe(355);
    expect(formatDesignator(designatorNumber(magneticFromTrue(5, 10)))).toBe('36');
  });

  it('designatorNumber: .5 は切り上げ、浮動小数点の揺れに強い', () => {
    expect(designatorNumber(5)).toBe(1);
    expect(designatorNumber(4.9999999999)).toBe(1);
    expect(designatorNumber(355)).toBe(36);
    expect(designatorNumber(360)).toBe(36);
    expect(designatorNumber(0)).toBe(36);
    expect(designatorNumber(25 - 1e-12)).toBe(3);
    expect(designatorNumber(-10)).toBe(35);
  });
});
