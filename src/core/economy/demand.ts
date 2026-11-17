import { AIRCRAFT_TYPES, type TypeTable } from '../sim/aircraftTypes';
import { BALANCE } from './balance';
import { cityDemandCeiling, cityEventEffects } from './city';
import { activeContractsOn, seatsFor, type CompanyState } from './company';
import { airlineDef, destinationDef, routeAvailability, routeCapabilitiesForAirport, type DestinationDef, type RouteCapabilities } from './registry';

/**
 * 路線需要モデル（フェーズ 3 §3。docs/42 3-05〜3-08）。
 * market が有効な会社だけが使う。自都市と相手都市の規模・需要構成・距離から路線の需要（人/日、両方向）を出し、
 * 都市の需要上限で配分して、路線の座席で割って契約ごとの搭乗率を決める。新しい乱数は使わない。
 */

export interface RouteDemandInfo {
  destinationId: string;
  /** その日の路線需要（人/日・両方向。都市の需要上限で配分した後） */
  demand: number;
  /** 供給座席（両方向） */
  seats: number;
  /** 需要 ÷ 座席（路線の基準搭乗率 L_r） */
  baseLf: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 距離の減衰 g(d) */
export function distanceFactor(distanceKm: number): number {
  return Math.min(1, 0.4 + (0.6 * distanceKm) / 600) * Math.exp(-Math.max(0, distanceKm - 1000) / 6000);
}

/** 需要指数 I_d（業務と観光の加重） */
export function demandIndex(dest: Pick<DestinationDef, 'demand'>): number {
  return 0.55 * dest.demand.business + 0.45 * dest.demand.leisure;
}

/**
 * 路線の需要 D_r（人/日・両方向、配分前）。city がない会社は null。
 * D_r = K × (P_o/1e6)^α × (P_d/1e6)^β × I_d × g(d) × φ_r × A × F × R
 */
export function routeDemand(c: CompanyState, dest: DestinationDef, access = 1): number | null {
  if (!c.city) return null;
  const M = BALANCE.market;
  const fee = 1 - (c.fees.terminal - 1) * BALANCE.feeSensitivity.loadFactorPerRatio;
  const rating = BALANCE.demand.ratingFactorMin + ((BALANCE.demand.ratingFactorMax - BALANCE.demand.ratingFactorMin) * c.rating) / 100;
  const phi = dest.scope === 'domestic' ? 1 : M.internationalFactor;
  // アクセス係数 A は都市需要上限と同じ正規化（0.7 + 0.3 × 正規化アクセス。計画 §3.6 の計算例）
  const a = 0.7 + 0.3 * Math.min(1, Math.max(0, (access - 0.3) / 0.8));
  return (
    M.K *
    Math.pow(c.city.population / 1e6, M.alpha) *
    Math.pow(dest.population / 1e6, M.beta) *
    demandIndex(dest) *
    distanceFactor(dest.distanceKm) *
    phi *
    a *
    fee *
    rating
  );
}

/** その日の路線ごとの需要と供給（都市の需要上限 C で配分した後）。city がなければ null */
export function routeDemandSummary(
  c: CompanyState,
  day: number,
  access = 1,
  types: TypeTable = AIRCRAFT_TYPES,
  routeCapabilities: RouteCapabilities = routeCapabilitiesForAirport(),
): Map<string, RouteDemandInfo> | null {
  if (!c.city) return null;
  const seatsByDest = new Map<string, number>();
  for (const k of activeContractsOn(c, day)) {
    if (routeAvailability(airlineDef(k.airlineId), destinationDef(k.destinationId), routeCapabilities) !== 'available') continue;
    seatsByDest.set(k.destinationId, (seatsByDest.get(k.destinationId) ?? 0) + k.perDay * seatsFor(c, k.airlineId, k.typeId, types) * 2);
  }
  const raw = new Map<string, number>();
  let total = 0;
  for (const destId of seatsByDest.keys()) {
    const d = routeDemand(c, destinationDef(destId), access) ?? 0;
    raw.set(destId, d);
    total += d;
  }
  const ceiling = cityDemandCeiling(c.city, access) * cityEventEffects(c.city, day).demandMultiplier;
  const scale = total > 0 ? Math.min(1, ceiling / total) : 1;
  const out = new Map<string, RouteDemandInfo>();
  for (const [destId, seats] of seatsByDest) {
    const demand = (raw.get(destId) ?? 0) * scale;
    out.set(destId, { destinationId: destId, demand, seats, baseLf: seats > 0 ? demand / seats : 0 });
  }
  return out;
}

const TYPE_APPEAL: Record<string, number> = { fullService: 1.0, lcc: 1.05, regional: 0.95 };

/**
 * 契約ごとの搭乗率 L_k（揺らぎなし）。city がなければ null。
 * L_k = clamp(L_r × q_k / q̄_r, lfMin, lfMax)。q は会社の種別と運賃水準、q̄ は路線内の座席加重平均。
 */
export function routeLoadFactors(
  c: CompanyState,
  day: number,
  access = 1,
  types: TypeTable = AIRCRAFT_TYPES,
  routeCapabilities: RouteCapabilities = routeCapabilitiesForAirport(),
): Map<string, number> | null {
  const summary = routeDemandSummary(c, day, access, types, routeCapabilities);
  if (!summary) return null;
  const M = BALANCE.market;
  const byDest = new Map<string, { k: (typeof contracts)[number]; q: number; seats: number }[]>();
  const contracts = activeContractsOn(c, day).filter(
    (k) => routeAvailability(airlineDef(k.airlineId), destinationDef(k.destinationId), routeCapabilities) === 'available',
  );
  for (const k of contracts) {
    const dest = destinationDef(k.destinationId);
    const idx = demandIndex(dest);
    const leisureShare = idx > 0 ? (0.45 * dest.demand.leisure) / idx : 0;
    const priceSensitivityOfMarket = 0.45 * leisureShare + 0.15;
    const a = airlineDef(k.airlineId);
    const q = (TYPE_APPEAL[a.type] ?? 1) * (1 + 0.3 * priceSensitivityOfMarket * (1 - a.fareLevel));
    const list = byDest.get(k.destinationId) ?? [];
    list.push({ k, q, seats: k.perDay * seatsFor(c, k.airlineId, k.typeId, types) * 2 });
    byDest.set(k.destinationId, list);
  }
  const out = new Map<string, number>();
  for (const [destId, list] of byDest) {
    const info = summary.get(destId);
    if (!info) continue;
    const seatTotal = list.reduce((s, x) => s + x.seats, 0);
    const qBar = seatTotal > 0 ? list.reduce((s, x) => s + x.q * x.seats, 0) / seatTotal : 1;
    for (const x of list) out.set(x.k.id, clamp(info.baseLf * (qBar > 0 ? x.q / qBar : 1), M.lfMin, M.lfMax));
  }
  return out;
}
