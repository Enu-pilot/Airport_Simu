import type { FacilityKind, SizeClass, TerminalAreaKind } from '../model/types';
import type { UnitKind } from '../sim/types';

/**
 * ゲームバランス用の設定値（docs/14_management_rules.md）。
 *
 * 金額はすべてゲーム内通貨「cr（クレジット）」で、現実の空港料金・人件費・建設費とは無関係です。
 * 数値はゲームとしての遊びやすさのための仮の値で、ここだけを変えれば調整できるようにしている。
 */
export const CURRENCY = 'cr';

export const BALANCE = {
  /** 初期資金（キャリア: 小さな飛行場から / サンドボックス） */
  initialCash: { career: 4_000_000, sandbox: 1_000_000_000 },

  // ------------------------------------------------------------ 建設費
  construction: {
    runwayPerTile: 40_000,
    taxiwayPerTile: { S: 4_000, M: 6_000, L: 8_000 } as Record<SizeClass, number>,
    roadPerTile: 1_500,
    stand: { S: 60_000, M: 100_000, L: 180_000 } as Record<SizeClass, number>,
    /** 面積型の施設（タイルあたり、ターミナルは階ごと） */
    perTile: { apron: 1_500, terminal: 20_000, serviceArea: 500, parking: 800 } as Partial<Record<FacilityKind, number>>,
    facility: {
      gate: 50_000,
      hangar: 1_200_000,
      tower: 800_000,
      maintenance: 500_000,
      fuelFarm: 600_000,
      fireStation: 500_000,
      gseBase: 400_000,
      baggageSort: 700_000,
    } as Partial<Record<FacilityKind, number>>,
    jetBridge: 150_000,
    /** 車両の購入費（GSE基地のプロパティの台数分） */
    vehicle: { tug: 150_000, beltLoader: 80_000, baggageTractor: 60_000, fuelTruck: 200_000, cateringTruck: 120_000, cleaningVan: 50_000 } as Partial<Record<UnitKind, number>>,
    /** ターミナル内のエリア（設備1つあたり、またはタイルあたり） */
    areaUnit: { checkIn: 20_000, security: 120_000, baggageClaim: 150_000, restroom: 30_000, shop: 80_000, restaurant: 120_000, escalator: 200_000, elevator: 150_000 } as Partial<Record<TerminalAreaKind, number>>,
    areaPerTile: 2_000,
    /** 撤去・縮小したときに戻る割合 */
    refundRate: 0.25,
  },

  // ------------------------------------------------------------ 収入
  fees: {
    /** 着陸料（最大離陸重量 1t あたり）。ピーク時間は割増 */
    landingPerTonne: 150,
    peakSurcharge: 0.25,
    /** 駐機料（無料時間を超えた1時間あたり） */
    parkingFreeHours: 2,
    parkingPerHour: { S: 500, M: 1_000, L: 2_000 } as Record<SizeClass, number>,
    /** ターミナル使用料（旅客1人あたり） */
    paxDeparting: 120,
    paxArriving: 60,
    /** 地上支援料（1回の折り返しあたり） */
    groundHandling: { S: 3_000, M: 6_000, L: 12_000 } as Record<SizeClass, number>,
    /** 契約料（契約した1日の便数1便あたり、1日ごと） */
    contractPerDailyFlight: 3_000,
  },
  /** 料金の倍率をプレイヤーが変えたときの需要・航空会社満足度への影響 */
  feeSensitivity: { loadFactorPerRatio: 0.3, satisfactionPerRatio: 12 },
  retail: { shopPerPax: 15, restaurantPerPax: 22, shopVisitProb: 0.5, shopSec: 8 * 60, restaurantSec: 20 * 60, minSlackSec: 40 * 60 },
  carPark: { carShare: 0.3, feePerCar: 400, stayDays: 2 },

  // ------------------------------------------------------------ 費用（1日あたり）
  daily: {
    salary: { staff: 1_200, engineer: 2_000 } as Partial<Record<UnitKind, number>>,
    /** 車両の維持費（1台あたり） */
    vehicle: 300,
    /** 窓口の要員（カウンター・レーン・ゲート 1つあたり） */
    checkInCounter: 800,
    securityLane: 2_500,
    gate: 600,
    /** 施設の維持費（建設費に対する1日あたりの割合） */
    maintenanceRate: 0.0003,
    /** 光熱費（ターミナル1タイル・1階あたり） */
    utilitiesPerTerminalTile: 30,
  },
  /** 地上支援の作業ごとの運営費 */
  taskCost: { unload: 300, load: 300, fuel: 600, clean: 400, cater: 300, inspect: 600, pushback: 200, defect: 3_000 } as Record<string, number>,
  /** 補償・対応費 */
  compensation: { missedPax: 400, leftBag: 300, delayedFlight60: 5_000 },

  // ------------------------------------------------------------ 需要・航空会社
  demand: {
    /** 搭乗率 = 基本 × 路線需要 × 料金係数 × 評価係数 × 揺らぎ */
    baseLoadFactor: { fullService: 0.78, lcc: 0.86, regional: 0.7 },
    ratingFactorMin: 0.75,
    ratingFactorMax: 1.15,
    noise: 0.08,
    inboundDelayProb: 0.2,
    inboundDelayMaxMin: 30,
  },
  offers: { baseProb: 0.12, ratingProb: 0.3, maxOpen: 6, expireDays: 3, contractDays: 30 },
  contracts: { renewGoodSat: 70, renewOkSat: 45, withdrawSat: 25, withdrawDays: 3, increaseMinSat: 60, decreasePenaltySat: 10 },
  bankruptcyDays: 30,
} as const;

/** 定時運航の判定（予定から15分以内） */
export const ON_TIME_SEC = 15 * 60;
