import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { analyzeDayPlan, type DayPlan } from '../../../src/core/economy/planning';
import { addTerminalTransitLink, moveEntity, placeFacility, placeTerminalArea, updateEntity } from '../../../src/core/layout/operations';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { checkPaxInvariants } from '../../../src/core/sim/invariants';
import { createContext } from '../../../src/core/sim/context';
import { addDepartureGroup, setAreaClosed } from '../../../src/core/sim/passengers';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { passengerFlowIssues } from '../../../src/core/terminal/flowDiagnostics';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { reassignStand } from '../../../src/core/sim/disruptions';
import type { AirportLayout, TerminalAreaKind } from '../../../src/core/model/types';
import type { PaxGroup } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { runUntil } from './helpers';

const manual = { autoSchedule: false };
const groups = (sim: Simulation, flightId: string): PaxGroup[] => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);

function twoTerminalAirport(): { layout: AirportLayout; first: string; second: string; standA: string; standB: string } {
  let layout = createSampleAirport();
  const first = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  const originalAreas = Object.values(layout.terminalAreas).filter((area) => area.terminalId === first);
  layout = must(placeFacility(layout, 'terminal', { x: 106, y: 70 }, { w: 48, h: 8, name: 'ターミナルB', props: { levels: 2 } })).layout;
  const second = Object.values(layout.facilities).filter((f) => f.kind === 'terminal').at(-1)!.id;
  for (const area of originalAreas) {
    layout = must(placeTerminalArea(layout, second, area.level, area.kind as TerminalAreaKind, { x: area.origin.x + 60, y: area.origin.y + 21 }, {
      w: area.w,
      h: area.h,
      name: `${area.name} B`,
      props: structuredClone(area.props),
    })).layout;
  }
  const gates = Object.values(layout.facilities).filter((f) => f.kind === 'gate').sort((a, b) => a.id.localeCompare(b.id));
  const gateB = gates[0]!;
  layout = must(updateEntity(layout, gateB.id, { props: { connectedTo: second } })).layout;
  return { layout, first, second, standA: String(gates[1]!.props.standId), standB: String(gateB.props.standId) };
}

const contractPlan = (standId: string) => ({ contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 });

describe('複数ターミナルの旅客処理', () => {
  it('単一ターミナルでは従来どおりゲート所属ターミナルへ出発旅客を割り当てる', () => {
    const layout = createSampleAirport();
    const sim = createSimulation(layout, { seed: 'one-terminal', settings: manual });
    const stand = Object.keys(layout.stands).sort()[0]!;
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(stand) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => groups(sim, dep.id).length > 0, 2 * 3600);
    const expected = sim.ctx.terminal.gates[sim.ctx.standGate[stand]!]!.terminalId;
    expect(new Set(groups(sim, dep.id).map((g) => g.terminalId))).toEqual(new Set([expected]));
  });

  it('複数入口から次工程へ接続している入口だけを選ぶ', { timeout: 180_000 }, () => {
    let layout = createSampleAirport();
    const terminalId = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
    const oldEntrance = Object.values(layout.terminalAreas).find((area) => area.terminalId === terminalId && area.kind === 'entrance')!;
    layout = must(updateEntity(layout, oldEntrance.id, { w: 2, h: 2 })).layout;
    layout = must(moveEntity(layout, oldEntrance.id, { x: 46, y: 55 })).layout;
    const isolatedEntrance = oldEntrance.id;
    layout = must(placeTerminalArea(layout, terminalId, oldEntrance.level, 'entrance', { x: 80, y: 54 }, { w: 14, h: 3, name: '接続入口' })).layout;
    const sim = createSimulation(layout, { seed: 'entrance-route', settings: manual });
    const stand = Object.keys(layout.stands).sort()[0]!;
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(stand) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => groups(sim, dep.id).some((group) => group.area !== null), 3 * 3600);
    const started = groups(sim, dep.id).filter((group) => group.state !== 'toAirport');
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((group) => group.area !== isolatedEntrance && group.state !== 'stranded')).toBe(true);
  });

  it('2ターミナルの出発・到着便はゲート所属施設だけを通り、搭乗・退出まで完了する', { timeout: 300_000 }, () => {
    const { layout, first, second, standA, standB } = twoTerminalAirport();
    const sim = createSimulation(layout, { seed: 'two-terminals', settings: manual });
    const a = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(standA) });
    const b = addTurnaround(sim, 'narrow180', 30 * 60, { departureAt: 180 * 60, plan: contractPlan(standB) });
    const arrA = sim.state.flights[a.arrivalFlightId]!;
    const arrB = sim.state.flights[b.arrivalFlightId]!;
    const depA = sim.state.flights[a.departureFlightId]!;
    const depB = sim.state.flights[b.departureFlightId]!;

    runUntil(sim, () => a.state === 'departed' && b.state === 'departed' && arrA.pax.exited === arrA.pax.deplaned && arrB.pax.exited === arrB.pax.deplaned, 8 * 3600);

    const checkTerminal = (flightId: string, terminalId: string) => {
      const gs = groups(sim, flightId);
      expect(gs.length).toBeGreaterThan(0);
      expect(gs.every((g) => g.terminalId === terminalId)).toBe(true);
      expect(gs.every((g) => g.area === null || sim.ctx.terminal.areas[g.area]?.terminalId === terminalId)).toBe(true);
      expect(gs.every((g) => g.route.every((id) => sim.ctx.terminal.areas[id]?.terminalId === terminalId))).toBe(true);
      return gs;
    };
    const departureA = checkTerminal(depA.id, first);
    const departureB = checkTerminal(depB.id, second);
    const arrivalA = checkTerminal(arrA.id, first);
    const arrivalB = checkTerminal(arrB.id, second);
    expect(departureA.every((g) => g.state === 'boarded' && g.boardedGate === depA.pax.gateId && g.securityCleared)).toBe(true);
    expect(departureB.every((g) => g.state === 'boarded' && g.boardedGate === depB.pax.gateId && g.securityCleared)).toBe(true);
    expect(arrivalA.every((g) => g.state === 'exited')).toBe(true);
    expect(arrivalB.every((g) => g.state === 'exited')).toBe(true);
    expect(layout.terminalAreas[arrA.pax.claimAreaId ?? '']?.terminalId).toBe(first);
    expect(layout.terminalAreas[arrB.pax.claimAreaId ?? '']?.terminalId).toBe(second);
    for (const terminalId of [first, second]) {
      for (const kind of ['checkIn', 'security']) {
        const ids = Object.values(sim.ctx.terminal.areas).filter((area) => area.terminalId === terminalId && area.kind === kind).map((area) => area.id);
        expect(ids.some((id) => (sim.state.facilities[id]?.served ?? 0) > 0)).toBe(true);
      }
    }
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('運航計画は旅客需要・処理能力を割当てターミナル別に集計する', () => {
    const { layout, first, second } = twoTerminalAirport();
    const plan: DayPlan = {
      day: 0,
      dropped: [],
      flights: Array.from({ length: 8 }, (_, i) => ({ key: `f${i}`, contractId: 'c', airlineId: 'SK', destinationId: 'north', typeId: 'narrow180' as const, arrNumber: `SK${i * 2 + 1}`, depNumber: `SK${i * 2 + 2}`, arrivalAt: 3600, departureAt: 4 * 3600, arrPax: 100, depPax: 120 + i, seats: 180, inboundDelaySec: 0 })),
    };
    const analysis = analyzeDayPlan(plan, createContext(layout));
    expect(Object.keys(analysis.terminalCapacity).sort()).toEqual([first, second].sort());
    expect(analysis.terminalCapacity[first]!.securityPerHour).toBeGreaterThan(0);
    expect(analysis.terminalCapacity[second]!.checkInPerHour).toBeGreaterThan(0);
    expect(analysis.capacity.contactStands + analysis.capacity.remoteStands).toBe(analysis.capacity.totalStands);
    expect(analysis.capacity.simultaneousPushbacks).toBeNull();
    expect(analysis.capacity.taxiwayMovementsPerHour).toBeNull();
    expect(analysis.capacity.dailyMovements).toBeNull();
    expect(analysis.capacity.busPaxPerHour).toBeNull();
    expect(Object.values(analysis.hourlyByTerminal).reduce((sum, hours) => sum + hours.reduce((n, pax) => n + pax, 0), 0)).toBe(analysis.hourly.depPax.reduce((n, pax) => n + pax, 0));
    expect(Object.values(analysis.assignments).map((assignment) => assignment.terminalId)).toEqual(expect.arrayContaining([first, second]));
  });

  it('旧データ等で処理秒が欠けてもdocs/12の施設別既定値で能力を計算する', () => {
    const layout = structuredClone(createSampleAirport());
    const security = Object.values(layout.terminalAreas).find((area) => area.kind === 'security')!;
    const checkIn = Object.values(layout.terminalAreas).find((area) => area.kind === 'checkIn')!;
    delete security.props.serviceSecPerPax;
    delete checkIn.props.serviceSecPerPax;
    const terminalId = security.terminalId;
    const emptyPlan: DayPlan = { day: 0, flights: [], dropped: [] };
    const analysis = analyzeDayPlan(emptyPlan, createContext(layout));
    expect(analysis.terminalCapacity[terminalId]!.securityPerHour).toBe(Number(security.props.lanes) * 3600 / 15);
    expect(analysis.terminalCapacity[terminalId]!.checkInPerHour).toBe(Number(checkIn.props.counters) * 3600 / 50);
  });

  it('構造検証は不通のターミナルだけを特定し、到着の手荷物経路も検査する', () => {
    const { layout, first, second } = twoTerminalAirport();
    const normal = analyzeLayout(layout).issues;
    expect(normal.some((issue) => issue.code === 'TERMINAL_DEPARTURE_ROUTE' || issue.code === 'GATE_ARRIVAL_NO_BAGGAGE_ROUTE')).toBe(false);

    const checkIn = Object.values(layout.terminalAreas).find((area) => area.terminalId === second && area.kind === 'checkIn')!;
    let brokenDeparture = must(updateEntity(layout, checkIn.id, { w: 10 })).layout;
    brokenDeparture = must(moveEntity(brokenDeparture, checkIn.id, { x: 140, y: 76 })).layout;
    const depIssues = analyzeLayout(brokenDeparture).issues.filter((issue) => issue.code === 'TERMINAL_DEPARTURE_ROUTE');
    expect(depIssues.map((issue) => issue.targets[0])).toEqual([second]);
    expect(depIssues.some((issue) => issue.targets.includes(first))).toBe(false);

    const claim = Object.values(layout.terminalAreas).find((area) => area.terminalId === second && area.kind === 'baggageClaim')!;
    let brokenArrival = must(updateEntity(layout, claim.id, { w: 5 })).layout;
    brokenArrival = must(moveEntity(brokenArrival, claim.id, { x: 148, y: 75 })).layout;
    expect(analyzeLayout(brokenArrival).issues.some((issue) => issue.code === 'GATE_ARRIVAL_NO_BAGGAGE_ROUTE' && issue.targets.some((id) => layout.facilities[id]?.kind === 'gate' && layout.facilities[id]?.props.connectedTo === second))).toBe(true);
  });

  it('施設閉鎖による長時間滞留を旅客単位でなく工程・施設単位に集約し、復旧後は解消する', { timeout: 300_000 }, () => {
    const layout = createSampleAirport();
    const security = Object.values(layout.terminalAreas).find((area) => area.kind === 'security')!.id;
    const sim = createSimulation(layout, { seed: 'flow-monitor', settings: manual });
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(Object.keys(layout.stands).sort()[0]!) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    setAreaClosed(sim, security, true);
    runUntil(sim, () => groups(sim, dep.id).some((group) => group.state === 'waitingFacility'), 3 * 3600);
    let issues = passengerFlowIssues(sim);
    let stuck = issues.filter((issue) => issue.stage === '保安検査' && issue.targetId === security);
    for (let i = 0; i < 20 * 60 && stuck.length === 0; i++) {
      stepSimulation(sim);
      issues = passengerFlowIssues(sim);
      stuck = issues.filter((issue) => issue.stage === '保安検査' && issue.targetId === security);
    }
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.severity).toBe('warning');
    expect(stuck[0]!.pax).toBeGreaterThan(5);
    expect(stuck[0]!.flightIds).toEqual([dep.id]);

    setAreaClosed(sim, security, false);
    runUntil(sim, () => groups(sim, dep.id).every((group) => group.state !== 'waitingFacility'), 120);
    expect(passengerFlowIssues(sim).some((issue) => issue.targetId === security)).toBe(false);
  });

  it('歩行中に通路先の施設が閉鎖されると旧経路を破棄し、復旧後に再探索する', { timeout: 300_000 }, () => {
    const layout = createSampleAirport();
    const security = Object.values(layout.terminalAreas).find((area) => area.kind === 'security')!.id;
    const sim = createSimulation(layout, { seed: 'close-security-in-motion', settings: manual });
    const stand = Object.keys(layout.stands).sort()[0]!;
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(stand) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => groups(sim, dep.id).some((group) => group.state === 'walking' && group.steps[group.stepIndex] === 'security' && group.route.includes(security)), 3 * 3600);
    const walking = groups(sim, dep.id).find((group) => group.state === 'walking' && group.steps[group.stepIndex] === 'security' && group.route.includes(security))!;
    setAreaClosed(sim, security, true);
    stepSimulation(sim);
    expect(walking.state).toBe('waitingFacility');
    expect(walking.route).not.toContain(security);
    setAreaClosed(sim, security, false);
    runUntil(sim, () => walking.securityCleared, 20 * 60);
    expect(walking.securityCleared).toBe(true);
  });

  it('ターミナル未割当ての出発ゲートは既定ターミナルへ決定的に流れ、ゲートなしとして処理する', { timeout: 300_000 }, () => {
    let layout = createSampleAirport();
    const standId = Object.keys(layout.stands).sort()[0]!;
    const gate = Object.values(layout.facilities).find((f) => f.kind === 'gate' && f.props.standId === standId)!;
    layout = must(updateEntity(layout, gate.id, { props: { standId: null } })).layout;
    const sim = createSimulation(layout, { seed: 'no-gate-terminal', settings: manual });
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(standId) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => dep.pax.boarding === 'closed', 6 * 3600);
    expect(dep.pax.gateId).toBeNull();
    expect(groups(sim, dep.id).every((g) => g.terminalId === sim.ctx.paxTerminal && g.reason === 'noGate')).toBe(true);
  });

  it('複数ターミナルで搭乗ゲートが未割当てなら、既定ターミナルへ推測で振り分けない', { timeout: 300_000 }, () => {
    let { layout } = twoTerminalAirport();
    for (const gate of Object.values(layout.facilities).filter((f) => f.kind === 'gate')) {
      layout = must(updateEntity(layout, gate.id, { props: { standId: null } })).layout;
    }
    const sim = createSimulation(layout, { seed: 'unassigned-multiterminal-gate', settings: manual });
    const stand = Object.keys(layout.stands).sort()[0]!;
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(stand) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => groups(sim, dep.id).length > 0 && groups(sim, dep.id).every((group) => group.state === 'stranded'), 4 * 3600);
    expect(dep.pax.gateId).toBeNull();
    expect(groups(sim, dep.id).every((group) => group.terminalId === null && group.reason === 'noGate')).toBe(true);
    expect(passengerFlowIssues(sim).some((issue) => issue.severity === 'critical' && issue.terminalId === null)).toBe(true);
  });

  it('運航中の保存・復元で各グループのterminalIdと進行状態を保つ', { timeout: 300_000 }, () => {
    const { layout, second, standB } = twoTerminalAirport();
    const sim = createSimulation(layout, { seed: 'multi-terminal-save', settings: manual });
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(standB) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => groups(sim, dep.id).some((g) => g.terminalId === second && g.state !== 'toAirport'), 3 * 3600);
    const p = buildProject({ name: 'multi', savedAt: '2026-11-14T00:00:00Z', layout, company: createSandboxCompany(), pin: null, scenarios: [], sim });
    const read = validateProject(serializeProject(p), { fallbackCompany: createSandboxCompany() });
    expect(read.errors).toEqual([]);
    const restored = restoreSimulation(read.project!.layout, read.project!.sim!, effectiveModels(read.project!.catalog));
    expect(restored.violations).toEqual([]);
    expect(restored.sim.state.paxGroups).toEqual(sim.state.paxGroups);
  });

  it('搭乗口変更後に同じターミナルの旅客を新しいゲートへ再経路探索する', { timeout: 300_000 }, () => {
    const { layout: initial, second, standA, standB } = twoTerminalAirport();
    const gateA = Object.values(initial.facilities).find((f) => f.kind === 'gate' && f.props.standId === standA)!;
    const layout = must(updateEntity(initial, gateA.id, { props: { connectedTo: second } })).layout;
    const sim = createSimulation(layout, { seed: 'gate-change-reroute', settings: manual });
    const start = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', start + 20 * 60, { departureAt: start + 170 * 60, plan: contractPlan(standB) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => dep.pax.gateId !== null && groups(sim, dep.id).length > 0, 2 * 3600);
    expect(dep.pax.gateId).not.toBe(gateA.id);
    expect(reassignStand(sim, ac.id, standA)).toEqual({ ok: true });
    runUntil(sim, () => ac.standId === standA && dep.pax.gateId === gateA.id, 10 * 60);
    runUntil(sim, () => ac.state === 'departed', 5 * 3600);
    const passengers = groups(sim, dep.id);
    expect(passengers.every((group) => group.terminalId === second)).toBe(true);
    expect(passengers.every((group) => group.state === 'boarded' && group.boardedGate === gateA.id)).toBe(true);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('スポット変更で別ターミナルになっても連絡通路を歩いて新ゲートへ搭乗する', { timeout: 300_000 }, () => {
    const { layout: initial, first, second, standA, standB } = twoTerminalAirport();
    const departureArea = (terminalId: string) =>
      Object.values(initial.terminalAreas).find((area) => area.terminalId === terminalId && area.kind === 'waiting')!;
    const layout = must(addTerminalTransitLink(initial, {
      kind: 'walkway',
      fromAreaId: departureArea(second).id,
      toAreaId: departureArea(first).id,
      distanceM: 250,
      travelSec: 120,
      capacityPerHour: 1200,
      bidirectional: true,
      allowedZones: ['departure'],
    })).layout;
    const sim = createSimulation(layout, { seed: 'cross-terminal-stand-change', settings: manual });
    const start = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', start + 20 * 60, { departureAt: start + 5 * 3600, plan: contractPlan(standB) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => dep.pax.gateId !== null, 60);
    expect(sim.ctx.terminal.gates[dep.pax.gateId!]!.terminalId).toBe(second);
    const passenger = addDepartureGroup(sim, dep.id, 50, sim.state.now)!;
    passenger.steps = ['gate'];
    passenger.stepIndex = 0;
    passenger.securityCleared = true;
    passenger.area = sim.ctx.terminal.gates[dep.pax.gateId!]!.boarding;
    passenger.state = 'dwelling';
    passenger.retryAt = sim.state.now + 3600;

    expect(reassignStand(sim, ac.id, standA)).toEqual({ ok: true });
    runUntil(sim, () => ac.standId === standA && dep.pax.gateId === Object.values(layout.facilities).find((f) => f.kind === 'gate' && f.props.standId === standA)!.id, 10 * 60);
    runUntil(sim, () => passenger.targetTerminalId === first && passenger.state === 'walking', 10 * 60);
    const crossing = groups(sim, dep.id).find((group) => group.targetTerminalId === first && group.state === 'walking')!;
    const project = buildProject({ name: 'transfer', savedAt: '2026-11-14T00:00:00Z', layout, company: createSandboxCompany(), pin: null, scenarios: [], sim });
    const saved = validateProject(serializeProject(project), { fallbackCompany: createSandboxCompany() });
    expect(saved.errors).toEqual([]);
    const restored = restoreSimulation(saved.project!.layout, saved.project!.sim!, effectiveModels(saved.project!.catalog));
    expect(restored.sim.state.paxGroups[crossing.id]).toEqual(crossing);
    runUntil(sim, () => ac.state === 'departed', 8 * 3600);

    const passengers = groups(sim, dep.id);
    expect(passengers.every((group) => group.terminalId === first)).toBe(true);
    expect(passengers.every((group) => group.targetTerminalId === undefined)).toBe(true);
    expect(passengers.every((group) => group.state === 'boarded' && group.boardedGate === dep.pax.gateId)).toBe(true);
    expect(passenger.walkSec).toBeGreaterThan(120);
    expect(passengers.some((group) => group.walkSec > 120)).toBe(true);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('ターミナル間連絡通路の時間帯能力を超えた旅客は待機し、次の時間帯に移動する', { timeout: 300_000 }, () => {
    const { layout: initial, first, second, standA, standB } = twoTerminalAirport();
    const departureArea = (terminalId: string) =>
      Object.values(initial.terminalAreas).find((area) => area.terminalId === terminalId && area.kind === 'waiting')!;
    const layout = must(addTerminalTransitLink(initial, {
      kind: 'walkway',
      fromAreaId: departureArea(second).id,
      toAreaId: departureArea(first).id,
      distanceM: 250,
      travelSec: 120,
      capacityPerHour: 40,
      bidirectional: true,
      allowedZones: ['departure'],
    })).layout;
    const sim = createSimulation(layout, { seed: 'terminal-link-capacity-wait', settings: manual });
    const start = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', start + 20 * 60, { departureAt: start + 5 * 3600, plan: contractPlan(standB) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => dep.pax.gateId !== null, 60);
    const origin = departureArea(second).id;
    const firstGroup = addDepartureGroup(sim, dep.id, 30, sim.state.now)!;
    const secondGroup = addDepartureGroup(sim, dep.id, 20, sim.state.now)!;
    for (const group of [firstGroup, secondGroup]) {
      group.steps = ['gate'];
      group.stepIndex = 0;
      group.securityCleared = true;
      group.area = origin;
      group.state = 'dwelling';
      group.retryAt = sim.state.now;
    }

    expect(reassignStand(sim, ac.id, standA)).toEqual({ ok: true });
    runUntil(sim, () => firstGroup.terminalLinkId !== undefined && secondGroup.state === 'waitingTransport', 20 * 60);
    expect(sim.state.terminalTransit?.passengersByLink).toEqual({ [Object.keys(layout.terminalLinks!)[0]!]: 30 });
    const retryAt = secondGroup.retryAt;
    runUntil(sim, () => secondGroup.terminalLinkId !== undefined, 70 * 60);
    expect(secondGroup.retryAt).toBe(retryAt);
    expect(secondGroup.walkSec).toBeGreaterThan(0);
    expect([first, second]).toContain(firstGroup.terminalId);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('通路へ入る前に経路が閉鎖された場合は未使用の能力予約を戻す', { timeout: 300_000 }, () => {
    const { layout: initial, first, second, standA, standB } = twoTerminalAirport();
    const departureArea = (terminalId: string) =>
      Object.values(initial.terminalAreas).find((area) => area.terminalId === terminalId && area.kind === 'waiting')!;
    const layout = must(addTerminalTransitLink(initial, {
      kind: 'walkway',
      fromAreaId: departureArea(second).id,
      toAreaId: departureArea(first).id,
      distanceM: 250,
      travelSec: 120,
      capacityPerHour: 40,
      bidirectional: true,
      allowedZones: ['departure'],
    })).layout;
    const sim = createSimulation(layout, { seed: 'terminal-link-cancel-reservation', settings: manual });
    const start = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', start + 20 * 60, { departureAt: start + 5 * 3600, plan: contractPlan(standB) });
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => dep.pax.gateId !== null, 60);
    const group = addDepartureGroup(sim, dep.id, 30, sim.state.now)!;
    group.steps = ['gate'];
    group.stepIndex = 0;
    group.securityCleared = true;
    group.area = departureArea(second).id;
    group.state = 'dwelling';
    group.retryAt = sim.state.now;

    expect(reassignStand(sim, ac.id, standA)).toEqual({ ok: true });
    runUntil(sim, () => group.terminalLinkId !== undefined, 20 * 60);
    const linkId = Object.keys(layout.terminalLinks!)[0]!;
    group.legProgress = 0;
    expect(group.legProgress).toBe(0);
    expect(sim.state.terminalTransit?.passengersByLink[linkId]).toBe(30);

    sim.state.closedAreas.push(departureArea(first).id);
    runUntil(sim, () => group.terminalLinkId === undefined, 60);
    expect(sim.state.terminalTransit?.passengersByLink[linkId]).toBeUndefined();
    expect(group.replanAfterTerminalLink).toBeUndefined();
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('上下移動設備の時間帯能力を超えた旅客は待機し、次の時間帯に移動する', { timeout: 300_000 }, () => {
    let layout = createSampleAirport();
    const terminalId = Object.values(layout.facilities).find((facility) => facility.kind === 'terminal')!.id;
    const escalator = Object.values(layout.terminalAreas).find((area) => area.terminalId === terminalId && area.kind === 'escalator')!;
    layout = must(updateEntity(layout, escalator.id, { props: { capacityPerHour: 40 } })).layout;

    const lower = Object.values(layout.terminalAreas).find((area) => area.terminalId === terminalId && area.kind === 'entrance')!;
    const upper = Object.values(layout.terminalAreas).find((area) => area.terminalId === terminalId && area.kind === 'waiting')!;
    const sim = createSimulation(layout, { seed: 'vertical-capacity-wait', settings: manual });
    const start = sim.state.now;
    const stand = Object.keys(layout.stands).sort()[0]!;
    const aircraft = addTurnaround(sim, 'narrow180', start + 20 * 60, {
      departureAt: start + 5 * 3600,
      plan: contractPlan(stand),
    });
    const departure = sim.state.flights[aircraft.departureFlightId]!;
    runUntil(sim, () => departure.pax.gateId !== null, 3600);
    const firstGroup = addDepartureGroup(sim, departure.id, 30, sim.state.now)!;
    const secondGroup = addDepartureGroup(sim, departure.id, 20, sim.state.now)!;

    for (const group of [firstGroup, secondGroup]) {
      group.steps = ['gate'];
      group.stepIndex = 0;
      group.securityCleared = true;
      group.area = lower.id;
      group.route = [escalator.id, upper.id];
      group.legLength = 0.1;
      group.state = 'walking';
    }

    runUntil(sim, () => firstGroup.terminalLinkId !== undefined && secondGroup.state === 'waitingTransport', 60);
    expect(firstGroup.terminalLinkId).toBe(`vertical:${escalator.id}`);
    expect(secondGroup.terminalLinkWaitingId).toBe(`vertical:${escalator.id}`);
    expect(sim.state.terminalTransit?.passengersByLink).toEqual({ [`vertical:${escalator.id}`]: 30 });

    runUntil(sim, () => secondGroup.terminalLinkId !== undefined, 70 * 60);
    expect(secondGroup.terminalLinkId).toBe(`vertical:${escalator.id}`);
    expect(secondGroup.walkSec).toBeGreaterThan(0);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });
});
