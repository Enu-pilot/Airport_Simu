import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addTurnaround, createSimulation } from '../../../src/core/sim/simulation';
import { keepOnlyStand, runUntil } from './helpers';

const manual = { autoSchedule: false };

describe('待機理由の拡充（スポット割当の失敗理由を分ける）', () => {
  it('出発経路が確保できない場合は noStand ではなく noDepartureRoute になる', () => {
    const sim = createSimulation(createSampleAirport(), { settings: manual });
    // 滑走路端の入口につながる誘導路を閉鎖する: 着陸後の離脱経路は残るが、
    // 離陸距離を満たす入口へは到達できず、折り返し出発の経路が作れない
    sim.state.closures.taxiways.push('twy_2', 'twy_4');
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60);
    runUntil(sim, () => ac.state === 'holding', 3600);
    expect(ac.holdReason).toBe('noDepartureRoute');
    expect(ac.standId).toBeNull();
    // スポット自体は空いている（割当済みスポットは0）
    expect(Object.keys(sim.state.standAssignments)).toHaveLength(0);
    expect(sim.state.flights[ac.arrivalFlightId]!.delayCauses).toContain('noRoute');
  });

  it('空きスポットの区分が機体より小さい場合は standTooSmall になる', () => {
    const layout = keepOnlyStand(createSampleAirport(), 'std_1');
    const sim = createSimulation(layout, { settings: manual });
    const ac = addTurnaround(sim, 'wide300', sim.state.now + 20 * 60);
    runUntil(sim, () => ac.state === 'holding', 3600);
    expect(ac.holdReason).toBe('standTooSmall');
    expect(ac.standId).toBeNull();
  });

  it('ゲートの国内/国際区分が合わない場合は gateRouteMismatch になる', () => {
    const layout = keepOnlyStand(createSampleAirport(), 'std_1');
    const sim = createSimulation(layout, { settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60);
    // サンプル空港のゲートは国内扱い。国際線として到着させると区分が合わない
    sim.state.flights[ac.arrivalFlightId]!.routeType = 'international';
    runUntil(sim, () => ac.state === 'holding', 3600);
    expect(ac.holdReason).toBe('gateRouteMismatch');
    expect(ac.standId).toBeNull();
  });

  it('本当に空きがない場合は従来どおり noStand になる', () => {
    const layout = keepOnlyStand(createSampleAirport(), 'std_1');
    const sim = createSimulation(layout, { settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'regional70', t, { departureAt: t + 35 * 60 });
    const b = addTurnaround(sim, 'narrow180', t + 2 * 60, { departureAt: t + 3 * 3600 });
    runUntil(sim, () => b.state === 'holding', 3600);
    expect(a.standId).toBe('std_1');
    expect(b.holdReason).toBe('noStand');
  });
});
