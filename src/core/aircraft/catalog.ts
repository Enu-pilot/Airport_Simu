import type { SizeClass } from '../model/types';
import type { TaskKind, UnitKind } from '../sim/types';

/**
 * 航空機の機種カタログ（docs/16_aircraft_catalog.md）。
 *
 * - 機種は安定した ID（例: "B777-300", "B777-300ER"）で管理する。名前が似ていても派生型は別の機種として扱う。
 * - 寸法・重量・座席などの実機データには、値ごとに状態（status）と出典（source）を付ける:
 *     official = メーカーの公開資料で確認した値（出典 URL・参照日・値の定義つき）
 *     game     = ゲーム用の設定値（実機の値ではない。性能・地上作業時間・費用など）
 *     unset    = 公開資料で確認できなかったため未設定（実機の値を推定しない）
 * - カタログの版（CATALOG_VERSION）と保存形式の版は別物。収録データを直したら CATALOG_VERSION を上げる。
 * - ゲーム内の性能・適合性は簡略化モデルであり、実際の航空機の運用・空港の設計に使える値ではない。
 */

export const CATALOG_VERSION = '2026.10.1';

export type DataStatus = 'official' | 'game' | 'unset';

export interface Sourced<T> {
  value: T | null;
  status: DataStatus;
  /** DATA_SOURCES のキー */
  source?: string;
  /** 値の定義・注記（どの表のどの値か、範囲のうちどれを採ったか） */
  note?: string;
}

export interface DataSource {
  id: string;
  publisher: string;
  title: string;
  url: string;
  /** 参照日（このカタログを作成したときに資料を取得・照合した日） */
  accessed: string;
}

/** 参照した公開資料（すべて 2026-10-27 に取得して値を照合した） */
export const DATA_SOURCES: Record<string, DataSource> = {
  'boeing-737ng-acaps': {
    id: 'boeing-737ng-acaps',
    publisher: 'Boeing Commercial Airplanes',
    title: '737 Airplane Characteristics for Airport Planning, D6-58325-7 Rev C (October 2025) §2.1.3, §2.2.5, §2.2.6',
    url: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/737NG_REV_C.pdf',
    accessed: '2026-10-27',
  },
  'boeing-777-acaps': {
    id: 'boeing-777-acaps',
    publisher: 'Boeing Commercial Airplanes',
    title: '777-200/200ER/300 Airplane Characteristics for Airport Planning, D6-58329 Rev E (December 2024) §2.1.4–2.1.6, §2.2.2, §2.3.2',
    url: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/777-200-200ER-300_Rev_E.pdf',
    accessed: '2026-10-27',
  },
  'boeing-777er-acaps': {
    id: 'boeing-777er-acaps',
    publisher: 'Boeing Commercial Airplanes',
    title: '777-200LR/-300ER/-Freighter Airplane Characteristics for Airport Planning, D6-58329-2 Rev G (December 2024) §2.1.1, §2.2.2, §2.3.2',
    url: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/777-200LR-300ER-F_Rev_G.pdf',
    accessed: '2026-10-27',
  },
  'boeing-787-web': {
    id: 'boeing-787-web',
    publisher: 'Boeing',
    title: 'Boeing 787 Dreamliner（製品ページの 787-9 技術仕様）',
    url: 'https://www.boeing.com/commercial/787',
    accessed: '2026-10-27',
  },
  'airbus-a320ceo-web': {
    id: 'airbus-a320ceo-web',
    publisher: 'Airbus',
    title: 'A320ceo（製品ページの主要諸元）',
    url: 'https://aircraft.airbus.com/en/aircraft/a320-family/a320ceo',
    accessed: '2026-10-27',
  },
  'airbus-a320neo-web': {
    id: 'airbus-a320neo-web',
    publisher: 'Airbus',
    title: 'A320neo（製品ページの主要諸元）',
    url: 'https://aircraft.airbus.com/en/aircraft/a320-family/a320neo',
    accessed: '2026-10-27',
  },
  'airbus-a350-ff': {
    id: 'airbus-a350-ff',
    publisher: 'Airbus',
    title: 'A350 Family Facts and Figures, October 2024（A350 Technical Data 表）',
    url: 'https://www.airbus.com/sites/g/files/jlcbta136/files/2024-10/Airbus-A350-Family-Facts-and-Figures-October-2024.pdf',
    accessed: '2026-10-27',
  },
  'airbus-a380-ff': {
    id: 'airbus-a380-ff',
    publisher: 'Airbus',
    title: 'A380 Facts and Figures, February 2022（Dimensions / Operating data 表）',
    url: 'https://www.airbus.com/sites/g/files/jlcbta136/files/2022-02/Airbus-A380-Facts-and-Figures-February-2022.pdf',
    accessed: '2026-10-27',
  },
};

/**
 * ゲーム内の性能・地上作業のプロファイル（すべて status = game）。
 * 実機の性能ではなく、運航シミュレーションの挙動を決める設定値。
 */
export interface GameProfile {
  /** 誘導路の最高速度・進入速度（m/s）、着陸後の必要減速距離（m）、離陸の加速度（m/s²）と浮揚速度（m/s） */
  taxiSpeed: number;
  approachSpeed: number;
  landingRollM: number;
  takeoffAccel: number;
  rotateSpeed: number;
  /** 最小折り返し時間（秒）。計画のスケジュールに使う */
  turnaroundSec: number;
  /** 作業時間の上書き（秒）と、必要な作業員・車両の上書き */
  taskSec?: Partial<Record<TaskKind, number>>;
  unitNeeds?: Partial<Record<TaskKind, Partial<Record<UnitKind, number>>>>;
  /** 貨物室に積める手荷物の個数 */
  holdBags: number;
  /** 航空会社の運航費（1ブロック時間あたり、cr）。分析で使う参考値 */
  costPerBlockHour: number;
  /** 着陸料などに使う重量（t）。実機の最大離陸重量があればそれを使う */
  mtowT: number;
}

export interface AircraftModel {
  id: string;
  /** 旧形式の汎用機材（実在の機種ではない） */
  generic: boolean;
  manufacturer: string;
  family: string;
  /** 派生型（例: "-300ER"） */
  variant: string;
  /** 正式な機種名・派生型名 */
  name: string;
  /** ICAO の機種コード（汎用機材は null） */
  icao: string | null;
  lengthM: Sourced<number>;
  wingspanM: Sourced<number>;
  heightM: Sourced<number>;
  mtowKg: Sourced<number>;
  /** 最大旅客定員（認定・資料上の最大座席数） */
  maxPax: Sourced<number>;
  /** メーカー資料の標準座席数（記載のとおりの文字列） */
  typicalSeats: Sourced<string>;
  cargoM3: Sourced<number>;
  fuelL: Sourced<number>;
  /** 航空会社が座席数を指定しないときのゲーム内の座席数（ゲームの設定値） */
  defaultSeats: number;
  engines: number;
  doubleDeck: boolean;
  profile: GameProfile;
  /** 3D 表示のアセット（render3d/assets.ts） */
  assetId: string;
  /** このカタログでの最終更新日 */
  updated: string;
}

const off = <T>(value: T, source: string, note?: string): Sourced<T> => ({ value, status: 'official', source, ...(note ? { note } : {}) });
const game = <T>(value: T, note?: string): Sourced<T> => ({ value, status: 'game', ...(note ? { note } : {}) });
const unset = (note: string): Sourced<never> => ({ value: null, status: 'unset', note });

// ---------------------------------------------------------------- ゲーム用の性能テンプレート

const NARROW = { taxiSpeed: 8, approachSpeed: 70, landingRollM: 1300, takeoffAccel: 2.2, rotateSpeed: 72 };
const WIDE = { taxiSpeed: 7, approachSpeed: 75, landingRollM: 1800, takeoffAccel: 1.8, rotateSpeed: 80 };
const VERY_LARGE = { taxiSpeed: 6.5, approachSpeed: 72, landingRollM: 1900, takeoffAccel: 1.7, rotateSpeed: 80 };

/** 双通路機の地上作業: 荷下ろし・積み込みはベルトローダー・牽引車各2、給油車2、清掃は作業員6 */
const WIDE_NEEDS: GameProfile['unitNeeds'] = {
  unload: { beltLoader: 2, baggageTractor: 2, staff: 4 },
  load: { beltLoader: 2, baggageTractor: 2, staff: 4 },
  fuel: { fuelTruck: 2, staff: 2 },
  clean: { cleaningVan: 1, staff: 6 },
  cater: { cateringTruck: 2, staff: 2 },
};

const D = '2026-10-27';

export const AIRCRAFT_MODELS: AircraftModel[] = [
  // ------------------------------------------------------------ 旧形式の汎用機材（Phase 2〜6 の機材区分。値はすべてゲーム用）
  {
    id: 'regional70',
    generic: true,
    manufacturer: '汎用',
    family: '汎用リージョナル機',
    variant: '',
    name: '汎用 リージョナル機（70席）',
    icao: null,
    lengthM: game(27),
    wingspanM: game(26),
    heightM: unset('汎用機材のため未設定'),
    mtowKg: game(38_000),
    maxPax: unset('汎用機材のため未設定'),
    typicalSeats: game('70'),
    cargoM3: unset('汎用機材のため未設定'),
    fuelL: unset('汎用機材のため未設定'),
    defaultSeats: 70,
    engines: 2,
    doubleDeck: false,
    profile: { taxiSpeed: 8, approachSpeed: 65, landingRollM: 900, takeoffAccel: 2.5, rotateSpeed: 60, turnaroundSec: 30 * 60, holdBags: 200, costPerBlockHour: 180_000, mtowT: 38 },
    assetId: 'generic-regional',
    updated: D,
  },
  {
    id: 'narrow180',
    generic: true,
    manufacturer: '汎用',
    family: '汎用ナローボディ機',
    variant: '',
    name: '汎用 ナローボディ機（180席）',
    icao: null,
    lengthM: game(38),
    wingspanM: game(36),
    heightM: unset('汎用機材のため未設定'),
    mtowKg: game(78_000),
    maxPax: unset('汎用機材のため未設定'),
    typicalSeats: game('180'),
    cargoM3: unset('汎用機材のため未設定'),
    fuelL: unset('汎用機材のため未設定'),
    defaultSeats: 180,
    engines: 2,
    doubleDeck: false,
    profile: { taxiSpeed: 8, approachSpeed: 70, landingRollM: 1300, takeoffAccel: 2.2, rotateSpeed: 72, turnaroundSec: 45 * 60, holdBags: 400, costPerBlockHour: 300_000, mtowT: 78 },
    assetId: 'generic-narrow',
    updated: D,
  },
  {
    id: 'wide300',
    generic: true,
    manufacturer: '汎用',
    family: '汎用ワイドボディ機',
    variant: '',
    name: '汎用 ワイドボディ機（300席）',
    icao: null,
    lengthM: game(64),
    wingspanM: game(61),
    heightM: unset('汎用機材のため未設定'),
    mtowKg: game(250_000),
    maxPax: unset('汎用機材のため未設定'),
    typicalSeats: game('300'),
    cargoM3: unset('汎用機材のため未設定'),
    fuelL: unset('汎用機材のため未設定'),
    defaultSeats: 300,
    engines: 2,
    doubleDeck: false,
    profile: { taxiSpeed: 7, approachSpeed: 75, landingRollM: 1800, takeoffAccel: 1.8, rotateSpeed: 80, turnaroundSec: 90 * 60, holdBags: 900, costPerBlockHour: 700_000, mtowT: 250 },
    assetId: 'generic-wide',
    updated: D,
  },

  // ------------------------------------------------------------ Boeing
  {
    id: 'B737-800',
    generic: false,
    manufacturer: 'Boeing',
    family: '737 Next-Generation',
    variant: '-800',
    name: 'Boeing 737-800',
    icao: 'B738',
    lengthM: off(39.47, 'boeing-737ng-acaps', '全長（§2.2.5 図）'),
    wingspanM: off(34.32, 'boeing-737ng-acaps', 'ウィングレットなしの翼幅（§2.2.5 図）'),
    heightM: off(12.55, 'boeing-737ng-acaps', '垂直尾翼上端までの高さ（§2.2.5 図）'),
    mtowKg: off(79_015, 'boeing-737ng-acaps', '最大設計離陸重量（§2.1.3 の最大のオプション。70,533〜79,015 kg）'),
    maxPax: unset('資料の表に最大座席数（出口制限）の記載がないため未設定'),
    typicalSeats: off('160（2クラス）/ 184（全席エコノミー）', 'boeing-737ng-acaps', '§2.1.3 SEATING CAPACITY'),
    cargoM3: off(45.1, 'boeing-737ng-acaps', '下部貨物室の最大容積（§2.1.3）'),
    fuelL: off(26_024, 'boeing-737ng-acaps', '使用可能燃料（§2.1.3）'),
    defaultSeats: 160,
    engines: 2,
    doubleDeck: false,
    profile: { ...NARROW, turnaroundSec: 45 * 60, holdBags: 280, costPerBlockHour: 320_000, mtowT: 79 },
    assetId: 'proc-narrow-boeing',
    updated: D,
  },
  {
    id: 'B737-800W',
    generic: false,
    manufacturer: 'Boeing',
    family: '737 Next-Generation',
    variant: '-800 (Blended Winglets)',
    name: 'Boeing 737-800（ウィングレット付き, 737-800W）',
    icao: 'B738',
    lengthM: off(39.47, 'boeing-737ng-acaps', '全長（§2.2.6 図）'),
    wingspanM: off(35.79, 'boeing-737ng-acaps', 'ブレンデッド・ウィングレット付きの翼幅（§2.2.6 図）'),
    heightM: off(12.55, 'boeing-737ng-acaps', '垂直尾翼上端までの高さ（§2.2.6 図）'),
    mtowKg: off(79_015, 'boeing-737ng-acaps', '最大設計離陸重量（§2.1.3 の 737-800/-800W の最大値）'),
    maxPax: unset('資料の表に最大座席数（出口制限）の記載がないため未設定'),
    typicalSeats: off('160（2クラス）/ 184（全席エコノミー）', 'boeing-737ng-acaps', '§2.1.3 SEATING CAPACITY'),
    cargoM3: off(45.1, 'boeing-737ng-acaps', '下部貨物室の最大容積（§2.1.3）'),
    fuelL: off(26_024, 'boeing-737ng-acaps', '使用可能燃料（§2.1.3）'),
    defaultSeats: 160,
    engines: 2,
    doubleDeck: false,
    profile: { ...NARROW, turnaroundSec: 45 * 60, holdBags: 280, costPerBlockHour: 315_000, mtowT: 79 },
    assetId: 'proc-narrow-boeing',
    updated: D,
  },
  {
    id: 'B777-300',
    generic: false,
    manufacturer: 'Boeing',
    family: '777',
    variant: '-300',
    name: 'Boeing 777-300',
    icao: 'B773',
    lengthM: off(73.86, 'boeing-777-acaps', '全長（§2.2.2 図）'),
    wingspanM: off(60.93, 'boeing-777-acaps', '翼幅（§2.2.2 図）'),
    heightM: off(18.76, 'boeing-777-acaps', '§2.3.2 地上高の表の K（垂直尾翼上端）の最大値'),
    mtowKg: off(299_370, 'boeing-777-acaps', '最大設計離陸重量（§2.1.5 の最大のオプション。263,083〜299,370 kg）'),
    maxPax: unset('資料の表に最大座席数（出口制限）の記載がないため未設定'),
    typicalSeats: off('451（2クラス）/ 368（3クラス）', 'boeing-777-acaps', '§2.1.5 SEATING CAPACITY'),
    cargoM3: off(213.9, 'boeing-777-acaps', '下部貨物室の最大容積（§2.1.5）'),
    fuelL: off(169_207, 'boeing-777-acaps', '使用可能燃料（§2.1.5）'),
    defaultSeats: 368,
    engines: 2,
    doubleDeck: false,
    profile: { ...WIDE, turnaroundSec: 90 * 60, unitNeeds: WIDE_NEEDS, holdBags: 1_200, costPerBlockHour: 820_000, mtowT: 299 },
    assetId: 'proc-wide-777',
    updated: D,
  },
  {
    id: 'B777-300ER',
    generic: false,
    manufacturer: 'Boeing',
    family: '777',
    variant: '-300ER',
    name: 'Boeing 777-300ER',
    icao: 'B77W',
    lengthM: off(73.86, 'boeing-777er-acaps', '全長（§2.2.2 図）'),
    wingspanM: off(64.8, 'boeing-777er-acaps', '翼幅（§2.2.2 図）'),
    heightM: off(18.85, 'boeing-777er-acaps', '§2.3.2 地上高の表の K（垂直尾翼上端）の最大値'),
    mtowKg: off(351_534, 'boeing-777er-acaps', '最大設計離陸重量（§2.1.1）'),
    maxPax: unset('資料の表に最大座席数（出口制限）の記載がないため未設定'),
    typicalSeats: off('339（2クラス）/ 370（3クラス）', 'boeing-777er-acaps', '§2.1.1 TYPICAL SEATING CAPACITY'),
    cargoM3: off(213.8, 'boeing-777er-acaps', '下部貨物室の最大容積（§2.1.1）'),
    fuelL: off(181_283, 'boeing-777er-acaps', '使用可能燃料（§2.1.1）'),
    defaultSeats: 370,
    engines: 2,
    doubleDeck: false,
    profile: { ...WIDE, turnaroundSec: 95 * 60, unitNeeds: WIDE_NEEDS, holdBags: 1_200, costPerBlockHour: 860_000, mtowT: 352 },
    assetId: 'proc-wide-777',
    updated: D,
  },
  {
    id: 'B787-9',
    generic: false,
    manufacturer: 'Boeing',
    family: '787 Dreamliner',
    variant: '-9',
    name: 'Boeing 787-9',
    icao: 'B789',
    lengthM: off(62.8, 'boeing-787-web', 'Length'),
    wingspanM: off(60.1, 'boeing-787-web', 'Wingspan'),
    heightM: off(17.0, 'boeing-787-web', 'Height'),
    mtowKg: off(259_220, 'boeing-787-web', 'Maximum takeoff weight'),
    maxPax: unset('製品ページに最大座席数の記載がないため未設定'),
    typicalSeats: off('250–325（2クラス）', 'boeing-787-web', 'Seats (two-class)'),
    cargoM3: unset('製品ページに貨物室容積の記載がないため未設定'),
    fuelL: unset('製品ページに燃料容量の記載がないため未設定'),
    defaultSeats: 290,
    engines: 2,
    doubleDeck: false,
    profile: { ...WIDE, turnaroundSec: 75 * 60, unitNeeds: WIDE_NEEDS, holdBags: 900, costPerBlockHour: 640_000, mtowT: 259 },
    assetId: 'proc-wide-787',
    updated: D,
  },

  // ------------------------------------------------------------ Airbus
  {
    id: 'A320-200',
    generic: false,
    manufacturer: 'Airbus',
    family: 'A320 Family',
    variant: '-200 (A320ceo)',
    name: 'Airbus A320-200（A320ceo）',
    icao: 'A320',
    lengthM: off(37.57, 'airbus-a320ceo-web', 'Overall length'),
    wingspanM: off(35.8, 'airbus-a320ceo-web', 'Wing span（シャークレット付き）'),
    heightM: off(11.76, 'airbus-a320ceo-web', 'Height'),
    mtowKg: off(78_000, 'airbus-a320ceo-web', 'Max take-off weight 78.00 t'),
    maxPax: off(180, 'airbus-a320ceo-web', 'Max seating'),
    typicalSeats: off('140–170（2クラス）', 'airbus-a320ceo-web', 'Typical seating'),
    cargoM3: unset('ページの記載は LD3-45W コンテナ7台で、容積（m³）の記載がないため未設定'),
    fuelL: off(27_200, 'airbus-a320ceo-web', 'Max fuel capacity'),
    defaultSeats: 150,
    engines: 2,
    doubleDeck: false,
    profile: { ...NARROW, turnaroundSec: 45 * 60, holdBags: 260, costPerBlockHour: 310_000, mtowT: 78 },
    assetId: 'proc-narrow-airbus',
    updated: D,
  },
  {
    id: 'A320neo',
    generic: false,
    manufacturer: 'Airbus',
    family: 'A320 Family',
    variant: 'neo',
    name: 'Airbus A320neo',
    icao: 'A20N',
    lengthM: off(37.57, 'airbus-a320neo-web', 'Overall length'),
    wingspanM: off(35.8, 'airbus-a320neo-web', 'Wing span (geometric)'),
    heightM: off(11.76, 'airbus-a320neo-web', 'Height'),
    mtowKg: off(79_000, 'airbus-a320neo-web', 'MTOW 79.00 t'),
    maxPax: off(194, 'airbus-a320neo-web', 'Max seating'),
    typicalSeats: off('150–180（2クラス）', 'airbus-a320neo-web', 'Typical seating'),
    cargoM3: unset('ページの記載は LD3-45W コンテナ7台で、容積（m³）の記載がないため未設定'),
    fuelL: off(26_730, 'airbus-a320neo-web', 'Max fuel capacity'),
    defaultSeats: 165,
    engines: 2,
    doubleDeck: false,
    profile: { ...NARROW, turnaroundSec: 45 * 60, holdBags: 260, costPerBlockHour: 290_000, mtowT: 79 },
    assetId: 'proc-narrow-airbus',
    updated: D,
  },
  {
    id: 'A350-900',
    generic: false,
    manufacturer: 'Airbus',
    family: 'A350',
    variant: '-900',
    name: 'Airbus A350-900',
    icao: 'A359',
    lengthM: off(66.8, 'airbus-a350-ff', 'Length'),
    wingspanM: off(64.75, 'airbus-a350-ff', 'Wing span'),
    heightM: off(17.05, 'airbus-a350-ff', 'Height'),
    mtowKg: off(283_000, 'airbus-a350-ff', 'Max. Take-Off Weight 283 t'),
    maxPax: off(440, 'airbus-a350-ff', 'Max seating capability'),
    typicalSeats: off('300–350（3クラス）', 'airbus-a350-ff', 'Typical 3-class seating'),
    cargoM3: off(172.4, 'airbus-a350-ff', 'Usable cargo volume'),
    fuelL: off(141_000, 'airbus-a350-ff', 'Max fuel capacity'),
    defaultSeats: 325,
    engines: 2,
    doubleDeck: false,
    profile: { ...WIDE, turnaroundSec: 80 * 60, unitNeeds: WIDE_NEEDS, holdBags: 1_000, costPerBlockHour: 700_000, mtowT: 283 },
    assetId: 'proc-wide-a350',
    updated: D,
  },
  {
    id: 'A380-800',
    generic: false,
    manufacturer: 'Airbus',
    family: 'A380',
    variant: '-800',
    name: 'Airbus A380-800',
    icao: 'A388',
    lengthM: off(72.7, 'airbus-a380-ff', 'Overall length'),
    wingspanM: off(79.8, 'airbus-a380-ff', 'Wingspan (geometric)'),
    heightM: off(24.1, 'airbus-a380-ff', 'Height'),
    mtowKg: off(575_000, 'airbus-a380-ff', 'Maximum takeoff weight 560 t / 575 t のうち大きい方'),
    maxPax: off(853, 'airbus-a380-ff', 'max seating capacity'),
    typicalSeats: off('545（4クラス）', 'airbus-a380-ff', 'Typical passenger seating'),
    cargoM3: unset('資料の 1,570 m³ は客室を含む3層の容積のため、貨物室容積としては未設定'),
    fuelL: off(320_000, 'airbus-a380-ff', 'Maximum fuel capacity'),
    defaultSeats: 545,
    engines: 4,
    doubleDeck: true,
    profile: {
      ...VERY_LARGE,
      // 資料の "Standard turn-around-time: 90min" を参考にしたゲーム値
      turnaroundSec: 90 * 60,
      unitNeeds: { ...WIDE_NEEDS, fuel: { fuelTruck: 3, staff: 3 }, clean: { cleaningVan: 2, staff: 8 }, cater: { cateringTruck: 3, staff: 3 } },
      holdBags: 1_400,
      costPerBlockHour: 1_300_000,
      mtowT: 575,
    },
    assetId: 'proc-a380',
    updated: D,
  },
];

export const CATALOG: Record<string, AircraftModel> = Object.fromEntries(AIRCRAFT_MODELS.map((m) => [m.id, m]));

// ---------------------------------------------------------------- ゲームの区分ルール

/** ICAO の飛行場基準コード文字（翼幅の区分）。ゲームの適合性判定に使う */
export type CodeLetter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** 翼幅（m）→ コード文字（ICAO Annex 14 の翼幅の区分を参考にした、ゲーム内の区分） */
export function codeLetterOf(wingspanM: number): CodeLetter | null {
  if (!Number.isFinite(wingspanM) || wingspanM <= 0) return null;
  if (wingspanM < 15) return 'A';
  if (wingspanM < 24) return 'B';
  if (wingspanM < 36) return 'C';
  if (wingspanM < 52) return 'D';
  if (wingspanM < 65) return 'E';
  if (wingspanM < 80) return 'F';
  return null;
}

/**
 * ゲームのサイズ区分（S/M/L）: コード C 以下 = M、D・E = L、F = L（＋コード F 対応施設が必要）。
 * 旧形式の汎用機材は Phase 2 以来の区分（regional70 = S, narrow180 = M, wide300 = L）をそのまま使う。
 */
export function sizeClassOf(m: AircraftModel): { size: SizeClass; codeF: boolean } {
  if (m.generic) return { size: m.id === 'regional70' ? 'S' : m.id === 'narrow180' ? 'M' : 'L', codeF: false };
  const code = codeLetterOf(m.wingspanM.value ?? NaN);
  return { size: code === 'A' || code === 'B' || code === 'C' ? 'M' : 'L', codeF: code === 'F' || code === null };
}

export function modelOf(id: string): AircraftModel | undefined {
  return CATALOG[id];
}

export const MANUFACTURERS = [...new Set(AIRCRAFT_MODELS.map((m) => m.manufacturer))];
