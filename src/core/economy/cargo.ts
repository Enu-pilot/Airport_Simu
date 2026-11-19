import { AIRCRAFT_MODELS } from '../aircraft/catalog';
import { BALANCE } from './balance';
import { airlineDef, destinationDef, type DestinationDef } from './registry';
import { effectiveTier } from './unlocks';
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
 * 大型貨物専用機の境界（CARGO-08 格 5「取扱規模拡張」、PO 承認 2026-11-19）。
 * 貨物専用機（座席を持たない機種）のうち、主甲板＋下部貨物室の合計容積が
 * 600 m³ 以上のものを大型とする。カタログ値では B767-300F が 438 m³、
 * B747-400F 605 / B777F 653 / B747-8F 855 m³ で、この境界が両群を分ける。
 * 旅客機のベリー貨物は対象外（専用機だけを数える）。
 */
export const LARGE_FREIGHTER_MIN_M3 = 600;

/** その機種が格 5 で解放される大型貨物専用機か（カタログに無い機種は false） */
export function isLargeFreighter(typeId: string): boolean {
  const model = AIRCRAFT_MODELS.find((m) => m.id === typeId);
  if (!model || model.defaultSeats !== 0) return false;
  return (model.cargoM3.value ?? 0) >= LARGE_FREIGHTER_MIN_M3;
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
  /**
   * 積替貨物 (m3/日、CARGO-08 格 7)。到着貨物のうち翌日便へ接続する量。
   * 格 7 未満・接続先のない単一路線・翌日に運搬のない日は 0。
   * 運搬量 (carriedM3) の内数であり、需要・積み残しの保存式には影響しない。
   */
  transshipmentM3: number;
}

/**
 * その日の貨物契約の運搬計画（5-12 CARGO-02 の集計層）。
 * 路線需要を、その路線の有効な貨物契約へ均等に割り当て、各契約の能力で頭打ちにする。
 * 保存式: 需要 = 運べた量 + 積み残し（能力未算出の契約分は積み残し側に入る）。
 * 旅客の便計画（planning.ts）とは独立で、旅客便は生成しない。
 */
export function planCargoDay(c: CompanyState, day: number): CargoDayPlan {
  const base = planCargoDayBase(c, day);
  return { ...base, transshipmentM3: transshipmentM3For(c, base, day) };
}

/**
 * 積替量 (CARGO-08 格 7)。接続は翌日便のみ:
 * - 片方向の運搬量は路線別 carried の半分（計画は両方向合算のため）。
 * - 路線 d から他路線への接続上限は min(片方向_d, 片方向合計 − 片方向_d) の合計
 *   （同一路線内の折り返しは積替に数えない）。
 * - 接続率 (BALANCE.cargo.transshipmentShare) を掛け、翌日の片方向運搬量でも頭打ちにする
 *   （翌日に便がなければ積替は成立しない）。
 */
function transshipmentM3For(c: CompanyState, base: CargoDayPlanBase, day: number): number {
  if (effectiveTier(c) < 7 || base.carriedM3 <= 0) return 0;
  const oneDirByDest = new Map<string, number>();
  for (const row of base.contracts) {
    oneDirByDest.set(row.destinationId, (oneDirByDest.get(row.destinationId) ?? 0) + row.carriedM3 / 2);
  }
  if (oneDirByDest.size < 2) return 0;
  const totalOneDir = [...oneDirByDest.values()].reduce((a, v) => a + v, 0);
  let connectable = 0;
  for (const v of oneDirByDest.values()) connectable += Math.min(v, totalOneDir - v);
  if (connectable <= 0) return 0;
  const nextDayOneDir = planCargoDayBase(c, day + 1).carriedM3 / 2;
  return Math.min(BALANCE.cargo.transshipmentShare * connectable, nextDayOneDir);
}

type CargoDayPlanBase = Omit<CargoDayPlan, 'transshipmentM3'>;

function planCargoDayBase(c: CompanyState, day: number): CargoDayPlanBase {
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
  // 積替も同率で縮む（接続便へ載せられる量自体が減るため）
  return { ...plan, contracts, carriedM3, leftoverM3: plan.demandM3 - carriedM3, transshipmentM3: plan.transshipmentM3 * scale };
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
  /** 貨物トラック搬出入の推定台数 (台/日、集約換算。個別車両は運行しない。積替分は空港を出ないため除く) */
  truckTrips: number;
  /** 積替貨物 (m3/日、CARGO-08 格 7。格 7 未満や接続なしでは 0) */
  transshipmentM3: number;
}

/** トラック搬出入の対象量 = 運搬量 − 積替量（積替貨物は空港の外へ出ない） */
function truckedM3(carriedM3: number, transshipmentM3: number): number {
  return Math.max(0, carriedM3 - transshipmentM3);
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
  const transshipmentM3 = plan.transshipmentM3;
  return {
    day,
    carriedM3: plan.carriedM3,
    leftoverM3: plan.leftoverM3,
    revenue: Math.round(plan.carriedM3 * M.revenuePerM3),
    handlingCost: Math.round(plan.carriedM3 * M.handlingCostPerM3),
    truckTrips: Math.ceil(truckedM3(plan.carriedM3, transshipmentM3) / M.truckCapacityM3),
    transshipmentM3,
  };
}

/**
 * その日の計画ベースの貨物トラック台数（台/日、5-12 CARGO-05）。
 * 道路競合の背景交通として使う推定値で、当日計画の運搬量から集約換算する。
 * 実績の台数は cargoActualFinance / cargoDailyFinance 側が正で、こちらは表示には使わない。
 */
export function cargoPlannedTruckTripsPerDay(c: CompanyState, day: number): number {
  const plan = planCargoDay(c, day);
  const trucked = truckedM3(plan.carriedM3, plan.transshipmentM3);
  return trucked > 0 ? Math.ceil(trucked / BALANCE.cargo.truckCapacityM3) : 0;
}

/**
 * 貨物トラック搬出入の時間帯配分（CARGO-08 格 6）。格 6 以上でのみ有効で、
 * 1 日の計画台数を BALANCE.cargo.truckHourlyProfile の重みで 24 時間へ配分する。
 * 合計は cargoPlannedTruckTripsPerDay と一致する（配分だけが変わる）。
 * 格 6 未満は null（呼び出し側は従来の 24 時間均等配分を使う）。
 */
export function cargoPlannedTruckTripsByHour(c: CompanyState, day: number): number[] | null {
  if (effectiveTier(c) < 6) return null;
  const total = cargoPlannedTruckTripsPerDay(c, day);
  const profile = BALANCE.cargo.truckHourlyProfile;
  const weightSum = profile.reduce((a, v) => a + v, 0);
  if (total <= 0 || weightSum <= 0) return profile.map(() => 0);
  return profile.map((w) => (total * w) / weightSum);
}

/**
 * 実績ベースの貨物収支（5-12 の sim 実便化）。計画値ではなく、その日に貨物タスクが
 * 実際に完了して積み下ろしした量 (m3) から収入・荷役費・トラック台数を出す。
 * 積み残しは「その日の路線需要 − 実績の運搬量」。日次締めが日報と台帳への計上に使う。
 */
export function cargoActualFinance(c: CompanyState, day: number, actualCarriedM3: number): CargoDailyFinance {
  const plan = planCargoDay(c, day);
  const carriedM3 = Math.max(0, actualCarriedM3);
  const M = BALANCE.cargo;
  // 積替の実績は計画の接続量を上限とし、実績の運搬量を超えない
  const transshipmentM3 = Math.min(plan.transshipmentM3, carriedM3);
  return {
    day,
    carriedM3,
    leftoverM3: Math.max(0, plan.demandM3 - carriedM3),
    revenue: Math.round(carriedM3 * M.revenuePerM3),
    handlingCost: Math.round(carriedM3 * M.handlingCostPerM3),
    truckTrips: Math.ceil(truckedM3(carriedM3, transshipmentM3) / M.truckCapacityM3),
    transshipmentM3,
  };
}
