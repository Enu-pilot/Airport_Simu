import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { effectiveModels, restoreSimulation } from '../../src/core/io/project';
import { thinSnapshotState } from '../../src/core/sim/thin';
import type { SimState } from '../../src/core/sim/types';
import { addContract, createSandboxCompany } from '../../src/core/economy/company';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { DAY_SEC } from '../../src/core/sim/rules';

describe('5-11 保存データの間引き', () => {
  it('実セーブ: 間引いても復元でき、生きている機体の参照は壊れない', () => {
    const raw = JSON.parse(readFileSync('/home/hatch/workspace/user/files/skyport-test2_hard-20261118-1052.skyport.json', 'utf8'));
    const state = structuredClone(raw.sim.state) as SimState;
    thinSnapshotState(state);
    for (const a of Object.values(state.aircraft)) {
      expect(state.flights[a.arrivalFlightId]).toBeDefined();
      expect(state.flights[a.departureFlightId]).toBeDefined();
    }
    // 間引きが復元の整合性結果を変えないこと（G2/O1 の判定を運航側の skip・離陸済みに合わせてあり、このセーブは違反 0 件）
    const original = restoreSimulation(raw.layout, raw.sim, effectiveModels(raw.catalog));
    const { violations } = restoreSimulation(raw.layout, { state, company: raw.sim.company }, effectiveModels(raw.catalog));
    expect(violations).toEqual(original.violations);
  });

  it('2 日目に入ると前日の終了便と付随データが間引かれ、復元も通る', { timeout: 600000 }, () => {
    const layout = createSampleAirport();
    const company = createSandboxCompany('thin-511');
    addContract(company, {
      airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 4, window: 'any',
      feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0,
    });
    const sim = createSimulation(layout, { company, seed: 'thin-511' });
    // 1 日 + 2 時間（締めを 1 回通る）
    const target = 21600 + DAY_SEC + 7200;
    while (sim.state.now < target) stepSimulation(sim);
    const before = structuredClone(sim.state);
    const thinned = structuredClone(sim.state);
    const sizeBefore = JSON.stringify(before).length;
    const result = thinSnapshotState(thinned);
    expect(result.flights).toBeGreaterThan(0);
    expect(result.groups).toBeGreaterThan(0);
    expect(JSON.stringify(thinned).length).toBeLessThan(sizeBefore);
    // 生きている機体の参照はすべて残る
    for (const a of Object.values(thinned.aircraft)) {
      expect(thinned.flights[a.arrivalFlightId]).toBeDefined();
      expect(thinned.flights[a.departureFlightId]).toBeDefined();
    }
    // 当日（2 日目）の便は残る
    const todayStart = Math.floor(thinned.now / DAY_SEC) * DAY_SEC;
    for (const f of Object.values(before.flights)) {
      if (f.scheduled >= todayStart) expect(thinned.flights[f.id]).toBeDefined();
    }
    const { violations } = restoreSimulation(layout, { state: thinned, company: sim.company ?? null }, effectiveModels(null));
    expect(violations).toEqual([]);
  });
});
