import { describe, expect, it } from 'vitest';
import { operationalStateReadings } from '../../src/core/capability';
import type { AirportLayout } from '../../src/core/model/types';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { setEquipmentBroken } from '../../src/core/sim/baggage';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import type { Disruption, SimState } from '../../src/core/sim/types';

/**
 * F6-04 状態生成の第三弾: 設備故障台帳（sim/baggage の state.equipment）からの
 * failed 生成。障害に由来しない停止（sim/ground のランダム故障、運航画面からの
 * 手動停止）は第二弾では生成されず、旧 UI 側導出だけが拾っていた不足の解消。
 * 障害由来の分は障害側の生成が優先され、二重に出ないこと。
 * `belt:` キー（受取所ベルト）とユニットのキーは施設の行にしない
 * （旧 UI 側導出と同じ範囲）。
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
  runways: {},
  facilities: {
    fac_sort: { id: 'fac_sort', kind: 'baggageSort', name: '仕分け設備1', buildState: 'operational', props: {} },
    fac_gate: { id: 'fac_gate', kind: 'gate', name: 'ゲート棟', buildState: 'operational', props: {} },
  },
  terminalAreas: {
    ta_claim: { id: 'ta_claim', kind: 'baggageClaim', name: '受取所1', props: { belts: 2 } },
  },
  stands: {},
} as unknown as AirportLayout;

describe('F6-04 設備故障台帳からの状態生成（operationalStateReadings）', () => {
  it('ランダム故障（自動復旧予定あり）は failed になり、理由が障害と区別できる', () => {
    const state = fakeState({
      equipment: { fac_sort: { broken: true, repairUntil: 3600, downSec: 600 } },
    });
    const rs = operationalStateReadings(state, layout);
    const rows = rs.filter((r) => r.subjectId === 'fac_sort');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('failed');
    expect(rows[0]!.domain).toBe('baggage');
    expect(rows[0]!.effective).toBe(0);
    expect(rows[0]!.basis).toContain('ランダム故障');
    expect(rows[0]!.basis).not.toContain('障害 dis');
  });

  it('手動停止（自動復旧なし）は failed になり、ランダム故障と理由が異なる', () => {
    const state = fakeState({
      equipment: { fac_sort: { broken: true, repairUntil: null, downSec: 600 } },
    });
    const rs = operationalStateReadings(state, layout);
    const rows = rs.filter((r) => r.subjectId === 'fac_sort');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('failed');
    expect(rows[0]!.basis).toContain('手動停止');
  });

  it('障害由来と非由来が併存しても行は 1 件で、障害側の根拠が優先される', () => {
    const state = fakeState({
      disruptions: [disruption({ id: 'dis_9', kind: 'baggageFailure', targetId: 'fac_sort' })],
      equipment: { fac_sort: { broken: true, repairUntil: null, downSec: 600 } },
    });
    const rs = operationalStateReadings(state, layout);
    const rows = rs.filter((r) => r.subjectId === 'fac_sort');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('failed');
    expect(rows[0]!.basis).toContain('障害 dis_9');
  });

  it('復旧した設備（broken でない）は生成されない', () => {
    const state = fakeState({
      equipment: { fac_sort: { broken: false, repairUntil: null, downSec: 600 } },
    });
    expect(operationalStateReadings(state, layout)).toHaveLength(0);
  });

  it('belt: キー（受取所ベルト）とユニットのキーは施設の行にしない', () => {
    const state = fakeState({
      equipment: {
        'belt:ta_claim': { broken: true, repairUntil: 3600, downSec: 60 },
        gu_1: { broken: true, repairUntil: 3600, downSec: 60 },
      },
    });
    expect(operationalStateReadings(state, layout)).toHaveLength(0);
  });

  it('読み取り専用: 状態を変更せず、equipment 未定義の状態でも例外なく空を返す', () => {
    const state = fakeState({
      equipment: { fac_sort: { broken: true, repairUntil: null, downSec: 0 } },
    });
    const before = JSON.stringify(state);
    operationalStateReadings(state, layout);
    expect(JSON.stringify(state)).toBe(before);
    expect(operationalStateReadings(fakeState({}), layout)).toHaveLength(0);
  });

  it('サンプル空港: 仕分け設備の台帳エントリだけで failed になる（UI 側の固定テストと対）', () => {
    const sample = createSampleAirport();
    const sorter = Object.values(sample.facilities).find((f) => f.kind === 'baggageSort')!;
    expect(sorter).toBeDefined();
    const state = fakeState({
      equipment: { [sorter.id]: { broken: true, repairUntil: null, downSec: 600 } },
    });
    const rs = operationalStateReadings(state, sample);
    expect(rs.find((r) => r.subjectId === sorter.id)?.state).toBe('failed');
  });

  it('実経路: setEquipmentBroken の手動停止・ランダム故障が生成され、自動復旧で消える', () => {
    const sample = createSampleAirport();
    const sim = createSimulation(sample, { seed: 'cap-equipment', settings: { autoSchedule: false } });
    const sorterId = sim.ctx.sorters[0]!.id;
    // 手動停止（simRunner と同じく repairSec なし）
    setEquipmentBroken(sim, sorterId, true);
    let rs = operationalStateReadings(sim.state, sample);
    expect(rs.find((r) => r.subjectId === sorterId)?.basis).toContain('手動停止');
    setEquipmentBroken(sim, sorterId, false);
    expect(operationalStateReadings(sim.state, sample).find((r) => r.subjectId === sorterId)).toBeUndefined();
    // ランダム故障（ground.randomFailures と同じく repairSec あり）→ 期限で自動復旧し行が消える
    setEquipmentBroken(sim, sorterId, true, 60);
    rs = operationalStateReadings(sim.state, sample);
    expect(rs.find((r) => r.subjectId === sorterId)?.basis).toContain('ランダム故障');
    for (let i = 0; i < 120; i++) stepSimulation(sim);
    expect(sim.state.equipment[sorterId]!.broken).toBe(false);
    expect(operationalStateReadings(sim.state, sample).find((r) => r.subjectId === sorterId)).toBeUndefined();
  });
});
