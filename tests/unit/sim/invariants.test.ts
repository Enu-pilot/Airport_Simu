import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addTurnaround, createSimulation } from '../../../src/core/sim/simulation';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { runUntil } from './helpers';

/** 不変条件チェック自体が違反を検出できることの確認（壊した状態を与える） */
describe('不変条件チェック', () => {
  const setup = () => {
    const sim = createSimulation(createSampleAirport(), { settings: { autoSchedule: false } });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'narrow180', t);
    const b = addTurnaround(sim, 'narrow180', t + 5 * 60);
    runUntil(sim, () => a.state === 'taxiIn', 3600);
    return { sim, a, b };
  };

  it('正常な状態では違反なし', () => {
    expect(checkInvariants(setup().sim)).toEqual([]);
  });

  it('同じスポットを2機に割り当てると検出する', () => {
    const { sim, a, b } = setup();
    b.standId = a.standId;
    expect(checkInvariants(sim).some((v) => v.startsWith('S1'))).toBe(true);
  });

  it('占有していない滑走路で離陸滑走すると検出する', () => {
    const { sim, b } = setup();
    b.state = 'takeoff';
    b.runwayId = 'rwy_1';
    expect(checkInvariants(sim).some((v) => v.startsWith('R1'))).toBe(true);
  });

  it('予約していない誘導路を走ると検出する', () => {
    const { sim } = setup();
    sim.state.edgeReservations = {};
    expect(checkInvariants(sim).some((v) => v.startsWith('T1'))).toBe(true);
  });

  it('1ティックで大きく移動（瞬間移動）すると検出する', () => {
    const { sim, a } = setup();
    a.stateSince = 0;
    a.x += 10;
    expect(checkInvariants(sim).some((v) => v.startsWith('M1'))).toBe(true);
  });
});
