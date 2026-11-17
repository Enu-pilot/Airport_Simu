import type { AircraftTypeId } from '../sim/aircraftTypes';

/**
 * 登録データ（就航都市・航空会社・国・地域）の型。
 * データの足し方は docs/43_data_extension_guide.md を参照。数値はすべてゲーム内の値。
 */

export type AirlineType = 'fullService' | 'lcc' | 'regional';
export type AirlineService = 'domesticPassenger' | 'internationalPassenger' | 'cargo';

export interface Unlock {
  /** 空港評価 0〜100。既定 0（旧 minimumAirportRating） */
  minRating?: number;
  /** 空港の格 0〜5。既定 0。フェーズ 3 では保持と検証だけ（判定は 4-01） */
  minTier?: number;
}

export interface CountryDef {
  id: string;
  name: string;
  regionId: string;
}

export interface RegionDef {
  id: string;
  name: string;
}

export interface DestinationInput {
  /** 必須。/^[A-Z][A-Z0-9]{2}$/。保存データの参照キー（変えない） */
  id: string;
  /** 必須。表示名 */
  name: string;
  /** 必須。COUNTRY_DATA に存在すること */
  countryId: string;
  /** 必須。自空港からのゲーム上の距離 50〜20,000 km */
  distanceKm: number;
  /** 必須。都市規模（人）1,000〜40,000,000 */
  population: number;
  /** 既定: 国の regionId */
  regionId?: string;
  /** 表示用。既定なし */
  coordinates?: { latitude: number; longitude: number };
  /** 各 0.1〜3.0、既定 1.0 */
  demand?: { business?: number; leisure?: number; cargo?: number };
  /** 相手空港の混雑度 0〜1、既定 0.3（提案の便数上限に効く） */
  congestion?: number;
  unlock?: Unlock;
  /** 旧モデルの需要係数 0.3〜2.0。legacy 項目は必須、新規項目は既定 1.0 */
  passengerDemand?: number;
  /** フェーズ 3 以前からある項目（旧ルールの会社でも使う）。新規項目には付けない */
  legacy?: true;
  /** 新規の提案・一覧に出さないが、既存契約の参照は解決できる（削除の代わり） */
  retired?: true;
}

export interface AirlineInput {
  /** 必須。/^[A-Z][A-Z0-9]$/（2 文字） */
  id: string;
  /** 必須 */
  name: string;
  /** 必須 */
  type: AirlineType;
  /** 必須。1 件以上 */
  services: AirlineService[];
  /** 必須。1 件以上。機種は AIRCRAFT_TYPES に存在、座席 1〜機種の maxPax */
  fleet: { typeId: AircraftTypeId; seats: number }[];
  /** 便名の接頭辞。既定 = id */
  code?: string;
  /** 採算の基準搭乗率 0.3〜0.95。既定は種別値 */
  baseLoadFactor?: number;
  /** 運賃水準 0.5〜2.0。既定は種別値 */
  fareLevel?: number;
  /** 0〜1。既定は種別値 */
  priceSensitivity?: number;
  /** 求める定時率 0.5〜0.99。既定は種別値 */
  minOtp?: number;
  /** 拠点にできるか（4-04 用。フェーズ 3 では保持と検証のみ）。既定 false */
  canBase?: boolean;
  unlock?: Unlock;
  /** 塗装色 0x000000〜0xffffff。省略時は既定塗装 */
  livery?: { body: number; tail: number; stripe: number; engine: number };
  legacy?: true;
  retired?: true;
}

export interface DestinationDef {
  id: string;
  name: string;
  countryId: string;
  regionId: string;
  /** 表示用。入力で省略した場合は 0,0（検証で warn を出す） */
  coordinates: { latitude: number; longitude: number };
  distanceKm: number;
  /** 旅客搭乗率に掛ける需要係数（旧モデル） */
  passengerDemand: number;
  /** 貨物需要の指数（= demand.cargo） */
  cargoDemand: number;
  /** 新規路線の提示に必要な空港評価（= unlock.minRating） */
  minimumAirportRating?: number;
  population: number;
  demand: { business: number; leisure: number; cargo: number };
  congestion: number;
  unlock: Unlock;
  scope: 'domestic' | 'international';
  legacy: boolean;
  retired: boolean;
}

export interface FleetEntry {
  typeId: AircraftTypeId;
  /** この航空会社の座席数（同じ機種でも航空会社ごとに違ってよい） */
  seats: number;
}

export interface AirlineDef {
  id: string;
  code: string;
  name: string;
  type: AirlineType;
  fleet: FleetEntry[];
  priceSensitivity: number;
  minOtp: number;
  minimumAirportRating?: number;
  services: AirlineService[];
  baseLoadFactor: number;
  fareLevel: number;
  canBase: boolean;
  unlock: Unlock;
  livery?: { body: number; tail: number; stripe: number; engine: number };
  legacy: boolean;
  retired: boolean;
}

/** 種別ごとの既定値（計画 §1.2。BALANCE.demand.baseLoadFactor と同値に保つ） */
export const AIRLINE_TYPE_DEFAULTS: Record<AirlineType, { baseLoadFactor: number; fareLevel: number; priceSensitivity: number; minOtp: number }> = {
  fullService: { baseLoadFactor: 0.78, fareLevel: 1.0, priceSensitivity: 0.3, minOtp: 0.82 },
  lcc: { baseLoadFactor: 0.86, fareLevel: 0.7, priceSensitivity: 0.8, minOtp: 0.7 },
  regional: { baseLoadFactor: 0.7, fareLevel: 0.9, priceSensitivity: 0.5, minOtp: 0.75 },
};
