import type { CrossingMaxCode, SizeClass } from '../model/types';
import { DEFAULT_LEVEL_HEIGHT_M } from '../model/levels';
import { TICK_SEC } from './rules';
import { CATALOG, codeLetterOf, sizeClassOf, type AircraftModel, type GameProfile } from '../aircraft/catalog';

/**
 * シミュレーションが使う機種の属性（機種カタログ core/aircraft/catalog.ts から作る）。
 * 寸法・重量は実機データ（カタログの official 値）があればそれを使い、性能・作業時間はゲーム用の設定値。
 *
 * シミュレーションは SimContext.types（このテーブル）だけを参照する。保存済みプロジェクトを開くときは、
 * 保存時の機種データ（スナップショット）からテーブルを作るので、カタログを更新しても過去の結果は変わらない。
 */
export interface AircraftType {
  /** 機種ID（便・契約・保存データはこの ID で機種を参照する） */
  id: AircraftTypeId;
  label: string;
  /** 短い表示名（ICAO コードがあればそれ） */
  shortLabel: string;
  /** 旧形式の汎用機材 */
  generic: boolean;
  /** カタログにもスナップショットにもない機種ID（代替の値で動かしている） */
  unresolved: boolean;
  size: SizeClass;
  /** コード F 対応の施設が必要（翼幅 65 m 以上） */
  codeF: boolean;
  /** 航空会社の座席構成を指定しないときの座席数 */
  seats: number;
  /** 最大旅客定員（不明は null） */
  maxPax: number | null;
  /** 最大離陸重量（t）。着陸料の計算に使う */
  mtowT: number;
  /** 機体長・翼幅・全高（m）。誘導路の予約解放・表示の大きさに使う */
  lengthM: number;
  wingspanM: number;
  heightM: number | null;
  /** 2階建て客室（表示・搭乗橋の情報に使う） */
  doubleDeck: boolean;
  engines: number;
  /** 誘導路の最高速度（m/s） */
  taxiSpeed: number;
  /** 進入・接地速度（m/s） */
  approachSpeed: number;
  /** 接地から離脱速度まで減速するのに最低限必要な距離（m） */
  landingRollM: number;
  /** 離陸滑走の加速度（m/s²）と浮揚速度（m/s） */
  takeoffAccel: number;
  rotateSpeed: number;
  /** 最小折り返し時間（秒） */
  turnaroundSec: number;
  holdBags: number;
  taskSec?: GameProfile['taskSec'];
  unitNeeds?: GameProfile['unitNeeds'];
  costPerBlockHour: number;
}

export type AircraftTypeId = string;
export type TypeTable = Record<string, AircraftType>;

export function typeFromModel(m: AircraftModel): AircraftType {
  const { size, codeF } = sizeClassOf(m);
  const p = m.profile;
  return {
    id: m.id,
    label: m.name,
    shortLabel: m.icao ? `${m.icao}` : m.name.replace(/^汎用 /, ''),
    generic: m.generic,
    unresolved: false,
    size,
    codeF,
    seats: m.defaultSeats,
    maxPax: m.maxPax.value,
    mtowT: p.mtowT,
    lengthM: m.lengthM.value ?? 40,
    wingspanM: m.wingspanM.value ?? 40,
    heightM: m.heightM.value,
    doubleDeck: m.doubleDeck,
    engines: m.engines,
    taxiSpeed: p.taxiSpeed,
    approachSpeed: p.approachSpeed,
    landingRollM: p.landingRollM,
    takeoffAccel: p.takeoffAccel,
    rotateSpeed: p.rotateSpeed,
    turnaroundSec: p.turnaroundSec,
    holdBags: p.holdBags,
    ...(p.taskSec ? { taskSec: p.taskSec } : {}),
    ...(p.unitNeeds ? { unitNeeds: p.unitNeeds } : {}),
    costPerBlockHour: p.costPerBlockHour,
  };
}

/** 機種データ（カタログまたは保存時のスナップショット）から機種テーブルを作る */
export function buildTypeTable(models: Record<string, AircraftModel> = CATALOG): TypeTable {
  return Object.fromEntries(Object.values(models).map((m) => [m.id, typeFromModel(m)]));
}

/** 現在のカタログの機種テーブル（UI・新規作成の既定値） */
export const AIRCRAFT_TYPES: TypeTable = buildTypeTable();
export const AIRCRAFT_TYPE_IDS: AircraftTypeId[] = Object.keys(AIRCRAFT_TYPES);

/** Unknown-height and future aircraft get a conservative envelope instead of being treated as zero-height. */
export const UNKNOWN_AIRCRAFT_HEIGHT_M = 30;
export const AIRCRAFT_CLEARANCE_MARGIN_M = 3;

export function requiredAircraftClearanceM(types: TypeTable = AIRCRAFT_TYPES): number {
  return Math.max(
    UNKNOWN_AIRCRAFT_HEIGHT_M,
    ...Object.values(types).map((type) => type.heightM ?? UNKNOWN_AIRCRAFT_HEIGHT_M),
  ) + AIRCRAFT_CLEARANCE_MARGIN_M;
}

/**
 * 宣言されたコード区分に対する必要クリアランス（J-1 の宣言方式）:
 * そのコード区分（翼幅からのコード文字）に属し、高さが既知の機種の最大尾翼高 + 余裕。
 * 高さ不明の機種（汎用機材などのプレースホルダ）は区分の最大に数えない
 * （区分全体が未知機種の保守値に引っ張られないようにするため）。
 * 区分内に高さ既知の機種が無ければ全体基準と同じ保守値に落とす。
 */
export function requiredClearanceForCode(code: CrossingMaxCode, types: TypeTable = AIRCRAFT_TYPES): number {
  const heights = Object.values(types)
    .filter((type) => type.heightM !== null && codeLetterOf(type.wingspanM) === code)
    .map((type) => type.heightM as number);
  return (heights.length ? Math.max(...heights) : UNKNOWN_AIRCRAFT_HEIGHT_M) + AIRCRAFT_CLEARANCE_MARGIN_M;
}

/** 宣言コードに対するデッキ床高: 必要クリアランスを満たす最小の層（1層 = DEFAULT_LEVEL_HEIGHT_M）の床高 */
export function deckElevationForCode(code: CrossingMaxCode, types: TypeTable = AIRCRAFT_TYPES): number {
  const clearance = requiredClearanceForCode(code, types);
  return Math.ceil(clearance / DEFAULT_LEVEL_HEIGHT_M) * DEFAULT_LEVEL_HEIGHT_M;
}

/**
 * 機種を引く。テーブルにない ID は「未解決の機種」として汎用ナローボディ機の値で代替する
 * （データは消さず、表示・検証で未解決であることを示す）。
 */
export function resolveType(types: TypeTable, id: AircraftTypeId): AircraftType {
  const t = types[id];
  if (t) return t;
  const base = AIRCRAFT_TYPES.narrow180!;
  return { ...base, id, label: `未解決の機種（${id}）`, shortLabel: `?${id}`, generic: false, unresolved: true };
}

/** 浮揚までの離陸滑走距離（m） */
export function takeoffDistanceM(t: AircraftType): number {
  return (t.rotateSpeed * t.rotateSpeed) / (2 * t.takeoffAccel);
}

/**
 * 離陸滑走の所要時間（秒）。実際の積分（`speed += a·dt; dist += speed·dt` を 1 tick ずつ）が浮揚距離に届く最小の tick 数 × TICK_SEC。
 * 連続式 sqrt(2D/a) より最大 1 tick 長い。夜間規制の予測（simulation.ts departureBlocked）と実際の離陸時刻を一致させるために使う（1-13 / D-2）。
 */
export function takeoffRollSec(t: AircraftType): number {
  const accel = t.takeoffAccel;
  const target = takeoffDistanceM(t);
  let speed = 0;
  let dist = 0;
  let ticks = 0;
  while (dist < target && ticks < 100_000) {
    speed += accel * TICK_SEC;
    dist += speed * TICK_SEC;
    ticks++;
  }
  return ticks * TICK_SEC;
}
