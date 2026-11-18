import { describe, expect, it } from 'vitest';
import {
  curveRequiredWidthM,
  mainGearOffTrackM,
  maxEntrySpeedMps,
  retPath,
  stoppingDistanceM,
  taxiwayCornerFillet,
} from '../../src/core/airside/taxiwayDesign';

describe('5-17 T4 コーナーのフィレットと主脚余裕', () => {
  it('直角コーナー・半径 100m: 接線長 100m、弧長 50πm、旋回角 90 度', () => {
    // タイル座標: 頂点 (10,10)、西から来て南へ曲がる（1 タイル = 25m なので辺は十分長い）
    const f = taxiwayCornerFillet({ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, 100);
    expect(f).not.toBeNull();
    expect(f!.tangentDistM).toBeCloseTo(100, 6);
    expect(f!.arcLengthM).toBeCloseTo(50 * Math.PI, 6);
    expect(f!.turnAngleDeg).toBeCloseTo(90, 6);
  });

  it('一直線と折り返しは null、接線長が辺を超える半径も null', () => {
    expect(taxiwayCornerFillet({ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 10 }, 100)).toBeNull();
    expect(taxiwayCornerFillet({ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 0, y: 10 }, 100)).toBeNull();
    // 辺は 250m しかないのに接線長 1000m が必要な半径は入らない
    expect(taxiwayCornerFillet({ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, 1000)).toBeNull();
  });

  it('オフトラッキング: R=100, L=20 で約 2.02m 内側にずれ、必要幅は OMGWS + 2×ずれ', () => {
    const off = mainGearOffTrackM(100, 20)!;
    expect(off).toBeCloseTo(100 - Math.sqrt(10000 - 400), 10);
    expect(curveRequiredWidthM(9, off)).toBeCloseTo(9 + 2 * off, 10);
    expect(mainGearOffTrackM(100, 100)).toBeNull();
    expect(mainGearOffTrackM(100, 0)).toBe(0);
  });
});

describe('5-17 T5 RET 形状', () => {
  it('離脱角 30 度・半径 300m・間隔 180m の経路が手計算と一致する', () => {
    const p = retPath(30, 300, 180)!;
    const arcLat = 300 * (1 - Math.cos(Math.PI / 6));
    expect(p.arcLengthM).toBeCloseTo(300 * (Math.PI / 6), 8);
    expect(p.straightLengthM).toBeCloseTo((180 - arcLat) / Math.sin(Math.PI / 6), 8);
    expect(p.alongRunwayM).toBeCloseTo(300 * Math.sin(Math.PI / 6) + p.straightLengthM * Math.cos(Math.PI / 6), 8);
    expect(p.totalLengthM).toBeCloseTo(p.arcLengthM + p.straightLengthM, 8);
  });

  it('円弧だけで間隔を超える場合は null、直角は RET として扱わない', () => {
    expect(retPath(30, 3000, 180)).toBeNull();
    expect(retPath(90, 300, 180)).toBeNull();
    expect(retPath(0, 300, 180)).toBeNull();
  });

  it('停止距離と許容進入速度は逆関数の関係', () => {
    expect(stoppingDistanceM(50, 2)).toBeCloseTo(625, 8);
    expect(maxEntrySpeedMps(625, 2)).toBeCloseTo(50, 8);
    expect(stoppingDistanceM(50, 0)).toBeNull();
  });
});
