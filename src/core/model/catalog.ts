import type { FacilityKind, PaxZone, PropValue, SizeClass, TerminalAreaKind } from './types';

/** 1タイルの実寸（m）。距離・滑走路長の換算に使う */
export const TILE_M = 25;

/** 占有判定のレイヤー。重なりの可否は validation の互換表で決める */
export type FootprintLayer =
  | 'runway'
  | 'strip'
  | 'taxiway'
  | 'apron'
  | 'stand'
  | 'gate'
  | 'building'
  | 'area'
  | 'roadPublic'
  | 'roadService';

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
};

export const FACILITY_KINDS = Object.keys(FACILITY_SPECS) as FacilityKind[];

export type PropDef =
  | { key: string; type: 'int'; min: number; max: number }
  | { key: string; type: 'bool' }
  | { key: string; type: 'enum'; options: readonly string[] }
  /** スポットIDへの参照 */
  | { key: string; type: 'standRef' };

export const PROP_SCHEMAS: Record<FacilityKind, readonly PropDef[]> = {
  apron: [],
  terminal: [{ key: 'levels', type: 'int', min: 1, max: 3 }],
  gate: [
    { key: 'standId', type: 'standRef' },
    { key: 'jetBridge', type: 'bool' },
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
  ],
  baggageSort: [{ key: 'capacityPerMin', type: 'int', min: 1, max: 500 }],
  serviceArea: [],
  parking: [{ key: 'spaces', type: 'int', min: 0, max: 20000 }],
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
/** 滑走路の描画・占有上の半幅（タイル） */
export const RUNWAY_HALF_WIDTH = 1.5;
/** 滑走路保護区域（着陸帯）の半幅・端部延長（タイル）。誘導路以外は配置不可 */
export const STRIP_HALF_WIDTH = 3.5;
export const STRIP_END_EXTENSION = 2.5;

/** ゲートと紐付けスポットの最大距離（チェビシェフ距離、タイル） */
export const GATE_MAX_STAND_DISTANCE = 3;

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
  escalator: {
    defaultW: 2, defaultH: 1, minW: 1, minH: 1, zone: 'landside', zoneEditable: true,
    props: [{ key: 'travelSec', type: 'int', min: 5, max: 300 }], defaults: { travelSec: 30 },
  },
  elevator: {
    defaultW: 1, defaultH: 1, minW: 1, minH: 1, zone: 'landside', zoneEditable: true,
    props: [{ key: 'travelSec', type: 'int', min: 5, max: 300 }], defaults: { travelSec: 60 },
  },
};

export const TERMINAL_AREA_KINDS = Object.keys(TERMINAL_AREA_SPECS) as TerminalAreaKind[];
