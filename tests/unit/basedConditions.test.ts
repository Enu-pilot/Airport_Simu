import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState, type Contract } from '../../src/core/economy/company';
import { basedConditionDetails } from '../../src/core/economy/basedConditions';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext } from '../../src/core/sim/context';
import { createSimulation, type Simulation } from '../../src/core/sim/simulation';
import { basedConditionsUnmet } from '../../src/core/sim/overnight';
import type { AirportLayout } from '../../src/core/model/types';

/**
 * UIデザイン更新 第3段階・§6-3: 拠点契約の条件開示（読み取り専用ヘルパー）。
 * 判定の正本 basedConditionsUnmet（Simulation が必要）と同じ未達集合を、
 * (会社, 文脈) だけで返すことを担保する。会社データは変更しない。
 */

function basedCompany(seed: string, opts: { perDay?: number; basedAircraft?: number; typeId?: string } = {}): { c: CompanyState; k: Contract } {
  const c = createSandboxCompany(seed);
  c.features = { based: true, overnight: true };
  const k = addContract(c, {
    airlineId: 'SK', destinationId: 'KTA', typeId: opts.typeId ?? 'B737-800', perDay: opts.perDay ?? 2, window: 'any',
    feeDiscount: 0.25, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, kind: 'based', basedAircraft: opts.basedAircraft ?? 2,
  });
  c.basedFleet = {};
  for (let i = 1; i <= (opts.basedAircraft ?? 2); i++) {
    c.basedFleet[`ba_${i}`] = { id: `ba_${i}`, airlineId: 'SK', contractId: k.id, typeId: opts.typeId ?? 'B737-800', cycles: 0, lastCheckDay: null };
  }
  c.airlines['SK'] ??= { satisfaction: 60, lowDays: 0 };
  return { c, k };
}

const simOf = (c: CompanyState, layout: AirportLayout = createSampleAirport()): Simulation =>
  createSimulation(layout, { company: c, seed: c.seed });

function expectSameUnmet(c: CompanyState, k: Contract, layout: AirportLayout = createSampleAirport()) {
  const sim = simOf(c, layout);
  const fromSim = [...basedConditionsUnmet(sim, k.id)].sort();
  const details = basedConditionDetails(c, sim.ctx, k.id);
  expect(details).not.toBeNull();
  expect([...details!.unmet].sort()).toEqual(fromSim);
  expect(details!.allMet).toBe(fromSim.length === 0);
  // 数値の整合: 未達でない項目は required <= available（滞泊だけはサイズ適合の貪欲判定が正本なので除く）
  for (const item of details!.items) {
    if (item.key === 'overnight') continue;
    expect(item.met).toBe(item.available >= item.required);
  }
  return details!;
}

describe('basedConditions: 締め判定との一致（表示専用ヘルパー）', () => {
  it('(a) 滞泊の能力が足りないケースで一致する', () => {
    const { c, k } = basedCompany('bc-a', { typeId: 'A350-900', basedAircraft: 2, perDay: 1 });
    const d = expectSameUnmet(c, k);
    expect(d.unmet).toContain('滞泊の能力');
    const ovn = d.items.find((i) => i.key === 'overnight')!;
    expect(ovn.met).toBe(false);
    expect(ovn.required).toBeGreaterThan(0);
  });

  it('(b) 整備の能力が足りないケースで一致する', () => {
    const { c, k } = basedCompany('bc-b', { basedAircraft: 6, perDay: 12 });
    const d = expectSameUnmet(c, k);
    expect(d.unmet).toContain('整備の能力');
    const m = d.items.find((i) => i.key === 'maintenance')!;
    expect(m.required).toBe(6); // ceil(6 × 12 / 12)
    expect(m.available).toBeLessThan(6);
  });

  it('(c) 整備士が足りないケースで一致する', () => {
    const layout = createSampleAirport();
    for (const f of Object.values(layout.facilities)) if (f.kind === 'maintenance') f.props.engineers = 0;
    const { c, k } = basedCompany('bc-c', { basedAircraft: 2, perDay: 1 });
    const d = expectSameUnmet(c, k, layout);
    expect(d.unmet).toContain('整備士');
    const e = d.items.find((i) => i.key === 'engineers')!;
    expect(e.available).toBe(0);
    expect(e.required).toBe(1); // ceil(2 / 2)
  });

  it('条件を満たすケースでも一致する（未達ゼロ）', () => {
    const { c, k } = basedCompany('bc-ok', { basedAircraft: 2, perDay: 1 });
    const d = expectSameUnmet(c, k);
    expect(d.unmet).toEqual([]);
    expect(d.allMet).toBe(true);
  });

  it('拠点契約でなければ null を返す', () => {
    const c = createSandboxCompany('bc-none');
    const ctx = createContext(createSampleAirport());
    const other = Object.values(c.contracts).find((x) => x.kind !== 'based');
    if (other) expect(basedConditionDetails(c, ctx, other.id)).toBeNull();
    expect(basedConditionDetails(c, ctx, 'no-such-contract')).toBeNull();
  });

  it('会社データを変更しない（表示専用）', () => {
    const { c, k } = basedCompany('bc-pure', { basedAircraft: 3, perDay: 4 });
    const layout = createSampleAirport();
    const ctx = createContext(layout);
    const before = JSON.stringify(c);
    basedConditionDetails(c, ctx, k.id);
    expect(JSON.stringify(c)).toBe(before);
  });
});
