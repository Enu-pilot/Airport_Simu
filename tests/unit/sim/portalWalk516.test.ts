import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addPortal, placeFacility } from '../../../src/core/layout/operations';
import { addTurnaround, createSimulation, type Simulation } from '../../../src/core/sim/simulation';
import type { AirportLayout, TerminalAreaKind } from '../../../src/core/model/types';
import type { Aircraft, PaxGroup } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { runUntil } from './helpers';

/**
 * 5-16 T5: ポータルがある空港では、旅客グループが交通施設とターミナル入口/出口の間を
 * 実際に歩く（accessWalk）。ポータルがない空港では従来どおり歩かない。
 */
const manual = { autoSchedule: false };
const areaId = (l: AirportLayout, kind: TerminalAreaKind) => Object.values(l.terminalAreas).find((a) => a.kind === kind)!.id;
const groups = (sim: Simulation, flightId: string): PaxGroup[] => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);

function layoutWithPortals(withPortals: boolean): AirportLayout {
  let l = createSampleAirport();
  l = must(placeFacility(l, 'busTerminal', { x: 30, y: 58 })).layout;
  if (withPortals) {
    const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
    l = must(addPortal(l, { facilityId: bt.id, areaId: areaId(l, 'entrance') })).layout;
    l = must(addPortal(l, { facilityId: bt.id, areaId: areaId(l, 'exit') })).layout;
  }
  return l;
}

function oneTurnaround(layout: AirportLayout, seed: string) {
  const sim = createSimulation(layout, { seed, settings: manual });
  const t = sim.state.now + 20 * 60;
  const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
  return { sim, ac, dep: sim.state.flights[ac.departureFlightId]!, arr: sim.state.flights[ac.arrivalFlightId]! };
}

const departed = (ac: Aircraft) => () => ac.state === 'departed';

describe('5-16 T5 ポータル経由の旅客実移動', () => {
  it('ポータルがあると出発・到着の両方でアクセス区間を歩き、歩行時間が記録される', () => {
    const { sim, ac, dep, arr } = oneTurnaround(layoutWithPortals(true), 'portal-walk');
    let sawEnterWalk = false;
    runUntil(sim, () => {
      for (const g of Object.values(sim.state.paxGroups)) {
        if (g.state === 'accessWalk' && g.accessLeg?.phase === 'enter') sawEnterWalk = true;
      }
      return ac.state === 'departed';
    }, 6 * 3600);
    expect(sawEnterWalk).toBe(true);
    expect(dep.pax.boarded).toBe(dep.pax.booked);
    expect(dep.pax.missed).toBe(0);
    const depGroups = groups(sim, dep.id);
    expect(depGroups.some((g) => g.accessLeg?.phase === 'enter')).toBe(true);
    expect(depGroups.every((g) => g.state === 'boarded')).toBe(true);
    const arrGroups = groups(sim, arr.id);
    expect(arrGroups.length).toBeGreaterThan(0);
    expect(arrGroups.some((g) => g.accessLeg?.phase === 'exit')).toBe(true);
    expect(arrGroups.every((g) => g.state === 'exited')).toBe(true);
    const walker = depGroups.find((g) => g.accessLeg)!;
    expect(walker.walkSec).toBeGreaterThan(0);
    void departed;
  });

  it('ポータルがない空港ではアクセス区間を歩かない（従来どおり）', () => {
    const { sim, ac, dep } = oneTurnaround(layoutWithPortals(false), 'portal-walk-none');
    runUntil(sim, departed(ac), 6 * 3600);
    expect(dep.pax.boarded).toBe(dep.pax.booked);
    for (const g of Object.values(sim.state.paxGroups)) {
      expect(g.accessLeg).toBeUndefined();
    }
  });
});
