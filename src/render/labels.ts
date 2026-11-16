import { compareIds } from '../core/model/ids';
import { facilityLevel } from '../core/model/levels';
import type { AirportLayout } from '../core/model/types';

/** 施設名ラベルを出す施設（表示中の階だけ。建物内設備・ゲート・内部表示中のターミナルは出さない）。W-1 */
export function visibleFacilityLabelIds(layout: AirportLayout, mapLevel: number | 'all', interiorShown: boolean): string[] {
  return Object.values(layout.facilities)
    .filter((f) => f.name && !f.parentFacilityId && f.kind !== 'gate' && !(f.kind === 'terminal' && interiorShown))
    .filter((f) => mapLevel === 'all' || facilityLevel(f) === mapLevel)
    .map((f) => f.id)
    .sort(compareIds);
}

/** 内部表示で描く建物内設備（親の種類は問わず、表示中の階の設備）。選択の規則（pickCandidatesAt）と一致させる。W-2 */
export function visibleInteriorFacilityIds(layout: AirportLayout, interiorLevel: number): string[] {
  return Object.values(layout.facilities)
    .filter((f) => f.parentFacilityId && (f.floorIndex ?? 0) === interiorLevel)
    .map((f) => f.id)
    .sort(compareIds);
}
