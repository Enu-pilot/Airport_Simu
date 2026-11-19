import { describe, expect, it } from 'vitest';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { addRoadPath, placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import { analyzeAccess } from '../../src/core/access/model';
import { findStationTerminalAccess } from '../../src/core/access/verticalWalk';
import { adjacentTerminalAreas } from '../../src/core/terminal/adjacency';
import { classifyFacilityConnection } from '../../src/core/terminal/networkGraph';
import { analyzeLayout } from '../../src/core/validation/validate';
import type { AirportLayout } from '../../src/core/model/types';
import { must } from './helpers';

/**
 * 同一階層での辺接触による駅の連絡扱い（隣接連絡）。
 *
 * 仕様: 交通施設がターミナルエリアと「同じ地図階層」で「辺を共有して」接していれば、
 * ポータルや旅客連絡通路が無くてもターミナルに連絡しているものとして扱う。
 * 階層が違う・1タイル離れている・角だけの接触は対象外。
 * 旅客ルート判定（analyzeAccess）と検証（analyzeLayout）が同じ結論になることを固定する。
 *
 * 配置（スターター飛行場のターミナル (46,49) 20×8 の北西）:
 * - 地下エリア: 到着通路（地上階）の真下に地下階エスカレーター (46,49) 3×2 を置く
 * - 地下駅: (41,46) 6×3、mapLevel -1。東端のタイル (46,48) が地下エリア (46,49) と辺で接する
 * - 地下線路: y=48 を敷地端 (x=0) から駅の西 (x=39) まで、階層 -1 で引く
 */

interface Built { layout: AirportLayout; stationId: string; terminalId: string; basementAreaId: string | null }

function build(opts: { basement: boolean; stationOrigin: { x: number; y: number }; railEndX: number }): Built {
  let l = createStarterAirfield();
  const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
  let basementAreaId: string | null = null;
  if (opts.basement) {
    const r = must(placeTerminalArea(l, terminal.id, -1, 'escalator', { x: 46, y: 49 }, { w: 3, h: 2, name: '地下連絡' }));
    l = r.layout;
    basementAreaId = r.created[0]!;
  }
  const st = must(placeFacility(l, 'railStation', opts.stationOrigin, { mapLevel: -1, props: { trainsPerHour: 6, level: -1 } }));
  l = st.layout;
  const rail = must(addRoadPath(l, [{ x: 0, y: 48 }, { x: opts.railEndX, y: 48 }], { roadClass: 'rail', level: -1 }));
  l = rail.layout;
  return { layout: l, stationId: st.created[0]!, terminalId: terminal.id, basementAreaId };
}

/** 隣接あり: 駅 (41,46)、線路は駅西端の手前 x=40 まで（駅タイル (41,48) に接する） */
const adjacent = () => build({ basement: true, stationOrigin: { x: 41, y: 46 }, railEndX: 40 });
/** 階層違い: 地下エリアなし。駅は地上階の到着通路と平面では接するが階層が違う */
const levelMismatch = () => build({ basement: false, stationOrigin: { x: 41, y: 46 }, railEndX: 40 });
/** 1タイル離れ: 駅 (39,46)。地下エリアとの間にタイルが空く */
const gap = () => build({ basement: true, stationOrigin: { x: 39, y: 46 }, railEndX: 38 });
/** 角接触のみ: 駅 (40,46)。地下エリアの角 (46,49) と駅タイル (45,48) が斜めに接するだけ */
const cornerOnly = () => build({ basement: true, stationOrigin: { x: 40, y: 46 }, railEndX: 39 });

const codesFor = (l: AirportLayout, id: string) => analyzeLayout(l).byTarget[id]?.map((i) => i.code) ?? [];
const terminalsOf = (l: AirportLayout) => Object.values(l.facilities).filter((f) => f.kind === 'terminal' && f.buildState === 'operational');

describe('同一階層の辺接触による駅の連絡（隣接連絡）', () => {
  it('(a) 地下駅が同階層でターミナルエリアに接すれば、ポータル・連絡通路なしで鉄道が使える', () => {
    const { layout, stationId, basementAreaId } = adjacent();
    const station = layout.facilities[stationId]!;
    // 連絡の根拠は地下エリアへの隣接
    expect(adjacentTerminalAreas(layout, station).map((a) => a.areaId)).toEqual([basementAreaId]);
    const access = findStationTerminalAccess(layout, station, terminalsOf(layout));
    expect(access?.kind).toBe('adjacent');
    // アクセスモデル: 鉄道が有効になり、本数と最小の徒歩（1タイル分）が反映される
    const a = analyzeAccess(layout);
    expect(a.modes.rail.available).toBe(true);
    expect(a.modes.rail.facilities).toContain(stationId);
    expect(a.trainsPerHour).toBe(6);
    expect(a.modes.rail.walkMin).toBe(0.3); // walkMinutes(1) = 25m / 1.2m/s ≈ 0.35分 → 0.3
    // 複合グラフでも入口まで届く（地下エリア → 到着通路 → 受取 → 出口 → 入口）
    const entrance = Object.values(layout.terminalAreas).find((x) => x.kind === 'entrance')!;
    expect(classifyFacilityConnection(layout, stationId, entrance.id).status).toBe('operational');
    const exit = Object.values(layout.terminalAreas).find((x) => x.kind === 'exit')!;
    expect(classifyFacilityConnection(layout, stationId, exit.id).status).toBe('operational');
  });

  it('(b) 平面では接していても階層が違えば未接続のまま', () => {
    const { layout, stationId } = levelMismatch();
    const station = layout.facilities[stationId]!;
    expect(adjacentTerminalAreas(layout, station)).toEqual([]);
    expect(findStationTerminalAccess(layout, station, terminalsOf(layout))).toBeNull();
    const a = analyzeAccess(layout);
    expect(a.modes.rail.available).toBe(false);
    expect(a.modes.rail.reason).toBe('notConnected');
    expect(a.trainsPerHour).toBe(0);
  });

  it('(c) 1タイル離れていれば未接続', () => {
    const { layout, stationId } = gap();
    const station = layout.facilities[stationId]!;
    expect(adjacentTerminalAreas(layout, station)).toEqual([]);
    expect(findStationTerminalAccess(layout, station, terminalsOf(layout))).toBeNull();
    expect(analyzeAccess(layout).modes.rail.available).toBe(false);
  });

  it('(d) 角だけの接触では未接続', () => {
    const { layout, stationId } = cornerOnly();
    const station = layout.facilities[stationId]!;
    expect(adjacentTerminalAreas(layout, station)).toEqual([]);
    expect(findStationTerminalAccess(layout, station, terminalsOf(layout))).toBeNull();
    expect(analyzeAccess(layout).modes.rail.available).toBe(false);
  });

  it('(e) 検証表示が判定と一致する（接続時は未接続警告なし、未接続時は警告あり。線路接続とは別）', () => {
    const okCase = adjacent();
    const okCodes = codesFor(okCase.layout, okCase.stationId);
    expect(okCodes).not.toContain('STATION_NO_RAIL'); // 線路には接している
    expect(okCodes).not.toContain('ACCESS_ROUTE_UNREACHABLE'); // 隣接で届くので出ない

    const badCase = levelMismatch();
    const badCodes = codesFor(badCase.layout, badCase.stationId);
    expect(badCodes).not.toContain('STATION_NO_RAIL'); // 線路接続はある（別の話）
    expect(badCodes).toContain('ACCESS_ROUTE_UNREACHABLE'); // 階層が違い届かない
  });

  it('(f) 隣接していても線路が敷地外へ届いていなければ STATION_NO_RAIL で、鉄道は使えない', () => {
    // 線路を敷地端まで引かない（x=10 止まり）ケース
    let l = createStarterAirfield();
    const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    l = must(placeTerminalArea(l, terminal.id, -1, 'escalator', { x: 46, y: 49 }, { w: 3, h: 2 })).layout;
    const st = must(placeFacility(l, 'railStation', { x: 41, y: 46 }, { mapLevel: -1, props: { trainsPerHour: 6, level: -1 } }));
    l = st.layout;
    l = must(addRoadPath(l, [{ x: 10, y: 48 }, { x: 40, y: 48 }], { roadClass: 'rail', level: -1 })).layout;
    const stationId = st.created[0]!;
    // 隣接そのものは成立しているが、外部接続がないので使えない（隣接は線路接続の代わりにならない）
    expect(adjacentTerminalAreas(l, l.facilities[stationId]!)).toHaveLength(1);
    expect(analyzeAccess(l).modes.rail.available).toBe(false);
    expect(codesFor(l, stationId)).toContain('STATION_NO_RAIL');
  });
});
