import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { addRoadPath, placeFacility } from '../../src/core/layout/operations';
import { facilityLevel } from '../../src/core/model/levels';
import { analyzeAccess } from '../../src/core/access/model';
import { must } from './helpers';

/**
 * 5-14 T4/T6: 階層の優先関係の明文化と、内部施設が能力に加算されない原則の固定。
 * - 地図階層: mapLevel > railStation の props.level > 0
 * - 内部の階は floorIndex が表す
 * - 親に内包された駅・バスターミナルは、明示接続（5-16 のポータル）までアクセス能力に数えない
 */
describe('5-14 T4/T6 階層優先と内部施設の能力', () => {
  it('facilityLevel の優先順位: mapLevel が props.level より優先される', () => {
    const base = createStarterAirfield();
    const l = must(placeFacility(base, 'railStation', { x: 68, y: 58 }, { props: { level: -1 } })).layout;
    const st = Object.values(l.facilities).find((f) => f.kind === 'railStation')!;
    expect(facilityLevel(st)).toBe(-1);
    expect(facilityLevel({ ...st, mapLevel: 2 })).toBe(2);
    expect(facilityLevel({ ...st, mapLevel: undefined, props: {} })).toBe(0);
  });

  it('ターミナル内の駅は鉄道アクセスに加算されない（独立駅は加算される）', () => {
    let l = createStarterAirfield();
    l = must(addRoadPath(l, [{ x: 70, y: 61 }, { x: 70, y: 105 }], { roadClass: 'rail', name: '空港線' })).layout;
    l = must(placeFacility(l, 'railStation', { x: 68, y: 58 })).layout;
    const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    l = must(placeFacility(l, 'railStation', { x: 50, y: 50 }, { parentFacilityId: terminal.id, floorIndex: 0 })).layout;
    const stations = Object.values(l.facilities).filter((f) => f.kind === 'railStation');
    expect(stations).toHaveLength(2);
    const interior = stations.find((f) => f.parentFacilityId === terminal.id)!;
    const a = analyzeAccess(l);
    expect(a.modes.rail.available).toBe(true);
    expect(a.modes.rail.facilities).not.toContain(interior.id);
  });

  it('ターミナル内のバスターミナルはバスアクセスに加算されない', () => {
    let l = createStarterAirfield();
    const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    l = must(placeFacility(l, 'busTerminal', { x: 50, y: 50 }, { parentFacilityId: terminal.id, floorIndex: 0 })).layout;
    const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
    const a = analyzeAccess(l);
    expect(a.modes.bus.facilities).not.toContain(bt.id);
  });
});
