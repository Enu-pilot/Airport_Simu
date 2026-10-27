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
  /** 使用する機種 */
  fleet: AircraftTypeId[];
  /** 料金への敏感さ（0〜1） */
  priceSensitivity: number;
  /** 求める定時運航率 */
  minOtp: number;
}

export const AIRLINES: AirlineDef[] = [
  { id: 'SK', code: 'SK', name: 'スカイライン航空', type: 'fullService', fleet: ['narrow180', 'wide300'], priceSensitivity: 0.3, minOtp: 0.85 },
  { id: 'NP', code: 'NP', name: 'ノースパシフィック航空', type: 'fullService', fleet: ['narrow180', 'wide300'], priceSensitivity: 0.35, minOtp: 0.8 },
  { id: 'RJ', code: 'RJ', name: 'リージョナルジェット', type: 'regional', fleet: ['regional70'], priceSensitivity: 0.5, minOtp: 0.75 },
  { id: 'AQ', code: 'AQ', name: 'アクアエア', type: 'lcc', fleet: ['narrow180'], priceSensitivity: 0.8, minOtp: 0.7 },
  { id: 'HB', code: 'HB', name: 'ハミングバード', type: 'lcc', fleet: ['regional70', 'narrow180'], priceSensitivity: 0.7, minOtp: 0.7 },
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
