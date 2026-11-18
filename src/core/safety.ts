import type { AirportLayout } from './model/types';

/**
 * 消防区分と管制塔レベル（5-05 / docs/39 A7）。
 * 施設の props（消防 category 1〜10、管制塔 level 1〜3）に役割を持たせるための算出。
 * ここでの不足は検証・計画の警告と能力表示に使う助言的な制限で、運航そのものは止めない
 * （既存の空港の結果を変えないための線引き。docs/42 §3.4 5-05 の完了条件）。
 */

/** 機体長（m）→ 必要な消防区分（ICAO の救難消防区分の長さ基準） */
export function requiredFireCategory(lengthM: number): number {
  if (!Number.isFinite(lengthM) || lengthM <= 0) return 1;
  if (lengthM < 9) return 1;
  if (lengthM < 12) return 2;
  if (lengthM < 18) return 3;
  if (lengthM < 24) return 4;
  if (lengthM < 28) return 5;
  if (lengthM < 39) return 6;
  if (lengthM < 49) return 7;
  if (lengthM < 61) return 8;
  if (lengthM < 76) return 9;
  return 10;
}

/** 空港の消防区分 = 消防施設の category の最大値（施設がなければ 0） */
export function airportFireCategory(layout: AirportLayout): number {
  let best = 0;
  for (const f of Object.values(layout.facilities)) {
    if (f.kind !== 'fireStation' || f.parentFacilityId) continue;
    best = Math.max(best, Number(f.props.category ?? 7));
  }
  return best;
}

/** 管制塔のレベル = 管制塔の level の最大値（なければ 0） */
export function towerLevel(layout: AirportLayout): number {
  let best = 0;
  for (const f of Object.values(layout.facilities)) {
    if (f.kind !== 'tower' || f.parentFacilityId) continue;
    best = Math.max(best, Number(f.props.level ?? 1));
  }
  return best;
}

/** 管制塔レベル → 1 時間に扱える発着回数の目安（表示・警告用） */
export function towerCapacityPerHour(level: number): number {
  if (level <= 0) return 0;
  if (level === 1) return 30;
  if (level === 2) return 60;
  return 120;
}
