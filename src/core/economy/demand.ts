import { AIRCRAFT_TYPES, type TypeTable } from '../sim/aircraftTypes';
import { BALANCE } from './balance';
import { airMarketPopulationOf } from './city';
import { activeContractsOn, seatsFor, type CompanyState } from './company';
import { airlineDef, destinationDef, routeAvailability, routeCapabilitiesForAirport, type DestinationDef, type RouteCapabilities } from './registry';

/**
 * 路線需要モデル（フェーズ 3 §3。docs/42 3-05〜3-08）。
 * market が有効な会社だけが使う。自都市と相手都市の規模・需要構成・距離から路線の需要（人/日、両方向）を出し、
 * 路線の座席で割って契約ごとの搭乗率を決める。新しい乱数は使わない。
 * docs/46 反映（2026-11-19）: 出発側は航空市場人口、目的地側は利用圏人口・必須需要・
 * 航空依存度・季節プロファイルを使い、都市総需要上限による路線間の比例縮小はしない。
 */

export interface RouteDemandInfo {
  destinationId: string;
  /** その日の路線需要（人/日・両方向。OD ごとの潜在需要そのもの） */
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

/** 必須需要の互換読み込み（docs/46: essential ?? business ?? 1） */
export function essentialOf(demand: { essential?: number; business?: number }): number {
  return demand.essential ?? demand.business ?? 1;
}

/** 需要指数 I_d（必須需要と観光の加重。docs/46 で business から essential へ移行） */
export function demandIndex(dest: { demand: { essential?: number; business?: number; leisure: number } }): number {
  return 0.55 * essentialOf(dest.demand) + 0.45 * dest.demand.leisure;
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

const mean12 = (table: readonly number[]): number => table.reduce((a, v) => a + v, 0) / 12;

/**
 * 季節・曜日係数: 相手都市の必須/観光の構成で重み付けし、需要指数で割って平均 1 に保つ。
 *
 * 月別係数は docs/46 §3.2 の式: 必須需要は essentialMonth、観光需要は目的地の
 * seasonalityProfile の表を使い、合成して需要指数で割る（年間平均 1）。
 * プロファイルのない目的地（国際線など）は従来の monthBusiness/monthLeisure を使う。
 * 曜日係数は従来の weekdayBusiness/weekdayLeisure を必須/観光の重みで合成したものを
 * そのまま使う（docs/46 は曜日係数の値を指定していないための簡略化）。
 */
export function seasonalWeekdayFactor(dest: { demand: { essential?: number; business?: number; leisure: number }; seasonalityProfile?: DestinationDef['seasonalityProfile'] }, day: number): number {
  const idx = demandIndex(dest);
  if (idx <= 0) return 1;
  const M = BALANCE.market;
  const wd = weekdayOf(day);
  const mo = monthOf(day);
  const essential = essentialOf(dest.demand);
  const profile = dest.seasonalityProfile ? M.seasonalityProfiles[dest.seasonalityProfile] : undefined;
  if (!profile) {
    // プロファイルのない目的地は従来の合成式のまま（business は essential へ読み替える）
    const business = 0.55 * essential * M.weekdayBusiness[wd]! * M.monthBusiness[mo]!;
    const leisure = 0.45 * dest.demand.leisure * M.weekdayLeisure[wd]! * M.monthLeisure[mo]!;
    return (business + leisure) / idx;
  }
  const weekday = (0.55 * essential * M.weekdayBusiness[wd]! + 0.45 * dest.demand.leisure * M.weekdayLeisure[wd]!) / idx;
  const essentialMonth = M.essentialMonth[mo]! / mean12(M.essentialMonth);
  const leisureMonth = profile[mo]! / mean12(profile);
  const monthly = (0.55 * essential * essentialMonth + 0.45 * dest.demand.leisure * leisureMonth) / idx;
  return weekday * monthly;
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
  // docs/46: 出発側は航空市場人口（未設定なら都市人口）、目的地側は利用圏人口
  // （未設定なら従来の population）、航空依存度は目的地側に一度だけ掛ける
  return (
    M.K *
    Math.pow(airMarketPopulationOf(c.city) / 1e6, M.alpha) *
    Math.pow((dest.catchmentPopulation ?? dest.population) / 1e6, M.beta) *
    demandIndex(dest) *
    dest.aviationDependency *
    distanceFactor(dest.distanceKm) *
    phi *
    a *
    fee *
    rating
  );
}

/**
 * その日の路線ごとの需要と供給。city がなければ null。
 * docs/46 §7.1-3: 市場モードでは都市総需要上限による路線間の比例縮小をしない。
 * 各 OD の潜在需要は独立で、他路線の追加・削除で変わらない（受入条件 9）。
 * cityDemandCeiling は都市成長・レガシー経路の用途に残してある（city.ts）。
 */
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
    const seats = k.perDay * seatsFor(c, k.airlineId, k.typeId, types) * 2;
    seatsByDest.set(k.destinationId, (seatsByDest.get(k.destinationId) ?? 0) + seats);
  }
  const out = new Map<string, RouteDemandInfo>();
  for (const [destId, seats] of seatsByDest) {
    const dest = destinationDef(destId);
    const demand = (routeDemand(c, dest, access) ?? 0) * seasonalWeekdayFactor(dest, day);
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
