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
export const TAXIWAY_DRAW_WIDTH_M = { S: 15, M: 23, L: 30, F: 38 } as const;

/** 道路・鉄道の描画幅（m、ゲームの表示用の値） */
export const ROAD_DRAW_WIDTH_M = { road: 12, rail: 8, walkway: 5, fuel: 2 } as const;

/** Vertical occupancy used by layout validation and 3D rendering (game display dimensions). */
export const FACILITY_HEIGHT_M: Partial<Record<FacilityKind, number>> = {
  terminal: 18, tower: 45, hangar: 24, maintenance: 14, fuelFarm: 10, fireStation: 9,
  gseBase: 6, baggageSort: 10, serviceArea: 6, parking: 3, gate: 6, apron: 0.2, boardingBridge: 6, agtStation: 6,
  railStation: 8, taxiStand: 2, busStop: 3, busTerminal: 6, cargoTerminal: 9, staffParking: 1, hotel: 18,
  shoppingMall: 12, culturalHall: 10, park: 1,
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
  apron: { layer: 'apron', defaultW: 12, defaultH: 8, resizable: true, minW: 2, minH: 2, dragPlace: true, needsAirsideAccess: false },
  terminal: { layer: 'building', defaultW: 20, defaultH: 8, resizable: true, minW: 2, minH: 2, dragPlace: true, needsAirsideAccess: false },
  gate: { layer: 'gate', defaultW: 1, defaultH: 1, resizable: false, minW: 1, minH: 1, dragPlace: false, needsAirsideAccess: false },
  // 機能H: 搭乗橋（PBB）。ロタンダ基部 1×1、回転可。占有レイヤーはゲートと同じ 'gate'、
  // 垂直区間は地上 3〜6m の帯（model/levels の facilityVerticalRange で特例）
  boardingBridge: { layer: 'gate', defaultW: 1, defaultH: 1, resizable: false, minW: 1, minH: 1, dragPlace: false, needsAirsideAccess: false },
  // 機能I: AGT の駅。1×2 または 2×2（design-GHIJ-detail.md §I.2）。建物内にも単独にも置ける
  agtStation: { layer: 'building', defaultW: 2, defaultH: 1, resizable: true, minW: 1, minH: 1, dragPlace: false, needsAirsideAccess: false },
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
  shoppingMall: { layer: 'building', defaultW: 8, defaultH: 5, resizable: false, minW: 8, minH: 5, dragPlace: false, needsAirsideAccess: false },
  culturalHall: { layer: 'building', defaultW: 6, defaultH: 4, resizable: false, minW: 6, minH: 4, dragPlace: false, needsAirsideAccess: false },
  park: { layer: 'area', defaultW: 8, defaultH: 5, resizable: true, minW: 2, minH: 2, dragPlace: true, needsAirsideAccess: false },
};

export const FACILITY_KINDS = Object.keys(FACILITY_SPECS) as FacilityKind[];

/**
 * 施設種別の sim 効果分類（UI 改善 案3）。表示専用の静的分類で、sim の計算には使わない。
 * - 'active': sim / economy / access のいずれかが、その施設または props を実際に参照している
 * - 'displayOnly': 数値 props は表示・入力できるが、その値自体は sim で消費されない
 * - 'none': sim 上の効果がない
 * 根拠が確認できない種別はここに載せない（= 分類対象外。バッジも出さない）。
 * 根拠のない種別を推測で 'none' / 'displayOnly' にしないこと（Phase 6 計画 §4.1 と同じ原則）。
 */
export type FacilitySimEffect = 'active' | 'displayOnly' | 'none';

export const FACILITY_SIM_EFFECT: Partial<Record<FacilityKind, FacilitySimEffect>> = {
  // スタンドはエプロン面上に置くことが前提（validation/validate.ts のスタンド占有判定）
  apron: 'active',
  // 内部エリア・光熱費（economy/ops）の土台
  terminal: 'active',
  // standId / boardingMode / routeType を旅客搭乗とスポット割当が参照
  gate: 'active',
  // 型式・デッキを旅客の搭乗/降機速度が参照（core/model/boardingBridge 経由で sim/passengers）
  boardingBridge: 'active',
  // 機能I: 経路探索（findTerminalTransferRoute）への辺の合成と容量予約が systemId / segments を参照
  agtStation: 'active',
  // 夜間整備枠（1 棟 = 1 機。core/capability maintenanceReading、sim/overnight）
  hangar: 'active',
  // 管制能力 towerCapacityPerHour（core/safety）
  tower: 'active',
  // bays / engineers を整備・地上支援が参照
  maintenance: 'active',
  // 表示のみなのは props.capacityKL（貯蔵量）だけ: 在庫の消費・残量は未実装で、
  // capacityKL は sim のどこからも読まれない。施設の存在自体は給油の前提
  // （sim/context の hasFuelFarm、layout/fuelHydrants の配管→給油）なので、
  // バッジ文言は「貯蔵量」に対するものとして出す
  fuelFarm: 'displayOnly',
  // 消防カテゴリ（core/safety）
  fireStation: 'active',
  // staff / 車両台数が地上支援ユニットになる（sim/context の bases）
  gseBase: 'active',
  // capacityPerMin を手荷物仕分けが参照（sim/context の sorters、sim/baggage）
  baggageSort: 'active',
  // sim / economy / access のどこからも参照がない（配置と、重なり検証での
  // エリア重なりの例外扱いのみ。validation/validate.ts）
  serviceArea: 'none',
  // spaces が駐車容量・満車・駐車収入に効く（access/model、economy）
  parking: 'active',
  // berths がタクシー能力に効く（access/model）
  taxiStand: 'active',
  // busBays / busesPerHour がバス能力に効く（access/model）
  busStop: 'active',
  // berths / busesPerHour がバス能力に効く（access/model、core/capability の adapter）
  busTerminal: 'active',
  // throughputM3PerHour が貨物荷役に効く（economy/cargo）
  cargoTerminal: 'active',
  // trainsPerHour / platforms が鉄道能力に効く（access/model）
  railStation: 'active',
  // spaces は使われている: access/model が staffSpaces（道路に接した施設の合計）を出し、
  // 不足分は economy/ops dailyFixedCosts の通勤対策費（staffCommute、600 円/台/日）になる。
  // ※ 計画書（ui-improvement-plan-p1-3）の「spaces 未使用」という前提はこのコードと異なるため 'active' とした
  staffParking: 'active',
  // rooms が宿泊収入（economy/ops の hotelPerRoomNight）と access の hotelRooms に効く
  hotel: 'active',
  // 運航 sim には影響しないが、economy/city の residentFacilityBonus が住民満足度の
  // 日次プラスとして参照する（機能E拡張2）。プラス量は BALANCE.noise.residentFacilities
  shoppingMall: 'active',
  culturalHall: 'active',
  park: 'active',
};

export type PropDef =
  | { key: string; type: 'int'; min: number; max: number }
  | { key: string; type: 'bool' }
  | { key: string; type: 'enum'; options: readonly string[] }
  /** スポットIDへの参照 */
  | { key: string; type: 'standRef' }
  /** 施設（種類 of）への参照。null = 未指定（欠落と同じ） */
  | { key: string; type: 'facilityRef'; of: FacilityKind }
  /** AGT 系統（AgtSystem）への参照。null = 未指定（欠落と同じ）。機能I */
  | { key: string; type: 'agtSystemRef' };

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
  terminal: [
    { key: 'levels', type: 'int', min: 1, max: 4 },
    /** エリアを置ける相対階の下限（機能G。欠落 = -3 = TERMINAL_AREA_MIN_LEVEL、従来どおり）。建物生成では 0 を書く */
    { key: 'floorRangeMin', type: 'int', min: -3, max: 3 },
    /** エリアを置ける相対階の上限（機能G。欠落 = levels − 1、従来どおり） */
    { key: 'floorRangeMax', type: 'int', min: -3, max: 3 },
  ],
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
  // 機能H: 搭乗橋（PBB）のインスタンス props。型式パラメータ自体は PBB_TYPES（下記）に持ち、ここには持たない
  boardingBridge: [
    /** 紐付く搭乗ゲート（必須） */
    { key: 'gateId', type: 'facilityRef', of: 'gate' },
    /** 紐付くスポット（必須。ゲートの standId と一致すること） */
    { key: 'standId', type: 'standRef' },
    /** 型式（= トンネル本数の設定: tunnel1 = 1本、tunnel2 / tunnel2Upper = 2本） */
    { key: 'bridgeType', type: 'enum', options: ['tunnel1', 'tunnel2', 'tunnel2Upper'] },
    /** この基が接続するデッキ（tunnel2Upper の2基目は 'upper'） */
    { key: 'deck', type: 'enum', options: ['main', 'upper'] },
  ],
  // 機能I: AGT の駅。系統所属は systemId（1 駅 = 1 系統）、ホーム数は表示・将来拡張用（容量計算には入れない）
  agtStation: [
    { key: 'systemId', type: 'agtSystemRef' },
    { key: 'platforms', type: 'int', min: 1, max: 4 },
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
  shoppingMall: [],
  culturalHall: [],
  park: [],
};

export const DEFAULT_PROPS: Record<FacilityKind, Record<string, PropValue>> = {
  apron: {},
  terminal: { levels: 2 },
  gate: { standId: null, jetBridge: true },
  boardingBridge: { gateId: null, standId: null, bridgeType: 'tunnel1', deck: 'main' },
  agtStation: { systemId: null, platforms: 2 },
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
  shoppingMall: {},
  culturalHall: {},
  park: {},
};

/** スポットの寸法（幅 = 機首と直交方向、奥行き = 機首方向）。入口は中央に最も近いタイルに置くため偶数幅も可 */
export const STAND_DIMS: Record<SizeClass, { w: number; d: number }> = {
  S: { w: 2, d: 2 },
  M: { w: 3, d: 2 },
  L: { w: 4, d: 4 },
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

/** ゲートと紐付けスポットの最大距離（チェビシェフ距離、タイル）。
 * スポット寸法改定（奥行き縮小）で既存配置の距離が最大 2 タイル増えるため 3 → 5 に緩和 */
export const GATE_MAX_STAND_DISTANCE = 5;
/** 独立ゲートの連絡通路の長さの警告しきい値（タイル。1.5 km） */
export const GATE_CONNECTOR_MAX_TILES = 60;

// ---------------------------------------------------------------- 搭乗橋（PBB、機能H）

/** 搭乗橋の型式。ユーザー指定の「1本/2本」は型式で表す: tunnel1 = 1本、tunnel2 / tunnel2Upper = 2本 */
export type PbbBridgeType = 'tunnel1' | 'tunnel2' | 'tunnel2Upper';

/** 搭乗橋1基が接続するデッキ */
export type PbbDeck = 'main' | 'upper';

export interface PbbTypeSpec {
  /** トンネル本数 */
  tunnels: 1 | 2;
  /** 主デッキのドアシル高の適合範囲（m） */
  sillMain: { min: number; max: number };
  /** 上デッキのドアシル高の適合範囲（m）。上デッキに接続できない型式は null */
  sillUpper: { min: number; max: number } | null;
  /** 搭乗速度（秒/人）。upper は上デッキ側の1基ぶん */
  boardSecPerPax: { main: number; upper?: number };
  /** 降機速度（人/分）。upper は上デッキ側の1基ぶん */
  deplanePerMin: { main: number; upper?: number };
  /** 建設費（cr）。tunnel1 は従来の jetBridge 上乗せ（economy/balance の jetBridge）と同額 */
  cost: number;
}

/**
 * 搭乗橋の型式パラメータ（インスタンス props には持たず、型式で引く）。
 * tunnel1 の搭乗 3.0 秒/人・降機 20 人/分は、従来の橋の定数（sim/passengers の
 * BOARD_SEC_PER_PAX.bridge / DEPLANE_PAX_PER_MIN.bridge）と一致させること
 * （互換合成の等価性 = ゴールデン不変の根拠。design-GHIJ-detail.md §H.2）。
 */
export const PBB_TYPES: Record<PbbBridgeType, PbbTypeSpec> = {
  tunnel1: {
    tunnels: 1, sillMain: { min: 2.0, max: 4.6 }, sillUpper: null,
    boardSecPerPax: { main: 3.0 }, deplanePerMin: { main: 20 }, cost: 150_000,
  },
  tunnel2: {
    tunnels: 2, sillMain: { min: 2.0, max: 5.4 }, sillUpper: null,
    boardSecPerPax: { main: 2.4 }, deplanePerMin: { main: 24 }, cost: 260_000,
  },
  tunnel2Upper: {
    tunnels: 2, sillMain: { min: 2.0, max: 5.4 }, sillUpper: { min: 6.8, max: 8.6 },
    boardSecPerPax: { main: 2.2, upper: 3.0 }, deplanePerMin: { main: 26, upper: 26 }, cost: 420_000,
  },
};

/**
 * 機体ドアシル高（m）。機種カタログに実値が無いため SizeClass からのゲーム値
 * （status: game。UI ではゲーム値と分かるように出すこと。H-U4）。
 * 判定はこの表で行い、機体全高（heightM）では行わない。
 */
export const DOOR_SILL_M: Record<SizeClass, number> = { S: 2.6, M: 3.4, L: 4.7 };
/** 2階建て機の上デッキのドアシル高（m、ゲーム値） */
export const DOOR_SILL_UPPER_M = 7.9;

// ---------------------------------------------------------------- AGT（機能I）

/**
 * AGT 系統パラメータの範囲（design-GHIJ-detail.md §I.2 / §I.4）。
 * 操作（operations）と検証（validate）の両方がこの表で弾く。
 */
export const AGT_PARAM_RANGES = {
  vehicleCapacity: { min: 10, max: 600 },
  headwaySec: { min: 30, max: 1800 },
  dwellSec: { min: 5, max: 120 },
  speedMps: { min: 5, max: 25 },
} as const;

/** AGT 系統の既定パラメータ（UI の新規作成フォームの初期値） */
export const AGT_SYSTEM_DEFAULTS = { vehicleCapacity: 100, headwaySec: 180, dwellSec: 20, speedMps: 12 } as const;

/**
 * セグメント距離の導出に使う迂回係数。terminal/model の独立ゲート接続路
 * （CONNECTOR_DETOUR = 1.25、直線 × TILE_M × 1.25）と同じ流儀で、駅中心間の
 * 直線距離に掛ける。導出値は AgtSegment.distanceM に固定して保存し、再計算しない。
 */
export const AGT_SEGMENT_DETOUR = 1.25;

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
  // ラウンジ（5-19 2A）: 購買施設ではなく「搭乗までの滞在の質」の施設。収容は席数ベースで、
  // 利用資格・滞在モデルは terminal/serviceProfile.ts（isLoungeEligible）と
  // terminal/serviceDetailSim.ts の lounge ステップが持つ。shop/restaurant の派生ではない。
  lounge: {
    defaultW: 4, defaultH: 2, minW: 1, minH: 1, zone: 'departure', zoneEditable: true,
    props: [{ key: 'seats', type: 'int', min: 0, max: 5000 }], defaults: { seats: 40 },
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
