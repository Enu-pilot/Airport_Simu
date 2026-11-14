import type { CityConfig } from '../economy/city';

export type RailService = 'local' | 'rapid' | 'express';

/** ゲーム内のアクセス鉄道モデル。数値は実在路線の予測値ではない。 */
export const RAIL_SERVICE: Record<RailService, {
  minQuality: number;
  speedKph: number;
  fareSurcharge: number;
  operatingCostMultiplier: number;
}> = {
  local: { minQuality: 1, speedKph: 45, fareSurcharge: 0, operatingCostMultiplier: 1 },
  rapid: { minQuality: 2, speedKph: 65, fareSurcharge: 0, operatingCostMultiplier: 1.4 },
  express: { minQuality: 3, speedKph: 90, fareSurcharge: 500, operatingCostMultiplier: 2.2 },
};

export function railServiceOf(value: unknown): RailService {
  return value === 'rapid' || value === 'express' ? value : 'local';
}

export function railServiceAvailable(city: CityConfig | undefined, service: RailService): boolean {
  return !city || (city.railQuality >= RAIL_SERVICE[service].minQuality && city.railQuality > 0);
}

export function cityTravelMinutes(city: CityConfig, speedKph: number): number {
  return city.distanceKm / Math.max(1, speedKph) * 60;
}
