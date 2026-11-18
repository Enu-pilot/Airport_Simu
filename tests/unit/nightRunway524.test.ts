import { describe, expect, it } from 'vitest';
import { bearingInSector, nightEndPermissions } from '../../src/core/economy/nightRunway';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';

describe('5-24 方向別夜間運航の判定', () => {
  it('方位範囲は 0 度跨ぎを含めて判定する', () => {
    const north = { fromDeg: 350, toDeg: 10 };
    expect(bearingInSector(0, north)).toBe(true);
    expect(bearingInSector(355, north)).toBe(true);
    expect(bearingInSector(90, north)).toBe(false);
    expect(bearingInSector(90, { fromDeg: 45, toDeg: 135 })).toBe(true);
    expect(bearingInSector(270, { fromDeg: 45, toDeg: 135 })).toBe(false);
  });

  it('東側が保護区域なら、東への離陸と東からの進入だけが夜間不可になる（サンプル空港は方位 90）', () => {
    const l = createSampleAirport();
    const perms = nightEndPermissions(l, [{ fromDeg: 45, toDeg: 135, label: '市街地' }]);
    expect(perms).toHaveLength(2);
    const start = perms.find((p) => p.end === 'start')!;
    const far = perms.find((p) => p.end === 'far')!;
    expect(start.departureBearing).toBe(90);
    expect(start.departureAllowed).toBe(false); // 東へ離陸は市街地上空
    expect(start.arrivalAllowed).toBe(true); // 進入は西側から
    expect(far.departureAllowed).toBe(true); // 西へ離陸
    expect(far.arrivalAllowed).toBe(false); // 進入は東側から
  });

  it('保護区域がなければ全方向が候補になる', () => {
    const perms = nightEndPermissions(createSampleAirport(), []);
    expect(perms.every((p) => p.departureAllowed && p.arrivalAllowed)).toBe(true);
  });
});
