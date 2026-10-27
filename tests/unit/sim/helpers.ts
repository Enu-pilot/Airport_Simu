import { addTaxiwayPath, deleteEntity, placeFacility, placeRunway, placeStand, type OpResult } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import type { AircraftState } from '../../../src/core/sim/types';
import { emptyLayout, must } from '../helpers';

/** 不変条件を毎ティック確認しながら進める。cond が真になったら止める */
export function runUntil(sim: Simulation, cond: () => boolean, maxTicks: number): number {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return i;
    stepSimulation(sim);
    const v = checkInvariants(sim);
    if (v.length > 0) throw new Error(`t=${sim.state.now}: ${v.join(' / ')}`);
  }
  if (cond()) return maxTicks;
  throw new Error(`condition not met within ${maxTicks} ticks (t=${sim.state.now})`);
}

export function states(sim: Simulation, acId: string): AircraftState[] {
  return sim.state.aircraft[acId]!.history.map((h) => h.state);
}

/**
 * 滑走路の北側にスポット、南側に平行誘導路がある空港。
 * スポットと滑走路端の間の移動は、必ず滑走路を横断する。
 *
 *   y=19..22  [S1][S2]          (スポット, 機首北)
 *   y=23      ──┬── エプロン誘導路
 *   y=30  ══════╪══════ 滑走路 (x=10..100)
 *   y=38  ──────┴────── 平行誘導路
 */
export function crossingAirport(): AirportLayout {
  let l = emptyLayout(120, 60);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeRunway(l, { x: 10, y: 30 }, 90, 90, { surfaceWidthM: 45 }));
  step(addTaxiwayPath(l, [{ x: 10, y: 38 }, { x: 100, y: 38 }]));
  step(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 10, y: 38 }]));
  step(addTaxiwayPath(l, [{ x: 100, y: 30 }, { x: 100, y: 38 }]));
  step(addTaxiwayPath(l, [{ x: 55, y: 23 }, { x: 55, y: 38 }]));
  step(placeFacility(l, 'apron', { x: 42, y: 15 }, { w: 26, h: 9 }));
  step(addTaxiwayPath(l, [{ x: 45, y: 23 }, { x: 65, y: 23 }]));
  step(placeStand(l, { x: 47, y: 19 }, 'M', 0, 'operational', 'S1'));
  step(placeStand(l, { x: 58, y: 19 }, 'M', 0, 'operational', 'S2'));
  return l;
}

/** サンプル空港からスポットを1つだけ残す */
export function keepOnlyStand(l: AirportLayout, keep: string): AirportLayout {
  for (const id of Object.keys(l.stands)) if (id !== keep) l = must(deleteEntity(l, id)).layout;
  return l;
}
