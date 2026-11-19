import type { FacilityKind, PaxZone, PropValue, SizeClass, TerminalAreaKind } from './types';

/** 1タイルの実寸（m）。距離・滑走路長の換算に使う（定義は geometry/frames.ts） */
export { TILE_M } from '../geometry/frames';

/** 区間ごとに進む地上走行（フェーズ 2）の設定の範囲と既定（docs/41） */
export const TAXI_BLOCK_TILES_MIN = 4;
export const TAXI_BLOCK_TILES_MAX = 40;
export const TAXI_BLOCK_TILES_DEFAULT = 10;
/** 誘導路ごとの進入可能機数の上限の範囲 */
export const TAXI_BLOCK_MAX_AIRCRAFT = 10;

/**
 * 誘導路の描画幅（m）。ゲーム内の表示用の値であり、ICAO 等の実寸基準ではない（status: game）。
 * 2D・3D の両方がこの表を使う（実寸の値は Phase 12/13 で出典付きの別表を持つ）。
 */
export const TAXIWAY_DRAW_WIDTH_M = { S: 15, M: 23, L: 30, codeF: 38 } as const;

/** 道路・鉄道の描画幅（m、ゲームの表示用の値） */
export const ROAD_DRAW_WIDTH_M = { road: 12, rail: 8, walkway: 5, fuel: 2 } as const;

/** Vertical occupancy used by layout validation and 3D rendering (game display dimensions). */
export const FACILITY_HEIGHT_M: Partial<Record<FacilityKind, number>> = {
  terminal: 18, tower: 45, hangar: 24, maintenance: 14, fuelFarm: 10, fireStation: 9,
  gseBase: 6, baggageSort: 10, serviceArea: 6, parking: 3, gate: 6, apron: 0.2,
  railStation: 8, taxiStand: 2, busStop: 3, busTerminal: 6, cargoTerminal: 9, staffParking: 1, hotel: 18,
};

/** 占有判定のレイヤー。重なりの可否は validation の互換表で決める */
export type FootprintLayer =
  | 'runway'
  | 'strip'
  | 'resa'
  | 'taxiway'
  | 'apron'
  | 'stand'
  | 'gate'
  | 'building'
  | 'interior'
  | 'area'
  | 'roadPublic'
  | 'roadService'
  | 'rail'
  | 'walkway'
  | 'fuelPipe';

export interface FacilitySpec {
  layer: FootprintLayer;
  defaultW: number;
  defaultH: number;
  /** 幅・奥行きを変更できる（エリア系） */
  resizable: boolean;
  minW: number;
  minH: number;
  /** ドラッグで矩形配置する */
  dragPlace: boolean;
  /** エプロン・サービスエリア・誘導路・サービス道路への隣接が必要 */
  needsAirsideAccess: boolean;
}

export const FACILITY_SPECS: Record<FacilityKind, FacilitySpec> = {
  apron: { layer: 'apron', defaultW: 12, defaultH: 8, resizable: true, minW: 3, minH: 3, dragPlace: true, needsAirsideAccess: false },
  terminal: { layer: 'building', defaultW: 20, defaultH: 8, resizable: true, minW: 4, minH: 3, dragPlace: true, needsAirsideAccess: false },
  gate: { layer: 'gate', defaultW: 1, defaultH: 1, resizable: false, minW: 1, minH: 1, dragPlace: false, needsAirsideAccess: false },
  hangar: { layer: 'building', defaultW: 6, defaultH: 5, resizable: true, minW: 4, minH: 4, dragPlace: false, needsAirsideAccess: true },
  tower: { layer: 'building', defaultW: 2, defaultH: 2, resizable: false, minW: 2, minH: 2, dragPlace: false, needsAirsideAccess: false },
  maintenance: { layer: 'building', defaultW: 4, defaultH: 3, resizable: false, minW: 4, minH: 3, dragPlace: false, needsAirsideAccess: true },
  fuelFarm: { layer: 'building', defaultW: 3, defaultH: 3, resizable: false, minW: 3, minH: 3, dragPlace: false, needsAirsideAccess: true },
  fireStation: { layer: 'building', defaultW: 3, defaultH: 3, resizable: false, minW: 3, minH: 3, dragPlace: false, needsAirsideAccess: true },
  gseBase: { layer: 'building', defaultW: 3, defaultH: 3, resizable: false, minW: 3, minH: 3, dragPlace: false, needsAirsideAccess: true },
  baggageSort: { layer: 'building', defaultW: 4, defaultH: 4, resizable: false, minW: 4, minH: 4, dragPlace: false, needsAirsideAccess: true },
  serviceArea: { layer: 'area', defaultW: 6, defaultH: 4, resizable: true, minW: 2, minH: 2, dragPlace: true, needsAirsideAccess: false },
  parking: { layer: 'area', defaultW: 8, defaultH: 5, resizable: true, minW: 2, minH: 2, dragPlace: true, needsAirsideAccess: false },
  taxiStand: { layer: 'area', defaultW: 3, defaultH: 2, resizable: false, minW: 3, minH: 2, dragPlace: false, needsAirsideAccess: false },
  busStop: { layer: 'area', defaultW: 4, defaultH: 2, resizable: false, minW: 4, minH: 2, dragPlace: false, needsAirsideAccess: false },
  busTerminal: { layer: 'building', defaultW: 8, defaultH: 3, resizable: true, minW: 4, minH: 2, dragPlace: false, needsAirsideAccess: false },
  cargoTerminal: { layer: 'building', defaultW: 10, defaultH: 6, resizable: true, minW: 6, minH: 4, dragPlace: false, needsAirsideAccess: true },
  railStation: { layer: 'building', defaultW: 6, defaultH: 3, resizable: false, minW: 6, minH: 3, dragPlace: false, needsAirsideAccess: false },
  staffParking: { layer: 'area', defaultW: 6, defaultH: 4, resizable: true, minW: 2, minH: 2, dragPlace: true, needsAirsideAccess: false },
  hotel: { layer: 'building', defaultW: 5, defaultH: 4, resizable: false, minW: 5, minH: 4, dragPlace: false, needsAirsideAccess: false },
};

export const FACILITY_KINDS = Object.keys(FACILITY_SPECS) as FacilityKind[];

export type PropDef =
  | { key: string; type: 'int'; min: number; max: number }
  | { key: string; type: 'bool' }
  | { key: string; type: 'enum'; options: readonly string[] }
  /** スポットIDへの参照 */
  | { key: string; type: 'standRef' }
  /** 施設（種類 of）への参照。null = 未指定（欠落と同じ） */
  | { key: string; type: 'facilityRef'; of: FacilityKind };

/** プロパティが欠落しているときの値（DEFAULT_PROPS には入れない: 新しく置いた施設の JSON を従来と同じに保つため）。読む側と UI が使う */
export function propDefault(def: PropDef): PropValue {
  switch (def.type) {
    case 'int':
      return def.min;
    case 'bool':
      return false;
    case 'enum':
      return def.options[0] ?? null;
    default:
      return null;
  }
}

export const PROP_SCHEMAS: Record<FacilityKind, readonly PropDef[]> = {
  apron: [],
  terminal: [{ key: 'levels', type: 'int', min: 1, max: 4 }],
  gate: [
    { key: 'standId', type: 'standRef' },
    { key: 'jetBridge', type: 'bool' },
    /** 搭乗方式（欠落 = 'contact'）。'bus' はランプバスでリモートスポットへ運ぶバスゲート（docs/29） */
    { key: 'boardingMode', type: 'enum', options: ['contact', 'bus'] },
    /** 明示の接続先ターミナル（欠落 = 隣接で決まる）。隣接しないゲートは連絡通路でつながる独立ゲート */
    { key: 'connectedTo', type: 'facilityRef', of: 'terminal' },
    /** 国内/国際の別（フェーズ 4。欠落 = 'domestic'）。'swing' は兼用 */
    { key: 'routeType', type: 'enum', options: ['domestic', 'international', 'swing'] },
  ],
  hangar: [{ key: 'maxSize', type: 'enum', options: ['S', 'M', 'L'] }],
  tower: [{ key: 'level', type: 'int', min: 1, max: 3 }],
  maintenance: [
    { key: 'bays', type: 'int', min: 1, max: 10 },
    { key: 'engineers', type: 'int', min: 0, max: 50 },
  ],
  fuelFarm: [{ key: 'capacityKL', type: 'int', min: 100, max: 50000 }],
  fireStation: [{ key: 'category', type: 'int', min: 1, max: 10 }],
  gseBase: [
    { key: 'staff', type: 'int', min: 0, max: 200 },
    { key: 'tugs', type: 'int', min: 0, max: 30 },
    { key: 'beltLoaders', type: 'int', min: 0, max: 30 },
    { key: 'baggageTractors', type: 'int', min: 0, max: 30 },
    { key: 'fuelTrucks', type: 'int', min: 0, max: 30 },
    { key: 'cateringTrucks', type: 'int', min: 0, max: 30 },
    { key: 'cleaningVans', type: 'int', min: 0, max: 30 },
    /** ランプバス（旅客を運ぶバス）の台数（欠落 = 0） */
    { key: 'apronBuses', type: 'int', min: 0, max: 30 },
  ],
  baggageSort: [{ key: 'capacityPerMin', type: 'int', min: 1, max: 500 }],
  serviceArea: [],
  parking: [{ key: 'spaces', type: 'int', min: 0, max: 20000 }],
  taxiStand: [{ key: 'berths', type: 'int', min: 1, max: 20 }],
  busStop: [
    { key: 'busBays', type: 'int', min: 1, max: 10 },
    { key: 'busesPerHour', type: 'int', min: 1, max: 30 },
  ],
  busTerminal: [
    { key: 'berths', type: 'int', min: 1, max: 20 },
    { key: 'busesPerHour', type: 'int', min: 1, max: 60 },
  ],
  cargoTerminal: [{ key: 'throughputM3PerHour', type: 'int', min: 10, max: 500 }],
  railStation: [
    { key: 'level', type: 'int', min: -5, max: 10 },
    { key: 'trainsPerHour', type: 'int', min: 1, max: 20 },
    { key: 'railService', type: 'enum', options: ['local', 'rapid', 'express'] },
    /** ホーム数（フェーズ 4。欠落 = 2） */
    { key: 'platforms', type: 'int', min: 1, max: 12 },
  ],
  staffParking: [{ key: 'spaces', type: 'int', min: 0, max: 5000 }],
  hotel: [{ key: 'rooms', type: 'int', min: 10, max: 2000 }],
};

export const DEFAULT_PROPS: Record<FacilityKind, Record<string, PropValue>> = {
  apron: {},
  terminal: { levels: 2 },
  gate: { standId: null, jetBridge: true },
  hangar: { maxSize: 'M' },
  tower: { level: 1 },
  maintenance: { bays: 2, engineers: 3 },
  fuelFarm: { capacityKL: 2000 },
  fireStation: { category: 7 },
  gseBase: { staff: 20, tugs: 2, beltLoaders: 3, baggageTractors: 3, fuelTrucks: 2, cateringTrucks: 2, cleaningVans: 2 },
  baggageSort: { capacityPerMin: 30 },
  serviceArea: {},
  parking: { spaces: 400 },
  taxiStand: { berths: 4 },
  busStop: { busBays: 2, busesPerHour: 4 },
  busTerminal: { berths: 4, busesPerHour: 12 },
  cargoTerminal: { throughputM3PerHour: 60 },
  railStation: { trainsPerHour: 4 },
  staffParking: { spaces: 120 },
  hotel: { rooms: 200 },
};

/** スポットの寸法（幅 = 機首と直交方向、奥行き = 機首方向）。幅は入口を中央に置くため奇数 */
export const STAND_DIMS: Record<SizeClass, { w: number; d: number }> = {
  S: { w: 3, d: 3 },
  M: { w: 3, d: 4 },
  L: { w: 5, d: 5 },
};

/** 滑走路: 舗装幅による対応区分 */
export const RUNWAY_WIDTH_CLASS: Record<30 | 45 | 60, SizeClass> = { 30: 'S', 45: 'M', 60: 'L' };
/** 滑走路: 区分ごとの必要長（m） */
export const RUNWAY_MIN_LENGTH_M: Record<SizeClass, number> = { S: 1200, M: 2000, L: 2800 };
/**
 * 自由形の滑走路の長さの範囲（m）。ゲーム値（出典なし）: 最小 25 m（1 タイル）、
 * 最大は従来形の最大ステップ数（operations.ts の MAX_RUNWAY_LENGTH = 200）の斜め長 200 × 25 × √2 m。
 */
export const FREE_RUNWAY_MIN_M = 25;
export const FREE_RUNWAY_MAX_M = 200 * Math.SQRT2 * 25;
/** 滑走路の描画・占有上の半幅（タイル） */
export const RUNWAY_HALF_WIDTH = 1.5;
/** 滑走路保護区域（着陸帯）の半幅・端部延長（タイル）。誘導路以外は配置不可 */
export const STRIP_HALF_WIDTH = 3.5;
export const STRIP_END_EXTENSION = 2.5;

/** ゲートと紐付けスポットの最大距離（チェビシェフ距離、タイル） */
export const GATE_MAX_STAND_DISTANCE = 3;
/** 独立ゲートの連絡通路の長さの警告しきい値（タイル。1.5 km） */
export const GATE_CONNECTOR_MAX_TILES = 60;

// ---------------------------------------------------------------- ターミナル内部

export interface TerminalAreaSpec {
  defaultW: number;
  defaultH: number;
  minW: number;
  minH: number;
  zone: PaxZone;
  /** 区域をプレイヤーが選べる（通路・待合・トイレ・上下移動） */
  zoneEditable: boolean;
  props: readonly PropDef[];
  defaults: Record<string, PropValue>;
}

export const TERMINAL_AREA_SPECS: Record<TerminalAreaKind, TerminalAreaSpec> = {
  entrance: { defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'landside', zoneEditable: false, props: [], defaults: {} },
  exit: { defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'landside', zoneEditable: false, props: [], defaults: {} },
  checkIn: {
    defaultW: 8, defaultH: 2, minW: 1, minH: 1, zone: 'landside', zoneEditable: false,
    props: [{ key: 'counters', type: 'int', min: 0, max: 100 }, { key: 'serviceSecPerPax', type: 'int', min: 5, max: 600 }],
    defaults: { counters: 8, serviceSecPerPax: 50 },
  },
  security: {
    defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'departure', zoneEditable: false,
    props: [{ key: 'lanes', type: 'int', min: 0, max: 30 }, { key: 'serviceSecPerPax', type: 'int', min: 3, max: 300 }],
    defaults: { lanes: 3, serviceSecPerPax: 15 },
  },
  departureLobby: {
    defaultW: 10, defaultH: 2, minW: 1, minH: 1, zone: 'departure', zoneEditable: false,
    props: [{ key: 'seats', type: 'int', min: 0, max: 5000 }], defaults: { seats: 200 },
  },
  waiting: {
    defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'departure', zoneEditable: true,
    props: [{ key: 'seats', type: 'int', min: 0, max: 5000 }], defaults: { seats: 100 },
  },
  restroom: {
    defaultW: 2, defaultH: 2, minW: 1, minH: 1, zone: 'departure', zoneEditable: true,
    props: [{ key: 'fixtures', type: 'int', min: 0, max: 100 }], defaults: { fixtures: 6 },
  },
  arrivalCorridor: { defaultW: 10, defaultH: 1, minW: 1, minH: 1, zone: 'arrival', zoneEditable: false, props: [], defaults: {} },
  baggageClaim: {
    defaultW: 6, defaultH: 3, minW: 1, minH: 1, zone: 'arrival', zoneEditable: false,
    props: [{ key: 'belts', type: 'int', min: 0, max: 20 }], defaults: { belts: 2 },
  },
  hall: { defaultW: 4, defaultH: 4, minW: 1, minH: 1, zone: 'landside', zoneEditable: true, props: [], defaults: {} },
  // 動く歩道: 通路の拡張。置いた区間だけ歩行が速くなる（速度モデルは terminal/model.ts の MOVING_WALKWAY_BELT_MPS）
  movingWalkway: { defaultW: 6, defaultH: 1, minW: 1, minH: 1, zone: 'departure', zoneEditable: true, props: [], defaults: {} },
  stairs: {
    defaultW: 2, defaultH: 1, minW: 1, minH: 1, zone: 'landside', zoneEditable: true,
    props: [{ key: 'travelSec', type: 'int', min: 5, max: 300 }, { key: 'capacityPerHour', type: 'int', min: 1, max: 100000 }],
    defaults: { travelSec: 45 },
  },
  escalator: {
    defaultW: 2, defaultH: 1, minW: 1, minH: 1, zone: 'landside', zoneEditable: true,
    props: [{ key: 'travelSec', type: 'int', min: 5, max: 300 }, { key: 'capacityPerHour', type: 'int', min: 1, max: 100000 }],
    defaults: { travelSec: 30 },
  },
  elevator: {
    defaultW: 1, defaultH: 1, minW: 1, minH: 1, zone: 'landside', zoneEditable: true,
    props: [{ key: 'travelSec', type: 'int', min: 5, max: 300 }, { key: 'capacityPerHour', type: 'int', min: 1, max: 100000 }],
    defaults: { travelSec: 60 },
  },
  shop: {
    defaultW: 3, defaultH: 2, minW: 1, minH: 1, zone: 'departure', zoneEditable: true,
    props: [{ key: 'capacity', type: 'int', min: 1, max: 100 }], defaults: { capacity: 8 },
  },
  restaurant: {
    defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'departure', zoneEditable: true,
    props: [{ key: 'capacity', type: 'int', min: 1, max: 100 }], defaults: { capacity: 10 },
  },
  // フェーズ 4: 国際・乗継のエリア
  emigration: {
    defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'departureIntl', zoneEditable: false,
    props: [{ key: 'lanes', type: 'int', min: 0, max: 30 }, { key: 'serviceSecPerPax', type: 'int', min: 3, max: 300 }],
    defaults: { lanes: 4, serviceSecPerPax: 30 },
  },
  immigration: {
    defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'arrival', zoneEditable: false,
    props: [{ key: 'booths', type: 'int', min: 0, max: 30 }, { key: 'serviceSecPerPax', type: 'int', min: 3, max: 300 }],
    defaults: { booths: 6, serviceSecPerPax: 45 },
  },
  customs: {
    defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'landside', zoneEditable: false,
    props: [{ key: 'lanes', type: 'int', min: 0, max: 30 }, { key: 'serviceSecPerPax', type: 'int', min: 3, max: 300 }],
    defaults: { lanes: 4, serviceSecPerPax: 20 },
  },
  transferSecurity: {
    defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'departure', zoneEditable: true,
    props: [{ key: 'lanes', type: 'int', min: 0, max: 30 }, { key: 'serviceSecPerPax', type: 'int', min: 3, max: 300 }],
    defaults: { lanes: 2, serviceSecPerPax: 15 },
  },
};

export const TERMINAL_AREA_KINDS = Object.keys(TERMINAL_AREA_SPECS) as TerminalAreaKind[];
