import { CATALOG, HOME_COUNTRY_ID, findAirline, findDestination } from '../data/index';
import type { AirlineDef, CountryDef, DestinationDef, RegionDef } from '../data/types';
import { intlProcessingReady, type TerminalModel } from '../terminal/model';
import type { CompanyState } from './company';
import { featureOn } from './unlocks';

export type { AirlineDef, AirlineType, AirlineService, CabinSpec, CountryDef, DestinationDef, FleetEntry, RegionDef, Unlock } from '../data/types';
export { CATALOG, HOME_COUNTRY_ID, airlinesFor, destinationsFor, findAirline, findDestination, resolveAirlineId, resolveDestinationId } from '../data/index';

/**
 * 航空会社・就航先の登録データの互換の窓口。
 * 実データは `src/core/data/`（destinations.ts / airlines.ts / countries.ts）にあり、
 * 足し方は docs/43_data_extension_guide.md を参照。ここは既存の import を壊さないための再輸出。
 */

export type RouteType = 'domestic' | 'international';
export type DestinationService = 'passenger' | 'cargo';

export interface RouteCapabilities {
  originCountryId: string;
  internationalPassengerProcessing: boolean;
}

export function routeCapabilitiesForAirport(originCountryId = HOME_COUNTRY_ID, opts: { international?: boolean } = {}): RouteCapabilities {
  // フェーズ 4 §4.5: 国際旅客処理は、解放と有効化（features.international）と設備の準備がそろった空港だけ true。
  // 判定は呼び出し側（会社とターミナルを持つ場所）が internationalProcessingFor で行う
  return { originCountryId, internationalPassengerProcessing: opts.international === true };
}

/** フェーズ 4 §4.5: その会社・ターミナルで国際旅客処理ができるか（解放+有効化+設備） */
export function internationalProcessingFor(company: CompanyState | null | undefined, terminal: TerminalModel): boolean {
  return !!company && featureOn(company, 'international') && intlProcessingReady(terminal);
}

export const REGIONS: RegionDef[] = CATALOG.regions;
export const COUNTRIES: CountryDef[] = CATALOG.countries;
export const AIRLINES: AirlineDef[] = CATALOG.airlines;
export const DESTINATIONS: DestinationDef[] = CATALOG.destinations;

export const airlineDef = (id: string): AirlineDef => findAirline(id)!;
export const destinationDef = (id: string): DestinationDef => findDestination(id)!;

export function classifyRoute(originCountryId: string, destination: Pick<DestinationDef, 'countryId'>): RouteType {
  return originCountryId === destination.countryId ? 'domestic' : 'international';
}

export function airlineSupportsRoute(airline: AirlineDef, route: RouteType, service: DestinationService = 'passenger'): boolean {
  if (service === 'cargo') return airline.services.includes('cargo');
  return airline.services.includes(route === 'domestic' ? 'domesticPassenger' : 'internationalPassenger');
}

/**
 * 就航範囲（路線網）の制限: 会社に networkDestinations があれば、その集合に入る目的地だけが対象。
 * 国内・国際共通の許可集合で、未指定の会社は無制限。
 * 使う場所は「新規の提案の生成」と「読み込み時の既存契約の付け替え判定」だけ。
 * 注意: routeAvailability 本体には入れない — 計画・需要集計が既存契約を unsupportedRoutes に
 * 落として壊してしまうため（付け替えは importCompany 内の reassignOutOfScopeContracts で行う）。
 */
export function airlineNetworkAllows(airline: AirlineDef, destination: Pick<DestinationDef, 'id'>): boolean {
  return !airline.networkDestinations || airline.networkDestinations.includes(destination.id);
}

/** 架空会社の就航制限（機能F）が効き始める空港の格（3 = 国内主要空港） */
export const FICTIONAL_RESTRICTION_TIER = 3;

/**
 * 架空会社の就航制限: 格が FICTIONAL_RESTRICTION_TIER 以上のとき、架空会社の新規提案は
 * 架空の目的地だけに限る。実在会社には一切影響しない。networkDestinations とは AND（積集合）。
 * 使う場所は airlineNetworkAllows と同じく「新規の提案の生成」と「持ち替えの候補判定」だけ。
 * routeAvailability 本体には入れない（理由は airlineNetworkAllows のコメントと同じ）。
 * 格（tier）は呼び出し側が渡す: 目標（goals）のない会社では制限を掛けない（呼び出し側が 0 を渡す）。
 */
export function airlineFictionalAllows(airline: AirlineDef, destination: Pick<DestinationDef, 'fictional'>, tier: number): boolean {
  return !airline.fictional || tier < FICTIONAL_RESTRICTION_TIER || destination.fictional;
}

export function routeAvailability(
  airline: AirlineDef,
  destination: DestinationDef,
  capabilities: RouteCapabilities,
  service: DestinationService = 'passenger',
): 'available' | 'airline-unsupported' | 'international-processing-required' {
  const route = classifyRoute(capabilities.originCountryId, destination);
  if (!airlineSupportsRoute(airline, route, service)) return 'airline-unsupported';
  if (service === 'passenger' && route === 'international' && !capabilities.internationalPassengerProcessing) {
    return 'international-processing-required';
  }
  return 'available';
}
