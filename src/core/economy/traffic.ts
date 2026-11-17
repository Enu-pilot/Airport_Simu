import type { FlightRecord } from '../analytics/records';
import { AIRCRAFT_TYPES, type AircraftTypeId, type TypeTable } from '../sim/aircraftTypes';
import type { CompanyState, Contract } from './company';
import { routeDemandSummary, routeLoadFactors } from './demand';
import { routeCapabilitiesForAirport, type RouteCapabilities } from './registry';

/**
 * 旅客実績の集計と、提案の見込み搭乗率（フェーズ 3 §5）。読み取り専用の導出。
 */
export interface TrafficTotals {
  flights: number;
  /** 旅客数（予約 + 到着） */
  pax: number;
  /** 供給座席（両方向） */
  seats: number;
  /** 搭乗率（pax ÷ seats。座席 0 は null） */
  loadFactor: number | null;
}

const empty = (): TrafficTotals => ({ flights: 0, pax: 0, seats: 0, loadFactor: null });

function add(t: TrafficTotals, r: FlightRecord): void {
  if (r.result === 'cancelled') return;
  t.flights += 1;
  t.pax += r.paxBooked + r.paxArrived;
  t.seats += r.seats * 2;
}

function finish(map: Map<string, TrafficTotals>): Map<string, TrafficTotals> {
  for (const t of map.values()) t.loadFactor = t.seats > 0 ? t.pax / t.seats : null;
  return map;
}

/** 航空会社ごとの実績 */
export function trafficByAirline(records: readonly FlightRecord[]): Map<string, TrafficTotals> {
  const map = new Map<string, TrafficTotals>();
  for (const r of records) {
    if (!r.airlineId) continue;
    const t = map.get(r.airlineId) ?? empty();
    add(t, r);
    map.set(r.airlineId, t);
  }
  return finish(map);
}

/** 路線（就航先）ごとの実績。契約 ID → 就航先 ID の解決を渡す */
export function trafficByRoute(records: readonly FlightRecord[], destinationOf: (contractId: string) => string | undefined): Map<string, TrafficTotals> {
  const map = new Map<string, TrafficTotals>();
  for (const r of records) {
    if (!r.contractId) continue;
    const destId = destinationOf(r.contractId);
    if (!destId) continue;
    const t = map.get(destId) ?? empty();
    add(t, r);
    map.set(destId, t);
  }
  return finish(map);
}

export interface LoadFactorPreview {
  /** 見込み搭乗率（0〜1） */
  lf: number;
  /** その路線のその日の需要（人/日・両方向、配分後） */
  demand: number;
  /** その路線の供給座席（この契約を含む） */
  seats: number;
}

/**
 * 提案（または仮の契約）の見込み搭乗率。market がない会社・city がない会社は null。
 * 仮の契約を足した会社で routeLoadFactors を計算し直す（会社そのものは変更しない）。
 */
export function previewLoadFactor(
  c: CompanyState,
  candidate: Pick<Contract, 'airlineId' | 'destinationId' | 'typeId'> & { perDay: number },
  day: number,
  access = 1,
  types: TypeTable = AIRCRAFT_TYPES,
  routeCapabilities: RouteCapabilities = routeCapabilitiesForAirport(),
): LoadFactorPreview | null {
  if (!c.market || !c.city) return null;
  const virtual: Contract = {
    id: '__preview',
    airlineId: candidate.airlineId,
    destinationId: candidate.destinationId,
    typeId: candidate.typeId as AircraftTypeId,
    perDay: candidate.perDay,
    window: 'any',
    feeDiscount: 0,
    startDay: day,
    endDay: day,
    status: 'active',
    offerExpiresDay: day,
    numberBase: 0,
  };
  const c2: CompanyState = { ...c, contracts: { ...c.contracts, [virtual.id]: virtual } };
  const lfs = routeLoadFactors(c2, day, access, types, routeCapabilities);
  const lf = lfs?.get(virtual.id);
  if (lf === undefined) return null;
  const info = routeDemandSummary(c2, day, access, types, routeCapabilities)?.get(candidate.destinationId);
  return { lf, demand: info?.demand ?? 0, seats: info?.seats ?? 0 };
}
