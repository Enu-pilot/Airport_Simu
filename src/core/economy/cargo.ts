import { AIRCRAFT_MODELS } from '../aircraft/catalog';
import { BALANCE } from './balance';
import { airlineDef, destinationDef, type DestinationDef } from './registry';
import type { CompanyState } from './company';
import type { AirportLayout } from '../model/types';

/**
 * 貨物の基盤（5-12 CARGO-01 / CARGO-03）。
 *
 * 旅客モデルとは独立に、都市の貨物需要指数から路線の日次貨物需要（m3）を算出する。
 * 乱数は使わない（決定性は旅客側と同じ）。貨物は opt-in で、貨物契約を持つ会社だけが
 * 後続の便生成・荷役でこの需要を使う。ここでは需要と適格・容量の参照だけを提供し、
 * 既存の旅客便・旅客数・収支には一切触れない。
 *
 * 単位は容積 (m3) で統一する。貨物重量は実データがないため扱わない（計画 §2）。
 */

/** 貨物の距離係数: 短距離はトラック代替で小さく、長距離は緩やかに減衰する（ゲーム値） */
export function cargoDistanceFactor(distanceKm: number): number {
  return Math.min(1, 0.25 + distanceKm / 1200) * Math.exp(-Math.max(0, distanceKm - 3000) / 9000);
}

/**
 * 路線の貨物需要 (m3/日・両方向、配分前)。city がない会社は null。
 * D = K × (P_o/1e6)^alpha × (P_d/1e6)^beta × cargoIndex × g_cargo(d) × phi
 */
export function routeCargoDemandM3(c: CompanyState, dest: DestinationDef): number | null {
  if (!c.city) return null;
  const M = BALANCE.cargo;
  const phi = dest.scope === 'domestic' ? 1 : M.internationalFactor;
  return (
    M.K *
    Math.pow(c.city.population / 1e6, M.alpha) *
    Math.pow(dest.population / 1e6, M.beta) *
    dest.demand.cargo *
    cargoDistanceFactor(dest.distanceKm) *
    phi
  );
}

/** 航空会社が貨物サービスを提供するか（貨物契約の適格条件、CARGO-01） */
export function airlineCargoEligible(airlineId: string): boolean {
  return airlineDef(airlineId).services.includes('cargo');
}

/**
 * 機種の下部貨物室容積 (m3、CARGO-03)。カタログに出典付きの値がある場合だけ返す。
 * 未設定の機種は null（未算出）で、推定はしない（docs/16 のデータ品質ルール）。
 * これは旅客便のベリー容量であり、貨物専用機の主甲板容量は CARGO-02 以降で扱う。
 */
export function cargoHoldM3(typeId: string): number | null {
  const model = AIRCRAFT_MODELS.find((m) => m.id === typeId);
  if (!model) return null;
  return model.cargoM3.value;
}

export interface CargoContractDay {
  contractId: string;
  destinationId: string;
  /** その契約の 1 日の輸送能力 (m3、往復)。機種の容積が未算出なら null */
  capacityM3: number | null;
  /** 割り当てられた需要 (m3) */
  allocatedM3: number;
  /** 実際に運べる量 (m3) = min(割当, 能力)。能力が未算出なら 0 */
  carriedM3: number;
}

export interface CargoDayPlan {
  day: number;
  contracts: CargoContractDay[];
  /** 路線需要の合計 (m3/日) */
  demandM3: number;
  /** 運べた量の合計 (m3/日) */
  carriedM3: number;
  /** 積み残し (m3/日) = 需要 − 運べた量 */
  leftoverM3: number;
}

/**
 * その日の貨物契約の運搬計画（5-12 CARGO-02 の集計層）。
 * 路線需要を、その路線の有効な貨物契約へ均等に割り当て、各契約の能力で頭打ちにする。
 * 保存式: 需要 = 運べた量 + 積み残し（能力未算出の契約分は積み残し側に入る）。
 * 旅客の便計画（planning.ts）とは独立で、旅客便は生成しない。
 */
export function planCargoDay(c: CompanyState, day: number): CargoDayPlan {
  const active = Object.values(c.contracts).filter(
    (k) => k.kind === 'cargo' && k.status === 'active' && day >= k.startDay && day <= k.endDay,
  );
  const byDest = new Map<string, typeof active>();
  for (const k of active) {
    const arr = byDest.get(k.destinationId) ?? [];
    arr.push(k);
    byDest.set(k.destinationId, arr);
  }
  const contracts: CargoContractDay[] = [];
  let demandTotal = 0;
  let carriedTotal = 0;
  for (const [destId, ks] of byDest) {
    const demand = routeCargoDemandM3(c, destinationDef(destId)) ?? 0;
    demandTotal += demand;
    const share = demand / ks.length;
    for (const k of ks) {
      const hold = cargoHoldM3(k.typeId);
      const capacityM3 = hold === null ? null : hold * k.perDay * 2;
      const carriedM3 = capacityM3 === null ? 0 : Math.min(share, capacityM3);
      carriedTotal += carriedM3;
      contracts.push({ contractId: k.id, destinationId: destId, capacityM3, allocatedM3: share, carriedM3 });
    }
  }
  contracts.sort((a, b) => (a.contractId < b.contractId ? -1 : 1));
  return { day, contracts, demandM3: demandTotal, carriedM3: carriedTotal, leftoverM3: demandTotal - carriedTotal };
}

/**
 * 貨物上屋の荷役能力（5-12 CARGO-04）。運用中で建物内包でない貨物上屋の
 * throughputM3PerHour の合計 (m3/時)。旅客ターミナルの能力には合算しない。
 */
export function cargoHandlingCapacityM3PerHour(layout: AirportLayout): number {
  let total = 0;
  for (const f of Object.values(layout.facilities)) {
    if (f.kind !== 'cargoTerminal' || f.buildState !== 'operational' || f.parentFacilityId) continue;
    total += Math.max(0, Number(f.props.throughputM3PerHour ?? 0) || 0);
  }
  return total;
}

/**
 * 荷役能力で運搬計画を頭打ちにする（CARGO-04）。能力を超えた分は積み残しへ移り、
 * 保存式（需要 = 運搬 + 積み残し）は保たれる。契約ごとの配分は元の carried 比率で按分する。
 */
export function limitCargoByHandling(plan: CargoDayPlan, capacityM3PerDay: number): CargoDayPlan {
  if (plan.carriedM3 <= capacityM3PerDay) return plan;
  const scale = plan.carriedM3 > 0 ? capacityM3PerDay / plan.carriedM3 : 0;
  const contracts = plan.contracts.map((row) => ({ ...row, carriedM3: row.carriedM3 * scale }));
  const carriedM3 = contracts.reduce((a, r) => a + r.carriedM3, 0);
  return { ...plan, contracts, carriedM3, leftoverM3: plan.demandM3 - carriedM3 };
}

export interface CargoDailyFinance {
  day: number;
  /** 運搬量 (m3) */
  carriedM3: number;
  /** 積み残し (m3) */
  leftoverM3: number;
  /** 貨物収入 (cr) = 運搬量 × revenuePerM3 */
  revenue: number;
  /** 荷役費 (cr) = 上屋で処理した量 × handlingCostPerM3 */
  handlingCost: number;
  /** 貨物トラック搬出入の推定台数 (台/日、集約換算。個別車両は運行しない) */
  truckTrips: number;
}

/**
 * その日の貨物収支と陸側搬出入の集計（5-12 CARGO-05/06 の計算層）。
 * 運搬計画（planCargoDay）を、呼び出し側が決めた 1 日の荷役能力（m3/日。
 * 例: 貨物上屋の能力/時 × 運用時間）で頭打ちにしてから、収入・荷役費・
 * トラック台数を出す。旅客の収支とは分離した独立集計で、日報への永続化は
 * 行わない（保存形式・フィンガープリントに触れない）。
 */
export function cargoDailyFinance(c: CompanyState, day: number, handlingCapacityM3PerDay: number): CargoDailyFinance {
  const plan = limitCargoByHandling(planCargoDay(c, day), handlingCapacityM3PerDay);
  const M = BALANCE.cargo;
  return {
    day,
    carriedM3: plan.carriedM3,
    leftoverM3: plan.leftoverM3,
    revenue: Math.round(plan.carriedM3 * M.revenuePerM3),
    handlingCost: Math.round(plan.carriedM3 * M.handlingCostPerM3),
    truckTrips: Math.ceil(plan.carriedM3 / M.truckCapacityM3),
  };
}
