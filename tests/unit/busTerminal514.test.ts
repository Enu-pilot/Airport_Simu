import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { placeFacility } from '../../src/core/layout/operations';
import { FACILITY_SPECS, PROP_SCHEMAS, DEFAULT_PROPS } from '../../src/core/model/catalog';
import { CATALOG_RAW, validateCatalog } from '../../src/core/data/index';
import { analyzeAccess } from '../../src/core/access/model';
import { facilityValue } from '../../src/core/economy/construction';
import { dailyFixedCosts } from '../../src/core/economy/ops';
import { createContext } from '../../src/core/sim/context';
import { BALANCE } from '../../src/core/economy/balance';
import { must } from './helpers';

/**
 * 5-14 T5: バスターミナル（busTerminal）を独立施設として追加する。
 * 既存の busStop は残し、両方がバスアクセスとして合算される。
 * 内部施設（parentFacilityId あり）はアクセス能力に加算されない（T6 の原則）。
 */
describe('5-14 T5 バスターミナル', () => {
  it('カタログに種別・仕様・既定 props があり、カタログ検証が通る', () => {
    expect(FACILITY_SPECS.busTerminal.layer).toBe('building');
    expect(PROP_SCHEMAS.busTerminal.map((p) => p.key)).toEqual(['berths', 'busesPerHour']);
    expect(DEFAULT_PROPS.busTerminal).toEqual({ berths: 4, busesPerHour: 12 });
    expect(validateCatalog(CATALOG_RAW)).toEqual([]);
  });

  it('道路に接したバスターミナルがバス手段として使え、容量はバースで頭打ちになる', () => {
    let l = createStarterAirfield();
    l = must(placeFacility(l, 'busTerminal', { x: 36, y: 58 })).layout;
    const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
    const a = analyzeAccess(l);
    expect(a.modes.bus.available).toBe(true);
    expect(a.modes.bus.facilities).toContain(bt.id);
    // min(busesPerHour=12, berths=4 × 6/バース) = 12 便/時
    expect(a.modes.bus.capacityPerHour).toBe(12 * BALANCE.accessModel.busSeats);
  });

  it('busStop と併設すると便数が合算される', () => {
    let l = createStarterAirfield();
    l = must(placeFacility(l, 'busStop', { x: 30, y: 58 })).layout;
    const onlyStop = analyzeAccess(l).modes.bus.capacityPerHour!;
    l = must(placeFacility(l, 'busTerminal', { x: 36, y: 58 })).layout;
    const both = analyzeAccess(l).modes.bus.capacityPerHour!;
    // busStop: min(4, 2×6)=4 便、busTerminal: 12 便 → 合計 16 便分増える
    expect(both - onlyStop).toBe(12 * BALANCE.accessModel.busSeats);
  });

  it('建設費と日次運営費がアクセス施設として計上される', () => {
    const before = createStarterAirfield();
    const l = must(placeFacility(before, 'busTerminal', { x: 36, y: 58 })).layout;
    const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
    expect(facilityValue(bt)).toBe(BALANCE.construction.access.busTerminal);
    const without = dailyFixedCosts(createContext(before)).accessOps ?? 0;
    const withBt = dailyFixedCosts(createContext(l)).accessOps ?? 0;
    expect(withBt - without).toBe(BALANCE.daily.access.busTerminal);
  });
});
