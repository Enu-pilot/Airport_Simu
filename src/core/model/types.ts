import type { Tile } from '../geometry/vec';

/**
 * 空港レイアウト（建設レイヤー）のデータモデル。
 *
 * - プレイヤーが編集するのはこのデータのみ。航空機の通行可能性を表す論理ネットワークは
 *   `airside/network.ts` でこのデータから決定的に導出する（保存しない）。
 * - すべてのエンティティは接頭辞付きの安定ID（例: "rwy_1", "tn_12"）を持ち、IDは再利用しない。
 * - エンティティ間の参照はIDで持つ。
 */

export type SizeClass = 'S' | 'M' | 'L';
export const SIZE_ORDER: Record<SizeClass, number> = { S: 1, M: 2, L: 3 };
export const sizeAtLeast = (a: SizeClass, b: SizeClass): boolean => SIZE_ORDER[a] >= SIZE_ORDER[b];
export const minSize = (a: SizeClass, b: SizeClass): SizeClass => (SIZE_ORDER[a] <= SIZE_ORDER[b] ? a : b);

/**
 * 建設状態。
 * - planned: 計画のみ（配置案）
 * - underConstruction: 建設中
 * - operational: 完成・運用可能
 * planned / underConstruction は論理ネットワーク上で `operational: false` となり、運用には使われない。
 */
export type BuildState = 'planned' | 'underConstruction' | 'operational';
export const BUILD_STATES: readonly BuildState[] = ['planned', 'underConstruction', 'operational'];

/** 建物・スポットの向き（時計回り、0 = 北向き） */
export type Rotation = 0 | 90 | 180 | 270;

/** 滑走路の向き（始点→終点の方位。時計回り、0 = 北 = 画面上方向） */
export type Heading = 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315;
export const HEADINGS: readonly Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];

export type TerrainType = 0 | 1 | 2 | 3 | 4;
export const Terrain = {
  grass: 0,
  forest: 1,
  water: 2,
  rock: 3,
  /** 敷地外（未取得地） */
  offsite: 4,
} as const satisfies Record<string, TerrainType>;

export interface Site {
  width: number;
  height: number;
  /** 行優先 (y * width + x) */
  terrain: TerrainType[];
  seed: string;
  /** 購入した土地のタイル数（Phase 6。未設定は 0） */
  purchased?: number;
}

/** 滑走路番号の接尾辞。'none' = 明示的に付けない（欠落 = 自動） */
export type RunwaySuffix = 'L' | 'C' | 'R' | 'none';

interface RunwayBase {
  id: string;
  name: string;
  /** 舗装幅（m）。対応機種区分を決める */
  surfaceWidthM: 30 | 45 | 60;
  buildState: BuildState;
  /** 始点側の番号の接尾辞の上書き（表示のみ。終点側は L↔R を入れ替える）。欠落 = 自動 */
  designatorSuffix?: RunwaySuffix;
}

/** 従来形（v1/v2 のデータはすべてこれ）。データも意味も永久に不変 */
export interface RunwayGrid8 extends RunwayBase {
  alignment?: undefined;
  /** 始点側の滑走路端（タイル中心） */
  start: Tile;
  heading: Heading;
  /** 中心線のタイルステップ数（斜めの場合は1ステップ = √2 タイル） */
  length: number;
}

/** 自由形の実寸（すべて m。欠落 = ゲーム既定値） */
export interface RunwayDims {
  /** 片側の肩の幅 */
  shoulderWidthM?: number;
  /** 着陸帯の半幅（中心線から） */
  stripHalfWidthM?: number;
  /** 着陸帯の端部延長（滑走路端から） */
  stripEndM?: number;
  /** RESA の長さ（着陸帯の端から外側へ。0 = なし） */
  resaLengthM?: number;
  /** RESA の全幅 */
  resaWidthM?: number;
  /** 停止位置（中心線からの垂直距離） */
  holdingPositionM?: number;
  /** 始点・終点の標高（表示・勾配の計算のみ） */
  elevationStartM?: number;
  elevationEndM?: number;
}

/** 自由方位・実寸（Phase 12〜） */
export interface RunwayFree extends RunwayBase {
  alignment: 'free';
  /** 始点（World フレーム、タイル単位。実数可） */
  start: Tile;
  /** 真方位（度、[0, 360)） */
  headingDeg: number;
  /** 実長（m）。正の有限の実数。丸めない */
  lengthM: number;
  dims?: RunwayDims;
}

export type Runway = RunwayGrid8 | RunwayFree;
export const isFreeRunway = (r: Runway): r is RunwayFree => r.alignment === 'free';

/** 誘導路・道路ネットワークのノード（交差点・滑走路入口・端点） */
export interface NetNode {
  id: string;
  pos: Tile;
  name: string;
  /**
   * 滑走路入口ノードでの停止義務（ホールディングポイント）。
   * 滑走路上にあるノードでのみ意味を持つ。
   */
  holdShort: boolean;
}

export interface TaxiwayEdge {
  id: string;
  from: string;
  to: string;
  name: string;
  /** 通行可能な最大機体区分（誘導路幅に相当） */
  widthClass: SizeClass;
  /** true の場合 from → to の一方通行 */
  oneWay: boolean;
  buildState: BuildState;
  /** コード F（翼幅 65〜80 m）の機体が通行できる（L 級のみ意味を持つ。Phase 7） */
  codeF?: boolean;
}

/** public: 一般道路 / service: 構内サービス道路（業務用）/ rail: 鉄道（空港連絡線） */
export type RoadClass = 'public' | 'service' | 'rail';

export interface RoadEdge {
  id: string;
  from: string;
  to: string;
  name: string;
  /** public: 一般道（旅客アクセス） / service: 構内サービス道路（GSE） */
  roadClass: RoadClass;
  oneWay: boolean;
  buildState: BuildState;
}

export interface Stand {
  id: string;
  name: string;
  /** 回転後の外接矩形の左上タイル */
  origin: Tile;
  /** 機首の向き。入口（プッシュバック側）は機首の反対側 */
  rotation: Rotation;
  size: SizeClass;
  buildState: BuildState;
  /** コード F（翼幅 65〜80 m）の機体を駐機できる（L 級のみ意味を持つ。Phase 7） */
  codeF?: boolean;
}

export type FacilityKind =
  | 'apron'
  | 'terminal'
  | 'gate'
  | 'hangar'
  | 'tower'
  | 'maintenance'
  | 'fuelFarm'
  | 'fireStation'
  | 'gseBase'
  | 'baggageSort'
  | 'serviceArea'
  | 'parking'
  // 空港アクセス・周辺施設（Phase 6）
  | 'taxiStand'
  | 'busStop'
  | 'railStation'
  | 'staffParking'
  | 'hotel';

export type PropValue = string | number | boolean | null;

export interface Facility {
  id: string;
  kind: FacilityKind;
  name: string;
  /** 回転後の外接矩形の左上タイル */
  origin: Tile;
  /** 回転前の幅・奥行き（タイル） */
  w: number;
  h: number;
  rotation: Rotation;
  buildState: BuildState;
  /** 種別ごとのプロパティ（catalog の PROP_SCHEMAS 参照） */
  props: Record<string, PropValue>;
}

/** ターミナル内部のエリア種別 */
export type TerminalAreaKind =
  | 'entrance'
  | 'exit'
  | 'checkIn'
  | 'security'
  | 'departureLobby'
  | 'waiting'
  | 'restroom'
  | 'arrivalCorridor'
  | 'baggageClaim'
  | 'hall'
  | 'escalator'
  | 'elevator'
  | 'shop'
  | 'restaurant';

/**
 * 旅客の区域。landside = 保安検査前（一般区域）、departure = 保安検査後の出発区域、arrival = 到着区域。
 * 区域をまたぐ移動は保安検査（landside → departure）と手荷物受取所・出口（arrival → landside）でのみ可能。
 */
export type PaxZone = 'landside' | 'departure' | 'arrival';

/** ターミナル内部のエリア（ターミナルの敷地内、階ごとの矩形） */
export interface TerminalArea {
  id: string;
  terminalId: string;
  /** 階（0 = 1F） */
  level: number;
  kind: TerminalAreaKind;
  name: string;
  origin: Tile;
  w: number;
  h: number;
  zone: PaxZone;
  props: Record<string, PropValue>;
}

/**
 * レイアウトの保存形式の版。
 * 3（Phase 12）: 自由形の滑走路・磁気偏角・ルール切替・TaxiwayEdge.geometry（Phase 13）など、任意項目の追加のみ。
 * v2 のデータはそのまま妥当な v3 なので、移行は何も書き換えない（`layout.schemaVersion` も 2 のまま。docs/21）。
 */
export const SCHEMA_VERSION = 3;

export interface AirportLayout {
  schemaVersion: number;
  name: string;
  site: Site;
  /** ID発行カウンタ（接頭辞ごと、単調増加） */
  counters: Record<string, number>;
  runways: Record<string, Runway>;
  taxiNodes: Record<string, NetNode>;
  taxiways: Record<string, TaxiwayEdge>;
  roadNodes: Record<string, NetNode>;
  roads: Record<string, RoadEdge>;
  stands: Record<string, Stand>;
  facilities: Record<string, Facility>;
  terminalAreas: Record<string, TerminalArea>;
  /** 磁気偏角（度、東偏差を正、[-180, 180]）。欠落 = 0（手入力のみ） */
  magneticVariationDeg?: number;
  /** 判定ルール。欠落 = 'classic' */
  ruleSet?: 'classic' | 'realistic';
}

export type EntityType = 'runway' | 'taxiNode' | 'taxiway' | 'roadNode' | 'road' | 'stand' | 'facility' | 'terminalArea';

export const ID_PREFIX: Record<EntityType, string> = {
  runway: 'rwy',
  taxiNode: 'tn',
  taxiway: 'twy',
  roadNode: 'rn',
  road: 'rd',
  stand: 'std',
  facility: 'fac',
  terminalArea: 'ta',
};

const PREFIX_TO_TYPE: Record<string, EntityType> = Object.fromEntries(
  Object.entries(ID_PREFIX).map(([t, p]) => [p, t as EntityType]),
);

/** ID の接頭辞からエンティティ種別を判定する */
export function entityTypeOf(id: string): EntityType | null {
  const prefix = id.slice(0, id.indexOf('_'));
  return PREFIX_TO_TYPE[prefix] ?? null;
}
