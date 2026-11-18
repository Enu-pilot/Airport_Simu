import type { SizeClass } from '../model/types';
import type { AircraftType } from './aircraftTypes';
import type { TaskKind, UnitKind } from './types';

/**
 * 折り返し作業の定義と、機種ごとの作業時間・必要ユニット（docs/13・docs/16 §4）。
 * 機種の作業時間・人員はゲーム用の設定値（実際の地上作業の標準時間ではない）。
 */

/** 作業の定義: 依存する作業、必要なユニット、作業時間（S/M/L、秒） */
export const TASK_DEFS: Record<TaskKind, { deps: TaskKind[]; needs: Partial<Record<UnitKind, number>>; sec: [number, number, number] }> = {
  deplane: { deps: [], needs: {}, sec: [0, 0, 0] },
  unload: { deps: [], needs: { beltLoader: 1, baggageTractor: 1, staff: 2 }, sec: [0, 0, 0] },
  fuel: { deps: [], needs: { fuelTruck: 1, staff: 1 }, sec: [600, 900, 1800] },
  clean: { deps: ['deplane'], needs: { cleaningVan: 1, staff: 3 }, sec: [600, 900, 1500] },
  cater: { deps: ['deplane'], needs: { cateringTruck: 1, staff: 1 }, sec: [480, 720, 1200] },
  inspect: { deps: [], needs: { engineer: 1 }, sec: [600, 900, 1200] },
  board: { deps: ['deplane', 'clean', 'cater', 'fuel', 'inspect'], needs: {}, sec: [0, 0, 0] },
  load: { deps: ['unload'], needs: { beltLoader: 1, baggageTractor: 1, staff: 2 }, sec: [0, 0, 0] },
  pushback: { deps: [], needs: { tug: 1, staff: 1 }, sec: [0, 0, 0] },
  // 貨物タスク（5-12）: 手荷物タスク（unload/load）とは別種。所要時間は区分値ではなく
  // 搭載量と貨物上屋の処理能力から決める（cargoTaskSec）。必要ユニットは作業員のみ
  cargoUnload: { deps: [], needs: { staff: 2 }, sec: [0, 0, 0] },
  cargoLoad: { deps: ['cargoUnload'], needs: { staff: 2 }, sec: [0, 0, 0] },
};
export const TURNAROUND_TASKS: readonly TaskKind[] = ['deplane', 'unload', 'fuel', 'clean', 'cater', 'inspect', 'board', 'load'];

/** 貨物便の折り返しタスク（5-12。旅客便には生成しない） */
export const CARGO_TASKS: readonly TaskKind[] = ['cargoUnload', 'cargoLoad'];

/**
 * 貨物タスクの所要時間（秒）: 搭載量 (m3) ÷ 貨物上屋の処理能力 (m3/時)。
 * 能力が 0（上屋なし）のときは扱えず、最低時間だけを返す（呼び出し側で能力なしを判定する）。
 */
export function cargoTaskSec(volumeM3: number, throughputM3PerHour: number): number {
  if (volumeM3 <= 0) return 0;
  if (throughputM3PerHour <= 0) return 1800;
  return Math.max(300, Math.round((volumeM3 / throughputM3PerHour) * 3600));
}

export const SIZE_INDEX: Record<SizeClass, 0 | 1 | 2> = { S: 0, M: 1, L: 2 };

/** 機種の作業で必要な作業員・車両（機種の指定がなければ作業の定義の値） */
export function taskNeeds(type: AircraftType, kind: TaskKind): Partial<Record<UnitKind, number>> {
  return { ...(type.unitNeeds?.[kind] ?? TASK_DEFS[kind].needs) };
}

/**
 * 機種の作業時間（秒）。汎用機材は Phase 4 の区分ごとの値。カタログの機種はゲーム用の式:
 *   清掃 = 座席数 × 5.5秒 × 3 ÷ 作業員数、ケータリング = 座席数 × 4秒 ÷ ケータリング車の台数、
 *   給油・点検 = 区分の値（給油は給油車の台数で割り、区分の基準より 1 台多ければ時間が半分）
 */
export function taskWorkSec(type: AircraftType, kind: TaskKind): number {
  const override = type.taskSec?.[kind];
  if (override !== undefined) return override;
  const base = TASK_DEFS[kind].sec[SIZE_INDEX[type.size]];
  if (type.generic || base === 0) return base;
  const needs = taskNeeds(type, kind);
  switch (kind) {
    case 'clean':
      return Math.round((type.seats * 5.5 * 3) / Math.max(1, needs.staff ?? 3));
    case 'cater':
      return Math.round((type.seats * 4) / Math.max(1, needs.cateringTruck ?? 1));
    case 'fuel':
      return Math.round((base * 2) / Math.max(1, (needs.fuelTruck ?? 1) + 1));
    default:
      return base;
  }
}
