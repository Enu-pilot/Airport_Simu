import { createSite, siteSizeById } from '../model/site';
import type { AirportLayout, FacilityKind, TerminalAreaKind } from '../model/types';
import type { Tile } from '../geometry/vec';
import {
  addRoadPath,
  addTaxiwayPath,
  createEmptyLayout,
  placeFacility,
  placeRunway,
  placeStand,
  placeTerminalArea,
  updateEntity,
  type OpResult,
  type PlaceFacilityOptions,
} from '../layout/operations';
import { findNodeAt } from '../layout/network';

/**
 * 初期サンプル空港。編集操作を順に適用して作るため、操作系の総合的な確認にもなる。
 * 生成結果はエラー・警告なし（tests/unit/sample.test.ts で検証）。
 *
 *   y=30  ════════ 滑走路 09/27（L級, 2875m）════════
 *          │A1        │A2              │A3         │A4
 *   y=38  ─┴──────────┴── 誘導路 A ────┴───────────┴─
 *                │B1                         │B2
 *   y=41  エプロン ┴──── エプロン誘導路 B ─────┴
 *                  [1][2][3][4][5][6][7][8] [L1]  スポット
 *   y=48            ゲート
 *   y=49-56         ターミナル（2階建て。1F 到着・入口、2F 出発）
 *   y=57  ───────── 一般道路 ─────────
 */
export function createSampleAirport(seed = 'skyport', sizeId?: string): AirportLayout {
  const size = sizeId && sizeId !== 'standard' ? siteSizeById(sizeId) : null;
  let layout = createEmptyLayout(createSite({ seed, ...(size ? { width: size.width, height: size.height } : {}) }), 'サンプル空港');
  const run = (r: OpResult): string[] => {
    if (!r.ok) throw new Error(`sample generation failed: ${r.reason}`);
    layout = r.layout;
    return r.created;
  };
  const fac = (kind: FacilityKind, origin: Tile, opts: PlaceFacilityOptions = {}) =>
    run(placeFacility(layout, kind, origin, opts))[0]!;

  run(placeRunway(layout, { x: 20, y: 30 }, 90, 115, { surfaceWidthM: 60, name: '' }));

  // 誘導路 A（平行誘導路）と滑走路への連絡誘導路
  run(addTaxiwayPath(layout, [{ x: 20, y: 38 }, { x: 135, y: 38 }], { widthClass: 'L', name: 'A' }));
  const connectors: [number, string][] = [
    [20, 'A1'],
    [60, 'A2'],
    [100, 'A3'],
    [135, 'A4'],
  ];
  for (const [x, name] of connectors) {
    run(addTaxiwayPath(layout, [{ x, y: 30 }, { x, y: 38 }], { widthClass: 'L', name }));
    // 滑走路入口ノードに誘導路名を付ける
    const entry = findNodeAt(layout.taxiNodes, { x, y: 30 })!;
    run(updateEntity(layout, entry, { name }));
  }

  // エプロンとエプロン誘導路 B
  fac('apron', { x: 40, y: 39 }, { w: 61, h: 10 });
  run(addTaxiwayPath(layout, [{ x: 45, y: 38 }, { x: 45, y: 41 }], { widthClass: 'L', name: 'B1' }));
  run(addTaxiwayPath(layout, [{ x: 95, y: 38 }, { x: 95, y: 41 }], { widthClass: 'L', name: 'B2' }));
  run(addTaxiwayPath(layout, [{ x: 45, y: 41 }, { x: 95, y: 41 }], { widthClass: 'L', name: 'B' }));

  // スポット（機首は南 = ターミナル側、入口は北のエプロン誘導路）
  const standIds: string[] = [];
  for (let i = 0; i < 8; i++) {
    standIds.push(run(placeStand(layout, { x: 48 + i * 5, y: 42 }, 'M', 180, 'operational', String(i + 1)))[0]!);
  }
  standIds.push(run(placeStand(layout, { x: 88, y: 42 }, 'L', 180, 'operational', 'L1'))[0]!);

  // ターミナルとゲート
  const terminal = fac('terminal', { x: 46, y: 49 }, { w: 48, h: 8, name: '旅客ターミナル', props: { levels: 2 } });
  // ターミナル内部: 1F = 到着・入口、2F = チェックイン・保安検査・出発ロビー（入口からエスカレーターで2Fへ）
  const area = (level: number, kind: TerminalAreaKind, x: number, y: number, w: number, h: number, name: string, props?: Record<string, number>) =>
    run(placeTerminalArea(layout, terminal, level, kind, { x, y }, { w, h, name, ...(props ? { props } : {}) }));
  area(0, 'arrivalCorridor', 46, 49, 48, 2, '到着通路');
  area(0, 'baggageClaim', 58, 51, 20, 3, '手荷物受取所', { belts: 3 });
  area(0, 'exit', 58, 54, 20, 3, '到着出口');
  area(0, 'entrance', 80, 54, 14, 3, '出発入口');
  area(0, 'escalator', 86, 52, 4, 2, 'エスカレーター');
  area(1, 'departureLobby', 46, 49, 48, 2, '出発ロビー');
  area(1, 'restroom', 46, 51, 4, 2, 'トイレ');
  area(1, 'security', 66, 51, 8, 2, '保安検査場', { lanes: 4 });
  area(1, 'waiting', 80, 51, 10, 2, '待合スペース');
  area(1, 'checkIn', 50, 53, 40, 2, 'チェックイン', { counters: 16 });
  standIds.forEach((standId, i) => {
    const x = i < 8 ? 49 + i * 5 : 90;
    fac('gate', { x, y: 48 }, { name: i < 8 ? String(i + 1) : 'L1', props: { standId, jetBridge: true } });
  });

  // 支援施設
  fac('tower', { x: 120, y: 44 }, { name: '管制塔' });
  fac('serviceArea', { x: 101, y: 39 }, { w: 8, h: 10, name: 'GSE置場' });
  fac('gseBase', { x: 101, y: 49 }, { name: 'GSE基地' });
  fac('fuelFarm', { x: 105, y: 49 }, { name: '燃料施設' });
  fac('fireStation', { x: 25, y: 39 }, { name: '消防' });
  fac('hangar', { x: 31, y: 39 }, { name: '格納庫' });
  fac('maintenance', { x: 36, y: 45 }, { name: '整備施設' });
  fac('baggageSort', { x: 42, y: 49 }, { name: '手荷物仕分け場' });

  // 道路と駐車場
  run(addRoadPath(layout, [{ x: 30, y: 57 }, { x: 110, y: 57 }, { x: 110, y: layout.site.height - 7 }], { roadClass: 'public', name: '空港通り' }));
  run(addRoadPath(layout, [{ x: 104, y: 48 }, { x: 104, y: 57 }], { roadClass: 'service', name: '構内道路' }));
  fac('parking', { x: 60, y: 58 }, { w: 30, h: 8, name: '駐車場' });

  return layout;
}
