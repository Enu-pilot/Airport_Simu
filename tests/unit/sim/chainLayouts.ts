import { addTaxiwayPath, placeFacility, placeFreeRunway, placeRunway, placeStand, type OpResult } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { emptyLayout, must } from '../helpers';

/** スポット・エプロンを北側に置く共通部分（誘導路 y=22 に接続） */
function apron(l0: AirportLayout, x0: number): AirportLayout {
  let l = l0;
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeFacility(l, 'apron', { x: x0, y: 15 }, { w: 26, h: 9 }));
  step(placeStand(l, { x: x0 + 5, y: 19 }, 'M', 0, 'operational', 'S1'));
  step(placeStand(l, { x: x0 + 10, y: 19 }, 'M', 0, 'operational', 'S2'));
  step(placeStand(l, { x: x0 + 16, y: 19 }, 'M', 0, 'operational', 'S3'));
  step(placeStand(l, { x: x0 + 21, y: 19 }, 'M', 0, 'operational', 'S4'));
  step(placeFacility(l, 'gseBase', { x: x0 + 27, y: 18 }));
  step(placeFacility(l, 'fuelFarm', { x: x0 + 27, y: 12 }));
  step(placeFacility(l, 'maintenance', { x: x0 - 6, y: 18 }));
  return l;
}

/**
 * 従来形の平行 2 本（y=30 と y=35、間隔 5 タイル = 125 m）を 1 本の誘導路（x=50）が横切る。
 * 南の滑走路へ行く経路は、北の滑走路を横断した直後に南の滑走路の停止位置（87.5 m 手前）に来る（連続横断の幾何）。
 */
export function legacyTwinAirport(): AirportLayout {
  let l = emptyLayout(130, 70);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeRunway(l, { x: 10, y: 30 }, 90, 90, { surfaceWidthM: 45 }));
  step(placeRunway(l, { x: 10, y: 35 }, 90, 90, { surfaceWidthM: 45 }));
  step(addTaxiwayPath(l, [{ x: 40, y: 23 }, { x: 62, y: 23 }]));
  step(addTaxiwayPath(l, [{ x: 50, y: 23 }, { x: 50, y: 45 }]));
  step(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 10, y: 35 }, { x: 10, y: 45 }]));
  step(addTaxiwayPath(l, [{ x: 100, y: 30 }, { x: 100, y: 35 }, { x: 100, y: 45 }]));
  step(addTaxiwayPath(l, [{ x: 10, y: 45 }, { x: 100, y: 45 }]));
  return apron(l, 38);
}

/** 約 23° で交差する自由形 2 本を、交差点の近くで誘導路（x=50）が横切る */
export function freeShallowCrossingAirport(): AirportLayout {
  let l = emptyLayout(130, 80);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeFreeRunway(l, { start: { x: 10, y: 30 }, headingDeg: 90, lengthM: 90 * 25 }, { surfaceWidthM: 45 }));
  // 方位 67°: 始点 (17, 48) から北東へ。x=50 の誘導路が y=30 の滑走路を横切った 100 m 先で横切る（連続横断の幾何）
  step(placeFreeRunway(l, { start: { x: 17, y: 48 }, headingDeg: 67, lengthM: 2400 }, { surfaceWidthM: 45 }));
  step(addTaxiwayPath(l, [{ x: 40, y: 23 }, { x: 62, y: 23 }]));
  step(addTaxiwayPath(l, [{ x: 50, y: 23 }, { x: 50, y: 50 }]));
  step(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 10, y: 48 }, { x: 17, y: 48 }]));
  step(addTaxiwayPath(l, [{ x: 100, y: 30 }, { x: 100, y: 50 }]));
  return apron(l, 38);
}
