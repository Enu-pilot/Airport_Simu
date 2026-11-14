import { describe, expect, it } from 'vitest';
import { findTerminalTransferRoute } from '../../src/core/terminal/interTerminal';
import { addTerminalTransitLink, placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { emptyLayout, must } from './helpers';

function twoTerminals() {
  let layout = emptyLayout(80, 60);
  const placedT1 = must(placeFacility(layout, 'terminal', { x: 2, y: 2 }, { name: 'Terminal A' }));
  layout = placedT1.layout;
  const t1 = placedT1.created[0]!;
  layout = must(placeFacility(layout, 'terminal', { x: 35, y: 2 }, { name: 'Terminal B' })).layout;
  const t2 = Object.values(layout.facilities).find((f) => f.name === 'Terminal B')!.id;
  const placedA = must(placeTerminalArea(layout, t1, 0, 'departureLobby', { x: 2, y: 2 }));
  layout = placedA.layout;
  const a1 = placedA.created[0]!;
  layout = must(placeTerminalArea(layout, t2, 0, 'departureLobby', { x: 35, y: 2 })).layout;
  const a2 = Object.values(layout.terminalAreas).find((a) => a.terminalId === t2)!.id;
  return { layout, t1, t2, a1, a2 };
}

describe('ターミナル間連絡設備', () => {
  it('既存のエリア間を双方向・片方向の徒歩経路として探索し、利用区域を守る', () => {
    const { layout: base, a1, a2 } = twoTerminals();
    const layout = must(addTerminalTransitLink(base, {
      kind: 'movingWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 240, travelSec: 90,
      capacityPerHour: 1200, bidirectional: false, allowedZones: ['departure'],
    })).layout;
    const forward = findTerminalTransferRoute(layout, { fromAreaId: a1, toAreaId: a2, zone: 'departure' });
    expect(forward).toMatchObject({ areas: [a1, a2], travelSec: 90, distanceM: 240, capacityPerHour: 1200 });
    expect(findTerminalTransferRoute(layout, { fromAreaId: a2, toAreaId: a1, zone: 'departure' })).toBeNull();
    expect(findTerminalTransferRoute(layout, { fromAreaId: a1, toAreaId: a2, zone: 'arrival' })).toBeNull();
    expect(findTerminalTransferRoute(layout, { fromAreaId: a1, toAreaId: a2, zone: 'departure', uncleared: true })).toBeNull();
  });

  it('建設中リンクは利用せず、接続データを保存・復元する', () => {
    const { layout: base, a1, a2 } = twoTerminals();
    const layout = must(addTerminalTransitLink(base, {
      kind: 'walkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 80,
      allowedZones: ['departure'], buildState: 'underConstruction',
    })).layout;
    expect(findTerminalTransferRoute(layout, { fromAreaId: a1, toAreaId: a2, zone: 'departure' })).toBeNull();
    const restored = importLayout(exportLayout(layout));
    expect(restored.terminalLinks).toEqual(layout.terminalLinks);
  });

  it('保安区域をまたぐリンクと同一ターミナル内のリンクは作れない', () => {
    const { layout: base, t1, a1, a2 } = twoTerminals();
    const sameTerminal = must(placeTerminalArea(base, t1, 0, 'waiting', { x: 20, y: 20 })).layout;
    expect(addTerminalTransitLink(base, { kind: 'walkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 80, allowedZones: ['landside'] })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    const sameTerminalArea = Object.values(sameTerminal.terminalAreas).find((area) => area.terminalId === t1 && area.id !== a1)!;
    expect(addTerminalTransitLink(sameTerminal, { kind: 'walkway', fromAreaId: a1, toAreaId: sameTerminalArea.id, distanceM: 100, travelSec: 80, allowedZones: ['departure'] })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
});
