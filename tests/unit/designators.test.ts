import { describe, expect, it } from 'vitest';
import { designatorsOf, reciprocalNumber } from '../../src/core/layout/designators';
import { runwayDesignators } from '../../src/core/layout/runway';
import type { AirportLayout, Heading, RunwayFree, RunwayGrid8, RunwaySuffix } from '../../src/core/model/types';
import { emptyLayout } from './helpers';

const free = (id: string, headingDeg: number, x = 0, y = 0, designatorSuffix?: RunwaySuffix): RunwayFree => ({
  id,
  name: '',
  alignment: 'free',
  start: { x, y },
  headingDeg,
  lengthM: 3000,
  surfaceWidthM: 45,
  buildState: 'operational',
  ...(designatorSuffix ? { designatorSuffix } : {}),
});
const grid = (id: string, heading: Heading, x = 0, y = 0): RunwayGrid8 => ({ id, name: '', start: { x, y }, heading, length: 40, surfaceWidthM: 45, buildState: 'operational' });

const layoutOf = (rs: (RunwayFree | RunwayGrid8)[], variation?: number): AirportLayout => {
  const l = emptyLayout();
  for (const r of rs) l.runways[r.id] = r;
  if (variation !== undefined) l.magneticVariationDeg = variation;
  return l;
};
const dz = (r: RunwayFree | RunwayGrid8, l: AirportLayout) => designatorsOf(r, l);
const one = (deg: number, variation?: number) => {
  const r = free('rwy_1', deg);
  return dz(r, layoutOf([r], variation));
};

describe('滑走路番号 designatorsOf（S2）', () => {
  it('0〜359° の整数と 0.5° 刻み: 番号は磁方位/10 の四捨五入（0.5 は切り上げ、0 は 36）で、逆向きは必ず 18 差', () => {
    for (let k = 0; k < 360 * 2; k++) {
      const deg = k / 2;
      const d = one(deg);
      const expected = Math.round(deg / 10) % 36 || 36;
      expect(d.numbers[0]).toBe(expected);
      expect(Math.abs(d.numbers[1] - d.numbers[0])).toBe(18);
      expect(d.numbers[1]).toBe(reciprocalNumber(d.numbers[0]));
      expect(d.trueDeg[0]).toBe(deg);
      expect(d.trueDeg[1]).toBe((deg + 180) % 360);
    }
  });

  it('境界: 0 → 36、4.999999 → 36、5 → 01、354.999999 → 35、355 → 36、359.999999 → 36、360 → 36、-0 → 36', () => {
    const n = (deg: number) => one(deg).numbers[0];
    expect(n(0)).toBe(36);
    expect(n(4.999999)).toBe(36);
    expect(n(5)).toBe(1);
    expect(n(14.999999)).toBe(1);
    expect(n(15)).toBe(2);
    expect(n(354.999999)).toBe(35);
    expect(n(355)).toBe(36);
    expect(n(359.999999)).toBe(36);
    expect(n(360)).toBe(36);
    expect(n(-0)).toBe(36);
    expect(n(180)).toBe(18);
    expect(one(0).text).toEqual(['36', '18']);
    expect(one(90).text).toEqual(['09', '27']);
  });

  it('全ての x5° の境界（5, 15, …, 355）で逆向きがちょうど 18 差（独立に丸めると崩れうる箇所）', () => {
    for (let m = 5; m < 360; m += 10) {
      for (const off of [-1e-9, 0, 1e-9]) {
        const d = one(m + off);
        expect(Math.abs(d.numbers[1] - d.numbers[0])).toBe(18);
      }
    }
  });

  it('非有限の方位は例外（NaN の番号を黙って返さない）', () => {
    expect(() => one(NaN)).toThrow();
    expect(() => one(Infinity)).toThrow();
    expect(() => one(-Infinity)).toThrow();
  });

  it('真方位と磁方位: 真 090° で偏差 10°E → 磁 080° = 08/26、10°W → 磁 100° = 10/28、偏差なし → 09/27', () => {
    const e = one(90, 10);
    expect(e.text).toEqual(['08', '26']);
    expect(e.magDeg).toEqual([80, 260]);
    expect(e.trueDeg).toEqual([90, 270]);
    const w = one(90, -10);
    expect(w.text).toEqual(['10', '28']);
    expect(w.magDeg).toEqual([100, 280]);
    expect(one(90).text).toEqual(['09', '27']);
    // 北をまたぐ: 真 005° 偏差 10°E → 磁 355° → 36
    expect(one(5, 10).text).toEqual(['36', '18']);
    // 偏差で 360 を超える側: 真 355° 偏差 10°W → 磁 005° → 01
    expect(one(355, -10).numbers[0]).toBe(1);
  });

  it('従来形の全 8 方位（偏差 0・接尾辞なし）は runwayDesignators と完全一致', () => {
    for (const h of [0, 45, 90, 135, 180, 225, 270, 315] as Heading[]) {
      const r = grid('rwy_1', h);
      expect(dz(r, layoutOf([r])).text).toEqual(runwayDesignators(h));
    }
  });

  it('接尾辞: 平行 2 本は L・R（進入方向から見て左から右）。終点側は L↔R が入れ替わる', () => {
    // 東向き（09）: 北（y が小さい）が左
    const a = free('rwy_1', 90, 0, 0);
    const b = free('rwy_2', 90, 0, 10);
    const l = layoutOf([a, b]);
    expect(dz(a, l).text).toEqual(['09L', '27R']);
    expect(dz(b, l).text).toEqual(['09R', '27L']);
    // 北向き（36）: 西（x が小さい）が左
    const c = free('rwy_1', 0, 0, 0);
    const d = free('rwy_2', 0, 10, 0);
    const l2 = layoutOf([c, d]);
    expect(dz(c, l2).suffix).toEqual(['L', 'R']);
    expect(dz(d, l2).suffix).toEqual(['R', 'L']);
    // 並べる順は ID に依らない（ID を入れ替えても物理的な左右は同じ）
    const e = free('rwy_2', 90, 0, 0);
    const f = free('rwy_1', 90, 0, 10);
    const l3 = layoutOf([e, f]);
    expect(dz(e, l3).suffix).toEqual(['L', 'R']);
    expect(dz(f, l3).suffix).toEqual(['R', 'L']);
  });

  it('接尾辞: 3 本は L・C・R、4 本以上は自動では付けない', () => {
    const rs = [free('rwy_1', 90, 0, 20), free('rwy_2', 90, 0, 0), free('rwy_3', 90, 0, 10)];
    const l = layoutOf(rs);
    expect(dz(rs[1]!, l).suffix[0]).toBe('L');
    expect(dz(rs[2]!, l).suffix[0]).toBe('C');
    expect(dz(rs[0]!, l).suffix[0]).toBe('R');
    expect(dz(rs[2]!, l).suffix[1]).toBe('C');
    const four = [...rs, free('rwy_4', 90, 0, 30)];
    const l4 = layoutOf(four);
    for (const r of four) expect(dz(r, l4).suffix).toEqual(['', '']);
  });

  it('接尾辞: 逆向き（27 側が始点）の平行滑走路も同じ組として数え、左右が物理的に正しい', () => {
    const a = free('rwy_1', 90, 0, 0); // 東向き、北側
    const b = free('rwy_2', 270, 100, 10); // 西向き、南側
    const l = layoutOf([a, b]);
    expect(dz(a, l).text).toEqual(['09L', '27R']);
    // b は西向きで進入すると左は南 = b 自身 → 27L
    expect(dz(b, l).text).toEqual(['27L', '09R']);
  });

  it('接尾辞は番号が違う滑走路や 1 本だけのときは付かない', () => {
    const a = free('rwy_1', 90, 0, 0);
    const b = free('rwy_2', 45, 0, 10);
    const l = layoutOf([a, b]);
    expect(dz(a, l).suffix).toEqual(['', '']);
    expect(dz(b, l).suffix).toEqual(['', '']);
  });

  it('designatorSuffix の上書きは自動より優先（none は付けない、終点側は L↔R が入れ替わる）', () => {
    const a = free('rwy_1', 90, 0, 0, 'C');
    const b = free('rwy_2', 90, 0, 10, 'none');
    const l = layoutOf([a, b]);
    expect(dz(a, l).text).toEqual(['09C', '27C']);
    expect(dz(b, l).text).toEqual(['09', '27']);
    const c = free('rwy_3', 90, 0, 50, 'R');
    expect(dz(c, layoutOf([c])).text).toEqual(['09R', '27L']);
  });

  it('従来形には接尾辞を自動で付けない（平行でも従来の表示のまま）。明示の上書きだけが効く', () => {
    const a = grid('rwy_1', 90, 0, 0);
    const b = grid('rwy_2', 90, 0, 10);
    const l = layoutOf([a, b]);
    expect(dz(a, l).text).toEqual(['09', '27']);
    expect(dz(b, l).text).toEqual(['09', '27']);
    const c: RunwayGrid8 = { ...grid('rwy_3', 90, 0, 20), designatorSuffix: 'L' };
    expect(dz(c, layoutOf([c])).text).toEqual(['09L', '27R']);
  });

  it('従来形と自由形が平行なら、自由形にだけ接尾辞が付く（左右の判定には従来形も数える）', () => {
    const g = grid('rwy_1', 90, 0, 0); // 北側
    const f = free('rwy_2', 90, 0, 10); // 南側 = 右
    const l = layoutOf([g, f]);
    expect(dz(g, l).text).toEqual(['09', '27']);
    expect(dz(f, l).text).toEqual(['09R', '27L']);
  });
});
