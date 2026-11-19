import { describe, expect, it } from 'vitest';
import { operationalStateReadings } from '../../src/core/capability';
import type { AirportLayout } from '../../src/core/model/types';
import type { Disruption, SimState } from '../../src/core/sim/types';

/**
 * F6-04 残件: 運航中状態（closed / failed / resourceShortage）の生成。
 * 減額源は有効な障害・閉鎖理由台帳・滑走路モードだけ。supplyShortage は
 * F6-13（保留中）の領域なので生成されないことも固定する。
 */

function disruption(over: Partial<Disruption>): Disruption {
  return {
    id: 'dis_1', kind: 'runwayClosed', targetId: null, start: 0, end: null,
    status: 'active', resolvedAt: null, resolvedBy: null,
    affected: { tasks: [], flights: [], units: [] }, ...over,
  } as Disruption;
}

function fakeState(over: Partial<SimState>): SimState {
  return {
    disruptions: [],
    runwayConfig: {},
    closures: { taxiways: [], stands: [], gates: [] },
    ...over,
  } as SimState;
}

const layout = {
  runways: { rwy_1: { id: 'rwy_1', name: '滑走路A' } },
  facilities: {
    fac_gate: { id: 'fac_gate', kind: 'gate', name: 'ゲート棟', buildState: 'operational', props: {} },
    fac_tower: { id: 'fac_tower', kind: 'tower', name: '管制塔', buildState: 'operational', props: { level: 2 } },
  },
  terminalAreas: {},
  stands: { st_1: { id: 'st_1', name: 'スポット1' } },
} as unknown as AirportLayout;

describe('F6-04 運航中状態の生成（operationalStateReadings）', () => {
  it('滑走路閉鎖の障害は closed、ゲート故障は failed（施設の理論能力は保持）', () => {
    const state = fakeState({
      disruptions: [
        disruption({ id: 'dis_1', kind: 'runwayClosed', targetId: 'rwy_1' }),
        disruption({ id: 'dis_2', kind: 'gateFailure', targetId: 'fac_gate' }),
      ],
    });
    const rs = operationalStateReadings(state, layout);
    const rwy = rs.find((r) => r.subjectId === 'rwy_1')!;
    expect(rwy.state).toBe('closed');
    expect(rwy.effective).toBe(0);
    const gate = rs.find((r) => r.subjectId === 'fac_gate')!;
    expect(gate.state).toBe('failed');
  });

  it('欠勤は resourceShortage、手荷物・車両故障は failed', () => {
    const state = fakeState({
      disruptions: [
        disruption({ id: 'dis_3', kind: 'staffAbsence', targetId: null, amount: 2, affected: { tasks: [], flights: [], units: ['u1', 'u2'] } }),
        disruption({ id: 'dis_4', kind: 'baggageFailure', targetId: 'belt:1' }),
        disruption({ id: 'dis_5', kind: 'vehicleFailure', targetId: 'unit_9' }),
      ],
    });
    const rs = operationalStateReadings(state, layout);
    expect(rs.find((r) => r.subjectId === 'staff:absence')!.state).toBe('resourceShortage');
    expect(rs.find((r) => r.subjectId === 'belt:1')!.state).toBe('failed');
    expect(rs.find((r) => r.subjectId === 'unit_9')!.state).toBe('failed');
  });

  it('滑走路モード closed（Work Order）と閉鎖台帳（手動閉鎖）からも closed を生成する', () => {
    const state = fakeState({
      runwayConfig: { rwy_1: { mode: 'closed' } } as unknown as SimState['runwayConfig'],
      closures: { taxiways: [], stands: ['st_1'], gates: [] },
      closureReasons: { taxiways: {}, stands: { st_1: ['manual'] }, gates: {} },
    } as Partial<SimState>);
    const rs = operationalStateReadings(state, layout);
    expect(rs.find((r) => r.subjectId === 'rwy_1')!.state).toBe('closed');
    const stand = rs.find((r) => r.subjectId === 'st_1')!;
    expect(stand.state).toBe('closed');
    expect(stand.basis).toContain('manual');
  });

  it('解決済みの障害と通常運航では何も生成しない。supplyShortage は生成しない', () => {
    const state = fakeState({
      disruptions: [disruption({ id: 'dis_9', kind: 'runwayClosed', targetId: 'rwy_1', status: 'resolved' })],
    });
    const rs = operationalStateReadings(state, layout);
    expect(rs).toHaveLength(0);
    expect(operationalStateReadings(fakeState({}), layout)).toHaveLength(0);
    const all = operationalStateReadings(fakeState({ disruptions: [disruption({ kind: 'staffAbsence', affected: { tasks: [], flights: [], units: ['u1'] } })] }), layout);
    expect(all.every((r) => r.state !== 'supplyShortage')).toBe(true);
  });

  it('同じ対象に障害と台帳が重なっても読み取りは 1 件だけ', () => {
    const state = fakeState({
      disruptions: [disruption({ id: 'dis_7', kind: 'gateFailure', targetId: 'fac_gate' })],
      closures: { taxiways: [], stands: [], gates: ['fac_gate'] },
      closureReasons: { taxiways: {}, stands: {}, gates: { fac_gate: ['disruption:dis_7'] } },
    } as Partial<SimState>);
    const rs = operationalStateReadings(state, layout);
    expect(rs.filter((r) => r.subjectId === 'fac_gate')).toHaveLength(1);
    expect(rs[0]!.state).toBe('failed');
  });
});
