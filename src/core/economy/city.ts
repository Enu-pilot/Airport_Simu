import type { CompanyState } from './company';
import { airlineDef } from './registry';
import { AIRCRAFT_TYPES, resolveType, type TypeTable } from '../sim/aircraftTypes';
import type { DayPlan } from './planning';
import type { OperatingHours } from './company';
import type { SizeClass } from '../model/types';
import { BALANCE } from './balance';

export type CityType = 'regional' | 'core' | 'metropolitan';
export type CityEventKind = 'festival' | 'sports' | 'conference';
export const CITY_EVENT_KINDS: readonly CityEventKind[] = ['festival', 'sports', 'conference'];
export type CityEventLocation = 'cityCenter' | 'airportDistrict';
export interface CityEvent {
  id: string;
  day: number;
  durationDays: number;
  kind: CityEventKind;
  /** 1 = local, 2 = regional, 3 = large */
  scale: 1 | 2 | 3;
  location: CityEventLocation;
}

export interface CityConfig {
  version: 1;
  type: CityType;
  population: number;
  distanceKm: number;
  roadQuality: 1 | 2 | 3 | 4 | 5;
  railQuality: 0 | 1 | 2 | 3 | 4 | 5;
  residents: number;
  events?: CityEvent[];
}

export const CITY_NIGHT_CURFEW = { fromMin: 22 * 60, toMin: 6 * 60 } as const;

export function isCityNightMovement(at: number): boolean {
  const minute = Math.floor((at % 86_400) / 60);
  return minute >= CITY_NIGHT_CURFEW.fromMin || minute < CITY_NIGHT_CURFEW.toMin;
}

/** 騒音規制を適用する日の次の許可時刻（06:00）。 */
export function nextCityMovementTime(at: number): number {
  const dayStart = Math.floor(at / 86_400) * 86_400;
  const morning = dayStart + CITY_NIGHT_CURFEW.toMin * 60;
  return at < morning ? morning : morning + 86_400;
}

export function cityOperatingHours(hours: OperatingHours): OperatingHours {
  return { ...hours, openMin: Math.max(hours.openMin, CITY_NIGHT_CURFEW.toMin), closeMin: Math.min(hours.closeMin, CITY_NIGHT_CURFEW.fromMin) };
}

/** 機種ごとのゲーム内騒音ポイント。dB値や現実の曝露量を表さない。 */
export function aircraftNoisePoints(size: SizeClass, engines: number): number {
  const sizePoints: Record<SizeClass, number> = { S: 1, M: 2, L: 3 };
  return sizePoints[size] + Math.max(1, engines) * 0.5;
}

export function applyCityNoiseImpact(city: CityConfig, noisePoints: number, nightMovements: number): number {
  const before = city.residents;
  const delta = Math.max(-1, Math.min(0.05, 0.03 - noisePoints * 0.0004 - nightMovements * 0.15));
  city.residents = Math.max(0, Math.min(100, city.residents + delta));
  return Math.round((city.residents - before) * 100) / 100;
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
    && Number.isFinite(c.residents) && Number(c.residents) >= 0 && Number(c.residents) <= 100
    && (c.events === undefined || (Array.isArray(c.events) && c.events.every(isCityEvent)));
}

export function isCityEvent(value: unknown): value is CityEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && e.id.length > 0
    && Number.isInteger(e.day) && Number(e.day) >= 0
    && Number.isInteger(e.durationDays) && Number(e.durationDays) >= 1 && Number(e.durationDays) <= 30
    && (e.kind === 'festival' || e.kind === 'sports' || e.kind === 'conference')
    && (e.scale === 1 || e.scale === 2 || e.scale === 3)
    && (e.location === 'cityCenter' || e.location === 'airportDistrict');
}

const EVENT_EFFECTS: Record<CityEventKind, { demand: number; traffic: number }> = {
  festival: { demand: 0.06, traffic: 0.09 },
  sports: { demand: 0.08, traffic: 0.12 },
  conference: { demand: 0.1, traffic: 0.07 },
};

export function cityEventEffects(city: CityConfig | undefined, day: number): { events: CityEvent[]; demandMultiplier: number; trafficMultiplier: number } {
  const events = (city?.events ?? []).filter((event) => day >= event.day && day < event.day + event.durationDays);
  let demandMultiplier = 1;
  let trafficMultiplier = 1;
  for (const event of events) {
    const effect = EVENT_EFFECTS[event.kind];
    demandMultiplier *= 1 + effect.demand * event.scale;
    trafficMultiplier += effect.traffic * event.scale * (event.location === 'airportDistrict' ? 1.5 : 1);
  }
  return { events, demandMultiplier: Math.min(1.8, demandMultiplier), trafficMultiplier: Math.min(2.5, trafficMultiplier) };
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
    return sum + contract.perDay * seats * baseLoad * 2;
  }, 0);
}

export function dailyPlanPassengerCount(plan: DayPlan): number {
  return plan.flights.reduce((sum, flight) => sum + flight.arrPax + flight.depPax, 0);
}

