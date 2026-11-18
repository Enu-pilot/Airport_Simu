import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState, type Contract } from '../../src/core/economy/company';
import { airlineSatisfaction } from '../../src/core/economy/ops';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation, type Simulation } from '../../src/core/sim/simulation';
import { basedConditionsUnmet, settlePhase4 } from '../../src/core/sim/overnight';
import type { AirportLayout } from '../../src/core/model/types';

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
  // SAS（SK）は最低評価 80 で初期関係が作られないため、拠点会社として使うには関係の初期化が要る
  c.airlines['SK'] ??= { satisfaction: 60, lowDays: 0 };
  return { c, k };
}

const simOf = (c: CompanyState, layout: AirportLayout = createSampleAirport()): Simulation =>
  createSimulation(layout, { company: c, seed: c.seed });

describe('basedAirline: 拠点の条件（4B-5 / §3.5）', () => {
  it('(a) 滞泊の能力が足りないと満たさない', () => {
    const { c, k } = basedCompany('based-a', { typeId: 'A350-900', basedAircraft: 2, perDay: 1 });
    // サンプル空港の L スポットは 1 つだけ。L の所属機 2 機は収まらない
    expect(basedConditionsUnmet(simOf(c), k.id)).toContain('滞泊の能力');
  });

  it('(b) 整備の能力が足りないと満たさない', () => {
    const { c, k } = basedCompany('based-b', { basedAircraft: 6, perDay: 12 });
    // 必要な整備は ceil(6 × 12 / 12) = 6 機/晩。サンプルの能力は 2 機/晩
    expect(basedConditionsUnmet(simOf(c), k.id)).toContain('整備の能力');
  });

  it('(c) 整備士が足りないと満たさない', () => {
    const layout = createSampleAirport();
    for (const f of Object.values(layout.facilities)) if (f.kind === 'maintenance') f.props.engineers = 0;
    const { c, k } = basedCompany('based-c', { basedAircraft: 2, perDay: 1 });
    expect(basedConditionsUnmet(simOf(c, layout), k.id)).toContain('整備士');
  });

  it('条件を満たさない日が 2 日では撤退せず、3 日連続で撤退する', () => {
    const { c, k } = basedCompany('based-w', { basedAircraft: 6, perDay: 12 });
    c.rating = 80;
    c.airlines['SK']!.satisfaction = 70;
    const sim = simOf(c);
    settlePhase4(sim, 0);
    expect(c.contracts[k.id]!.status).toBe('active');
    expect(c.basedIssueDays?.[k.id]).toBe(1);
    settlePhase4(sim, 0);
    expect(c.contracts[k.id]!.status).toBe('active');
    expect(c.basedIssueDays?.[k.id]).toBe(2);
    settlePhase4(sim, 0);
    expect(c.contracts[k.id]!.status).toBe('withdrawn');
    expect(Object.values(c.basedFleet ?? {}).filter((b) => b.contractId === k.id)).toHaveLength(0);
    expect(c.rating).toBe(75);
    expect(c.airlines['SK']!.satisfaction).toBe(30);
  });

  it('拠点の会社は満足度の加重が 2 倍になる（features.based のときだけ）', () => {
    const { c } = basedCompany('based-s');
    addContract(c, {
      airlineId: 'NP', destinationId: 'TWN', typeId: 'A320neo', perDay: 2, window: 'any',
      feeDiscount: 0.1, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0,
    });
    // サンドボックスの既定契約は対象外にして、SK と NP だけを有効な契約にする
    for (const k of Object.values(c.contracts)) {
      if (k.airlineId !== 'SK' && k.airlineId !== 'NP') k.status = 'withdrawn';
    }
    c.airlines['SK']!.satisfaction = 80;
    c.airlines['NP']!.satisfaction = 40;
    // (80 × 2 + 40) / 3 ≒ 66.7
    expect(airlineSatisfaction(c)).toBe(66.7);
    delete c.features;
    expect(airlineSatisfaction(c)).toBe(60);
  });
});
