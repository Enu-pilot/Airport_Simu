/** 区間ごとの走行（taxiMode 'block'）のテストの共通部品（テスト専用） */
import { Rng } from '../../../src/core/rng';
import type { AirportLayout } from '../../../src/core/model/types';
import { addTurnaround, type Simulation } from '../../../src/core/sim/simulation';
import { addTaxiwayPath, placeFacility, placeRunway, placeStand, type OpResult } from '../../../src/core/layout/operations';
import { emptyLayout, must } from '../helpers';

/**
 * 滑走路手前に長い誘導路（1250 m = 5 区間）がある配置: 滑走路端 (10,30) から南へ W（50 タイル）、その先の東西のエプロン誘導路 A にスポット n 個。到着の離脱路 E（x=80）。
 * 長い最終進入の区間に複数機が入るので、滑走路手前の列（runwayQueue）ができる。
 */
export function longApproachLayout(n = 4): AirportLayout {
  let l = emptyLayout(120, 110);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeRunway(l, { x: 10, y: 30 }, 90, 100, { surfaceWidthM: 45 }));
  step(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 10, y: 80 }], { name: 'W' }));
  const x0 = 12;
  step(addTaxiwayPath(l, [{ x: 10, y: 80 }, { x: 80, y: 80 }], { name: 'A' }));
  step(addTaxiwayPath(l, [{ x: 80, y: 30 }, { x: 80, y: 80 }], { name: 'E' }));
  step(placeFacility(l, 'apron', { x: x0 - 1, y: 81 }, { w: n * 5 + 4, h: 8 }));
  for (let i = 0; i < n; i++) step(placeStand(l, { x: x0 + i * 5, y: 81 }, 'M', 180, 'operational', `S${i + 1}`));
  step(placeFacility(l, 'gseBase', { x: x0 + n * 5 + 6, y: 85 }));
  step(placeFacility(l, 'fuelFarm', { x: x0 + n * 5 + 6, y: 90 }));
  step(placeFacility(l, 'maintenance', { x: x0 - 8, y: 85 }));
  return l;
}

export const asBlock = (l: AirportLayout, tiles?: number): AirportLayout => ({ ...l, taxiMode: 'block', ...(tiles !== undefined ? { taxiBlockTiles: tiles } : {}) });

/** n 機を同時刻に出発させる（到着は 60 秒刻み。出発は全機 t0 + 3600 に予定。d1a と同じ条件） */
export function simultaneous(sim: Simulation, n: number, seed: string, typeId = 'narrow180') {
  const t0 = sim.state.now + 20 * 60;
  const rng = new Rng(`${seed}:arr`);
  return Array.from({ length: n }, (_, i) => addTurnaround(sim, typeId, t0 + i * 60 + rng.int(0, 120), { departureAt: t0 + 3600 }));
}

export const phase2 = (tag: string, obj: unknown): void => {
  console.log(`[phase2] ${JSON.stringify({ tag, ...(obj as object) })}`);
};

/** 終了時に区間の占有・回廊の向き・交差点の予約が残っていないか */
export function leftovers(sim: Simulation): string[] {
  const out: string[] = [];
  const tb = sim.state.taxiBlocks;
  if (tb && Object.keys(tb.occ).length > 0) out.push(`occ: ${JSON.stringify(tb.occ)}`);
  if (tb && Object.keys(tb.locks).length > 0) out.push(`locks: ${JSON.stringify(tb.locks)}`);
  if (Object.keys(sim.state.nodeReservations).length > 0) out.push(`nodes: ${JSON.stringify(sim.state.nodeReservations)}`);
  if (Object.keys(sim.state.edgeReservations).length > 0) out.push(`edges: ${JSON.stringify(sim.state.edgeReservations)}`);
  return out;
}
