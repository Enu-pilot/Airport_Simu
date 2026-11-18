import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addPortal, placeFacility } from '../../../src/core/layout/operations';
import { addTurnaround, createSimulation } from '../../../src/core/sim/simulation';
import type { AirportLayout, FacilityKind, TerminalAreaKind } from '../../../src/core/model/types';
import { must } from '../helpers';
import { runUntil } from './helpers';

/**
 * 5-16 T7: Portal 対応の全交通施設で往復（入口方向・出口方向）の実歩行を検証する。
 * バスターミナルは portalWalk516 が担うため、ここでは残りの 4 種別を見る。
 */
const manual = { autoSchedule: false };
const areaId = (l: AirportLayout, kind: TerminalAreaKind) => Object.values(l.terminalAreas).find((a) => a.kind === kind)!.id;

const CASES: { kind: FacilityKind; pos: { x: number; y: number } }[] = [
  { kind: 'busStop', pos: { x: 30, y: 58 } },
  { kind: 'taxiStand', pos: { x: 40, y: 58 } },
  { kind: 'parking', pos: { x: 30, y: 58 } },
  { kind: 'railStation', pos: { x: 16, y: 58 } },
];

describe('5-16 T7 Portal 全種別の往復歩行', () => {
  for (const { kind, pos } of CASES) {
    it(`${kind}: 出発は入口方向、到着は出口方向にポータル区間を歩き、全員が搭乗・退出する`, { timeout: 300000 }, () => {
      let l = createSampleAirport();
      l = must(placeFacility(l, kind, pos)).layout;
      const fac = Object.values(l.facilities).find((f) => f.kind === kind)!;
      l = must(addPortal(l, { facilityId: fac.id, areaId: areaId(l, 'entrance') })).layout;
      l = must(addPortal(l, { facilityId: fac.id, areaId: areaId(l, 'exit') })).layout;

      const sim = createSimulation(l, { seed: `roundtrip-${kind}`, settings: manual });
      const t = sim.state.now + 20 * 60;
      const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
      const dep = sim.state.flights[ac.departureFlightId]!;
      const arr = sim.state.flights[ac.arrivalFlightId]!;
      runUntil(sim, () => ac.state === 'departed', 6 * 3600);

      expect(dep.pax.boarded).toBe(dep.pax.booked);
      expect(dep.pax.missed).toBe(0);
      const depGroups = (sim.state.flightPax[dep.id] ?? []).map((id) => sim.state.paxGroups[id]!);
      expect(depGroups.some((g) => g.accessLeg?.phase === 'enter' && g.accessLeg.facilityId === fac.id)).toBe(true);
      expect(depGroups.every((g) => g.state === 'boarded')).toBe(true);
      const arrGroups = (sim.state.flightPax[arr.id] ?? []).map((id) => sim.state.paxGroups[id]!);
      expect(arrGroups.length).toBeGreaterThan(0);
      expect(arrGroups.some((g) => g.accessLeg?.phase === 'exit' && g.accessLeg.facilityId === fac.id)).toBe(true);
      expect(arrGroups.every((g) => g.state === 'exited')).toBe(true);
    });
  }
});
