import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { addPortal, placeFacility } from '../../src/core/layout/operations';
import { connectionMatrix } from '../../src/core/terminal/connectionMatrix';
import { must } from './helpers';

describe('5-18 接続マトリクス', () => {
  it('Portal のあるバスターミナルは入口方向が接続済み、Portal がなければ noPortal と明示される', () => {
    let l = createStarterAirfield();
    l = must(placeFacility(l, 'busTerminal', { x: 36, y: 58 })).layout;
    const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
    const entrance = Object.values(l.terminalAreas).find((a) => a.kind === 'entrance')!;
    const exit = Object.values(l.terminalAreas).find((a) => a.kind === 'exit')!;

    const before = connectionMatrix(l).find((r) => r.facilityId === bt.id)!;
    expect(before.mode).toBe('bus');
    expect(before.toEntrance).toBe('noPortal');
    expect(before.fromExit).toBe('noPortal');

    l = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
    l = must(addPortal(l, { facilityId: bt.id, areaId: exit.id })).layout;
    const after = connectionMatrix(l).find((r) => r.facilityId === bt.id)!;
    expect(after.toEntrance).toBe('operational');
    expect(after.fromExit).toBe('operational');
  });

  it('交通施設がないレイアウトでは行が空になる', () => {
    const rows = connectionMatrix(createStarterAirfield());
    expect(rows.every((r) => ['railStation', 'busTerminal', 'busStop', 'taxiStand', 'parking'].includes(r.kind))).toBe(true);
  });
});
