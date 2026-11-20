/**
 * ゴールデンの入力レイアウトを組み立てる関数（Phase 11）。
 *
 * これらは **フィクスチャ（tests/golden/fixtures/*.layout.json）の再生成専用**。
 * ゴールデンの採取・照合はフィクスチャを読み込んで行う（capture.ts）。
 * 編集操作（Phase 12/13 で挙動が変わりうる）の変更が、ゴールデンの入力を黙って変えないようにするため。
 * 再生成: GOLDEN_FIXTURES_UPDATE=1 npx vitest run tests/unit/golden.fixtures.test.ts
 * 編集操作の失敗は黙って飛ばさず例外にする。
 */
import { addRoadPath, addTaxiwayPath, placeFacility, placeRunway, placeStand, placeTerminalArea, type OpResult } from '../../src/core/layout/operations';
import type { AirportLayout, Heading } from '../../src/core/model/types';
import { emptyLayout, must } from '../unit/helpers';

/**
 * 8 方位すべての滑走路（長さ・幅を変える）と、滑走路を斜めに横切る誘導路を持つ専用レイアウト。
 * 重なり・交差の検証結果も含めて採取対象（エラーが出てもよい）。
 */
export function createAllHeadingsLayout(): AirportLayout {
  let l = emptyLayout(260, 220);
  const step = (r: OpResult) => (l = must(r).layout);
  const widths = [30, 45, 60] as const;
  // 中心を 8 か所に分散して置く（始点, 方位, 長さ）
  const specs: { start: { x: number; y: number }; h: Heading; len: number }[] = [
    { start: { x: 20, y: 60 }, h: 0, len: 40 },
    { start: { x: 60, y: 20 }, h: 45, len: 31 },
    { start: { x: 80, y: 40 }, h: 90, len: 57 },
    { start: { x: 200, y: 20 }, h: 135, len: 23 },
    { start: { x: 150, y: 100 }, h: 180, len: 45 },
    { start: { x: 230, y: 120 }, h: 225, len: 66 },
    { start: { x: 140, y: 150 }, h: 270, len: 90 },
    { start: { x: 30, y: 130 }, h: 315, len: 18 },
    // 長さ違いの追加（最小に近い・長大）
    { start: { x: 20, y: 200 }, h: 90, len: 30 },
    { start: { x: 60, y: 210 }, h: 90, len: 120 },
    { start: { x: 200, y: 200 }, h: 45, len: 1 },
  ];
  specs.forEach((s, i) => step(placeRunway(l, s.start, s.h, s.len, { surfaceWidthM: widths[i % 3]!, name: '' })));
  // 滑走路を斜めに横切る誘導路・滑走路端へ接続する誘導路
  const paths: { x: number; y: number }[][] = [
    [{ x: 70, y: 30 }, { x: 90, y: 50 }, { x: 110, y: 70 }],
    // （[{100,60},{80,40}] は先頭の斜め誘導路と重なり NO_CHANGE になるため除外。レイアウトは従来と同一）
    [{ x: 10, y: 50 }, { x: 40, y: 50 }, { x: 60, y: 30 }],
    [{ x: 150, y: 140 }, { x: 170, y: 160 }],
    [{ x: 210, y: 110 }, { x: 180, y: 140 }, { x: 150, y: 170 }],
    [{ x: 20, y: 130 }, { x: 40, y: 130 }],
    [{ x: 20, y: 60 }, { x: 20, y: 90 }, { x: 50, y: 120 }],
    [{ x: 200, y: 20 }, { x: 215, y: 35 }],
  ];
  for (const p of paths) {
    step(addTaxiwayPath(l, p, { widthClass: 'M' })); // 失敗は黙って飛ばさずエラーにする
  }
  return l;
}


/**
 * 運航の負荷試験用レイアウト（Phase 11 R-G2）。
 * 平行な 2 本の滑走路（北 RWY-N y=30、南 RWY-S y=50）、斜め（45°）の連絡誘導路、滑走路横断（RWY-S を横切って RWY-N へ）、
 * 12 のスポットを持つ。RWY-N へ行く経路は必ず RWY-S を横断するので、ホールドショート・横断許可・競合が起きる。
 */
export function createStressLayout(): AirportLayout {
  let l = emptyLayout(220, 150);
  l.name = 'stress';
  const step = (r: OpResult): string[] => {
    const m = must(r);
    l = m.layout;
    return m.created;
  };
  const taxi = (pts: { x: number; y: number }[], name: string, widthClass: 'S' | 'M' | 'L' = 'L') => step(addTaxiwayPath(l, pts, { widthClass, name }));

  step(placeRunway(l, { x: 20, y: 30 }, 90, 120, { surfaceWidthM: 60, name: '' }));
  step(placeRunway(l, { x: 20, y: 50 }, 90, 120, { surfaceWidthM: 60, name: '' }));

  // 平行誘導路 T（RWY-S の南）と連絡誘導路（垂直 + 斜め 45°）
  taxi([{ x: 20, y: 58 }, { x: 140, y: 58 }], 'T');
  for (const x of [20, 60, 140]) taxi([{ x, y: 50 }, { x, y: 58 }], `S${x}`);
  taxi([{ x: 40, y: 50 }, { x: 48, y: 58 }], 'S-diag1');
  taxi([{ x: 110, y: 50 }, { x: 118, y: 58 }], 'S-diag2');

  // RWY-S と RWY-N の間の誘導路 M と、RWY-S を横断する連絡路 X
  taxi([{ x: 20, y: 40 }, { x: 100, y: 40 }, { x: 135, y: 40 }], 'M');
  taxi([{ x: 100, y: 58 }, { x: 100, y: 50 }, { x: 100, y: 40 }, { x: 100, y: 30 }], 'X');
  taxi([{ x: 135, y: 58 }, { x: 135, y: 50 }, { x: 135, y: 40 }, { x: 135, y: 30 }], 'X2');
  taxi([{ x: 20, y: 30 }, { x: 20, y: 40 }], 'N20');
  taxi([{ x: 60, y: 30 }, { x: 70, y: 40 }], 'N-diag1'); // 斜め
  taxi([{ x: 120, y: 30 }, { x: 110, y: 40 }], 'N-diag2'); // 斜め

  // エプロンとエプロン誘導路 B（サンプルを y+20 にしたもの）
  step(placeFacility(l, 'apron', { x: 40, y: 59 }, { w: 80, h: 10 }));
  taxi([{ x: 45, y: 58 }, { x: 45, y: 63 }], 'B1');
  taxi([{ x: 115, y: 58 }, { x: 115, y: 63 }], 'B2');
  taxi([{ x: 45, y: 61 }, { x: 115, y: 61 }], 'B');
  taxi([{ x: 45, y: 63 }, { x: 115, y: 63 }], 'B');

  // スポット 12（M×10 と L×2）。機首は南
  const standIds: string[] = [];
  for (let i = 0; i < 10; i++) standIds.push(step(placeStand(l, { x: 48 + i * 5, y: 64 }, 'M', 180, 'operational', String(i + 1)))[0]!);
  for (const [i, x] of [98, 108].entries()) standIds.push(step(placeStand(l, { x, y: 64 }, 'L', 180, 'operational', `L${i + 1}`))[0]!);

  // ターミナルとゲート
  const terminal = step(placeFacility(l, 'terminal', { x: 46, y: 69 }, { w: 72, h: 8, name: '旅客ターミナル', props: { levels: 2 } }))[0]!;
  const area = (level: number, kind: Parameters<typeof placeTerminalArea>[3], x: number, y: number, w: number, h: number, name: string, props?: Record<string, number>) =>
    step(placeTerminalArea(l, terminal, level, kind, { x, y }, { w, h, name, ...(props ? { props } : {}) }));
  area(0, 'arrivalCorridor', 46, 69, 72, 2, '到着通路');
  area(0, 'baggageClaim', 58, 71, 24, 3, '手荷物受取所', { belts: 4 });
  area(0, 'exit', 58, 74, 24, 3, '到着出口');
  area(0, 'entrance', 90, 74, 20, 3, '出発入口');
  area(0, 'escalator', 98, 72, 4, 2, 'エスカレーター');
  area(1, 'departureLobby', 46, 69, 72, 2, '出発ロビー');
  area(1, 'restroom', 46, 71, 4, 2, 'トイレ');
  area(1, 'security', 66, 71, 10, 2, '保安検査場', { lanes: 6 });
  area(1, 'waiting', 90, 71, 16, 2, '待合スペース');
  area(1, 'checkIn', 50, 73, 60, 2, 'チェックイン', { counters: 24 });
  standIds.forEach((standId, i) => {
    const x = i < 10 ? 49 + i * 5 : 100 + (i - 10) * 10;
    step(placeFacility(l, 'gate', { x, y: 68 }, { name: String(i + 1), props: { standId, jetBridge: true } }));
  });

  // 支援施設・道路
  for (const [kind, x, y, name] of [
    ['tower', 131, 64, '管制塔'],
    ['gseBase', 121, 69, 'GSE基地'],
    ['fuelFarm', 125, 69, '燃料施設'],
    ['fireStation', 25, 59, '消防'],
    ['hangar', 31, 59, '格納庫'],
    ['maintenance', 36, 65, '整備施設'],
    ['baggageSort', 42, 69, '手荷物仕分け場'],
  ] as const) {
    step(placeFacility(l, kind, { x, y }, { name }));
  }
  step(placeFacility(l, 'serviceArea', { x: 121, y: 59 }, { w: 8, h: 10, name: 'GSE置場' }));
  step(addRoadPath(l, [{ x: 30, y: 77 }, { x: 130, y: 77 }, { x: 130, y: 110 }], { roadClass: 'public', name: '空港通り' }));
  step(addRoadPath(l, [{ x: 124, y: 68 }, { x: 124, y: 77 }], { roadClass: 'service', name: '構内道路' }));
  step(placeFacility(l, 'parking', { x: 60, y: 78 }, { w: 30, h: 8, name: '駐車場' }));
  return l;
}
