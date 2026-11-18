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
    tunnelMultiplier: 10,
    elevatedMultiplier: 2,
    fuelPipePerTile: 1_500,
    terminalWalkwayPerTile: 4_500,
    movingWalkwayPerTile: 12_000,
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
    vehicle: { tug: 150_000, beltLoader: 80_000, baggageTractor: 60_000, fuelTruck: 200_000, cateringTruck: 120_000, cleaningVan: 50_000, apronBus: 250_000 } as Partial<Record<UnitKind, number>>,
    /** ターミナル内のエリア（設備1つあたり、またはタイルあたり） */
    areaUnit: { checkIn: 20_000, security: 120_000, baggageClaim: 150_000, restroom: 30_000, shop: 80_000, restaurant: 120_000, escalator: 200_000, elevator: 150_000 } as Partial<Record<TerminalAreaKind, number>>,
    areaPerTile: 2_000,
    /** 撤去・縮小したときに戻る割合 */
    refundRate: 0.25,
    /** 空港アクセス・周辺施設（Phase 6） */
    access: { taxiStand: 60_000, busStop: 90_000, railStation: 2_500_000, hotel: 1_800_000, staffParkingPerTile: 600, railPerTile: 25_000 },
    /** 土地の購入費（1タイルあたり） */
    landPerTile: 2_000,
  },
  /**
   * 空港の規模による建設費・維持費の割増（調整・安全対策・管理の複雑さを表すゲーム上の係数）:
   * 係数 = 1 + perValue × 資産額（cr）、上限 max
   */
  scale: { perValue: 0.5 / 100_000_000, max: 1.6 },

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
  /** 交通事業者から受け取る使用料（旅客1人あたり）と、駐車場・ホテルの収入 */
  accessFees: { taxi: 100, bus: 60, rail: 80, hotelPerRoomNight: 60 },
  retail: { shopPerPax: 15, restaurantPerPax: 22, shopVisitProb: 0.5, shopSec: 8 * 60, restaurantSec: 20 * 60, minSlackSec: 40 * 60 },
  /** 駐車料金（1台・1回の駐車あたり）と平均の駐車日数 */
  carPark: { feePerCar: 400, stayDays: 2 },

  // ------------------------------------------------------------ 費用（1日あたり）
  daily: {
    /** 運転士を含む（ランプバスは運転士の給与 + 車両の維持費） */
    salary: { staff: 1_200, engineer: 2_000, apronBus: 1_500 } as Partial<Record<UnitKind, number>>,
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
    /** 交通施設の運営費（1か所あたり） */
    access: { taxiStand: 300, busStop: 800, railStation: 6_000, hotel: 2_000 },
    /** 職員用駐車場が足りない分の通勤対策費（1台分あたり） */
    staffCommutePerMissing: 600,
  },
  /** 地上支援の作業ごとの運営費 */
  taskCost: { unload: 300, load: 300, fuel: 600, clean: 400, cater: 300, inspect: 600, pushback: 200, defect: 3_000, busTrip: 150 } as Record<string, number>,
  /** 補償・対応費 */
  compensation: { missedPax: 400, leftBag: 300, delayedFlight60: 5_000, missedConnection: 600 },

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
  /** フェーズ 4 のゲーム値（夜間滞泊・拠点・整備・兼用ゲート） */
  phase4: {
    /** 整備の周期（運航回数） */
    checkCycles: 12,
    /** 兼用ゲートの切替に必要な間隔（秒） */
    swingChangeSec: 600,
  },
  /** 路線需要モデル（フェーズ 3 §3。market 有効時のみ使う） */
  market: {
    /** D_r = K × (P_o/1e6)^alpha × (P_d/1e6)^beta × I × g(d) × φ × A × F × R */
    K: 600,
    alpha: 0.6,
    beta: 0.4,
    /** 契約の搭乗率のクランプ */
    lfMin: 0.1,
    lfMax: 0.98,
    /** 便ごとの揺らぎ（旧 loadFactor の noise と同じ） */
    noise: 0.08,
    /** 国際路線の需要係数 */
    internationalFactor: 0.6,
    /**
     * 季節・曜日係数（5-06）。各表は平均が 1 になるよう正規化してあり、年間需要はほぼ変わらない。
     * 曜日は day % 7（0 = 月曜）。月は day % 365 を非うるう年の月日に割り当てる。
     */
    weekdayBusiness: [1.08, 0.98, 0.97, 1.02, 1.12, 0.88, 0.95],
    weekdayLeisure: [0.92, 0.9, 0.92, 0.98, 1.08, 1.12, 1.08],
    monthBusiness: [1.0, 1.05, 1.05, 1.02, 0.98, 1.05, 1.0, 0.88, 1.02, 1.03, 1.0, 0.92],
    monthLeisure: [1.02, 0.85, 1.02, 0.95, 1.12, 0.85, 1.03, 1.2, 0.98, 1.0, 0.92, 1.06],
  },
  offers: { baseProb: 0.12, ratingProb: 0.3, maxOpen: 6, expireDays: 3, contractDays: 30 },
  contracts: { renewGoodSat: 70, renewOkSat: 45, withdrawSat: 25, withdrawDays: 3, increaseMinSat: 60, decreasePenaltySat: 10 },
  bankruptcyDays: 30,

  // ------------------------------------------------------------ 空港アクセス（docs/15_access_rules.md）
  accessModel: {
    /** 市街地から敷地の出入口までの所要時間（分） */
    externalMin: { car: 35, dropoff: 35, taxi: 35, bus: 50, rail: 30, walk: 120 },
    /** 旅客が払う運賃・料金（cr、空港の使用料を除く。駐車料金は1台分） */
    baseFare: { car: 0, dropoff: 0, taxi: 2_500, bus: 900, rail: 700, walk: 0 },
    /** 手段ごとの好み（定数項）と、時間の重み（1分あたり）、時間価値（cr/分） */
    asc: { car: 0, dropoff: 0.2, taxi: 0, bus: -0.3, rail: 0, walk: -1 },
    beta: 0.05,
    valueOfTime: 60,
    /** 1台に乗る旅客数（自家用車・タクシー） */
    paxPerCar: 1.6,
    /** アクセス係数 = min(max, floor + span × (1 − exp(−A / a0))) */
    factor: { floor: 0.3, span: 0.85, a0: 0.2, max: 1.1 },
    /** 処理能力: 出入口1か所あたりの道路（台/時）、ターミナルに接する一般道路1タイルあたりの車寄せ（台/時） */
    roadPerEntrance: 900,
    curbPerTile: 40,
    /** タクシー乗車枠1つあたり（人/時）、バス1台・列車1本の定員（空港利用分） */
    taxiPaxPerBerth: 30,
    busSeats: 50,
    busesPerBay: 6,
    trainSeats: 200,
    /** 混雑による遅れ（BPR 型）: 遅れ = 基本時間 × 0.15 × (交通量/容量)^4、上限（分） */
    congestionMaxMin: 90,
    /** 駐車場が満車のときに探し回る時間（分） */
    parkingSearchMin: 10,
    /** ホテル: 歩いて来る宿泊客の割合の上限に効く客室数 */
    hotelRoomsForFull: 400,
    /** 職員1人あたりの必要な職員用駐車台数 */
    staffParkingPerStaff: 0.5,
  },
} as const;

/** 定時運航の判定（予定から15分以内） */
export const ON_TIME_SEC = 15 * 60;
