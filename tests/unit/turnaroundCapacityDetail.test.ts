import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import type { AirportLayout } from '../../src/core/model/types';
import { createContext } from '../../src/core/sim/context';
import { turnaroundCapacity, turnaroundCapacityDetail } from '../../src/core/economy/planning';

/**
 * 地上支援の同時処理能力の内訳（表示用）:
 * サンプル空港の標準構成では実測どおり同時 2 機が上限で、ボトルネックは
 * ベルトローダーと手荷物牽引車（どちらも実効 2/3 台分）になる。
 */
function gseBase(layout: AirportLayout) {
  return Object.values(layout.facilities).find((f) => f.kind === 'gseBase')!;
}

describe('turnaroundCapacityDetail（地上支援の内訳）', () => {
  it('サンプル空港: 同時 2 機、ボトルネックはベルトローダーと手荷物牽引車', () => {
    const ctx = createContext(createSampleAirport());
    const detail = turnaroundCapacityDetail(ctx);
    expect(detail.capacity).toBe(2);
    expect(detail.capacity).toBe(turnaroundCapacity(ctx));
    expect(detail.gates).toEqual([]);
    const limiting = Object.fromEntries(detail.limiting.map((l) => [l.kind, l.add]));
    // 実効能力 2 の資源だけがボトルネック。どちらも 3 台 → 5 台で実効 3 台分になる
    expect(limiting).toEqual({ beltLoader: 2, baggageTractor: 2 });
  });

  it('ボトルネック資源を足すと同時処理が +1 機になる', () => {
    const layout = structuredClone(createSampleAirport());
    const base = gseBase(layout);
    base.props = { ...base.props, beltLoaders: Number(base.props.beltLoaders) + 2, baggageTractors: Number(base.props.baggageTractors) + 2 };
    const ctx = createContext(layout);
    expect(turnaroundCapacity(ctx)).toBe(3);
    expect(turnaroundCapacityDetail(ctx).capacity).toBe(3);
  });

  it('整備士がいなければ前提不足（gate）として返り、能力は 0', () => {
    const layout = structuredClone(createSampleAirport());
    for (const f of Object.values(layout.facilities)) if (f.kind === 'maintenance') delete layout.facilities[f.id];
    const detail = turnaroundCapacityDetail(createContext(layout));
    expect(detail.capacity).toBe(0);
    expect(detail.gates.map((g) => g.kind)).toContain('engineer');
    expect(detail.limiting).toEqual([]);
  });

  it('燃料施設がなければ前提不足（gate）として返る', () => {
    const layout = structuredClone(createSampleAirport());
    for (const f of Object.values(layout.facilities)) if (f.kind === 'fuelFarm') delete layout.facilities[f.id];
    const detail = turnaroundCapacityDetail(createContext(layout));
    expect(detail.capacity).toBe(0);
    expect(detail.gates.map((g) => g.kind)).toContain('fuelFarm');
  });
});
