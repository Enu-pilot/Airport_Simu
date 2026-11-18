import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { addPortal, placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import { analyzeLayout } from '../../src/core/validation/validate';
import type { AirportLayout, BuildState } from '../../src/core/model/types';
import { must } from './helpers';

/**
 * 5-16 T4: ポータル施設の接続状態（複合グラフの3状態）を構造検証へ接続する。
 * 運用中なら何も出さず、建設中でのみ届く場合は PORTAL_CONNECTION_PENDING（情報）、
 * 完成後も届かない場合は PORTAL_UNREACHABLE（警告）を出す。
 */
function layoutWithPortal(portalState: BuildState, target: 'entrance' | 'isolated') {
  let l: AirportLayout = createStarterAirfield();
  l = must(placeFacility(l, 'busTerminal', { x: 36, y: 58 })).layout;
  const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
  let areaId: string;
  if (target === 'entrance') {
    areaId = Object.values(l.terminalAreas).find((a) => a.kind === 'entrance')!.id;
  } else {
    // 入口とつながらない別ターミナルの待合（到達不能の対象）
    const t2 = must(placeFacility(l, 'terminal', { x: 15, y: 20 }, { name: 'B' }));
    l = t2.layout;
    const w = must(placeTerminalArea(l, t2.created[0]!, 0, 'waiting', { x: 15, y: 20 }));
    l = w.layout;
    areaId = w.created[0]!;
  }
  l = must(addPortal(l, { facilityId: bt.id, areaId })).layout;
  if (portalState !== 'operational') {
    const p = Object.values(l.portals!)[0]!;
    l = { ...l, portals: { [p.id]: { ...p, buildState: portalState } } };
  }
  return l;
}

const codes = (l: AirportLayout) => analyzeLayout(l).issues.map((i) => i.code);

describe('5-16 T4 ポータル接続状態の検証診断', () => {
  it('運用中ポータルでは新しい診断は出ない', () => {
    const cs = codes(layoutWithPortal('operational', 'entrance'));
    expect(cs).not.toContain('PORTAL_CONNECTION_PENDING');
    expect(cs).not.toContain('PORTAL_UNREACHABLE');
  });
  it('建設中ポータルは完成待ち（情報）になり、未接続警告は出ない', () => {
    const l = layoutWithPortal('underConstruction', 'entrance');
    const cs = codes(l);
    expect(cs).toContain('PORTAL_CONNECTION_PENDING');
    expect(cs).not.toContain('PORTAL_UNREACHABLE');
    expect(analyzeLayout(l).issues.find((i) => i.code === 'PORTAL_CONNECTION_PENDING')?.severity).toBe('info');
  });
  it('孤立したエリアへのポータルは未接続（警告）になる', () => {
    const cs = codes(layoutWithPortal('operational', 'isolated'));
    expect(cs).toContain('PORTAL_UNREACHABLE');
    expect(cs).not.toContain('PORTAL_CONNECTION_PENDING');
  });
});
