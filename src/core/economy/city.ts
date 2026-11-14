import type { CompanyState } from './company';
import { airlineDef, destinationDef } from './registry';
import { AIRCRAFT_TYPES, resolveType, type TypeTable } from '../sim/aircraftTypes';
import type { DayPlan } from './planning';
import { BALANCE } from './balance';

export type CityType = 'regional' | 'core' | 'metropolitan';
export interface CityConfig {
  version: 1;
  type: CityType;
  population: number;
  distanceKm: number;
  roadQuality: 1 | 2 | 3 | 4 | 5;
  railQuality: 0 | 1 | 2 | 3 | 4 | 5;
  residents: number;
}

export const CITY_TYPES: readonly CityType[] = ['regional', 'core', 'metropolitan'];

const CITY_PROFILE: Record<CityType, Omit<CityConfig, 'version' | 'residents'>> = {
  regional: { type: 'regional', population: 300_000, distanceKm: 25, roadQuality: 2, railQuality: 0 },
  core: { type: 'core', population: 1_200_000, distanceKm: 18, roadQuality: 3, railQuality: 2 },
  metropolitan: { type: 'metropolitan', population: 6_000_000, distanceKm: 30, roadQuality: 4, railQuality: 4 },
};

const TRIP_RATE: Record<CityType, number> = { regional: 0.004, core: 0.006, metropolitan: 0.009 };
const BASE_GROWTH: Record<CityType, number> = { regional: 0.0002, core: 0.0003, metropolitan: 0.0002 };

export function defaultCity(type: CityType = 'regional'): CityConfig {
  return { version: 1, ...CITY_PROFILE[type], residents: 70 };
}

export function isCityConfig(value: unknown): value is CityConfig {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return c.version === 1
    && CITY_TYPES.includes(c.type as CityType)
    && Number.isFinite(c.population) && Number(c.population) >= 1
    && Number.isFinite(c.distanceKm) && Number(c.distanceKm) >= 0 && Number(c.distanceKm) <= 500
    && Number.isInteger(c.roadQuality) && Number(c.roadQuality) >= 1 && Number(c.roadQuality) <= 5
    && Number.isInteger(c.railQuality) && Number(c.railQuality) >= 0 && Number(c.railQuality) <= 5
    && Number.isFinite(c.residents) && Number(c.residents) >= 0 && Number(c.residents) <= 100;
}

/** 旅客/日。すべてゲーム内のバランス値で、実都市の予測ではない。 */
export function cityDemandCeiling(city: CityConfig, accessFactor: number): number {
  const accessNorm = Math.max(0, Math.min(1, (accessFactor - 0.3) / 0.8));
  return city.population * TRIP_RATE[city.type]
    * Math.exp(-Math.max(0, city.distanceKm - 15) / 60)
    * (0.7 + 0.3 * accessNorm);
}

/** 便計画の旅客を都市需要の上限に合わせる係数。都市を持たない会社には適用しない。 */
export function cityDemandFactor(city: CityConfig, accessFactor: number, expectedDailyPax: number): number {
  return Math.min(1.1, cityDemandCeiling(city, accessFactor) / Math.max(1, expectedDailyPax));
}

/** 日次締めで都市人口を更新する。戻り値はマイルストーン通知。 */
export function growCity(city: CityConfig, dailyPax: number, demandCeiling: number): string[] {
  const basePopulation = CITY_PROFILE[city.type].population;
  const baseRoadQuality = CITY_PROFILE[city.type].roadQuality;
  const previousPopulation = city.population;
  const growth = BASE_GROWTH[city.type]
    + 0.0005 * Math.min(1, dailyPax / Math.max(1, 0.8 * demandCeiling))
      * Math.min(1, city.residents / 70);
  city.population = Math.round(city.population * (1 + growth));
  const events: string[] = [];
  const thresholds = [basePopulation * 1.5, basePopulation * 2];
  for (const threshold of thresholds) {
    if (previousPopulation < threshold && city.population >= threshold) {
      city.roadQuality = Math.min(5, Math.max(city.roadQuality, baseRoadQuality + 1)) as CityConfig['roadQuality'];
      events.push(`都市人口が ${threshold / basePopulation} 倍に達し、都市道路の整備度が ${city.roadQuality} になりました`);
    }
  }
  return events;
}

/** 契約便の基本搭乗率から計画旅客数を推定する。 */
export function expectedPassengers(company: CompanyState, day: number, types: TypeTable = AIRCRAFT_TYPES): number {
  return Object.values(company.contracts).reduce((sum, contract) => {
    if (contract.status !== 'active' || contract.startDay > day || contract.endDay < day) return sum;
    const seats = company.fleets?.[contract.airlineId]?.find((entry) => entry.typeId === contract.typeId)?.seats
      ?? resolveType(types, contract.typeId).seats;
    const baseLoad = BALANCE.demand.baseLoadFactor[airlineDef(contract.airlineId).type];
    const routeDemand = destinationDef(contract.destinationId).demand;
    return sum + contract.perDay * seats * baseLoad * routeDemand * 2;
  }, 0);
}

export function dailyPlanPassengerCount(plan: DayPlan): number {
  return plan.flights.reduce((sum, flight) => sum + flight.arrPax + flight.depPax, 0);
}

