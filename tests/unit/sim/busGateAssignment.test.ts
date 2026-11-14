import { describe, expect, it } from 'vitest';
import { analyzeDayPlan, type DayPlan } from '../../../src/core/economy/planning';
import { placeFacility, placeTerminalArea, updateEntity } from '../../../src/core/layout/operations';
import type { AirportLayout, TerminalAreaKind } from '../../../src/core/model/types';
import { resolveBusGateForStand, busGateStatus } from '../../../src/core/terminal/busGateAssignment';
import { buildTerminalModel } from '../../../src/core/terminal/model';
import { createContext } from '../../../src/core/sim/context';
import { addTurnaround, createSimulation } from '../../../src/core/sim/simulation';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { must } from '../helpers';
import { busLayout } from './busHelpers';
import { runUntil } from './helpers';

const manual = { autoSchedule: false };

function planForOneFlight(): DayPlan {
  return {
    day: 0,
    dropped: [],
    flights: [{
      key: 'remote-plan', contractId: 'test', airlineId: 'SK', destinationId: 'north', typeId: 'narrow180',
      arrNumber: 'SK001', depNumber: 'SK002', arrivalAt: 3600, departureAt: 7200,
      arrPax: 80, depPax: 80, seats: 180, inboundDelaySec: 0,
    }],
  };
}

function prepareAutoLayout(): AirportLayout {
  const layout = busLayout();
  // Leave one assignable remote stand and provide two usable bus gates.
  for (const stand of Object.values(layout.stands)) if (stand.id !== 'std_8') stand.buildState = 'underConstruction';
  layout.stands.std_8!.remoteBoarding = 'auto';
  layout.facilities.fac_8!.props = { boardingMode: 'bus', standId: null, jetBridge: false };
  return layout;
}

function prepareTwoTerminalBusLayout(): { layout: AirportLayout; terminalA: string; terminalB: string } {
  let layout = busLayout();
  const terminalA = Object.values(layout.facilities).find((facility) => facility.kind === 'terminal')!.id;
  const originalAreas = Object.values(layout.terminalAreas).filter((area) => area.terminalId === terminalA);
  layout = must(placeFacility(layout, 'terminal', { x: 106, y: 70 }, { w: 48, h: 8, name: 'Terminal B', props: { levels: 2 } })).layout;
  const terminalB = Object.values(layout.facilities).filter((facility) => facility.kind === 'terminal').at(-1)!.id;
  for (const area of originalAreas) {
    layout = must(placeTerminalArea(layout, terminalB, area.level, area.kind as TerminalAreaKind, { x: area.origin.x + 60, y: area.origin.y + 21 }, {
      w: area.w, h: area.h, name: `${area.name} B`, props: structuredClone(area.props),
    })).layout;
  }
  layout.facilities.fac_8!.props = { boardingMode: 'bus', standId: null, jetBridge: false, connectedTo: terminalB };
  for (const stand of Object.values(layout.stands)) if (stand.id !== 'std_8') stand.buildState = 'underConstruction';
  layout.stands.std_8!.buildState = 'operational';
  layout.stands.std_8!.remoteBoarding = 'bus';
  layout.stands.std_8!.busGateId = 'fac_8';
  return { layout, terminalA, terminalB };
}

describe('リモートスポットのバスゲート割当', () => {
  it('1つの明示バスゲートを複数スポットで共有でき、個別指定はそれぞれ優先する', () => {
    const layout = busLayout();
    layout.facilities.fac_8!.props = { boardingMode: 'bus', standId: null, jetBridge: false };
    layout.stands.std_4!.remoteBoarding = 'bus';
    layout.stands.std_4!.busGateId = 'fac_6';
    layout.stands.std_8!.remoteBoarding = 'bus';
    layout.stands.std_8!.busGateId = 'fac_6';
    const terminal = buildTerminalModel(layout);
    const sharedA = resolveBusGateForStand(layout, terminal, 'std_4', { x: 70, y: 43 }, ['fac_6', 'fac_8']);
    const sharedB = resolveBusGateForStand(layout, terminal, 'std_8', { x: 80, y: 43 }, ['fac_6', 'fac_8']);
    expect(sharedA).toMatchObject({ gateId: 'fac_6', terminalId: terminal.gates.fac_6!.terminalId });
    expect(sharedB).toMatchObject({ gateId: 'fac_6', terminalId: terminal.gates.fac_6!.terminalId });

    layout.stands.std_8!.busGateId = 'fac_8';
    const individual = resolveBusGateForStand(layout, buildTerminalModel(layout), 'std_8', { x: 80, y: 43 }, ['fac_6', 'fac_8']);
    expect(individual.gateId).toBe('fac_8');
  });

  it('計画時と実運航時に自動選択するバスゲートが一致する', () => {
    const layout = prepareAutoLayout();
    const context = createContext(layout);
    const analysis = analyzeDayPlan(planForOneFlight(), context);
    const planned = analysis.assignments['remote-plan']!;
    expect(planned.standId).toBe('std_8');
    expect(planned.busGateId).toBeTruthy();

    const sim = createSimulation(layout, { seed: 'bus-plan-live', settings: manual });
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, {
      departureAt: 170 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 80, depPax: 80, standId: 'std_8', seats: 180 },
    });
    const departure = sim.state.flights[ac.departureFlightId]!;
    const live = resolveBusGateForStand(
      sim.ctx.layout, sim.ctx.terminal, 'std_8', sim.ctx.network.nodes[sim.ctx.stands.std_8!.node]!.pos, sim.ctx.busGates,
    );
    expect(live.gateId).toBe(planned.busGateId);
    expect(live.terminalId).toBe(planned.terminalId);
    expect(departure.pax.gateId).toBeNull();
  });

  it('複数ターミナルでは指定ゲートのターミナルを使い、閉鎖時に別ターミナルへ逃がさない', () => {
    const { layout, terminalA, terminalB } = prepareTwoTerminalBusLayout();
    const terminal = buildTerminalModel(layout);
    const standPoint = { x: 85, y: 43 };
    const assignment = resolveBusGateForStand(layout, terminal, 'std_8', standPoint, ['fac_6', 'fac_8']);
    expect(assignment).toEqual({ gateId: 'fac_8', terminalId: terminalB });
    expect(assignment.terminalId).not.toBe(terminalA);
    expect(busGateStatus(layout, terminal, 'fac_8').usable).toBe(true);

    const closed = resolveBusGateForStand(layout, terminal, 'std_8', standPoint, ['fac_6', 'fac_8'], ['fac_8']);
    expect(closed).toMatchObject({ gateId: null, terminalId: null, failure: 'invalidGate' });
  });

  it('複数ターミナルの到着・出発旅客が同じ指定ターミナルのバスゲートを通る', { timeout: 300_000 }, () => {
    const { layout, terminalB } = prepareTwoTerminalBusLayout();
    const base = Object.values(layout.facilities).find((facility) => facility.kind === 'gseBase')!;
    base.props.apronBuses = 3;
    const context = createContext(layout);
    const planned = analyzeDayPlan(planForOneFlight(), context).assignments['remote-plan']!;
    expect(planned).toMatchObject({ standId: 'std_8', busGateId: 'fac_8', terminalId: terminalB });

    const sim = createSimulation(layout, { seed: 'bus-multi-terminal-flow', settings: manual });
    const aircraft = addTurnaround(sim, 'narrow180', 20 * 60, {
      departureAt: 170 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 80, depPax: 80, standId: 'std_8', seats: 180 },
    });
    const arrival = sim.state.flights[aircraft.arrivalFlightId]!;
    const departure = sim.state.flights[aircraft.departureFlightId]!;
    expect(runUntil(sim, () => aircraft.state === 'departed' && arrival.pax.exited > 0 && arrival.pax.exited === arrival.pax.deplaned && departure.pax.boarded > 0, 8 * 3600)).toBeLessThan(8 * 3600);
    expect(arrival.pax.gateId).toBe('fac_8');
    expect(departure.pax.gateId).toBe('fac_8');
    for (const flight of [arrival, departure]) {
      const groups = (sim.state.flightPax[flight.id] ?? []).map((groupId) => sim.state.paxGroups[groupId]!);
      expect(groups.length).toBeGreaterThan(0);
      expect(groups.every((group) => group.terminalId === terminalB)).toBe(true);
      expect(groups.every((group) => group.route.every((areaId) => sim.ctx.terminal.areas[areaId]?.terminalId === terminalB))).toBe(true);
    }
  });

  it('計画時の自動割当は閉鎖・建設中・片方向ゲートを候補にしない', () => {
    const layout = prepareAutoLayout();
    layout.facilities.fac_8!.buildState = 'underConstruction';
    const context = createContext(layout);
    const analysis = analyzeDayPlan(planForOneFlight(), context);
    const planned = analysis.assignments['remote-plan']!;
    expect(planned.busGateId).toBe('fac_6');

    const terminal = buildTerminalModel(layout);
    const gate = terminal.gates.fac_6!;
    terminal.gates.fac_6 = { ...gate, deplane: null };
    expect(busGateStatus(layout, terminal, 'fac_6')).toMatchObject({ usable: false, problem: 'missingDeplane' });
    const assignment = resolveBusGateForStand(layout, terminal, 'std_8', { x: 84, y: 43 }, ['fac_6']);
    expect(assignment).toMatchObject({ gateId: null, terminalId: null, failure: 'unconfigured' });
  });

  it('バスゲートがターミナルへ接続替えされると、派生割当も新しい所属先に従う', () => {
    const { layout, terminalA, terminalB } = prepareTwoTerminalBusLayout();
    const moved = must(updateEntity(layout, 'fac_8', { props: { connectedTo: terminalA } })).layout;
    const assignment = resolveBusGateForStand(moved, buildTerminalModel(moved), 'std_8', { x: 85, y: 43 }, ['fac_8']);
    expect(assignment).toEqual({ gateId: 'fac_8', terminalId: terminalA });
    expect(assignment.terminalId).not.toBe(terminalB);
  });

  it('存在しない明示ゲートは構造検証で修正可能なエラーとして出す', () => {
    const layout = busLayout();
    layout.stands.std_8!.remoteBoarding = 'bus';
    layout.stands.std_8!.busGateId = 'missing-gate';
    const issue = analyzeLayout(layout).issues.find((item) => item.code === 'STAND_BUS_GATE_INVALID' && item.targets.includes('std_8'));
    expect(issue?.params.problem).toBe('missing');
  });

  it('リモートスポットにバス車両がない場合、旅客を運べない警告をスポット単位で出す', () => {
    const layout = busLayout({ buses: 0 });
    layout.stands.std_8!.remoteBoarding = 'auto';
    const issue = analyzeLayout(layout).issues.find((item) => item.code === 'STAND_BUS_NO_VEHICLES' && item.targets.includes('std_8'));
    expect(issue).toBeDefined();
  });
});
