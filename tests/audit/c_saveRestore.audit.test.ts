/** 監査 c / ID17・21: 保存・復元の等価性（さまざまな運航状態で保存 → 検証 → 復元 → 継続し、中断しない運航と状態が一致） */
import { describe, expect, it } from 'vitest';
import { sampleSim, runChecked, runUntilTime, roundTrip, stateHash, DAY_SEC } from './c_helpers';
import { addDisruption } from '../../src/core/sim/disruptions';
import { createSimulation } from '../../src/core/sim/simulation';
import { createSandboxCompany } from '../../src/core/economy/company';
import { busLayout } from '../unit/sim/busHelpers';
import type { Simulation } from '../../src/core/sim/simulation';

function equivalence(make: () => Simulation, t1: number, t2: number, setup?: (s: Simulation) => void, label = ''): Simulation {
  const a = make();
  const b = make();
  if (setup) { runUntilTime(a, t1 - 600, 60, label); runUntilTime(b, t1 - 600, 60, label); setup(a); setup(b); }
  runUntilTime(a, t1, 60, label);
  runUntilTime(b, t1, 60, label);
  const r = roundTrip(b);
  runUntilTime(a, t2, 60, label);
  runUntilTime(r.sim, t2, 60, label);
  expect(stateHash(r.sim)).toBe(stateHash(a));
  return r.sim;
}

describe('ID17 保存・復元の等価性（seed 固定）', () => {
  for (const [name, t1] of [['着陸〜地上走行が多い朝', 8.4 * 3600], ['折返し作業中', 9.7 * 3600], ['正午', 12 * 3600]] as const) {
    it(`${name} (t=${t1}): 復元して +1 時間継続 = 中断なし`, () => {
      equivalence(() => sampleSim({ seed: 'c-save-a' }), t1, t1 + 3600, undefined, name);
    });
  }

  it('障害の発生中（滑走路閉鎖 + 天候 + 車両故障）に保存しても、復旧まで含め同一', () => {
    const setup = (s: Simulation) => {
      const t = s.state.now;
      addDisruption(s, { kind: 'weather', targetId: null, weather: 'fog', end: t + 5400 });
      addDisruption(s, { kind: 'runwayClosed', targetId: Object.keys(s.ctx.layout.runways)[0]!, end: t + 2400 });
      addDisruption(s, { kind: 'vehicleFailure', targetId: Object.values(s.state.units).find((u) => u.kind === 'tug')!.id, end: t + 3000 });
    };
    const r = equivalence(() => sampleSim({ seed: 'c-save-d' }), 9 * 3600, 12 * 3600, setup, 'dis');
    expect(r.state.disruptions.every((d) => d.status === 'resolved')).toBe(true);
  });

  it('バスが運行中（バスゲートのレイアウト）に保存しても同一。保存された運行状態に bus がある', () => {
    const r = equivalence(() => createSimulation(busLayout({ buses: 3 }), { seed: 'c-save-bus', company: createSandboxCompany() }), 10 * 3600, 12 * 3600, undefined, 'bus');
    expect(r.state.bus).toBeDefined();
  });

  it('日の締め直後に保存しても同一（company.day・日報・当日収支を含む）', () => {
    const r = equivalence(() => sampleSim({ seed: 'c-save-close' }), DAY_SEC + 5, DAY_SEC + 4 * 3600, undefined, 'close');
    expect(r.company!.reports.length).toBe(1);
  });

  it('旅客が処理中・ベルト・搭乗の途中の時刻を 15 分刻みで 4 回保存・復元しても最終状態は同一', () => {
    const a = sampleSim({ seed: 'c-save-loop' });
    let b = sampleSim({ seed: 'c-save-loop' });
    for (let i = 1; i <= 4; i++) {
      runUntilTime(a, 9 * 3600 + i * 900, 60, 'loop');
      runUntilTime(b, 9 * 3600 + i * 900, 60, 'loop');
      b = roundTrip(b).sim;
    }
    expect(stateHash(b)).toBe(stateHash(a));
    expect(b.state.activePax.length > 0).toBe(true);
  });
});

describe('ID21 統合シナリオ: サンプル空港 → 運航 → 障害 → 経済 → 保存・復元 → 複数日', () => {
  it('2 日運航し、途中で保存・復元・障害を挟んでも不変条件・資金の整合・旅客保存則を保つ', () => {
    let sim = sampleSim({ seed: 'c-scn' });
    runUntilTime(sim, 9 * 3600, 60, 'scn');
    addDisruption(sim, { kind: 'baggageFailure', targetId: sim.ctx.sorters[0]?.id ?? null, end: sim.state.now + 3600 });
    sim = roundTrip(sim).sim;
    runUntilTime(sim, DAY_SEC + 8 * 3600, 120, 'scn');
    sim = roundTrip(sim).sim;
    runUntilTime(sim, 2 * DAY_SEC + 3600, 120, 'scn');
    const rs = sim.company!.reports;
    expect(rs.length).toBe(2);
    expect(rs[1]!.cashEnd).toBeCloseTo(rs[0]!.cashEnd + rs[1]!.operatingProfit - rs[1]!.construction, 4);
    const p = sim.state.paxStats;
    expect(p.boarded + p.missed).toBeLessThanOrEqual(p.spawned);
    expect(p.exited).toBeLessThanOrEqual(p.deplaned);
    expect(runChecked).toBeTypeOf('function');
  });
});
