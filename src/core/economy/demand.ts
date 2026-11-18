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

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** day（開始日 = 0）→ 曜日（0 = 月曜〜6 = 日曜） */
export function weekdayOf(day: number): number {
  return ((Math.floor(day) % 7) + 7) % 7;
}

/** day → 月（0 = 1 月。1 年 = 365 日の繰り返し） */
export function monthOf(day: number): number {
  let rest = ((Math.floor(day) % 365) + 365) % 365;
  for (let m = 0; m < 12; m++) {
    if (rest < MONTH_DAYS[m]!) return m;
    rest -= MONTH_DAYS[m]!;
  }
  return 11;
}

/**
 * 季節・曜日係数（5-06）: 相手都市の業務/観光の構成で重み付けし、需要指数で割って平均 1 に保つ。
 * 業務は平日（特に金曜）と年度末に寄り、観光は週末と 5 月・8 月・年末年始に寄る。
 */
export function seasonalWeekdayFactor(dest: Pick<DestinationDef, 'demand'>, day: number): number {
  const idx = demandIndex(dest);
  if (idx <= 0) return 1;
  const M = BALANCE.market;
  const wd = weekdayOf(day);
  const mo = monthOf(day);
  const business = 0.55 * dest.demand.business * M.weekdayBusiness[wd]! * M.monthBusiness[mo]!;
  const leisure = 0.45 * dest.demand.leisure * M.weekdayLeisure[wd]! * M.monthLeisure[mo]!;
  return (business + leisure) / idx;
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
    const dest = destinationDef(destId);
    const d = (routeDemand(c, dest, access) ?? 0) * seasonalWeekdayFactor(dest, day);
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
