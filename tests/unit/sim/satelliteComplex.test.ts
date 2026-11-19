import { describe, expect, it } from 'vitest';
import {
  addTerminalTransitLink,
  moveEntity,
  placeFacility,
  placeTerminalArea,
  type OpResult,
} from '../../../src/core/layout/operations';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { terminalServiceComplexes } from '../../../src/core/terminal/serviceComplex';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { checkPaxInvariants } from '../../../src/core/sim/invariants';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import type { AirportLayout } from '../../../src/core/model/types';
import type { PaxGroup } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { runUntil } from './helpers';

/**
 * サテライト恒久対応: 入口・チェックイン・保安・手荷物受取・出口を持たない衛星ターミナルが、
 * 運用中ターミナルリンクで結ばれた本体ターミナルの設備を旅客フローと検証の両方で使えること。
 * リンクが無い/建設中なら従来どおり到達不可で、検証表示とも一致すること。
 */

const manual = { autoSchedule: false };
const groups = (sim: Simulation, flightId: string): PaxGroup[] =>
  (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);
const contractPlan = (standId: string) => ({ contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 });

type LinkState = 'operational' | 'underConstruction' | null;

function satelliteAirport(linkState: LinkState): { layout: AirportLayout; main: string; sat: string; gateId: string; standId: string } {
  let layout = createSampleAirport();
  const apply = (r: OpResult): string[] => {
    const m = must(r);
    layout = m.layout;
    return m.created;
  };
  const main = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  const areaOf = (terminalId: string, kind: string) =>
    Object.values(layout.terminalAreas).find((a) => a.terminalId === terminalId && a.kind === kind)!.id;
  const mainDep = areaOf(main, 'departureLobby');
  const mainArr = areaOf(main, 'arrivalCorridor');

  // サテライト: 本体の東に離れた建物。出発ロビー・到着通路・待合だけを持ち、
  // 入口・チェックイン・保安・手荷物受取・出口は持たない
  apply(placeFacility(layout, 'terminal', { x: 94, y: 49 }, { w: 36, h: 8, name: 'サテライト', props: { levels: 2 } }));
  const sat = Object.values(layout.facilities).filter((f) => f.kind === 'terminal').at(-1)!.id;
  const satDep = apply(placeTerminalArea(layout, sat, 1, 'departureLobby', { x: 94, y: 49 }, { w: 36, h: 2, name: 'サテライト出発ロビー' }))[0]!;
  const satArr = apply(placeTerminalArea(layout, sat, 0, 'arrivalCorridor', { x: 94, y: 49 }, { w: 36, h: 2, name: 'サテライト到着通路' }))[0]!;
  apply(placeTerminalArea(layout, sat, 1, 'waiting', { x: 110, y: 51 }, { w: 10, h: 2, name: 'サテライト待合' }));

  // 東端のゲート（Lスポット std_9）をサテライト北辺へ移す。スポットとの距離は
  // 従来範囲内に収まる（ゲート所属はサテライトになる）
  const gate = Object.values(layout.facilities).filter((f) => f.kind === 'gate')
    .find((f) => f.props.standId === 'std_9')!;
  const standId = String(gate.props.standId);
  // moveEntity は移動量指定: ゲートの原点からサテライト北辺 (94,48) への差分で移す
  apply(moveEntity(layout, gate.id, { x: 94 - gate.origin.x, y: 48 - gate.origin.y }));

  if (linkState) {
    apply(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: mainDep, toAreaId: satDep,
      distanceM: 250, travelSec: 120, bidirectional: true, allowedZones: ['departure'], buildState: linkState,
    }));
    apply(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: satArr, toAreaId: mainArr,
      distanceM: 250, travelSec: 120, bidirectional: true, allowedZones: ['arrival'], buildState: linkState,
    }));
  }
  return { layout, main, sat, gateId: gate.id, standId };
}

const codesFor = (layout: AirportLayout, target: string): string[] =>
  analyzeLayout(layout).byTarget[target]?.map((i) => i.code) ?? [];

describe('サテライト（リンク複合体）のサービス解決', () => {
  it('複合体は運用中リンクでのみ結ばれる', () => {
    const op = satelliteAirport('operational');
    expect(terminalServiceComplexes(op.layout).get(op.sat)).toEqual([op.main, op.sat].sort());
    const none = satelliteAirport(null);
    expect(terminalServiceComplexes(none.layout).get(none.sat)).toEqual([none.sat]);
    const uc = satelliteAirport('underConstruction');
    expect(terminalServiceComplexes(uc.layout).get(uc.sat)).toEqual([uc.sat]);
    expect(terminalServiceComplexes(uc.layout, { includeUnderConstruction: true }).get(uc.sat)).toEqual([uc.main, uc.sat].sort());
  });

  it('検証: リンク運用中はサテライトのゲート・施設に到達不能/設備なし警告が出ない', () => {
    const { layout, sat, gateId } = satelliteAirport('operational');
    const gateCodes = codesFor(layout, gateId);
    expect(gateCodes).not.toContain('GATE_UNREACHABLE');
    expect(gateCodes).not.toContain('GATE_ARRIVAL_NO_EXIT');
    expect(gateCodes).not.toContain('GATE_ARRIVAL_NO_BAGGAGE_ROUTE');
    const satCodes = codesFor(layout, sat);
    for (const code of ['TERMINAL_NO_ENTRANCE', 'TERMINAL_NO_EXIT', 'TERMINAL_NO_CHECKIN', 'TERMINAL_NO_SECURITY', 'TERMINAL_NO_BAGGAGE_CLAIM', 'TERMINAL_NO_ROAD']) {
      expect(satCodes).not.toContain(code);
    }
  });

  it('検証: リンクが無い独立した衛星棟は従来どおり警告が出る', () => {
    const { layout, sat, gateId } = satelliteAirport(null);
    const gateCodes = codesFor(layout, gateId);
    expect(gateCodes).toContain('GATE_UNREACHABLE');
    expect(gateCodes).toContain('GATE_ARRIVAL_NO_EXIT');
    const satCodes = codesFor(layout, sat);
    for (const code of ['TERMINAL_NO_ENTRANCE', 'TERMINAL_NO_EXIT', 'TERMINAL_NO_CHECKIN', 'TERMINAL_NO_SECURITY', 'TERMINAL_NO_BAGGAGE_CLAIM']) {
      expect(satCodes).toContain(code);
    }
  });

  it('検証: リンク建設中は到達不可ではなく完成待ちになる', () => {
    const { layout, gateId } = satelliteAirport('underConstruction');
    const gateCodes = codesFor(layout, gateId);
    expect(gateCodes).toContain('GATE_ROUTE_PENDING');
    expect(gateCodes).not.toContain('GATE_UNREACHABLE');
    expect(gateCodes).not.toContain('GATE_ARRIVAL_NO_EXIT');
  });

  it('実運航: リンク運用中はサテライトゲートで搭乗・降機・退出まで完了する', { timeout: 300_000 }, () => {
    const { layout, main, gateId, standId } = satelliteAirport('operational');
    const sim = createSimulation(layout, { seed: 'satellite-complex', settings: manual });
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(standId) });
    const arr = sim.state.flights[ac.arrivalFlightId]!;
    const dep = sim.state.flights[ac.departureFlightId]!;
    expect(sim.ctx.terminal.gates[gateId]!.terminalId).not.toBe(main);

    runUntil(sim, () => ac.state === 'departed' && arr.pax.deplaned > 0 && arr.pax.exited === arr.pax.deplaned && dep.pax.boarded > 0, 8 * 3600);

    const depGroups = groups(sim, dep.id);
    expect(depGroups.length).toBeGreaterThan(0);
    expect(depGroups.every((g) => g.state === 'boarded' && g.boardedGate === gateId)).toBe(true);
    const arrGroups = groups(sim, arr.id);
    expect(arrGroups.length).toBeGreaterThan(0);
    expect(arrGroups.every((g) => g.state === 'exited')).toBe(true);
    // 手荷物受取は本体ターミナルの受取所が選ばれる
    expect(layout.terminalAreas[arr.pax.claimAreaId ?? '']?.terminalId).toBe(main);
    // 本体のチェックイン・保安が実際に使われた
    for (const kind of ['checkIn', 'security'] as const) {
      const ids = Object.values(sim.ctx.terminal.areas).filter((a) => a.terminalId === main && a.kind === kind).map((a) => a.id);
      expect(ids.some((id) => (sim.state.facilities[id]?.served ?? 0) > 0)).toBe(true);
    }
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('実運航: リンクが無いとサテライトゲートの旅客は入場も退出もできない（従来どおり）', { timeout: 300_000 }, () => {
    const { layout, standId } = satelliteAirport(null);
    const sim = createSimulation(layout, { seed: 'satellite-isolated', settings: manual });
    const ac = addTurnaround(sim, 'narrow180', 20 * 60, { departureAt: 170 * 60, plan: contractPlan(standId) });
    const arr = sim.state.flights[ac.arrivalFlightId]!;
    const dep = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => groups(sim, dep.id).length > 0 && arr.pax.deplaned > 0, 4 * 3600);
    for (let i = 0; i < 1800; i++) stepSimulation(sim);
    // 出発客は入口が無いので建物に入れない
    expect(groups(sim, dep.id).every((g) => g.area === null && g.state !== 'boarded')).toBe(true);
    expect(dep.pax.boarded).toBe(0);
    // 到着客は降機口から先へ進めず退出できない
    expect(arr.pax.exited).toBe(0);
    expect(groups(sim, arr.id).every((g) => g.state === 'stranded')).toBe(true);
  });
});
