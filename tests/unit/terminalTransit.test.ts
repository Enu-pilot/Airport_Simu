import { describe, expect, it } from 'vitest';
import { findTerminalTransferRoute } from '../../src/core/terminal/interTerminal';
import { terminalTransitStatus } from '../../src/core/terminal/transitStatus';
import { buildTerminalModel } from '../../src/core/terminal/model';
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
  it('運行画面向けに今時間帯の予約人数と能力待ち人数を集計する', () => {
    const { layout: base, a1, a2 } = twoTerminals();
    const layout = must(addTerminalTransitLink(base, {
      kind: 'movingWalkway',
      fromAreaId: a1,
      toAreaId: a2,
      distanceM: 240,
      travelSec: 90,
      capacityPerHour: 1200,
      bidirectional: true,
      allowedZones: ['departure'],
    })).layout;
    const linkId = Object.keys(layout.terminalLinks!)[0]!;
    const status = terminalTransitStatus(
      layout,
      buildTerminalModel(layout),
      { hour: 3, passengersByLink: { [linkId]: 900 } },
      { [linkId]: 12 },
    );
    expect(status).toEqual([expect.objectContaining({
      id: linkId,
      fromTerminalId: Object.values(layout.terminalAreas).find((area) => area.id === a1)!.terminalId,
      toTerminalId: Object.values(layout.terminalAreas).find((area) => area.id === a2)!.terminalId,
      capacityPerHour: 1200,
      reservedThisHour: 900,
      waitingPax: 12,
      buildState: 'operational',
    })]);
  });

  it('ターミナル内のエレベーターも階層移動能力と待機人数を表示対象にする', () => {
    let layout = emptyLayout(30, 30);
    layout = must(placeFacility(layout, 'terminal', { x: 2, y: 2 }, { w: 12, h: 8, props: { levels: 2 } })).layout;
    const terminalId = Object.values(layout.facilities).find((facility) => facility.kind === 'terminal')!.id;
    layout = must(placeTerminalArea(layout, terminalId, 0, 'hall', { x: 5, y: 5 }, { w: 1, h: 1 })).layout;
    layout = must(placeTerminalArea(layout, terminalId, 1, 'hall', { x: 6, y: 5 }, { w: 1, h: 1 })).layout;
    layout = must(placeTerminalArea(layout, terminalId, 0, 'elevator', { x: 6, y: 5 }, {
      w: 1,
      h: 1,
      props: { capacityPerHour: 90 },
    })).layout;
    const elevator = Object.values(layout.terminalAreas).find((area) => area.kind === 'elevator')!;
    const transportId = `vertical:${elevator.id}`;
    const status = terminalTransitStatus(
      layout,
      buildTerminalModel(layout),
      { hour: 3, passengersByLink: { [transportId]: 70 } },
      { [transportId]: 5 },
    );
    expect(status).toEqual([expect.objectContaining({
      id: transportId,
      capacityPerHour: 90,
      reservedThisHour: 70,
      waitingPax: 5,
    })]);
  });

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

  it('段差なし経路では階段エリアを端点とするターミナル間リンクも利用しない', () => {
    const { layout: base, t1, a2 } = twoTerminals();
    const placed = must(placeTerminalArea(base, t1, 0, 'stairs', { x: 20, y: 8 }, { zone: 'departure', w: 1, h: 1 }));
    const stairs = placed.created[0]!;
    const layout = must(addTerminalTransitLink(placed.layout, {
      kind: 'walkway',
      fromAreaId: stairs,
      toAreaId: a2,
      distanceM: 100,
      travelSec: 30,
      allowedZones: ['departure'],
    })).layout;
    expect(findTerminalTransferRoute(layout, { fromAreaId: stairs, toAreaId: a2, zone: 'departure' })).not.toBeNull();
    expect(findTerminalTransferRoute(layout, { fromAreaId: stairs, toAreaId: a2, zone: 'departure', stepFree: true })).toBeNull();
  });

  it('保安区域をまたぐリンクと同一ターミナル内のリンクは作れない', () => {
    const { layout: base, t1, a1, a2 } = twoTerminals();
    const sameTerminal = must(placeTerminalArea(base, t1, 0, 'waiting', { x: 20, y: 20 })).layout;
    expect(addTerminalTransitLink(base, { kind: 'walkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 80, allowedZones: ['landside'] })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    const sameTerminalArea = Object.values(sameTerminal.terminalAreas).find((area) => area.terminalId === t1 && area.id !== a1)!;
    expect(addTerminalTransitLink(sameTerminal, { kind: 'walkway', fromAreaId: a1, toAreaId: sameTerminalArea.id, distanceM: 100, travelSec: 80, allowedZones: ['departure'] })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
});
