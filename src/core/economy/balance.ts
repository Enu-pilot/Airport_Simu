import type { FacilityKind, SizeClass, TaxiwayWidthClass, TerminalAreaKind } from '../model/types';
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
    // 2026-CF: F は区分ごとの +2,000 の等差をそのまま延長（PO 調整可）
    taxiwayPerTile: { S: 4_000, M: 6_000, L: 8_000, F: 10_000 } as Record<TaxiwayWidthClass, number>,
    roadPerTile: 1_500,
    tunnelMultiplier: 10,
    elevatedMultiplier: 2,
    fuelPipePerTile: 1_500,
    terminalWalkwayPerTile: 4_500,
    movingWalkwayPerTile: 12_000,
    stand: { S: 60_000, M: 100_000, L: 180_000 } as Record<SizeClass, number>,
    /** 面積型の施設（タイルあたり、ターミナルは階ごと） */
    perTile: { apron: 1_500, terminal: 20_000, serviceArea: 500, parking: 800, park: 400 } as Partial<Record<FacilityKind, number>>,
    /** 地下ターミナルの掘削割高（機能G / G-U2）: 基底階が地下 1 階につきターミナル建設費にこの倍率を重ねる（B1 = ×1.5、B2 = ×2.25）。地上ターミナルは ×1 で不変 */
    undergroundTerminalPerFloor: 1.5,
    facility: {
      gate: 50_000,
      hangar: 1_200_000,
      tower: 800_000,
      maintenance: 500_000,
      fuelFarm: 600_000,
      fireStation: 500_000,
      gseBase: 400_000,
      baggageSort: 700_000,
      cargoTerminal: 1_500_000,
      shoppingMall: 3_000_000,
      culturalHall: 1_500_000,
    } as Partial<Record<FacilityKind, number>>,
    jetBridge: 150_000,
    /**
     * AGT（機能I）: 駅は固定費（内部設備でも単独でも同額）。セグメントは距離単価 × distanceM で、
     * 基本単価は動く歩道の m 換算（movingWalkwayPerTile / TILE_M = 480）と同水準。
     * 高架（level > 0）は elevatedMultiplier、地下（level < 0）は掘削係数
     * undergroundTerminalPerFloor を深さぶん重ねる（construction.ts の layoutItems）。
     */
    agt: { station: 3_000_000, segmentPerMeter: 480 },
    /** 車両の購入費（GSE基地のプロパティの台数分） */
    vehicle: { tug: 150_000, beltLoader: 80_000, baggageTractor: 60_000, fuelTruck: 200_000, cateringTruck: 120_000, cleaningVan: 50_000, apronBus: 250_000 } as Partial<Record<UnitKind, number>>,
    /** ターミナル内のエリア（設備1つあたり、またはタイルあたり） */
    areaUnit: { checkIn: 20_000, security: 120_000, baggageClaim: 150_000, restroom: 30_000, shop: 80_000, restaurant: 120_000, lounge: 100_000, escalator: 200_000, elevator: 150_000 } as Partial<Record<TerminalAreaKind, number>>,
    areaPerTile: 2_000,
    /** 撤去・縮小したときに戻る割合 */
    refundRate: 0.25,
    /** 空港アクセス・周辺施設（Phase 6） */
    access: { taxiStand: 60_000, busStop: 90_000, busTerminal: 600_000, railStation: 2_500_000, hotel: 1_800_000, staffParkingPerTile: 600, railPerTile: 25_000 },
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
    /** 夜間（22時〜6時）の着陸料の割増（機能E。3b 設計 E.2 の原案: 夜間着陸料 ×1.3） */
    nightSurcharge: 0.3,
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
  /**
   * ラウンジ（5-19 2A）: 購買ではなく「搭乗までの滞在の質」の係数。
   * visitProb / minSlackMin は詳細モードの立寄り意図の既定値（運航側 planShop の
   * shopVisitProb / minSlackSec と同じ位置づけのゲームバランス定数）。
   * satisfactionPerUserHour / satisfactionCapPoints は、詳細モードの結果にだけ現れる
   * 体験指標（ラウンジ利用者・時間あたりの満足度換算ポイントと上限）の換算係数で、
   * AirportDay の満足度式には接続していない（接続はゲームバランス変更として別途 PO 判断が要る）。
   * 実測根拠のない新規定数のため、計画書（terminal_simulation_modes_plan.md）に根拠と未接続の旨を明記する。
   */
  lounge: { visitProb: 0.25, minSlackMin: 60, satisfactionPerUserHour: 2, satisfactionCapPoints: 5 },
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
    access: { taxiStand: 300, busStop: 800, busTerminal: 2_400, railStation: 6_000, hotel: 2_000 },
    /** 職員用駐車場が足りない分の通勤対策費（1台分あたり） */
    staffCommutePerMissing: 600,
    /**
     * AGT（機能I）の運営費: 系統ごとの日額 = 編成数 × trainsetPerDay + 駅数 × stationPerDay。
     * 編成数は集約式 ceil(総延長 × 2 / (speedMps × headwaySec))（model/agt）。
     * 資産額連動の維持費（maintenanceRate）とは別枠で、費用区分 'agtOps' に計上する
     */
    agt: { trainsetPerDay: 180_000, stationPerDay: 20_000 },
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
  /** 乗継需要モデル（docs/44 §4.2）。魅力の要素は路線需要モデル（market）と共通の重力型を使う */
  hub: {
    /** 接続品質が 1 になる乗継時間 = MCT + この余裕（分） */
    idealBufferMin: 45,
    /** MCT ぎりぎりの接続の品質（0〜1。乗り損ね不安で需要が落ちる） */
    tightQuality: 0.7,
    /** 理想を超えた待ち時間に対する需要減衰の時定数（分。指数減衰） */
    decayTauMin: 150,
    /** 終着需要の魅力（ネットワーク魅力と同じ尺度）。乗継割合 = 上限 × A_net / (A_net + localAppeal) */
    localAppeal: 1.0,
    /**
     * 直行便競合の重み（F6-17 HubChoiceShare、ゲーム値・校正は暫定）。
     * 乗継経路の魅力と、両都市を直行で結ぶ仮想経路の魅力（同じ重力型・直行距離で計算）を
     * 比べ、乗継が選ばれる割合 = A_via / (A_via + この重み × A_nonstop) を需要に掛ける。
     */
    nonstopPreference: 1.0,
  },
  /** 路線需要モデル（フェーズ 3 §3。market 有効時のみ使う） */
  market: {
    /**
     * D_r = K × (P_o/1e6)^alpha × (P_d/1e6)^beta × I × g(d) × φ × A × F × R
     * K は docs/46 §3.3 の暫定校正値（羽田―新千歳/福岡の2025年度実績で逆算した平均）。
     * 全国共通の確定値ではない（仙台・中部発では過大推計が残る。docs/46 §3.4）。
     * 校正の確定は PO 判断待ち。
     */
    K: 711,
    alpha: 0.6,
    beta: 0.6,
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
    /**
     * 季節プロファイル（docs/46 §4.2、観光需要の月別指数 1〜12 月）。
     * プロファイルを持つ目的地では monthBusiness/monthLeisure の代わりに、
     * 必須需要は essentialMonth、観光需要はこの表で月別係数を作る。
     * 各行は合計 12.0（平均 1.0）になるよう文書側で正規化済み。使う側でも平均で割って守る。
     */
    seasonalityProfiles: {
      URBAN: [0.89, 0.95, 1.07, 0.88, 0.97, 0.90, 0.96, 1.01, 1.02, 1.09, 1.15, 1.11],
      RAIL: [0.89, 0.90, 1.00, 0.97, 1.05, 1.01, 1.03, 1.04, 1.04, 1.07, 1.00, 1.00],
      REGIONAL: [0.94, 0.93, 1.07, 0.94, 1.10, 0.91, 1.02, 1.12, 1.00, 1.08, 0.98, 0.91],
      HOKKAIDO: [0.86, 0.97, 0.95, 0.76, 0.93, 1.02, 1.05, 1.13, 1.14, 1.15, 1.02, 1.02],
      SNOW: [1.25, 1.18, 1.05, 0.82, 0.78, 0.72, 0.77, 0.87, 0.91, 0.95, 1.12, 1.58],
      OKINAWA: [0.83, 0.94, 1.08, 0.90, 0.86, 0.87, 1.11, 1.19, 1.04, 1.13, 1.05, 1.00],
      ISLAND: [0.90, 0.92, 1.06, 0.96, 1.05, 0.95, 1.10, 1.20, 1.03, 1.08, 0.92, 0.83],
      SUMMER: [0.80, 0.87, 0.94, 0.92, 1.01, 0.70, 1.28, 1.40, 1.08, 1.01, 1.06, 0.93],
    } as Record<string, number[]>,
    /** 必須需要の月別プロファイル（docs/46 §4.2。年間を通じて安定し、12 月だけ落ちる） */
    essentialMonth: [1.02, 1.01, 1.04, 1.03, 1.00, 1.02, 1.00, 0.94, 1.00, 1.03, 1.02, 0.89],
  },
  /**
   * 貨物需要モデル（5-12 CARGO-01。ゲーム値であり実績統計ではない）。
   * 路線貨物需要 (m3/日・両方向) = K × (P_o/1e6)^alpha × (P_d/1e6)^beta × cargoIndex × g_cargo(d)
   * 旅客需要とは独立に計算し、既存の乱数列は消費しない。opt-in（貨物契約がある会社だけが使う）。
   */
  cargo: {
    K: 140,
    alpha: 0.6,
    beta: 0.4,
    /** 国際路線の貨物需要係数 */
    internationalFactor: 0.8,
    /** 貨物契約の提案を出す路線需要の下限 (m3/日) */
    minRouteDemandM3: 20,
    /** 貨物収入 (cr/m3、運搬量に対して。ゲーム値) */
    revenuePerM3: 900,
    /** 荷役費 (cr/m3、上屋で処理した量に対して。ゲーム値) */
    handlingCostPerM3: 120,
    /** 貨物トラック 1 台の積載量 (m3。搬出入台数の集約換算にだけ使うゲーム値) */
    truckCapacityM3: 40,
    /**
     * 貨物トラック搬出入の時間帯プロファイル（CARGO-08 格 6、相対重み 24 件・ゲーム値）。
     * 早朝の到着便バンク後と夕方の出発便バンク前に寄せ、深夜はほぼ止める。
     * 1 日の合計台数は変えず、配分だけを変える（コード側で正規化する）。
     */
    truckHourlyProfile: [
      0.2, 0.2, 0.2, 0.2, 0.4, 1.2, 1.7, 1.8, 1.5, 1.1,
      0.9, 0.9, 1.0, 1.1, 1.2, 1.1, 1.0, 1.3, 1.5, 1.4,
      1.1, 0.7, 0.5, 0.3,
    ],
    /**
     * 積替貨物の接続率（CARGO-08 格 7、ゲーム値）。到着貨物のうち、翌日便へ
     * 接続可能な量（路線ペアの流量上限）に対してこの割合が積替として成立する。
     */
    transshipmentShare: 0.35,
  },
  // ------------------------------------------------------------ 住民・騒音（機能E）
  /**
   * 防音工事助成（段階制）。費用を払ってレベルを上げると、実施時に住民満足度が即時回復し、
   * 以後の日次騒音影響のうち騒音ポイントの効きが noiseFactor 倍に緩和される。
   * 夜間運航 1 件あたりの効き（applyCityNoiseImpact の −0.15）は緩和対象にしない
   * （夜間割増とのトレードオフを残すため）。配列はレベル 1〜3 の順（index = レベル − 1）。
   * noiseFactor はレベル 0〜3 の順（index = レベル）。
   * 拡張1（海上移転係数）・拡張2（住民向け施設・騒音対策費の拠出）もこの節に集約する。
   */
  noise: {
    soundproof: {
      maxLevel: 3,
      cost: [2_000_000, 5_000_000, 12_000_000],
      recovery: [4, 6, 8],
      noiseFactor: [1, 0.85, 0.7, 0.5],
    },
    /**
     * 海上移転係数（機能E拡張1、PO 決定の強め案）: 空港の格（goals.tier）が上がるタイミングで
     * 空港が沖合へ移転・拡張した想定とし、騒音ポイントの効きをこの係数倍に軽減する。
     * 防音工事の noiseFactor と乗算で併用する。夜間運航 1 件あたりの効き（−0.15）は対象外。
     * 配列は格 0〜7 の順（index = 格）。格 0〜3 は移転前で ×1.0。
     */
    offshore: {
      factorByTier: [1, 1, 1, 1, 0.75, 0.5, 0.3, 0.15],
    },
    /**
     * 住民向け施設（機能E拡張2）: 建設して置くだけで、運航シミュレーションには影響せず
     * 住民満足度に日次のプラスを与える施設。運用中 1 棟ごとのプラス（/日）と、
     * 施設由来のプラス合計の上限（/日）。プラスは日次変化の回復側に加算され、
     * 既存の日次クランプ（−1〜+0.05）の内側で効く。
     */
    residentFacilities: {
      dailyBonus: { shoppingMall: 0.03, culturalHall: 0.02, park: 0.01 } as Partial<Record<FacilityKind, number>>,
      dailyCap: 0.1,
    },
    /**
     * 騒音対策費の拠出（機能E拡張2）: 費用を払うと住民満足度が即時回復する。1 日 1 回まで
     * （最終拠出日は CityConfig.lastNoiseContributionDay に持つ）。
     */
    contribution: {
      cost: 1_000_000,
      recovery: 1,
    },
  },
  offers: {
    baseProb: 0.12,
    ratingProb: 0.3,
    maxOpen: 6,
    expireDays: 3,
    contractDays: 30,
    /**
     * 提案確率への保有規模の反映（2026-11-21 ユーザー要望）: 保有型式数 − 1 にこの定数を掛けた分だけ
     * 提案確率を割り増す（倍率 = 1 + fleetWeightPerType × (型式数 − 1)）。最小規模（1 型式）は倍率 1 で
     * 従来どおり、最大規模（ANA 14 型式）でも 1.52 倍に留まる穏やかな効き方にするための値。
     * 強くしたい／弱くしたいときはこの定数だけを動かす（0 で無効化）。
     */
    fleetWeightPerType: 0.04,
  },
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
