import { describe, expect, it } from 'vitest';
import { addTurnaround, createSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { checkPhase4Invariants } from '../../../src/core/sim/invariants4';
import { createContext } from '../../../src/core/sim/context';
import { analyzeDayPlan, type DayPlan, type PlannedFlight } from '../../../src/core/economy/planning';
import type { PaxGroup } from '../../../src/core/sim/types';
import { intlAirport, intlGateId } from '../intlLayout';
import { keepOnlyStand, runUntil } from './helpers';

const manual = { autoSchedule: false };
const groups = (sim: Simulation, flightId: string): PaxGroup[] => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);

describe('国際便の旅客フロー（フェーズ 4 §4.4）', () => {
  it('出発は出国審査を、到着は入国審査と税関を通り、国際ゲートのスポットに付く', () => {
    const sim = createSimulation(intlAirport(), { seed: 'intl-flow', settings: manual });
    const t = sim.state.now + 20 * 60;
    const ac = addTurnaround(sim, 'narrow180', t, {
      departureAt: t + 240 * 60,
      plan: { contractId: 'k-intl', destinationId: 'SEL', arrPax: 90, depPax: 90, standId: 'std_8', routeType: 'international' },
    });
    const dep = sim.state.flights[ac.departureFlightId]!;
    const arr = sim.state.flights[ac.arrivalFlightId]!;
    runUntil(sim, () => ac.state === 'departed', 10 * 3600);

    expect(arr.standId).toBe('std_8');
    expect(dep.standId).toBe('std_8');

    const depGroups = groups(sim, dep.id);
    expect(depGroups.length).toBeGreaterThan(0);
    expect(dep.pax.boarded).toBe(dep.pax.booked);
    expect(depGroups.every((g) => g.state === 'boarded')).toBe(true);
    expect(depGroups.every((g) => g.steps.includes('emigration') && g.ciq?.emigration)).toBe(true);

    const arrGroups = groups(sim, arr.id);
    expect(arrGroups.length).toBeGreaterThan(0);
    expect(arr.pax.exited).toBe(arr.pax.booked);
    expect(arrGroups.every((g) => g.state === 'exited')).toBe(true);
    expect(arrGroups.every((g) => g.steps.includes('immigration') && g.steps.includes('customs'))).toBe(true);
    expect(arrGroups.every((g) => g.ciq?.immigration && g.ciq?.customs)).toBe(true);

    expect(checkPhase4Invariants(sim, true)).toEqual([]);
  });

  it('国内便は国際ゲートを使わず、国際区域にも入らない', () => {
    const sim = createSimulation(intlAirport(), { seed: 'dom-flow', settings: manual });
    const t = sim.state.now + 20 * 60;
    const ac = addTurnaround(sim, 'narrow180', t, {
      departureAt: t + 150 * 60,
      plan: { contractId: 'k-dom', destinationId: 'TYO', arrPax: 90, depPax: 90, standId: null },
    });
    const dep = sim.state.flights[ac.departureFlightId]!;
    const arr = sim.state.flights[ac.arrivalFlightId]!;
    runUntil(sim, () => ac.state === 'departed', 8 * 3600);

    expect(arr.standId).not.toBe('std_8');
    const depGroups = groups(sim, dep.id);
    expect(depGroups.length).toBeGreaterThan(0);
    expect(depGroups.every((g) => !g.steps.includes('emigration'))).toBe(true);
    const arrGroups = groups(sim, arr.id);
    expect(arrGroups.length).toBeGreaterThan(0);
    expect(arrGroups.every((g) => !g.steps.includes('immigration') && !g.steps.includes('customs'))).toBe(true);
    expect(checkPhase4Invariants(sim, true)).toEqual([]);
  });
});

describe('swing ゲートの切り替え間隔（フェーズ 4 §4.3）', () => {
  const flight = (key: string, arrivalAt: number, departureAt: number, intl = false): PlannedFlight => ({
    key,
    contractId: 'k',
    airlineId: 'SK',
    destinationId: intl ? 'SEL' : 'TYO',
    typeId: 'narrow180',
    arrNumber: 'SK100',
    depNumber: 'SK101',
    arrivalAt,
    departureAt,
    arrPax: 50,
    depPax: 50,
    seats: 180,
    inboundDelaySec: 0,
    ...(intl ? { routeType: 'international' as const } : {}),
  });

  function swingCtx() {
    const l = intlAirport();
    l.facilities[intlGateId(l)]!.props.routeType = 'swing';
    return createContext(keepOnlyStand(l, 'std_8'));
  }

  it('種別が違う便は、前の便の出発から 600 秒空かないと置けない', () => {
    const ctx = swingCtx();
    const plan: DayPlan = {
      day: 0,
      dropped: [],
      flights: [flight('dom', 3600, 7200), flight('intl', 7500, 11000, true)],
    };
    const a = analyzeDayPlan(plan, ctx);
    expect(a.assignments['dom']!.standId).toBe('std_8');
    expect(a.assignments['intl']!.standId).toBeNull();
    expect(a.issues.some((i) => i.code === 'STAND_CONFLICT' && i.keys.includes('intl'))).toBe(true);
  });

  it('600 秒空けば置ける。同種別の連続は間隔なしで置ける', () => {
    const ctx = swingCtx();
    const plan: DayPlan = {
      day: 0,
      dropped: [],
      flights: [flight('dom', 3600, 7200), flight('intl', 7900, 11000, true), flight('intl2', 11700, 15000, true)],
    };
    const a = analyzeDayPlan(plan, ctx);
    expect(a.assignments['intl']!.standId).toBe('std_8');
    expect(a.assignments['intl2']!.standId).toBe('std_8');
  });

  it('国際便だけの空港で国際ゲートがなければ INTL_GATE_MISSING', () => {
    const l = intlAirport();
    l.facilities[intlGateId(l)]!.props.routeType = 'domestic';
    const ctx = createContext(keepOnlyStand(l, 'std_8'));
    const plan: DayPlan = { day: 0, dropped: [], flights: [flight('intl', 3600, 7200, true)] };
    const a = analyzeDayPlan(plan, ctx);
    expect(a.assignments['intl']!.standId).toBeNull();
    expect(a.issues.some((i) => i.code === 'INTL_GATE_MISSING' && i.keys.includes('intl'))).toBe(true);
  });
});
