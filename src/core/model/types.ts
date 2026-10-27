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
}

export interface Runway {
  id: string;
  name: string;
  /** 始点側の滑走路端（タイル中心） */
  start: Tile;
  heading: Heading;
  /** 中心線のタイルステップ数（斜めの場合は1ステップ = √2 タイル） */
  length: number;
  /** 舗装幅（m）。対応機種区分を決める */
  surfaceWidthM: 30 | 45 | 60;
  buildState: BuildState;
}

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
}

export type RoadClass = 'public' | 'service';

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
  | 'serviceArea'
  | 'parking';

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
  | 'elevator';

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

export const SCHEMA_VERSION = 2;

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
