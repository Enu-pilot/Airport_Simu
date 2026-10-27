import type { SizeClass } from '../model/types';

/**
 * 機種定義（架空の代表機種）。数値はゲーム用の簡略値で、実機の性能を再現するものではない。
 */
export interface AircraftType {
  id: AircraftTypeId;
  label: string;
  size: SizeClass;
  seats: number;
  /** 機体長（m）。誘導路の予約を解放する距離（尾部の通過）に使う */
  lengthM: number;
  wingspanM: number;
  /** 誘導路の最高速度（m/s） */
  taxiSpeed: number;
  /** 進入・接地速度（m/s） */
  approachSpeed: number;
  /** 接地から離脱速度まで減速するのに最低限必要な距離（m） */
  landingRollM: number;
  /** 離陸滑走の加速度（m/s²）と浮揚速度（m/s） */
  takeoffAccel: number;
  rotateSpeed: number;
  /** 最小折り返し時間（秒）。Phase 2 では地上作業をこの時間で一括して扱う */
  turnaroundSec: number;
}

export type AircraftTypeId = 'regional70' | 'narrow180' | 'wide300';

export const AIRCRAFT_TYPES: Record<AircraftTypeId, AircraftType> = {
  regional70: {
    id: 'regional70',
    label: 'リージョナル機（70席）',
    size: 'S',
    seats: 70,
    lengthM: 27,
    wingspanM: 26,
    taxiSpeed: 8,
    approachSpeed: 65,
    landingRollM: 900,
    takeoffAccel: 2.5,
    rotateSpeed: 60,
    turnaroundSec: 30 * 60,
  },
  narrow180: {
    id: 'narrow180',
    label: 'ナローボディ機（180席）',
    size: 'M',
    seats: 180,
    lengthM: 38,
    wingspanM: 36,
    taxiSpeed: 8,
    approachSpeed: 70,
    landingRollM: 1300,
    takeoffAccel: 2.2,
    rotateSpeed: 72,
    turnaroundSec: 45 * 60,
  },
  wide300: {
    id: 'wide300',
    label: 'ワイドボディ機（300席）',
    size: 'L',
    seats: 300,
    lengthM: 64,
    wingspanM: 61,
    taxiSpeed: 7,
    approachSpeed: 75,
    landingRollM: 1800,
    takeoffAccel: 1.8,
    rotateSpeed: 80,
    turnaroundSec: 90 * 60,
  },
};

export const AIRCRAFT_TYPE_IDS = Object.keys(AIRCRAFT_TYPES) as AircraftTypeId[];

/** 浮揚までの離陸滑走距離（m） */
export function takeoffDistanceM(t: AircraftType): number {
  return (t.rotateSpeed * t.rotateSpeed) / (2 * t.takeoffAccel);
}
