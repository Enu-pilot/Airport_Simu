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
  type OpResult,
  type PlaceFacilityOptions,
} from '../layout/operations';

/**
 * キャリアモードの開始レイアウト「小さな飛行場」。
 * M級滑走路1本（2100m）、Mスポット3つ、小さな2階建てターミナル、最小限の支援施設。
 * サンプル空港（createSampleAirport）を縮小した配置で、エラー・警告なし（tests/unit/economy.test.ts）。
 *
 *   y=30  ═══════ 滑走路（M級, 2100m）═══════
 *          │A1             │A2              │A3
 *   y=38  ─┴──── 誘導路 A ─┴────────────────┴─
 *                │B1      │B2
 *   y=41  エプロン ┴── B ──┘
 *                  [1][2][3]   スポット
 *   y=48            ゲート
 *   y=49-56         ターミナル（1F 到着・入口、2F 出発）
 *   y=57  ───── 一般道路 ─────
 */
export function createStarterAirfield(seed = 'skyport-starter', sizeId?: string): AirportLayout {
  const size = sizeId && sizeId !== 'standard' ? siteSizeById(sizeId) : null;
  let layout = createEmptyLayout(createSite({ seed, ...(size ? { width: size.width, height: size.height } : {}) }), '小さな飛行場');
  const run = (r: OpResult): string[] => {
    if (!r.ok) throw new Error(`starter generation failed: ${r.reason}`);
    layout = r.layout;
    return r.created;
  };
  const fac = (kind: FacilityKind, origin: Tile, opts: PlaceFacilityOptions = {}) => run(placeFacility(layout, kind, origin, opts))[0]!;

  run(placeRunway(layout, { x: 20, y: 30 }, 90, 84, { surfaceWidthM: 45, name: '' }));
  run(addTaxiwayPath(layout, [{ x: 20, y: 38 }, { x: 104, y: 38 }], { widthClass: 'M', name: 'A' }));
  for (const [x, name] of [
    [20, 'A1'],
    [62, 'A2'],
    [104, 'A3'],
  ] as const) {
    run(addTaxiwayPath(layout, [{ x, y: 30 }, { x, y: 38 }], { widthClass: 'M', name }));
  }

  fac('apron', { x: 40, y: 39 }, { w: 26, h: 10 });
  run(addTaxiwayPath(layout, [{ x: 45, y: 38 }, { x: 45, y: 41 }], { widthClass: 'M', name: 'B1' }));
  run(addTaxiwayPath(layout, [{ x: 62, y: 38 }, { x: 62, y: 41 }], { widthClass: 'M', name: 'B2' }));
  run(addTaxiwayPath(layout, [{ x: 45, y: 41 }, { x: 62, y: 41 }], { widthClass: 'M', name: 'B' }));
  const standIds: string[] = [];
  for (let i = 0; i < 3; i++) standIds.push(run(placeStand(layout, { x: 48 + i * 5, y: 42 }, 'M', 180, 'operational', String(i + 1)))[0]!);

  const terminal = fac('terminal', { x: 46, y: 49 }, { w: 20, h: 8, name: '旅客ターミナル', props: { levels: 2 } });
  const area = (level: number, kind: TerminalAreaKind, x: number, y: number, w: number, h: number, name: string, props?: Record<string, number>) =>
    run(placeTerminalArea(layout, terminal, level, kind, { x, y }, { w, h, name, ...(props ? { props } : {}) }));
  area(0, 'arrivalCorridor', 46, 49, 20, 2, '到着通路');
  area(0, 'baggageClaim', 50, 51, 8, 3, '手荷物受取所', { belts: 1 });
  area(0, 'exit', 50, 54, 8, 3, '到着出口');
  area(0, 'entrance', 58, 54, 8, 3, '出発入口');
  area(0, 'escalator', 62, 52, 3, 2, 'エスカレーター');
  area(1, 'departureLobby', 46, 49, 20, 2, '出発ロビー');
  area(1, 'restroom', 46, 51, 3, 2, 'トイレ');
  area(1, 'security', 52, 51, 4, 2, '保安検査場', { lanes: 2 });
  area(1, 'waiting', 58, 51, 4, 2, '待合スペース');
  area(1, 'checkIn', 49, 53, 16, 2, 'チェックイン', { counters: 6 });
  standIds.forEach((standId, i) => fac('gate', { x: 49 + i * 5, y: 48 }, { name: String(i + 1), props: { standId, jetBridge: true } }));

  fac('tower', { x: 84, y: 42 }, { name: '管制塔' });
  fac('fireStation', { x: 25, y: 39 }, { name: '消防' });
  fac('maintenance', { x: 36, y: 45 }, { name: '整備施設', props: { bays: 1, engineers: 2 } });
  fac('baggageSort', { x: 42, y: 49 }, { name: '手荷物仕分け場', props: { capacityPerMin: 20 } });
  fac('gseBase', { x: 68, y: 49 }, {
    name: 'GSE基地',
    props: { staff: 10, tugs: 1, beltLoaders: 2, baggageTractors: 2, fuelTrucks: 1, cateringTrucks: 1, cleaningVans: 1 },
  });
  fac('fuelFarm', { x: 72, y: 49 }, { name: '燃料施設' });

  run(addRoadPath(layout, [{ x: 30, y: 57 }, { x: 76, y: 57 }, { x: 76, y: layout.site.height - 7 }], { roadClass: 'public', name: '空港通り' }));
  run(addRoadPath(layout, [{ x: 71, y: 48 }, { x: 71, y: 57 }], { roadClass: 'service', name: '構内道路' }));
  fac('parking', { x: 50, y: 58 }, { w: 16, h: 6, name: '駐車場', props: { spaces: 200 } });
  return layout;
}
