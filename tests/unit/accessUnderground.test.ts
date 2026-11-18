import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { analyzeAccess } from '../../src/core/access/model';
import { buildLandsideNetwork } from '../../src/core/access/landside';
import { analyzeLayout } from '../../src/core/validation/validate';
import { placeFacility } from '../../src/core/layout/operations';
import type { AirportLayout } from '../../src/core/model/types';
import { must } from './helpers';

/**
 * 地下の道路・鉄道と敷地外接続の判定／表示の一致（docs/15 §1）。
 *
 * 仕様: 敷地外周への到達は道路・鉄道とも階層を問わない（地下トンネル状の出入口も外部接続）。
 * ただし階層が変わる区間は接続設備（ランプ等）があるものだけを通し、施設は自分の階層の
 * 道路タイルに接していないと使えない。検証（analyzeLayout）と旅客ルート判定
 * （analyzeAccess / buildLandsideNetwork）が同じ結論になることを固定する。
 */

/** スターター飛行場の出入口（南端 y=105 へ出る一般道路 rd_2）を、
 *  「地下区間が外周に届き、ランプで地上道路へ上がる」形に作り替える（実セーブ mainplay1 と同じ構成） */
function undergroundEntrance(base: AirportLayout): AirportLayout {
  const l = structuredClone(base);
  // 外周側の端点は地下へ
  l.roadNodes['rn_3']!.level = -1;
  // 地下ノード (76,99,-1) と地上ノード (76,93,0) を挟み、間をランプでつなぐ
  l.roadNodes['rn_6'] = { id: 'rn_6', pos: { x: 76, y: 99 }, name: '', holdShort: true, level: -1 };
  l.roadNodes['rn_7'] = { id: 'rn_7', pos: { x: 76, y: 93 }, name: '', holdShort: true };
  delete l.roads['rd_2'];
  l.roads['rd_2a'] = { id: 'rd_2a', name: '空港通り', roadClass: 'public', oneWay: false, buildState: 'operational', from: 'rn_2', to: 'rn_7' };
  l.roads['rd_2b'] = { id: 'rd_2b', name: '空港通り', roadClass: 'public', oneWay: false, buildState: 'operational', from: 'rn_6', to: 'rn_3' };
  l.roads['rd_2r'] = { id: 'rd_2r', name: 'ramp', roadClass: 'public', oneWay: false, buildState: 'operational', from: 'rn_7', to: 'rn_6', connectorKind: 'ramp' };
  return l;
}

const codesFor = (l: AirportLayout, id: string) => analyzeLayout(l).byTarget[id]?.map((i) => i.code) ?? [];
const allCodes = (l: AirportLayout) => analyzeLayout(l).issues.map((i) => i.code);

describe('地下の道路と敷地外接続', () => {
  const base = createStarterAirfield();

  it('地下区間が外周に届きランプで地上へ上がる道路は「出入口」になり、駐車場・車寄せが使える（判定と表示が一致）', () => {
    const l = undergroundEntrance(base);
    const net = buildLandsideNetwork(l);
    expect(net.entryRoads).toEqual(['rd_2b']); // 外周に届くのは地下区間だけ
    const a = analyzeAccess(l);
    expect(a.entrances).toBe(1);
    expect(a.modes.car.available).toBe(true);
    expect(a.parkingSpaces).toBe(200);
    expect(a.modes.dropoff.available).toBe(true);
    // 検証側も同じ結論: 出入口なし警告も、駐車場の未接続警告も出ない
    expect(allCodes(l)).not.toContain('ROAD_NO_ENTRANCE');
    expect(codesFor(l, 'fac_12')).not.toContain('ACCESS_NOT_CONNECTED');
  });

  it('地下区間が外周に届いても、ランプが無ければ地上の施設は使えない（階層の規律は維持）', () => {
    const l = structuredClone(base);
    // 出入口区間の両端を地下にする: 地下としては外周に届くが、地上網とは階層が合わず接続設備もない
    l.roadNodes['rn_2']!.level = -1;
    l.roadNodes['rn_3']!.level = -1;
    const a = analyzeAccess(l);
    expect(a.modes.car.available).toBe(false);
    expect(a.modes.car.reason).toBe('notConnected');
    // 表示も一致: 駐車場に未接続の警告が出て、地上網の成分（rd_1）には出入口なしの警告が出る
    // （地下区間の成分は外周に届いているので、警告の対象は地上側の成分だけ）
    expect(codesFor(l, 'fac_12')).toContain('ACCESS_NOT_CONNECTED');
    const noEntrance = analyzeLayout(l).issues.filter((i) => i.code === 'ROAD_NO_ENTRANCE');
    expect(noEntrance.map((i) => i.targets)).toEqual([['rd_1']]);
  });

  it('未接続の駐車場には検証警告が出て、旅客ルート判定でも使われない', () => {
    const placed = must(placeFacility(base, 'parking', { x: 30, y: 64 }, { props: { spaces: 50 } }));
    const l = placed.layout;
    const id = placed.created[0]!;
    expect(codesFor(l, id)).toContain('ACCESS_NOT_CONNECTED');
    const a = analyzeAccess(l);
    expect(a.modes.car.facilities).not.toContain(id);
    expect(a.parkingSpaces).toBe(200); // 使えるのは既存の駐車場だけ
  });

  it('工事中の道路は出入口として数えない（判定と表示が一致）', () => {
    const l = structuredClone(base);
    l.roads['rd_2']!.buildState = 'underConstruction';
    expect(analyzeAccess(l).entrances).toBe(0);
    expect(allCodes(l)).toContain('ROAD_NO_ENTRANCE');
  });

  it('実セーブ mainplay1（地下道路→ランプ→地上道路）: 車・バスが使え、アクセス警告が出ない', () => {
    const raw = JSON.parse(readFileSync('/home/hatch/workspace/user/files/skyport-mainplay1-20261118-1842.skyport.json', 'utf8'));
    const layout = raw.layout as AirportLayout;
    const a = analyzeAccess(layout, { city: raw.company.city, day: raw.company.day });
    expect(a.entrances).toBe(1);
    expect(a.modes.car.available).toBe(true);
    expect(a.parkingSpaces).toBe(10000);
    expect(a.modes.bus.available).toBe(true);
    expect(a.busesPerHour).toBe(4);
    expect(a.factor).toBeGreaterThan(1);
    const codes = allCodes(layout);
    expect(codes).not.toContain('ACCESS_NOT_CONNECTED');
    expect(codes).not.toContain('ROAD_NO_ENTRANCE');
  });
});
