import type { AircraftTypeId } from '../sim/aircraftTypes';

/**
 * 航空会社・就航先の登録データ（すべて架空）。
 */

export type AirlineType = 'fullService' | 'lcc' | 'regional';

export interface AirlineDef {
  id: string;
  code: string;
  name: string;
  type: AirlineType;
  /** 保有機材の初期設定（機種ID と座席数。座席数は航空会社の座席構成で、ゲーム用の値） */
  fleet: FleetEntry[];
  /** 料金への敏感さ（0〜1） */
  priceSensitivity: number;
  /** 求める定時運航率 */
  minOtp: number;
}

export interface FleetEntry {
  typeId: AircraftTypeId;
  /** この航空会社の座席数（同じ機種でも航空会社ごとに違ってよい） */
  seats: number;
}

export const AIRLINES: AirlineDef[] = [
  {
    id: 'SK', code: 'SK', name: 'スカイライン航空', type: 'fullService',
    fleet: [{ typeId: 'B737-800W', seats: 166 }, { typeId: 'B787-9', seats: 266 }, { typeId: 'B777-300ER', seats: 316 }, { typeId: 'B787-10', seats: 320 }, { typeId: 'B767-300ER', seats: 250 }],
    priceSensitivity: 0.3, minOtp: 0.85,
  },
  {
    id: 'NP', code: 'NP', name: 'ノースパシフィック航空', type: 'fullService',
    fleet: [{ typeId: 'A320neo', seats: 180 }, { typeId: 'A350-900', seats: 310 }, { typeId: 'B777-300', seats: 400 }, { typeId: 'A380-800', seats: 520 }, { typeId: 'A350-1000', seats: 370 }, { typeId: 'A321neo', seats: 194 }],
    priceSensitivity: 0.35, minOtp: 0.8,
  },
  { id: 'RJ', code: 'RJ', name: 'リージョナルジェット', type: 'regional', fleet: [{ typeId: 'regional70', seats: 70 }, { typeId: 'E190', seats: 95 }, { typeId: 'E175', seats: 76 }, { typeId: 'ATR72-600', seats: 70 }], priceSensitivity: 0.5, minOtp: 0.75 },
  {
    id: 'AQ', code: 'AQ', name: 'アクアエア', type: 'lcc',
    fleet: [{ typeId: 'A320-200', seats: 180 }, { typeId: 'A320neo', seats: 186 }],
    priceSensitivity: 0.8, minOtp: 0.7,
  },
  {
    id: 'HB', code: 'HB', name: 'ハミングバード', type: 'lcc',
    fleet: [{ typeId: 'regional70', seats: 70 }, { typeId: 'B737-800', seats: 184 }, { typeId: 'B737-8', seats: 189 }],
    priceSensitivity: 0.7, minOtp: 0.7,
  },
];

export interface DestinationDef {
  id: string;
  name: string;
  distanceKm: number;
  /** 路線の需要係数（搭乗率に掛かる） */
  demand: number;
}

export const DESTINATIONS: DestinationDef[] = [
  { id: 'KTA', name: '北港', distanceKm: 450, demand: 1.0 },
  { id: 'TWN', name: '東湾市', distanceKm: 800, demand: 1.15 },
  { id: 'MSK', name: '南岬', distanceKm: 300, demand: 0.85 },
  { id: 'YKH', name: '雪原', distanceKm: 1200, demand: 0.95 },
  { id: 'KRG', name: '霧ヶ丘', distanceKm: 600, demand: 0.8 },
  { id: 'AOS', name: '青島', distanceKm: 1500, demand: 1.1 },
  { id: 'NSH', name: '西浜', distanceKm: 250, demand: 0.75 },
  { id: 'HSM', name: '星見', distanceKm: 2500, demand: 1.05 },
];

export const airlineDef = (id: string): AirlineDef => AIRLINES.find((a) => a.id === id)!;
export const destinationDef = (id: string): DestinationDef => DESTINATIONS.find((d) => d.id === id)!;
