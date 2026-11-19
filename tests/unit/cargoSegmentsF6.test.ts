import { describe, expect, it } from 'vitest';
import { placeFacility, updateEntity } from '../../src/core/layout/operations';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { analyzeAccess } from '../../src/core/access/model';
import { accessDeparture } from '../../src/core/access/runtime';
import { addContract, createSandboxCompany, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { createSimulation } from '../../src/core/sim/simulation';
import type { AirportLayout } from '../../src/core/model/types';
import type { PaxGroup } from '../../src/core/sim/types';
import { must } from './helpers';

/**
 * Phase 6 / F6-06（CARGO-05 区間モデル）: 貨物上屋が区間モデルの目的地になり、
 * 貨物トラックの背景交通が貨物経路の辺にだけ重なる。旅客側の区間交通量の記録は汚さない。
 * 集約モデル（access/runtime の road:<hour>）には触れない。
 */
const seg = (l: AirportLayout): AirportLayout => ({ ...l, accessCapacityModel: 'segment' });

function withCargoTerminal(l: AirportLayout): AirportLayout {
  return must(placeFacility(l, 'cargoTerminal', { x: 60, y: 58 })).layout;
}

function edgeWhere(l: AirportLayout, pred: (e: AirportLayout['roads'][string], a: { x: number; y: number }, b: { x: number; y: number }) => boolean): string {
  return Object.values(l.roads).find((e) => pred(e, l.roadNodes[e.from]!.pos, l.roadNodes[e.to]!.pos))!.id;
}
const entranceRoad = (l: AirportLayout): string => edgeWhere(l, (e, a, b) => e.roadClass === 'public' && a.x === 76 && b.x === 76);

describe('CARGO-05 区間モデル統合', () => {
  it('貨物上屋が目的地になり、区間能力と経路が付く', () => {
    const a = analyzeAccess(seg(withCargoTerminal(createStarterAirfield())));
    expect(a.segments).toBeDefined();
    expect(a.segments!.cargoCapacity).toBeGreaterThan(0);
    expect(Object.keys(a.segments!.cargoPaths).length).toBeGreaterThan(0);
  });

  it('貨物上屋がなければ貨物区間能力は 0 で経路なし（従来どおり）', () => {
    const a = analyzeAccess(seg(createStarterAirfield()));
    expect(a.segments!.cargoCapacity).toBe(0);
    expect(a.segments!.cargoPaths).toEqual({});
  });

  it('出入口の区間を細くすると貨物区間能力もその値に制限される', () => {
    const base = withCargoTerminal(createStarterAirfield());
    const narrowed = must(updateEntity(base, entranceRoad(base), { capacityPerHour: 300 })).layout;
    const a = analyzeAccess(seg(narrowed));
    expect(a.segments!.cargoCapacity).toBe(300);
  });

  it('運航: 貨物トラックの背景交通があると、共有区間の道路遅れは単調に増える', () => {
    const layout = seg(withCargoTerminal(createStarterAirfield()));
    const company = (features: CompanyState['features']): CompanyState => {
      const c = createSandboxCompany('cargo-seg');
      c.city = defaultCity('regional');
      c.rating = 80;
      c.features = features;
      c.airlines['NH'] ??= { satisfaction: 60, lowDays: 0 };
      addContract(c, {
        airlineId: 'NH', destinationId: 'TWN', typeId: 'B777F', perDay: 1, window: 'any',
        feeDiscount: 0.1, startDay: 0, endDay: 99, status: 'active', offerExpiresDay: 0, kind: 'cargo',
      });
      return c;
    };
    const group = (id: string): PaxGroup => ({ id, count: 2, walkSec: 0 }) as unknown as PaxGroup;
    const run = (features: CompanyState['features']): number => {
      const sim = createSimulation(layout, { company: company(features) });
      expect(sim.state.access?.segments?.cargoPaths).toBeDefined();
      let last = 0;
      for (let i = 0; i <= 700; i++) last = accessDeparture(sim, group(`g${i}`));
      return last;
    };
    const off = run({});
    const on = run({ cargo: true });
    expect(on).toBeGreaterThanOrEqual(off);
  });
});
