import { AIRLINE_DATA } from './airlines';
import { COUNTRY_DATA, REGION_DATA } from './countries';
import { DESTINATION_DATA } from './destinations';
import { AIRLINE_TYPE_DEFAULTS, type AirlineDef, type AirlineInput, type CountryDef, type DestinationDef, type DestinationInput, type RegionDef } from './types';
import { CatalogError, validateCatalog, type CatalogRaw } from './validate';

export * from './types';
export { defineAirline, defineDestination } from './define';
export { validateCatalog, CatalogError, LEGACY_AIRLINE_IDS, LEGACY_DESTINATION_IDS, type CatalogIssue, type CatalogRaw } from './validate';

export const HOME_COUNTRY_ID = 'JP';

/** 旧 ID → 新 ID の対応（初期は空。ID を変えるときだけ足す。docs/43） */
export const ID_ALIASES: Record<string, string> = {};

export interface Catalog {
  airlines: AirlineDef[];
  destinations: DestinationDef[];
  countries: CountryDef[];
  regions: RegionDef[];
  airlineById: Map<string, AirlineDef>;
  destinationById: Map<string, DestinationDef>;
}

function buildDestination(input: DestinationInput, countries: Map<string, CountryDef>): DestinationDef {
  const country = countries.get(input.countryId);
  const demand = { business: input.demand?.business ?? 1.0, leisure: input.demand?.leisure ?? 1.0, cargo: input.demand?.cargo ?? 1.0 };
  const unlock = { ...(input.unlock ?? {}) };
  return {
    id: input.id,
    name: input.name,
    countryId: input.countryId,
    regionId: input.regionId ?? country?.regionId ?? '',
    coordinates: input.coordinates ? { ...input.coordinates } : { latitude: 0, longitude: 0 },
    distanceKm: input.distanceKm,
    passengerDemand: input.passengerDemand ?? 1.0,
    cargoDemand: demand.cargo,
    ...(unlock.minRating !== undefined ? { minimumAirportRating: unlock.minRating } : {}),
    population: input.population,
    demand,
    congestion: input.congestion ?? 0.3,
    unlock,
    scope: input.countryId === HOME_COUNTRY_ID ? 'domestic' : 'international',
    legacy: input.legacy === true,
    retired: input.retired === true,
  };
}

function buildAirline(input: AirlineInput): AirlineDef {
  const d = AIRLINE_TYPE_DEFAULTS[input.type];
  const unlock = { ...(input.unlock ?? {}) };
  return {
    id: input.id,
    code: input.code ?? input.id,
    name: input.name,
    type: input.type,
    fleet: input.fleet.map((f) => ({ ...f })),
    priceSensitivity: input.priceSensitivity ?? d.priceSensitivity,
    minOtp: input.minOtp ?? d.minOtp,
    ...(unlock.minRating !== undefined ? { minimumAirportRating: unlock.minRating } : {}),
    services: [...input.services],
    baseLoadFactor: input.baseLoadFactor ?? d.baseLoadFactor,
    fareLevel: input.fareLevel ?? d.fareLevel,
    canBase: input.canBase === true,
    unlock,
    ...(input.livery ? { livery: { ...input.livery } } : {}),
    legacy: input.legacy === true,
    retired: input.retired === true,
  };
}

/** 生データを検証して構築する。不正（error の issue）なら CatalogError を投げる */
export function buildCatalog(raw: CatalogRaw): Catalog {
  const issues = validateCatalog(raw);
  if (issues.some((i) => i.level === 'error')) throw new CatalogError(issues);
  const countries = new Map(raw.countries.map((c) => [c.id, c]));
  const destinations = raw.destinations.map((d) => buildDestination(d, countries));
  const airlines = raw.airlines.map(buildAirline);
  return {
    airlines,
    destinations,
    countries: raw.countries.map((c) => ({ ...c })),
    regions: raw.regions.map((r) => ({ ...r })),
    airlineById: new Map(airlines.map((a) => [a.id, a])),
    destinationById: new Map(destinations.map((d) => [d.id, d])),
  };
}

export const CATALOG_RAW: CatalogRaw = {
  destinations: DESTINATION_DATA,
  airlines: AIRLINE_DATA,
  countries: COUNTRY_DATA,
  regions: REGION_DATA,
  aliases: ID_ALIASES,
};

/** 既定データで構築したカタログ（モジュール読み込み時に常に検証が走る） */
export const CATALOG: Catalog = buildCatalog(CATALOG_RAW);

export const resolveAirlineId = (id: string): string => ID_ALIASES[id] ?? id;
export const resolveDestinationId = (id: string): string => ID_ALIASES[id] ?? id;

export const findAirline = (id: string): AirlineDef | undefined => CATALOG.airlineById.get(resolveAirlineId(id));
export const findDestination = (id: string): DestinationDef | undefined => CATALOG.destinationById.get(resolveDestinationId(id));

/**
 * 会社が使える項目集合（計画 §2.4。決定性の要）:
 * market なしの会社は legacy のみ（現行と同一の集合・順序・乱数消費）、market ありは非 retired の全部。
 */
export interface CatalogScopeLike {
  market?: unknown;
}
export const airlinesFor = (c: CatalogScopeLike): AirlineDef[] =>
  CATALOG.airlines.filter((a) => !a.retired && (c.market ? true : a.legacy));
export const destinationsFor = (c: CatalogScopeLike): DestinationDef[] =>
  CATALOG.destinations.filter((d) => !d.retired && (c.market ? true : d.legacy));
