import { describe, expect, it } from 'vitest';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { classifyPaxConnection } from '../../src/core/terminal/route';
import { addTerminalTransitLink, placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import type { AirportLayout, BuildState } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * 5-13: 旅客接続の3状態判定。
 * operational（今通れる）/ underConstruction（建設中リンクが完成すれば通れる）/ unreachable。
 * planned は完成待ちに含めない。運用中の迂回路があれば operational を優先する。
 */
function terminalWithLobby(layout: AirportLayout, x: number, name: string) {
  const placed = must(placeFacility(layout, 'terminal', { x, y: 2 }, { name }));
  const t = placed.created[0]!;
  const withArea = must(placeTerminalArea(placed.layout, t, 0, 'departureLobby', { x, y: 2 }));
  return { layout: withArea.layout, terminal: t, area: withArea.created[0]! };
}

function setup(linkStates: BuildState[]) {
  let l = emptyLayout(120, 60);
  const a = terminalWithLobby(l, 2, 'A');
  l = a.layout;
  const b = terminalWithLobby(l, 35, 'B');
  l = b.layout;
  const c = terminalWithLobby(l, 68, 'C');
  l = c.layout;
  const pairs: [string, string][] = [[a.area, b.area], [b.area, c.area]];
  linkStates.forEach((state, i) => {
    l = must(addTerminalTransitLink(l, {
      kind: 'walkway', fromAreaId: pairs[i]![0], toAreaId: pairs[i]![1],
      distanceM: 100, travelSec: 60, bidirectional: true,
      allowedZones: ['departure'], buildState: state,
    })).layout;
  });
  return { layout: l, from: a.area, mid: b.area, to: c.area };
}

const classify = (l: AirportLayout, from: string, goal: string) =>
  classifyPaxConnection(
    buildTerminalModel(l),
    buildTerminalModel(l, { includeUnderConstruction: true }),
    { from, goals: new Map([[goal, 0]]) },
  );

describe('5-13 旅客接続の3状態判定', () => {
  it('運用中リンクで到達できれば operational', () => {
    const { layout, from, mid } = setup(['operational']);
    const r = classify(layout, from, mid);
    expect(r.status).toBe('operational');
    expect(r.route).not.toBeNull();
    expect(r.futureRoute).toBeNull();
  });

  it('建設中リンクを含めれば到達できる場合は underConstruction（実経路は返さない）', () => {
    const { layout, from, mid } = setup(['underConstruction']);
    const r = classify(layout, from, mid);
    expect(r.status).toBe('underConstruction');
    expect(r.route).toBeNull();
    expect(r.futureRoute).not.toBeNull();
  });

  it('建設中リンクを2本連続で通る場合も underConstruction', () => {
    const { layout, from, to } = setup(['underConstruction', 'underConstruction']);
    expect(classify(layout, from, to).status).toBe('underConstruction');
  });

  it('planned のみの接続は完成待ちにせず unreachable', () => {
    const { layout, from, mid } = setup(['planned']);
    expect(classify(layout, from, mid).status).toBe('unreachable');
  });

  it('リンクがなければ unreachable、途中で切れた建設中経路も unreachable', () => {
    const none = setup([]);
    expect(classify(none.layout, none.from, none.mid).status).toBe('unreachable');
    const broken = setup(['underConstruction']);
    expect(classify(broken.layout, broken.from, broken.to).status).toBe('unreachable');
  });

  it('運用中の迂回路があれば、建設中リンクがあっても operational を優先', () => {
    // A-B が建設中でも A-B の別リンク（運用中）があれば operational
    let { layout, from, mid } = setup(['underConstruction']);
    layout = must(addTerminalTransitLink(layout, {
      kind: 'movingWalkway', fromAreaId: from, toAreaId: mid,
      distanceM: 150, travelSec: 90, bidirectional: true,
      allowedZones: ['departure'], buildState: 'operational',
    })).layout;
    expect(classify(layout, from, mid).status).toBe('operational');
  });

  it('既定のモデル構築は従来どおり operational のみ（建設中リンクは現在経路に入らない）', () => {
    const { layout, from, mid } = setup(['underConstruction']);
    const current = buildTerminalModel(layout);
    expect(current.links[from] ?? []).toEqual([]);
    const future = buildTerminalModel(layout, { includeUnderConstruction: true });
    expect((future.links[from] ?? []).length).toBeGreaterThan(0);
    void mid;
  });
});
