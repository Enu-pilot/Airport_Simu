import { describe, expect, it } from 'vitest';
import { checkGate, airportUnits } from '../../src/core/aircraft/compat';
import { dailyFixedCosts } from '../../src/core/economy/ops';
import { facilityValue } from '../../src/core/economy/construction';
import { createContext } from '../../src/core/sim/context';
import { resolveType } from '../../src/core/sim/aircraftTypes';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { analyzeLayout } from '../../src/core/validation/validate';
import type { AirportLayout } from '../../src/core/model/types';

/** 12B-3a A4: 文脈・互換・経済・検証へのバスゲート/ランプバスの反映（バスがなければ従来と同一） */
const gates = (l: AirportLayout) => Object.values(l.facilities).filter((f) => f.kind === 'gate');
const base = (l: AirportLayout) => Object.values(l.facilities).find((f) => f.kind === 'gseBase')!;
function busLayout(buses = 2): AirportLayout {
  const l = createSampleAirport();
  const g = gates(l)[0]!;
  g.props.boardingMode = 'bus';
  g.props.standId = null;
  g.props.jetBridge = false;
  base(l).props.apronBuses = buses;
  return l;
}

describe('バスゲート・ランプバスの文脈', () => {
  it('従来のレイアウト: busGates は空、基地にランプバスのキーなし', () => {
    const ctx = createContext(createSampleAirport());
    expect(ctx.busGates).toEqual([]);
    for (const b of ctx.bases) expect('apronBus' in b.units).toBe(false);
    expect('apronBus' in airportUnits(createSampleAirport())).toBe(false);
  });

  it('バスゲートは busGates に入り、contact・standGate から外れる。スポットがリモートになる', () => {
    const l = busLayout();
    const gid = gates(l)[0]!.id;
    const std1 = createSampleAirport();
    const oldStand = gates(std1)[0]!.props.standId as string;
    // 元のゲートは std_1 に紐付いていたが、バスゲートに切り替えたので std_1 はリモート
    const ctx = createContext({ ...l, facilities: { ...l.facilities, [gid]: { ...l.facilities[gid]!, props: { ...l.facilities[gid]!.props, standId: oldStand } } } });
    expect(ctx.busGates).toEqual([gid]);
    expect(ctx.stands[oldStand]!.contact).toBe(false);
    expect(ctx.standGate[oldStand]).toBeUndefined();
    expect(ctx.bases.find((b) => b.id === base(l).id)!.units.apronBus).toBe(2);
  });

  it('建設中のバスゲートは busGates に入らない', () => {
    const l = busLayout();
    gates(l)[0]!.buildState = 'planned';
    expect(createContext(l).busGates).toEqual([]);
  });
});

describe('経済・互換', () => {
  it('ランプバスの購入費 250,000 とバス台数 0 の基地は従来と同じ資産額', () => {
    const l = createSampleAirport();
    const b = base(l);
    const v0 = facilityValue(b);
    b.props.apronBuses = 0;
    expect(facilityValue(b)).toBe(v0);
    b.props.apronBuses = 2;
    expect(facilityValue(b)).toBe(v0 + 500_000);
  });

  it('日次の固定費: バス 2 台で給与 3,000 + 維持費 600 が増え、0 台なら従来と同じ', () => {
    const base0 = dailyFixedCosts(createContext(createSampleAirport()));
    const withBus = dailyFixedCosts(createContext(busLayout(2)));
    expect(withBus.salary! - base0.salary!).toBe(3_000);
    expect(withBus.vehicles! - base0.vehicles!).toBe(600);
    const zero = createSampleAirport();
    base(zero).props.apronBuses = 0;
    expect(dailyFixedCosts(createContext(zero))).toEqual(base0);
  });

  it('checkGate: バスゲートは運用中なら適合（理由 GATE_BUS）、スポット不要', () => {
    const l = busLayout();
    const ctx = createContext(l);
    const t = resolveType(ctx.types, 'narrow180');
    expect(checkGate(t, gates(l)[0]!, l)).toEqual({ id: gates(l)[0]!.id, status: 'ok', reasons: ['GATE_BUS'] });
    expect(checkGate(t, gates(l)[1]!, l).reasons).not.toContain('GATE_BUS');
  });
});

describe('検証コード', () => {
  const codes = (l: AirportLayout, id: string) => (analyzeLayout(l).byTarget[id] ?? []).map((i) => i.code);
  it('バスゲートに GATE_NO_STAND は出ない。バスなしなら GATE_BUS_NO_VEHICLES、リモートスポットなしなら BUS_GATE_NO_REMOTE_STAND、standId があれば GATE_BUS_HAS_STAND', () => {
    const l = busLayout(0);
    const gid = gates(l)[0]!.id;
    expect(codes(l, gid)).not.toContain('GATE_NO_STAND');
    expect(codes(l, gid)).toContain('GATE_BUS_NO_VEHICLES');
    const l2 = busLayout(2);
    expect(codes(l2, gid)).not.toContain('GATE_BUS_NO_VEHICLES');
    // サンプルのスポットのうち 1 つはバスゲートに切り替えたのでリモート → 注意は出ない
    expect(codes(l2, gid)).not.toContain('BUS_GATE_NO_REMOTE_STAND');
    l2.facilities[gid]!.props.standId = Object.keys(l2.stands)[0]!;
    expect(codes(l2, gid)).toContain('GATE_BUS_HAS_STAND');
  });
});
