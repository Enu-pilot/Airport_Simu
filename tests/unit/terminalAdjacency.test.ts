import { describe, expect, it } from 'vitest';
import { placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { terminalServiceComplexes } from '../../src/core/terminal/serviceComplex';
import { findTerminalTransferRoute } from '../../src/core/terminal/interTerminal';
import { emptyLayout, must } from './helpers';

/**
 * ターミナル隣接の自動接続: 異なるターミナルのエリア同士が同レベルで辺を共有していれば、
 * 明示リンクが無くても接続し、同じサービス複合体になる（隣り合う建物は 1 つの建物とみなす）。
 */
function adjacentTerminals(t2x: number) {
  let layout = emptyLayout(80, 60);
  layout = must(placeFacility(layout, 'terminal', { x: 2, y: 2 }, { w: 10, h: 6, name: 'Terminal A' })).layout;
  const t1 = Object.values(layout.facilities).find((f) => f.name === 'Terminal A')!.id;
  layout = must(placeFacility(layout, 'terminal', { x: t2x, y: 2 }, { w: 10, h: 6, name: 'Terminal B' })).layout;
  const t2 = Object.values(layout.facilities).find((f) => f.name === 'Terminal B')!.id;
  layout = must(placeTerminalArea(layout, t1, 0, 'departureLobby', { x: 2, y: 2 }, { w: 10, h: 2 })).layout;
  const a1 = Object.values(layout.terminalAreas).find((a) => a.terminalId === t1)!.id;
  layout = must(placeTerminalArea(layout, t2, 0, 'departureLobby', { x: t2x, y: 2 }, { w: 10, h: 2 })).layout;
  const a2 = Object.values(layout.terminalAreas).find((a) => a.terminalId === t2)!.id;
  return { layout, t1, t2, a1, a2 };
}

describe('ターミナル隣接の自動接続', () => {
  it('辺を共有するエリア同士はリンク無しで相互に接続する', () => {
    const { layout, a1, a2 } = adjacentTerminals(12);
    const model = buildTerminalModel(layout);
    expect(model.links[a1]!.some((l) => l.to === a2)).toBe(true);
    expect(model.links[a2]!.some((l) => l.to === a1)).toBe(true);
  });

  it('隣接するターミナルは同じサービス複合体になる', () => {
    const { layout, t1, t2 } = adjacentTerminals(12);
    const complexes = terminalServiceComplexes(layout);
    expect(complexes.get(t1)).toContain(t2);
    expect(complexes.get(t2)).toContain(t1);
  });

  it('隣接していれば明示リンク無しでターミナル間経路が引ける', () => {
    const { layout, a1, a2 } = adjacentTerminals(12);
    const route = findTerminalTransferRoute(layout, { fromAreaId: a1, toAreaId: a2, zone: 'departure' });
    expect(route).not.toBeNull();
    expect(route!.connectionIds).toEqual([]);
  });

  it('離れているターミナルは接続せず複合体も分かれる（従来どおり）', () => {
    const { layout, t1, t2, a1, a2 } = adjacentTerminals(40);
    const model = buildTerminalModel(layout);
    expect(model.links[a1]!.some((l) => l.to === a2)).toBe(false);
    const complexes = terminalServiceComplexes(layout);
    expect(complexes.get(t1)).not.toContain(t2);
    expect(findTerminalTransferRoute(layout, { fromAreaId: a1, toAreaId: a2, zone: 'departure' })).toBeNull();
  });
});
