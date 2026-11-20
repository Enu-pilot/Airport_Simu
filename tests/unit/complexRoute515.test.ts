import { describe, expect, it } from 'vitest';
import { addTerminalTransitLink, placeFacility, placeTerminalArea, setFacilityFootprint } from '../../src/core/layout/operations';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { classifyPaxConnection, findPaxRoute } from '../../src/core/terminal/route';
import { deriveTerminalComplexes } from '../../src/core/terminal/complex';
import type { AirportLayout, BuildState } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * 建物間経路: 異なるターミナルのエリア同士が同レベルで辺を共有していれば、明示リンクが
 * 無くても旅客は建物をまたげる（隣り合う建物は 1 つの建物とみなす）。
 * 辺を共有しない建物同士は従来どおり operational な明示リンクだけが通行でき、
 * 区域越境は既存ルールに従う。
 */
function twoTouchingTerminals(withFootprint = false) {
  let l: AirportLayout = emptyLayout(120, 60);
  const a = must(placeFacility(l, 'terminal', { x: 2, y: 2 }, { name: 'A' }));
  l = a.layout;
  const b = must(placeFacility(l, 'terminal', { x: 22, y: 2 }, { name: 'B' }));
  l = b.layout;
  if (withFootprint) {
    // A を L 字形にする（外周リングは直交多角形）。占有タイルが変わっても結論は同じであること
    const ring = [
      { x: 2, y: 2 }, { x: 22, y: 2 }, { x: 22, y: 6 }, { x: 12, y: 6 },
      { x: 12, y: 10 }, { x: 2, y: 10 },
    ];
    l = must(setFacilityFootprint(l, a.created[0]!, ring)).layout;
  }
  const lobbyA = must(placeTerminalArea(l, a.created[0]!, 0, 'departureLobby', { x: 12, y: 2 }, { w: 10, h: 2 }));
  l = lobbyA.layout;
  const lobbyB = must(placeTerminalArea(l, b.created[0]!, 0, 'departureLobby', { x: 22, y: 2 }, { w: 10, h: 2 }));
  l = lobbyB.layout;
  return { l, aId: a.created[0]!, bId: b.created[0]!, lobbyA: lobbyA.created[0]!, lobbyB: lobbyB.created[0]! };
}

/** 辺を共有しない 2 ターミナル（建物もエリアも離れている） */
function twoSeparatedTerminals() {
  let l: AirportLayout = emptyLayout(120, 60);
  const a = must(placeFacility(l, 'terminal', { x: 2, y: 2 }, { name: 'A' }));
  l = a.layout;
  const b = must(placeFacility(l, 'terminal', { x: 32, y: 2 }, { name: 'B' }));
  l = b.layout;
  const lobbyA = must(placeTerminalArea(l, a.created[0]!, 0, 'departureLobby', { x: 12, y: 2 }, { w: 10, h: 2 }));
  l = lobbyA.layout;
  const lobbyB = must(placeTerminalArea(l, b.created[0]!, 0, 'departureLobby', { x: 32, y: 2 }, { w: 10, h: 2 }));
  l = lobbyB.layout;
  return { l, aId: a.created[0]!, bId: b.created[0]!, lobbyA: lobbyA.created[0]!, lobbyB: lobbyB.created[0]! };
}

const route = (l: AirportLayout, from: string, to: string) =>
  findPaxRoute(buildTerminalModel(l), { from, goals: new Map([[to, 0]]) });

describe('建物間経路は隣接または明示リンクに基づく', () => {
  it('辺で接していれば、明示リンクがなくても建物間は到達可能', () => {
    const { l, aId, bId, lobbyA, lobbyB } = twoTouchingTerminals();
    const complexes = deriveTerminalComplexes(l);
    const complexOf = (id: string) => complexes.find((c) => c.buildingIds.includes(id));
    expect(complexOf(aId)).toBeDefined();
    expect(complexOf(aId)).toBe(complexOf(bId)); // 同一複合体
    expect(route(l, lobbyA, lobbyB)).not.toBeNull();
    const cls = classifyPaxConnection(buildTerminalModel(l), buildTerminalModel(l, { includeUnderConstruction: true }), {
      from: lobbyA, goals: new Map([[lobbyB, 0]]),
    });
    expect(cls.status).toBe('operational');
  });

  it('非矩形（L字）建物でも同じ: 辺で接していれば到達可能', () => {
    const { l, lobbyA, lobbyB } = twoTouchingTerminals(true);
    expect(route(l, lobbyA, lobbyB)).not.toBeNull();
  });

  it('離れた建物同士は operational な明示リンクでのみ通行でき、建設中は将来モデルでのみ届く', () => {
    const base = twoSeparatedTerminals();
    expect(route(base.l, base.lobbyA, base.lobbyB)).toBeNull();
    const withLink = (state: BuildState) => must(addTerminalTransitLink(base.l, {
      kind: 'walkway', fromAreaId: base.lobbyA, toAreaId: base.lobbyB, distanceM: 50, travelSec: 30,
      bidirectional: true, allowedZones: ['departure'], buildState: state,
    })).layout;
    expect(route(withLink('operational'), base.lobbyA, base.lobbyB)).not.toBeNull();
    const uc = withLink('underConstruction');
    expect(route(uc, base.lobbyA, base.lobbyB)).toBeNull();
    expect(findPaxRoute(buildTerminalModel(uc, { includeUnderConstruction: true }), { from: base.lobbyA, goals: new Map([[base.lobbyB, 0]]) })).not.toBeNull();
    expect(route(withLink('planned'), base.lobbyA, base.lobbyB)).toBeNull();
  });
});
