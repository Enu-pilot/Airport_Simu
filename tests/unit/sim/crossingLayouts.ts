import { addTaxiwayPath, placeFacility, placeFreeRunway, placeStand, type OpResult } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { emptyLayout, must } from '../helpers';

/**
 * 交差する自由形の滑走路 2 本の空港（Phase 12 S7）。
 *   A: 東西（y=30, x=10..100）、B: 北東向き 45°（始点 (58,52) → (80,30) で A と交差 → 終点 (102,8)）
 *   A と B の交点 (80,30) には誘導路ノードがある（スポット側の誘導路が x=80 で A・B を同時に横断する）。
 *   スポットは北側のエプロン（入口が誘導路 y=23 に接する位置）。平行誘導路 y=38 は (72,38) で B を横断する。
 */
export function crossingFreeAirport(): AirportLayout {
  let l = emptyLayout(130, 90);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeFreeRunway(l, { start: { x: 10, y: 30 }, headingDeg: 90, lengthM: 90 * 25 }, { surfaceWidthM: 45 }));
  step(placeFreeRunway(l, { start: { x: 58, y: 52 }, headingDeg: 45, lengthM: 44 * Math.SQRT2 * 25 }, { surfaceWidthM: 45 }));
  step(addTaxiwayPath(l, [{ x: 10, y: 38 }, { x: 100, y: 38 }]));
  step(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 10, y: 38 }]));
  step(addTaxiwayPath(l, [{ x: 100, y: 30 }, { x: 100, y: 38 }]));
  step(addTaxiwayPath(l, [{ x: 58, y: 38 }, { x: 58, y: 52 }]));
  step(addTaxiwayPath(l, [{ x: 45, y: 23 }, { x: 80, y: 23 }, { x: 80, y: 38 }]));
  step(placeFacility(l, 'apron', { x: 42, y: 15 }, { w: 26, h: 9 }));
  step(placeStand(l, { x: 47, y: 21 }, 'M', 0, 'operational', 'S1'));
  step(placeStand(l, { x: 52, y: 21 }, 'M', 0, 'operational', 'S2'));
  step(placeStand(l, { x: 58, y: 21 }, 'M', 0, 'operational', 'S3'));
  step(placeStand(l, { x: 63, y: 21 }, 'M', 0, 'operational', 'S4'));
  step(placeFacility(l, 'gseBase', { x: 69, y: 18 }));
  step(placeFacility(l, 'fuelFarm', { x: 69, y: 12 }));
  step(placeFacility(l, 'maintenance', { x: 38, y: 18 }));
  return l;
}

/** 平行な自由形の滑走路 2 本（y=30 と y=60、間隔 750 m）。スポットは間の平行誘導路 y=45 の北側 */
export function parallelFreeAirport(): AirportLayout {
  let l = emptyLayout(130, 90);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeFreeRunway(l, { start: { x: 10, y: 30 }, headingDeg: 90, lengthM: 90 * 25 }, { surfaceWidthM: 45 }));
  step(placeFreeRunway(l, { start: { x: 10, y: 60 }, headingDeg: 90, lengthM: 90 * 25 }, { surfaceWidthM: 45 }));
  step(addTaxiwayPath(l, [{ x: 10, y: 45 }, { x: 100, y: 45 }]));
  step(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 10, y: 60 }]));
  step(addTaxiwayPath(l, [{ x: 100, y: 30 }, { x: 100, y: 60 }]));
  step(placeFacility(l, 'apron', { x: 42, y: 38 }, { w: 26, h: 7 }));
  step(placeStand(l, { x: 47, y: 43 }, 'M', 0, 'operational', 'S1'));
  step(placeStand(l, { x: 52, y: 43 }, 'M', 0, 'operational', 'S2'));
  step(placeStand(l, { x: 58, y: 43 }, 'M', 0, 'operational', 'S3'));
  step(placeStand(l, { x: 63, y: 43 }, 'M', 0, 'operational', 'S4'));
  step(placeFacility(l, 'gseBase', { x: 69, y: 40 }));
  step(placeFacility(l, 'fuelFarm', { x: 75, y: 40 }));
  step(placeFacility(l, 'maintenance', { x: 36, y: 40 }));
  return l;
}
