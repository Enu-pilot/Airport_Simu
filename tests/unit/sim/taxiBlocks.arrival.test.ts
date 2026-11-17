import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { holdShortOnRoute } from '../../../src/core/sim/routes';
import { resolveType } from '../../../src/core/sim/aircraftTypes';
import { addTurnaround, createSimulation } from '../../../src/core/sim/simulation';
import type { Aircraft } from '../../../src/core/sim/types';
import { allDone, linearLayout, manual, runwayIntrusions, traceRun } from '../../audit/d_helpers';
import { asBlock, leftovers, longApproachLayout, phase2 } from './blockHelpers';

const SEEDS = ['d1-s1', 'd1-s2', 'd1-s3'];

/** 到着の連続流入（d1d と同じ条件: スポット 8 に n 機、到着は 30 分に散らし、折り返しは 40〜60 分） */
function flow(layout: ReturnType<typeof linearLayout>, seed: string, n: number) {
  const sim = createSimulation(layout, { seed, settings: manual });
  const rng = new Rng(seed);
  const t0 = sim.state.now + 20 * 60;
  const acs: Aircraft[] = [];
  for (let i = 0; i < n; i++) {
    const arr = t0 + Math.round(rng.next() * 30 * 60);
    acs.push(addTurnaround(sim, (['regional70', 'narrow180', 'narrow180'] as const)[rng.int(0, 2)]!, arr, { departureAt: arr + (40 + rng.int(0, 20)) * 60 }));
  }
  return { sim, acs };
}

describe('2-05 taxiBlocks.arrival: 到着機の進入許可（滑走路の出口と、その先に収まる区間の枠）', () => {
  for (const seed of SEEDS) {
    for (const [name, mk] of [['linear', () => linearLayout({ stands: 8 })], ['longApproach', () => longApproachLayout(8)]] as const) {
      it(`${name} 到着 12 機の連続流入 × 出発 seed=${seed}: 解放位置の手前での停止 0・滑走路侵入 0・不変条件違反 0・確保が残らない`, { timeout: 180_000 }, () => {
        const { sim, acs } = flow(asBlock(mk()), seed, 12);
        let stopsBeforeRelease = 0;
        let intrusions = 0;
        let maxHold = 0;
        const tr = traceRun(sim, 8 * 3600, {
          every: 10,
          onTick: (s) => {
            intrusions += runwayIntrusions(s).length;
            for (const a of Object.values(s.state.aircraft)) {
              if (a.holdReason && a.state === 'holding') maxHold = Math.max(maxHold, s.state.now - (a.waitSince ?? s.state.now));
              if ((a.state !== 'landing' && a.state !== 'vacating') || !a.route || a.speed > 0.01 || a.stateSince === s.state.now) continue;
              const r = a.route;
              const len = resolveType(s.ctx.types, a.typeId).lengthM;
              const release = r.cum[r.runwayEnd]! + Math.max(holdShortOnRoute(s.ctx, r, r.runwayEnd, 1), len);
              // 着陸滑走中（dist < 出口）の停止も、解放位置の手前の停止も数える
              if (a.dist < release - 0.01) stopsBeforeRelease++;
            }
          },
        });
        expect(tr.violations, seed).toEqual([]);
        expect(stopsBeforeRelease, '滑走路を解放する前に速度 0 になった回数').toBe(0);
        expect(intrusions, '他機の離着陸中の滑走路侵入').toBe(0);
        expect(sim.state.stats.conflicts).toBe(0);
        expect(allDone(sim), seed).toBe(true);
        expect(leftovers(sim)).toEqual([]);
        phase2('2-05-arrival', { layout: name, seed, stopsBeforeRelease, intrusions, goArounds: sim.state.stats.goArounds, diverted: sim.state.stats.diverted, arrivals: sim.state.stats.arrivals, departures: sim.state.stats.departures, maxAirborneHoldSec: maxHold, flights: acs.length });
      });
    }
  }

  it('ゴーアラウンド時に確保が残らない（着陸時に滑走路が塞がっている状況を作る）', () => {
    const sim = createSimulation(asBlock(linearLayout({ stands: 4 })), { seed: 'ga', settings: manual });
    const t0 = sim.state.now + 20 * 60;
    for (let i = 0; i < 4; i++) addTurnaround(sim, 'narrow180', t0 + i * 30, { departureAt: t0 + 3600 + i * 60 });
    let sawGoAround = 0;
    traceRun(sim, 6 * 3600, {
      every: 5,
      onTick: (s) => {
        // 着陸の直前（approach）で、滑走路を他機が占有していたことにする（goAround の分岐を通す）。ゴーアラウンドの後で外す
        if (sawGoAround === 0) {
          for (const a of Object.values(s.state.aircraft)) {
            if (a.state === 'approach' && a.eta !== null && s.state.now >= a.eta - 1) {
              s.state.runways[a.runwayId!]!.occupant = { aircraftId: 'ac_ghost', purpose: 'landing', since: s.state.now };
              sawGoAround = s.state.now;
            }
          }
        } else if (sawGoAround > 0 && s.state.now >= sawGoAround + 3) {
          for (const rs of Object.values(s.state.runways)) if (rs.occupant?.aircraftId === 'ac_ghost') rs.occupant = null;
          sawGoAround = -1;
        }
      },
    });
    expect(sawGoAround).not.toBe(0);
    expect(sim.state.stats.goArounds).toBeGreaterThanOrEqual(1);
    expect(leftovers(sim)).toEqual([]);
  });
});
