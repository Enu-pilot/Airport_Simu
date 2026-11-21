import type { Disruption, DisruptionKind, WeatherKind, AircraftState, BagState, BlockReason, BusTripPhase, DelayCause, FlightPax, FlightStatus, HoldReason, MissReason, PaxState, RunwayMode, SimEvent, TaskKind, TaskState, UnitKind, UnitStatus } from '../core/sim/types';
import type { BuildState, EntityType, FacilityKind, PaxZone, RoadClass, RoadConnectorKind, SizeClass, TerminalAreaKind } from '../core/model/types';
import { entityTypeOf, type AirportLayout } from '../core/model/types';
import type { Issue, IssueCode, OperabilityReason, Severity } from '../core/validation/validate';
import type { OpFailure } from '../core/layout/operations';
import type { AirsideNodeKind } from '../core/airside/network';
import type { AirlineType } from '../core/economy/registry';
import type { Contract, ContractActionResult, CostCategory, DailyKpi, Project, RevenueCategory, TimeWindow } from '../core/economy/company';
import type { AccessMode, AccessUnavailable } from '../core/access/model';
import type { DataStatus } from '../core/aircraft/catalog';
import type { Bottleneck, GroupKey } from '../core/analytics/kpi';
import type { ScenarioKpis } from '../core/scenario/scenario';
import type { CompatReason, CompatStatus } from '../core/aircraft/compat';
import type { FleetResult } from '../core/economy/company';
import type { ResponseResult } from '../core/sim/disruptions';
import type { MissBottleneck } from '../core/sim/missBreakdown';
import type { PlanIssueCode } from '../core/economy/planning';
import type { AirlineScore, ScoreComponent, ScoreKey, ScoreLevel } from '../core/economy/airlineScore';
import type { ReviewMetric } from '../core/analytics/review';
import { AIRCRAFT_TYPES, resolveType } from '../core/sim/aircraftTypes';
import { floorDisplayLabel } from '../core/model/levels';
import { HEAT_BAND_HIGH_MIN, HEAT_BAND_MID_MIN } from '../core/access/heatmap';
import { BALANCE } from '../core/economy/balance';
import { CITY_NIGHT_CURFEW, NIGHT_OPS_DEFAULTS, NIGHT_OPS_RANGES } from '../core/economy/city';
import { DIFFICULTY, type DifficultyDef } from '../core/economy/game';
import type { SeasonalityProfile } from '../core/data/types';

export const FACILITY_LABEL: Record<FacilityKind, string> = {
  apron: 'エプロン',
  terminal: 'ターミナル',
  gate: '搭乗ゲート',
  boardingBridge: '搭乗橋（PBB）',
  agtStation: 'AGT 駅',
  hangar: '格納庫',
  tower: '管制塔',
  maintenance: '整備施設',
  fuelFarm: '燃料施設',
  fireStation: '消防施設',
  gseBase: 'GSE基地',
  baggageSort: '手荷物仕分け場',
  serviceArea: 'サービスエリア',
  parking: '駐車場',
  taxiStand: 'タクシー乗り場',
  busStop: 'バス乗り場',
  busTerminal: 'バスターミナル',
  cargoTerminal: '貨物上屋',
  railStation: '空港連絡駅',
  staffParking: '職員用駐車場',
  hotel: '空港ホテル',
  shoppingMall: 'ショッピングモール',
  culturalHall: '文化ホール',
  park: '公園',
};

export const ENTITY_LABEL: Record<EntityType, string> = {
  runway: '滑走路',
  taxiNode: '誘導路ノード',
  taxiway: '誘導路',
  roadNode: '道路ノード',
  road: '道路',
  stand: '駐機スポット',
  facility: '施設',
  terminalArea: 'ターミナル内エリア',
};

export const NODE_KIND_LABEL: Record<AirsideNodeKind, string> = {
  taxiway: '中間点',
  intersection: '交差点',
  endpoint: '端点',
  runwayEntry: '滑走路入口',
  runwayThreshold: '滑走路端',
  runwayIntersection: '滑走路の交差点',
  stand: 'スポット',
};

export const BUILD_STATE_LABEL: Record<BuildState, string> = {
  planned: '計画',
  underConstruction: '建設中',
  operational: '運用中',
};

export const SIZE_LABEL: Record<SizeClass, string> = { S: 'S（小型）', M: 'M（中型）', L: 'L（大型）' };
export const ROAD_CLASS_LABEL: Record<RoadClass, string> = { public: '一般道路', service: 'サービス道路（業務用）', rail: '鉄道（空港連絡線）', walkway: '旅客連絡通路', fuel: '燃料ハイドラント配管' };

export const PROP_LABEL: Record<string, string> = {
  checkInCounters: 'チェックインカウンター数',
  securityLanes: '保安検査レーン数',
  standId: '紐付けスポット',
  gateId: '紐付けゲート',
  bridgeType: '型式（トンネル本数）',
  deck: '接続デッキ',
  jetBridge: 'ボーディングブリッジ',
  boardingMode: '搭乗方式',
  connectedTo: '接続先ターミナル',
  routeType: '国内/国際の別',
  platforms: 'ホーム数',
  systemId: '所属する AGT 系統',
  lanes: '車線数',
  tracks: '線路数',
  apronBuses: 'ランプバス',
  maxSize: '収容可能な最大機体',
  level: '階層（地上0・地下負数・高架正数）',
  bays: '整備ベイ数',
  capacityKL: '貯蔵量（kL）',
  category: '消防カテゴリー',
  crews: 'GSEクルー数',
  staff: '作業員数',
  tugs: 'トーイングカー',
  beltLoaders: 'ベルトローダー',
  baggageTractors: '手荷物牽引車',
  fuelTrucks: '給油車',
  cateringTrucks: 'ケータリング車',
  cleaningVans: '清掃車',
  engineers: '整備士',
  capacityPerMin: '処理能力（個/分）',
  spaces: '駐車台数',
  berths: '乗車枠',
  busBays: '乗り場数',
  busesPerHour: 'バス便数（毎時）',
  trainsPerHour: '列車本数（毎時）',
  railService: '列車種別',
  rooms: '客室数',
};

/**
 * 施設種別ごとに意味が異なるプロパティキーのラベル上書き。
 * 例: 'level' は鉄道駅では地図階層だが、管制塔では管制塔レベル（1〜3）を指す。
 * 共通の PROP_LABEL のままだと管制塔にも駅用の「階層」説明が出てしまう（表示バグ）。
 */
export const PROP_LABEL_BY_KIND: Partial<Record<string, Record<string, string>>> = {
  tower: { level: '管制塔レベル（1〜3）' },
};

export function propLabel(kind: string, key: string): string {
  return PROP_LABEL_BY_KIND[kind]?.[key] ?? PROP_LABEL[key] ?? key;
}

/** ゲートの搭乗方式（docs/29） */
export const BOARDING_MODE_LABEL = {
  contact: '通常（コンタクト）',
  bus: 'バス（リモートスポット）',
  connectAuto: '自動（隣接）',
} as const;

export const RAIL_SERVICE_LABEL = { local: '各停', rapid: '快速', express: '特急' } as const;

/** 搭乗橋（PBB、機能H）の型式。トンネル本数を併記する（ユーザー指定の 1本/2本 設定） */
export const PBB_TYPE_LABEL: Record<string, string> = {
  tunnel1: 'tunnel1（1本）',
  tunnel2: 'tunnel2（2本）',
  tunnel2Upper: 'tunnel2Upper（2本・上デッキ対応）',
};

/** 搭乗橋の接続デッキ */
export const PBB_DECK_LABEL: Record<string, string> = {
  main: '主デッキ',
  upper: '上デッキ',
};

/** ゲートの国内/国際の別（フェーズ 4） */
export const GATE_ROUTE_TYPE_LABEL = { domestic: '国内', international: '国際', swing: '兼用（国内・国際）' } as const;

export const SEVERITY_LABEL: Record<Severity, string> = { error: 'エラー', warning: '警告', info: '情報' };

export const OPERABILITY_LABEL: Record<OperabilityReason, string> = {
  NOT_COMPLETED: '未完成（計画または建設中）',
  HAS_ERRORS: '配置・接続エラーがある',
  NO_OPERATIONAL_ROUTE: '運用中の誘導路で滑走路とつながっていない',
  ISOLATED: '滑走路につながっていない',
};

export const OP_FAILURE_LABEL: Record<OpFailure, string> = {
  NOT_FOUND: '対象が見つかりません',
  NOT_SUPPORTED: 'この対象にはその操作はできません',
  TOO_LONG_FOR_GRID: '長すぎてグリッド（従来形）に合わせられません（従来形の最大の長さを超えています）',
  INVALID_VALUE: '値が不正です',
  NODE_EXISTS: '移動先に別のノードがあります',
  EMPTY_PATH: '2点以上を指定してください',
  NO_CHANGE: '変更はありません',
  LAND_NOT_ADJACENT: '取得済みの敷地に隣接する土地だけ購入できます',
  LEVEL_MISMATCH: '異なる階層のノードを選択してください',
  INVALID_CONNECTOR: '移動種別に合った接続設備を選び、勾配・端点距離を確認してください',
};

/** 階層接続設備の種別名（W-8）。保存データの name（内部名）は変えず、表示だけ和名にする */
export const CONNECTOR_KIND_LABEL: Record<RoadConnectorKind, string> = {
  stairs: '階段',
  escalator: 'エスカレーター',
  elevator: 'エレベーター',
  ramp: 'スロープ',
  railRamp: '鉄道の勾配区間',
  pipeRiser: '燃料管の立ち上がり',
};

/** 配置・階数変更ができない理由（エディタ側で導く。コアの失敗コードは変えない。1-04） */
export const PLACEMENT_PROBLEM_LABEL = {
  floorOutOfRange: '選んだ階はこの建物にありません（建物の階数の範囲外です）',
  outsideParent: '建物の範囲の外には置けません',
  levelsInUse: '上の階にエリアや設備があるため、階数を減らせません',
  floorRangeInUse: '範囲外になる階にエリアがあるため、エリアの置ける階の範囲を変えられません',
  spanInUse: '範囲外になる階にエリアや設備があるため、建物の階の範囲を変えられません',
} as const;

/** 空港全体の離発着能力カード（1-19） */
export const OVERALL_CAPACITY_TITLE = '空港全体の離発着能力';
export const OVERALL_LIMIT_LABEL = { runway: '滑走路', stand: 'スポットの回転数', turnaround: '折り返し能力' } as const;
export const OVERALL_CAPACITY_NOTE = '滑走路・スポットの回転数・折り返し能力のうち最も小さい値。誘導路は未算出のため含めません。';

/** 運航中のリモートスポットの注記（1-11 / K-1） */
export const STAND_GATE_FIX_NOTE = '旅客を生成した後は搭乗ゲートを固定します（閉鎖中は再開を待ちます）';

/** 選択欄・子の一覧（1-03） */
export const PICK_CANDIDATES_LABEL = '重なっている対象:';
export const INTERIOR_CHILDREN_LABEL = '建物内の設備';
/** 親の階数を超える階の選択肢の注記（1-04） */
export const FLOOR_NOT_IN_PARENT_LABEL = '（この建物にはありません）';

/**
 * 建物内階の表記（階セレクタ・Toolbox／運航コントロールと地図上の階ラベルで共通に使う）。
 * 階の数値は建物内階（0 = 1F、-1 = B1、1 = 2F）。
 */
export const floorShortLabel = (level: number): string => (level < 0 ? `B${-level}` : `${level + 1}F`);
/** 建物内階の日本語表記（-1 → 地下1階、0 → 1階）。ボタンの title などに使う */
export const floorNameLabel = (level: number): string => (level < 0 ? `地下${-level}階` : `${level + 1}階`);
/** 階セレクタの選択肢（B3〜4F。ターミナル内エリアの最下階 TERMINAL_AREA_MIN_LEVEL に合わせる） */
export const FLOOR_SELECTOR_LEVELS: readonly number[] = [-3, -2, -1, 0, 1, 2, 3];

/** エンティティの表示名（名前が無ければ種別名 + 番号） */
export function displayName(layout: AirportLayout, id: string): string {
  const type = entityTypeOf(id);
  const num = id.slice(id.indexOf('_') + 1);
  // 複合連絡施設（J-2）は EntityType を持たないため、ここで先に解決する
  const cf = layout.connectionFacilities?.[id];
  if (cf) return cf.name ? `複合連絡施設 ${cf.name}` : `複合連絡施設 #${num}`;
  switch (type) {
    case 'runway': {
      const r = layout.runways[id];
      return r?.name || `滑走路 #${num}`;
    }
    case 'taxiway':
      return layout.taxiways[id]?.name ? `誘導路 ${layout.taxiways[id]!.name}` : `誘導路 #${num}`;
    case 'road': {
      const r = layout.roads[id];
      if (r?.connectorKind && (!r.name || r.name === r.connectorKind)) return `${CONNECTOR_KIND_LABEL[r.connectorKind]} #${num}`;
      return r?.name || `道路 #${num}`;
    }
    case 'taxiNode':
      return layout.taxiNodes[id]?.name ? `ノード ${layout.taxiNodes[id]!.name}` : `ノード #${num}`;
    case 'roadNode':
      return layout.roadNodes[id]?.name ? `道路ノード ${layout.roadNodes[id]!.name}` : `道路ノード #${num}`;
    case 'stand':
      return layout.stands[id]?.name ? `スポット ${layout.stands[id]!.name}` : `スポット #${num}`;
    case 'facility': {
      const f = layout.facilities[id];
      if (!f) return id;
      return f.name ? `${FACILITY_LABEL[f.kind]} ${f.name}` : `${FACILITY_LABEL[f.kind]} #${num}`;
    }
    case 'terminalArea': {
      const a = layout.terminalAreas[id];
      if (!a) return id;
      return `${a.level + 1}F ${a.name || AREA_KIND_LABEL[a.kind]}`;
    }
    default:
      return id;
  }
}

/** ポータル接続状態（5-16）の表示名 */
export const CAPABILITY_STATE_LABEL: Record<string, string> = {
  notInstalled: '未設置',
  uncomputed: '未算出',
  zeroCapacity: '能力 0',
  disconnected: '未接続',
  underConstruction: '建設中',
  closed: '閉鎖中',
  failed: '故障・停止',
  resourceShortage: '人員・車両不足',
  supplyShortage: '供給不足',
  operational: '稼働中',
};

/** 要対応リスト（UI 改善 案1）の文言。項目の生成・帯付けの正本は core/attention の buildAttentionItems */
export const ATTENTION_UI = {
  title: '運航の要対応（直近日報）',
  band: { high: '高', mid: '中', low: '低' } as Record<'high' | 'mid' | 'low', string>,
  noReport: '日報はまだありません（運航して日を締めると、直近の運航実績から要対応が表示されます）',
  none: '要対応はありません',
};

/** 施設種別の sim 効果バッジ（UI 改善 案3。分類の正本は core/model/catalog の FACILITY_SIM_EFFECT） */
export const SIM_EFFECT_LABEL: Record<'none' | 'displayOnly', string> = {
  none: '現在は効果なし',
  displayOnly: '表示のみ（消費なし）',
};

/** 混雑マップ（ヒート）の凡例。帯の定義は core/access/heatmap の heatBand と一致させる */
/** 凡例の閾値は core の帯判定（heatBand の HEAT_BAND_*）が正本。文言はそこから組み立てる */
export const HEAT_LEGEND = {
  title: '混雑の凡例（使用率）',
  low: `${Math.round(HEAT_BAND_MID_MIN * 100)}%未満`,
  mid: `${Math.round(HEAT_BAND_MID_MIN * 100)}%以上 ${Math.round(HEAT_BAND_HIGH_MIN * 100)}%未満`,
  high: `${Math.round(HEAT_BAND_HIGH_MIN * 100)}%以上`,
} as const;

/** ワークスペース骨格（UIデザイン更新 第1段階）: 左レールと下部タイムラインの文言 */
export const SHELL_UI = {
  railAttention: '要対応',
  railAttentionTitle: (n: number) => `要対応 ${n} 件（建設レンズの左パネル「要対応」タブを開きます）`,
  railBuild: '建設',
  railManage: '経営',
  railOperate: '運行',
  railAtc: '管制官',
  railLayers: 'レイヤー',
  railLayersTitle: 'マップの表示切り替え（レイヤー）',
  buildPanelTools: 'ツール',
  buildPanelFacilities: '施設一覧',
  buildPanelInbox: '要対応',
  timelineTitle: '24時間タイムライン',
  timelinePlanNote: '今日の計画（発着回数/時）',
  timelineNow: (hh: number, mm: number) => `現在 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
  timelineFlights: (n: number) => `${n} 回`,
  drawerLabel: '振り返りと履歴',
  drawerReviewTab: '振り返り',
  drawerHistoryTab: '履歴',
  drawerFinanceTab: '経理',
  drawerGroundTab: '地上・サービス',
  drawerOpsTab: '運行',
  drawerAirlinesTab: '航空会社',
  drawerLiveNote: '締め直後の振り返りは、「次の日へ」か「建設モードに戻る」を選ぶまで閉じられません',
} as const;

const portalStatusJa = (s: unknown): string =>
  s === 'operational' ? '接続済み' : s === 'underConstruction' ? '完成待ち' : '未接続';

const ISSUE_TEXT: Record<IssueCode, (n: string[], p: Issue['params']) => string> = {
  OUT_OF_BOUNDS: (n) => `${n[0]} が敷地の外にはみ出しています`,
  UNBUILDABLE_TERRAIN: (n, p) => `${n[0]} が建設できない土地（水域・岩場・未取得地）にかかっています（${p.tiles}タイル）`,
  OVERLAP: (n) => `${n[0]} と ${n[1]} が重なっています`,
  IN_RUNWAY_STRIP: (n) => `${n[0]} が ${n[1]} の保護区域（着陸帯）内にあります`,
  IN_RUNWAY_RESA: (n) => `${n[0]} が ${n[1]} の RESA（滑走路端安全区域）内にあります`,
  STAND_NOT_ON_APRON: (n) => `${n[0]} がエプロンの上にありません`,
  RUNWAY_TOO_SHORT: (n) => `${n[0]} が短すぎて、どの機体も使用できません（1,200m 以上必要）`,
  RUNWAY_NO_TAXIWAY: (n) => `${n[0]} に接続する誘導路がありません`,
  RUNWAY_PARALLEL_TOO_CLOSE: (n, p) =>
    `${n[0]} と ${n[1]} の平行滑走路の間隔が近すぎます（${p.distanceM}m。参考値 ${p.refM}m 以上。ゲームの判定）`,
  RUNWAY_PARALLEL_DEPENDENT: (n, p) =>
    `${n[0]} と ${n[1]} の平行滑走路の間隔（${p.distanceM}m）は、独立した計器運用の参考値（${p.refM}m）未満です（情報。ゲームの判定）`,
  RUNWAY_DESIGNATOR_CONFLICT: (n, p) => `滑走路番号 ${p.designator} が重複しています（${n.join(', ')}）。番号の接尾辞を設定してください`,
  HOLD_SHORT_TOO_CLOSE: (n, p) =>
    `${n[0]} の滑走路入口の停止位置に十分な距離がありません（誘導路に沿って中心線から ${p.achievedM}m までしか離れられません。停止位置 ${p.requiredM}m。ゲームの判定）。誘導路を長くするか、入る角度を大きくしてください`,
  TAXIWAY_ON_RUNWAY: (n) => `${n[0]} が ${n[1]} の上を走っています`,
  TAXIWAY_CROSSES_RUNWAY_NO_ENTRY: (n) => `${n[0]} が ${n[1]} を入口ノードなしで横切っています`,
  TAXIWAY_CROSSING_NO_JUNCTION: (n) => `${n[0]} と ${n[1]} が交差点なしで交差しています`,
  TAXIWAY_OVERLAP: (n) => `${n[0]} と ${n[1]} が同じ線上で重なっています`,
  TAXIWAY_ISOLATED: (n, p) => `滑走路につながっていない誘導路があります（${n[0]} ほか計${p.count}区間）`,
  TAXIWAY_DEAD_END: (n) => `${n[0]} は行き止まりです`,
  DUPLICATE_NODE: (n) => `同じ位置に複数のノードがあります（${n.join(', ')}）`,
  DUPLICATE_EDGE: (n) => `${n[0]} と ${n[1]} が同じノード間を結んでいます`,
  STAND_NOT_CONNECTED: (n) => `${n[0]} の入口が誘導路に接続されていません`,
  STAND_NO_RUNWAY_ROUTE: (n) => `${n[0]} から滑走路へ到達できません`,
  STAND_ROUTE_SIZE_LIMITED: (n, p) => `${n[0]}（${p.size}級）から滑走路まで、${p.size}級機が通れる誘導路・滑走路がありません`,
  STAND_ONE_WAY_TRAP: (n, p) =>
    `${n[0]} は一方通行のため${p.direction === 'arrival' ? '到着機が入れません' : '出発機が滑走路へ出られません'}`,
  STAND_REMOTE: (n, p) => (p.bus ? `${n[0]} はリモートスポットです（バスゲートのランプバスで搭乗）` : `${n[0]} にはゲートがありません（リモートスポット）`),
  OVERNIGHT_STAND_REMOVED: (n, p) => `${n[0]} には夜間滞泊の機体が ${p.count} 機います。撤去・閉鎖したままだと、運航の再開時に置き直せず欠航になります`,
  STAND_MULTIPLE_GATES: (n) => `${n[0]} に複数のゲートが紐付いています`,
  GATE_NOT_AT_TERMINAL: (n) => `${n[0]} がターミナルに接していません`,
  GATE_TERMINAL_AMBIGUOUS: (n) => `${n[0]} が複数のターミナル（${n.slice(1).join('・')}）に接しています。「接続先ターミナル」を指定してください`,
  GATE_NO_STAND: (n) => `${n[0]} にスポットが紐付いていません`,
  GATE_STAND_TOO_FAR: (n, p) => `${n[0]} と ${n[1]} が離れすぎています（${p.distance}タイル）`,
  GATE_BUS_HAS_STAND: (n) => `${n[0]} はバスゲートなので、紐付けたスポットは使われません`,
  GATE_BUS_NO_VEHICLES: (n) => `${n[0]} はバスゲートですが、運用中の GSE 基地にランプバスがありません（旅客を運べません）`,
  BUS_GATE_NO_REMOTE_STAND: (n) => `${n[0]} はバスゲートですが、リモートスポット（ゲートのないスポット）がありません`,
  STAND_BUS_GATE_INVALID: (n, p) => {
    const why: Record<string, string> = {
      missing: 'ゲートが未設定または存在しません',
      notBusGate: '指定先がバスゲートではありません',
      building: 'ゲートが建設中です',
      closed: 'ゲートが閉鎖されています',
      unconnected: 'ゲートがターミナルに接続されていません',
      missingBoarding: '出発旅客の搭乗口がありません',
      missingDeplane: '到着旅客の降機口がありません',
      crossTerminal: '搭乗口・降機口が同じターミナルに接続されていません',
      missingDepartureRoute: '入口・チェックイン・保安検査から搭乗口までの経路がありません',
      missingArrivalRoute: '降機口から手荷物受取所・出口までの経路がありません',
    };
    const gate = n[1] ?? (p.gateId ? String(p.gateId) : 'バスゲート');
    return `${n[0]} の接続先 ${gate} は利用できません（${why[String(p.problem)] ?? '接続設定を確認してください'}）。運用中で、同一ターミナルの搭乗口と降機口があるバスゲートを指定してください`;
  },
  STAND_BUS_NO_GATE: (n) => `${n[0]} に利用可能なバスゲートがありません。運用中のバスゲートをターミナルに接続し、搭乗口・降機口の両方を用意してください`,
  STAND_TERMINAL_INVALID: (n) => `${n[0]} の所属ターミナルが見つからないか、ターミナルではありません`,
  STAND_TERMINAL_NO_BUS_GATE: (n) => `${n[0]} の所属ターミナル ${n[1]} に、搭乗口・降機口の両方へ接続した使えるバスゲートがありません`,
  STAND_TERMINAL_MISMATCH: (n) => `${n[0]} の接続バスゲート ${n[1]} は所属ターミナルと別のターミナルにあります`,
  STAND_TERMINAL_IGNORED: (n, p) => `${n[0]} の所属ターミナルは使われません（${p.reason === 'fixed' ? '固定スポット' : 'バス不使用'}）`,
  STAND_BUS_NO_VEHICLES: (n) => `${n[0]} は ${n[1]} を利用しますが、運用中の GSE 基地にランプバスがありません。基地にランプバスを配置してください`,
  GATE_CONNECTION_INVALID: (n) => `${n[0]} の接続先がターミナルではありません（存在しない・別の種類の施設）`,
  GATE_CONNECTOR_CROSSES_RUNWAY: (n) => `${n[0]} の連絡通路が滑走路 ${n[1]} の滑走路・着陸帯を横切っています（旅客が滑走路を歩くことになります）`,
  GATE_CONNECTOR_LONG: (n, p) => `${n[0]} と ${n[1]} をつなぐ通路が長すぎます（約 ${p.tiles} タイル。歩行に時間がかかります）`,
  NO_AIRSIDE_ACCESS: (n) => `${n[0]} がエプロン・誘導路・サービスエリア・サービス道路に接していません`,
  TERMINAL_NO_ROAD: (n) => `${n[0]} が一般道路に接していません`,
  TERMINAL_NO_GATE: (n) => `${n[0]} に搭乗ゲートがありません`,
  PARKING_NO_ROAD: (n) => `${n[0]} が道路に接していません`,
  ROAD_NO_ENTRANCE: (n, p) => `敷地の出入口につながらない道路があります（${n[0]} ほか計${p.count}区間）`,
  ROAD_CROSSING_NO_JUNCTION: (n) => `${n[0]} と ${n[1]} が交差点なしで交差しています`,
  ROAD_LAYER_CONNECTION_INVALID: (n, p) => `${n[0]} の立体接続が成立していません（${p.reason ?? '接続種別・階層・勾配を確認してください'}）。同じ移動種別の接続設備で端点を結んでください`,
  ACCESS_NOT_CONNECTED: (n) => `${n[0]} が外部（敷地の出入口）につながる道路に接していません。利用されません`,
  STATION_NO_RAIL: (n) => `${n[0]} が敷地の外へつながる鉄道線に接続されていません。列車は来ません`,
  ACCESS_ROUTE_UNREACHABLE: (n) => `${n[0]} からターミナルへ旅客が移動できる連絡通路がありません。階層の一致と通路・階段・エレベーターの接続を確認してください`,
  ACCESS_FAR_FROM_TERMINAL: (n, p) =>
    Number(p.distance) < 0 ? `${n[0]} から歩いて行ける運用中のターミナルがありません` : `${n[0]} がターミナルから遠すぎます（${p.distance}タイル、上限16）`,
  TERMINAL_AREA_OUTSIDE: (n) => `${n[0]} がターミナルの範囲（敷地・階数）からはみ出しています`,
  TERMINAL_AREA_OVERLAP: (n) => `${n[0]} と ${n[1]} が同じ階で重なっています`,
  TERMINAL_NO_ENTRANCE: (n) => `${n[0]} に入口がありません（出発旅客が来られません）`,
  TERMINAL_NO_EXIT: (n) => `${n[0]} に出口がありません（到着旅客が出られません）`,
  TERMINAL_NO_CHECKIN: (n) => `${n[0]} にチェックインカウンターがありません`,
  TERMINAL_NO_SECURITY: (n) => `${n[0]} に保安検査場がありません`,
  TERMINAL_NO_BAGGAGE_CLAIM: (n) => `${n[0]} に手荷物受取所がありません`,
  SECURITY_NOT_CONNECTED: (n) => `${n[0]} が一般区域と出発区域の両方に接していません`,
  INTL_EMIGRATION_UNLINKED: (n) => `${n[0]}（出国審査）が出発区域と国際出発区域の両方に接していません`,
  INTL_IMMIGRATION_UNLINKED: (n) => `${n[0]}（入国審査）が国際到着区域と到着区域の両方に接していません`,
  INTL_CUSTOMS_UNLINKED: (n) => `${n[0]}（税関）が到着区域と一般区域の両方に接していません`,
  INTL_GATE_ZONE: (n) => `${n[0]}（国際ゲート）が国際出発区域・国際到着区域の両方に接していません`,
  SWING_GATE_ZONE: (n) => `${n[0]}（兼用ゲート）が国内・国際の両方の区域に接していません`,
  INTL_LOCKED: () => `国際線のエリアやゲートがありますが、国際機能が解放・有効化されていません`,
  GATE_NO_BOARDING_ACCESS: (n) => `${n[0]} に接する出発区域のエリア（出発ロビー等）がありません`,
  GATE_NO_ARRIVAL_ACCESS: (n) => `${n[0]} に接する到着通路がありません`,
  GATE_UNREACHABLE: (n) => `出発旅客が入口から保安検査を経て ${n[0]} に到達できません`,
  GATE_ARRIVAL_NO_EXIT: (n) => `${n[0]} から降りた旅客が出口へ行けません`,
  TERMINAL_DEPARTURE_ROUTE: (n) => `${n[0]} は入口から利用可能なチェックイン・保安検査まで連続して移動できません`,
  GATE_ARRIVAL_NO_BAGGAGE_ROUTE: (n) => `${n[0]} の到着旅客が手荷物受取所を経由して出口へ行けません`,
  TERMINAL_DEPARTURE_ROUTE_PENDING: (n) => `${n[0]} は建設中の連絡通路が完成すれば、入口からチェックイン・保安検査まで移動できるようになります（現在は未接続）`,
  GATE_ROUTE_PENDING: (n) => `${n[0]} は建設中の連絡通路が完成すれば旅客が到達できるようになります（現在は未接続）`,
  FACILITY_UNDERGROUND_KIND: (n) => `${n[0]} は地下に置けない種類の施設です（地下に置けるのは駐車場・従業員駐車場・鉄道駅・ターミナル・AGT 駅だけです）`,
  TERMINAL_UNDERGROUND_ISOLATED: (n) => `${n[0]} は地下だけで地上階がなく、他のターミナルや入口にもつながっていないため、旅客が到達できません（地下通路・連絡リンク・入口エリア・ポータルのいずれかで接続してください）`,
  GATE_UNDERGROUND_BRIDGE: (n) => `${n[0]} は地下の搭乗口のためボーディングブリッジは使えません（バスゲート扱いになります。ブリッジを無効にするか、地上のゲートを使ってください）`,
  PBB_GATE_MISMATCH: (n) => `${n[0]}（搭乗橋）の紐付けが正しくありません（ゲートが無い、スポットが無い、またはゲートの紐付けスポットと一致しません）`,
  PBB_NOT_ADJACENT: (n, p) => `${n[0]}（搭乗橋）がスポット ${n[1]} の入口から離れすぎています（${p.distance} タイル。入口の近傍に置いてください）`,
  PBB_DECK_DUPLICATE: (n, p) => `${n[0]} に ${p.deck === 'upper' ? '上' : '主'}デッキの搭乗橋が複数あります（1デッキにつき1基までです）`,
  PBB_SILL_RANGE: (n, p) => p.deck === 'upper'
    ? `${n[0]}（搭乗橋）は上デッキに接続できない型式です（2階建て機の上デッキには tunnel2Upper が必要です）`
    : `${n[0]}（搭乗橋）の型式では ${p.size} 区分のドア高（ゲーム値）に届かず、大型機で搭乗・降機が遅くなります（2本の型式では届きます）`,
  PBB_LEGACY_OVERRIDDEN: (n) => `${n[0]} には搭乗橋（PBB）が配置されているため、従来の「ボーディングブリッジ」設定は無視されます`,
  INTERIOR_FACILITY_UNLINKED: (n) => `${n[0]} は建物内の設備のため、地上サービス網に接続されず能力に数えられません`,
  FACILITY_INTERIOR_INVALID: (n, p) => `${n[0]} の建物内配置が無効です（階 ${p.floorLabel ?? p.floor ?? '不明'} または親建物・階層を確認してください）`,
  FACILITY_INTERIOR_OUTSIDE: (n) => `${n[0]} が親建物 ${n[1]} の範囲外にあります`,
  TERMINAL_LINK_CLEARANCE: (n, p) => `${n[0]} の連絡通路下の航空機クリアランスが不足しています（${p.clearance}m、必要 ${p.required}m）`,
  AGT_STATION_ORPHAN: (n) => `${n[0]}（AGT の駅）がどのエリアにも接続していません（ターミナル内の駅は同じ階のエリアに隣接させ、単独駅は歩行ポータルで接続してください）`,
  AGT_SEGMENT_ENDPOINT: (n) => `${n[0]}（AGT セグメント）の端点の駅が無い、または駅の所属系統がセグメントの系統と一致しません`,
  AGT_STATION_ISOLATED: (n) => `${n[0]}（AGT の駅）の系統にセグメントがありません（駅だけが置かれた状態です。セグメントで他の駅と結んでください）`,
  AGT_LEVEL_MISMATCH: (n, p) => `${n[0]}（AGT セグメント）の階（${p.segmentFloorLabel}）が両端駅の階（${p.fromFloorLabel} / ${p.toFloorLabel}）と一致しません`,
  AGT_CLEARANCE: (n, p) => `${n[0]}（AGT セグメント）の軌道下の航空機クリアランスが不足しています（床高 ${p.elevation}m、必要クリアランス ${p.required}m。下を通る最大機種コードを宣言するか、軌道を高くしてください）`,
  AGT_PARAM_RANGE: (n, p) => `${n[0]}（AGT 系統）のパラメータ ${p.param} が範囲外です（値 ${p.value}）`,
  CONNECTION_FACILITY_DANGLING: (n) => `${n[0]}（複合連絡施設）の参照が切れています（通路段・端点エリア・垂直エリアのいずれかが無い、または垂直エリアのターミナルが端点と一致しません）`,
  CONNECTION_FACILITY_FLOOR_GAP: (n, p) => `${n[0]}（複合連絡施設）の${p.side === 'a' ? '入口' : '出口'}側の垂直エリアが、端点エリアの階（${p.endpointFloorLabel}）と通路段の階（${p.segmentFloorLabel}）をつないでいません（不足する階に階段・エスカレーター・エレベーターを追加してください）`,
  CONNECTION_FACILITY_STEP_FREE: (n) => `${n[0]}（複合連絡施設）は段差なしとされていますが、片側の垂直移動が階段のみです（エスカレーターまたはエレベーターを追加してください）`,
  PORTAL_LEVEL_MISMATCH: (n, p) => `${n[0]} の歩行ポータルの階が接続先と一致しません（ポータル ${p.portalFloorLabel ?? `${p.floorIndex} 階`}、エリア ${p.areaFloorLabel ?? `${p.areaLevel} 階`}）`,
  PORTAL_CONNECTION_PENDING: (n, p) => `${n[0]} は建設中のポータルが完成すればターミナルと接続します（入口方向: ${portalStatusJa(p.toEntrance)}、出口方向: ${portalStatusJa(p.fromExit)}）`,
  PORTAL_UNREACHABLE: (n, p) => `${n[0]} のポータルからはターミナルの入口/出口へ到達できません（入口方向: ${portalStatusJa(p.toEntrance)}、出口方向: ${portalStatusJa(p.fromExit)}）`,
  NO_RUNWAY: () => '滑走路がありません',
  NO_TOWER: () => '管制塔がありません',
  NO_GSE_BASE: () => 'GSE基地がありません（作業員・車両がいないため折り返し作業ができません）',
  NO_FUEL_FARM: () => '燃料施設がありません（給油できません）',
  NO_MAINTENANCE: () => '整備施設がありません（整備士がいないため点検できません）',
  NO_BAGGAGE_SORT: () => '手荷物仕分け場がありません（預け手荷物を積み込めません）',
};

export function issueText(layout: AirportLayout, issue: Issue): string {
  // 文中の名前は targets → related の順
  return ISSUE_TEXT[issue.code](
    [...issue.targets, ...issue.related].map((t) => displayName(layout, t)),
    issue.params,
  );
}

// ---------------------------------------------------------------- 運航


export const AIRCRAFT_STATE_LABEL: Record<AircraftState, string> = {
  scheduled: '到着予定',
  inbound: '到着処理中',
  holding: '空中待機',
  approach: '最終進入',
  landing: '着陸',
  vacating: '滑走路離脱',
  taxiIn: '到着走行',
  docking: 'スポット進入',
  parked: '駐機中',
  turnaround: '出発準備中',
  readyForPushback: '出発待機',
  pushback: 'プッシュバック',
  taxiOut: '出発走行',
  holdShort: '離陸待ち',
  lineUp: '滑走路進入',
  takeoff: '離陸滑走',
  departed: '出発完了',
  diverted: '運航不能（ダイバート）',
  cannotOperate: '運航不能（欠航）',
};

export const HOLD_REASON_LABEL: Record<HoldReason, string> = {
  noStand: '空きスポットなし',
  standTooSmall: 'スポット区分不足',
  gateRouteMismatch: 'ゲートの国内/国際が不適合',
  terminalRestricted: '使用ターミナルの制限で割当不可',
  noDepartureRoute: '出発経路なし',
  noRunway: '使用できる滑走路なし',
  noRoute: '経路なし',
  routeBusy: '経路上に他機',
  separation: '先行機との間隔待ち',
  runwayBusy: '滑走路使用中',
  departurePriority: '出発優先',
  crossing: '滑走路横断待ち',
  intersection: '交差する滑走路が使用中',
  goAround: '着陸復行',
  boarding: '搭乗手続き中',
  groundCrew: 'トーイングカー・作業員待ち',
  weather: '天候',
  noiseCurfew: '夜間騒音規制',
  blockFull: '前の区間が満杯',
  opposingTraffic: '対向機の通過待ち',
  runwayQueue: '滑走路手前の待機列',
};

export const HOLD_REASON_EXPLANATION: Record<HoldReason, string> = {
  noStand: '適合する空きスポットが見つかるまで到着を保留します。',
  standTooSmall: '空きスポットはありますが、この機体の区分（サイズ）に適合するスポットがありません。大きなスポットを増やすか、工事中のスポットの完成を待ってください。',
  gateRouteMismatch: '適合する空きスポットはありますが、ゲートの国内線/国際線の区分がこの便と合わないため使えません。ゲートの区分設定を確認してください。',
  terminalRestricted: '適合する空きスポットはありますが、この航空会社に許可された使用ターミナルの範囲外のため使えません。運航計画の「航空会社の使用ターミナル」設定を確認してください。',
  noDepartureRoute: 'スポット自体は確保できますが、折り返し出発のために必要な離陸距離を満たす滑走路入口までの経路が確保できません。誘導路の工事・閉鎖や滑走路の運用方向を確認してください。',
  noRunway: '機体サイズ・運用方向・閉鎖状態を満たす滑走路がありません。',
  noRoute: '現在のネットワークに、割当先まで通行可能な経路がありません。',
  routeBusy: '必要な経路区間またはノードを他の機体が使用中です。',
  separation: '先行する機体との安全間隔を確保しています。',
  runwayBusy: '滑走路の使用許可または占有が解放されるのを待っています。',
  departurePriority: '到着機を優先しているため、地上走行の順番を待っています。',
  crossing: '滑走路を横断するため、横断許可を待っています。',
  intersection: '交差する滑走路の占有が解放されるのを待っています。',
  goAround: '進入を中止し、再進入または代替処理を行っています。',
  boarding: '搭乗処理または搭乗締切の完了を待っています。',
  groundCrew: '牽引作業員・トーイングカーなど必要な地上資源が空くのを待っています。',
  weather: '天候条件が運航可能な範囲へ戻るのを待っています。',
  noiseCurfew: '夜間騒音規制の運航可能時間になるのを待っています。',
  blockFull: '進む先の誘導路の区間が他の機体で満杯のため、区間の手前で待っています。',
  opposingTraffic: '同じ誘導路を逆向きに通る機体が抜けるのを待っています。',
  runwayQueue: '滑走路の手前で離陸の順番を待っています。',
};

export const DELAY_CAUSE_LABEL: Record<DelayCause, string> = {
  inboundLate: '出発地からの遅れ',
  noStand: 'スポット不足',
  runwayQueue: '滑走路の混雑',
  taxiCongestion: '誘導路の混雑',
  turnaround: '折り返し作業',
  noRoute: '経路なし',
  boarding: '搭乗手続き',
  groundHandling: '地上支援作業',
  apronBus: 'ランプバス待ち',
  weather: '天候',
  noiseRestriction: '夜間騒音規制',
  technical: '機材の不具合',
};

export const FLIGHT_STATUS_LABEL: Record<FlightStatus, string> = {
  scheduled: '予定',
  active: '運航中',
  completed: '完了',
  diverted: 'ダイバート',
  cancelled: '欠航',
};

export const RUNWAY_MODE_LABEL: Record<RunwayMode, string> = {
  mixed: '離着陸',
  arrivals: '着陸専用',
  departures: '離陸専用',
  closed: '閉鎖',
};

/** ゲーム内時刻（1日目 08:05） */
export function formatSimTime(sec: number, withSeconds = false): string {
  const day = Math.floor(sec / 86400) + 1;
  const s = sec % 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  return `${day}日目 ${hh}:${mm}${withSeconds ? `:${ss}` : ''}`;
}

/** 時刻のみ（08:05） */
export function formatClock(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

export function eventText(e: SimEvent, callsign: (id: string) => string): string {
  const who = e.aircraftId ? callsign(e.aircraftId) : '';
  switch (e.kind) {
    case 'spawn':
      return `${who} が空域に進入`;
    case 'state':
      return `${who}: ${AIRCRAFT_STATE_LABEL[e.state!]}${e.note ? `（${HOLD_REASON_LABEL[e.note as HoldReason] ?? e.note}）` : ''}`;
    case 'hold':
      return `${who} 待機: ${HOLD_REASON_LABEL[e.reason!]}`;
    case 'goAround':
      return e.reason === 'weather' ? `${who} 着陸復行（天候）` : `${who} 着陸復行（滑走路が空いていない）`;
    case 'diverted':
      return `${who} ダイバート（${e.reason ? HOLD_REASON_LABEL[e.reason] : '待機上限'}）`;
    case 'cannotOperate':
      return `${who} 欠航（${e.reason ? HOLD_REASON_LABEL[e.reason] : ''}）`;
    case 'conflict':
      return `⚠ 競合検知: ${who} と ${e.note ? callsign(e.note) : ''} が接近`;
    case 'scheduleGenerated':
      return `スケジュール生成（${e.note}）`;
    case 'boardingOpen':
      return `${e.note} 搭乗開始`;
    case 'boardingClosed':
      return `${e.note}`.replace(/^/, '搭乗締切 ');
    case 'paxMissed':
      return `⚠ 乗り遅れ: ${e.note}`;
    case 'areaClosed':
      return `施設を閉鎖: ${e.note}`;
    case 'areaOpened':
      return `施設を再開: ${e.note}`;
    case 'taskBlocked': {
      const [task, reason] = (e.note ?? ':').split(':') as [TaskKind, BlockReason];
      return `${who} ${TASK_LABEL[task] ?? task} 停止: ${BLOCK_REASON_LABEL[reason] ?? reason}`;
    }
    case 'taskDone':
      return `${who} ${TASK_LABEL[e.note as TaskKind] ?? e.note} 完了`;
    case 'equipmentDown':
      return `⚠ 設備停止: ${e.note}`;
    case 'equipmentUp':
      return `設備復旧: ${e.note}`;
    case 'bagsLeftBehind':
      return `⚠ 積み残し: ${e.note}`;
    case 'finance':
      return `💴 ${e.note}`;
    case 'busRescue':
      return `ランプバスの救援: ${e.note}`;
    case 'standAssigned':
      return `スポット割当: ${e.note ?? `${who} → ${e.standId ?? '不明'}`}`;
    case 'disruption':
      return `⚠ ${e.note}`;
  }
}

// ---------------------------------------------------------------- ターミナル内部・旅客

export const AREA_KIND_LABEL: Record<TerminalAreaKind, string> = {
  entrance: '入口',
  exit: '出口',
  checkIn: 'チェックイン',
  security: '保安検査場',
  departureLobby: '出発ロビー',
  waiting: '待合スペース',
  restroom: 'トイレ',
  arrivalCorridor: '到着通路',
  movingWalkway: '動く歩道',
  baggageClaim: '手荷物受取所',
  hall: '通路・ホール',
  stairs: '階段',
  escalator: 'エスカレーター',
  elevator: 'エレベーター',
  shop: '店舗',
  restaurant: '飲食店',
  lounge: 'ラウンジ',
  emigration: '出国審査',
  immigration: '入国審査',
  customs: '税関',
  transferSecurity: '乗継保安検査',
};

export const ZONE_LABEL: Record<PaxZone, string> = {
  landside: '一般区域（保安検査前）',
  departure: '出発区域（保安検査後）',
  arrival: '到着区域',
  departureIntl: '国際出発区域',
  arrivalIntl: '国際到着区域',
};

/** 契約の種類（フェーズ 4） */
export const CONTRACT_KIND_LABEL: Record<string, string> = {
  turnaround: '折り返し',
  overnight: '夜間滞泊',
  based: '拠点',
};

export const AREA_PROP_LABEL: Record<string, string> = {
  counters: 'カウンター数',
  serviceSecPerPax: '1人あたり処理時間（秒）',
  lanes: 'レーン数',
  seats: '座席数',
  fixtures: '個室・設備数',
  belts: 'ベルト数',
  booths: '窓口数',
  travelSec: '上下移動の所要時間（秒）',
  capacity: '同時に利用できるグループ数',
  levels: '階数',
};

/** 乗り遅れの詰まり箇所（ボトルネック）の分類名 */
export const MISS_BOTTLENECK_LABEL: Record<MissBottleneck, string> = {
  checkIn: 'チェックイン待ち',
  security: '保安検査待ち',
  emigration: '出国審査待ち',
  immigration: '入国審査待ち',
  customs: '税関待ち',
  transferSecurity: '乗継保安検査待ち',
  gate: '搭乗口・待合で待機',
  walking: '移動中',
  bus: 'バス待ち・乗車中',
  access: '空港へのアクセス中',
  transferLate: '乗継時間の不足',
  unreachable: '到達不能',
  routePending: '連絡通路の完成待ち',
  noGate: 'ゲートなし',
  facilityClosed: '施設閉鎖',
  other: 'その他',
};

export const PAX_STATE_LABEL: Record<PaxState, string> = {
  toAirport: '空港へ移動中',
  accessWalk: '交通施設から移動中',
  walking: '移動中',
  queuing: '順番待ち',
  inService: '手続き中',
  dwelling: '待機（自由時間）',
  boardingQueue: '搭乗待ち',
  boarded: '搭乗済み',
  waitingBaggage: '手荷物待ち',
  exited: '退出済み',
  stranded: '到達不能',
  waitingFacility: '施設閉鎖で待機',
  waitingTransport: '交通機関を待機',
  waitingBus: 'ランプバス待ち',
  onBus: 'ランプバスで移動中',
  missed: '乗り遅れ',
  cancelled: '欠航',
};

/** ランプバスの運行の段階 */
export const BUS_PHASE_LABEL: Record<BusTripPhase, string> = {
  waiting: '配車待ち',
  toPickup: '乗車地へ移動',
  loading: '乗車中',
  driving: '走行中',
  unloading: '降車中',
  stalled: '故障（救援待ち）',
  done: '完了',
  cancelled: '取消',
};

export const MISS_REASON_LABEL: Record<MissReason, string> = {
  late: '締切に間に合わず',
  unreachable: 'ゲートに到達できず',
  facilityClosed: '施設閉鎖で未処理',
  noGate: 'ゲートなし',
  noBus: 'ランプバスが来ず',
  cancelled: '欠航',
};

export const BOARDING_LABEL: Record<FlightPax['boarding'], string> = { notStarted: '搭乗前', open: '搭乗中', closed: '搭乗締切' };

// ---------------------------------------------------------------- 地上支援・手荷物

export const TASK_LABEL: Record<TaskKind, string> = {
  deplane: '降機',
  unload: '荷下ろし',
  fuel: '給油',
  clean: '機内清掃',
  cater: 'ケータリング',
  inspect: '整備・点検',
  board: '搭乗',
  load: '積み込み',
  pushback: 'プッシュバック',
  cargoUnload: '貨物荷下ろし',
  cargoLoad: '貨物積み込み',
};

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  pending: '未着手',
  blocked: '停止中',
  dispatched: '移動中',
  inProgress: '作業中',
  done: '完了',
  cancelled: '中止',
};

export const BLOCK_REASON_LABEL: Record<BlockReason, string> = {
  dependency: '先行作業待ち',
  waitingTime: '開始時刻待ち',
  noStaff: '作業員不足',
  noEngineer: '整備士不足',
  noVehicle: '車両不足',
  noFuelFarm: '燃料施設なし',
  unitBroken: '車両故障（再割り当て待ち）',
  waitingPax: '旅客待ち',
  waitingBags: '手荷物待ち',
  sorterDown: '仕分け設備停止',
};

export const UNIT_KIND_LABEL: Record<UnitKind, string> = {
  apronBus: 'ランプバス',
  staff: '作業員',
  engineer: '整備士',
  tug: 'トーイングカー',
  beltLoader: 'ベルトローダー',
  baggageTractor: '手荷物牽引車',
  fuelTruck: '給油車',
  cateringTruck: 'ケータリング車',
  cleaningVan: '清掃車',
};

export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  idle: '待機',
  enroute: '移動中',
  working: '作業中',
  returning: '帰還中',
  broken: '故障',
};

export const BAG_STATE_LABEL: Record<BagState, string> = {
  checkedIn: '預け入れ',
  sorting: '仕分け',
  madeUp: '仕分け済み',
  onCart: '搬送中',
  loaded: '積載済み',
  leftBehind: '積み残し',
  offloaded: '取り下ろし',
  onAircraft: '機内（到着）',
  atClaim: 'ベルト待ち',
  onBelt: 'ベルト上',
  collected: '受け取り済み',
};

// ---------------------------------------------------------------- 経営（docs/14_management_rules.md）

export const REVENUE_LABEL: Record<RevenueCategory, string> = {
  contract: '契約料',
  landing: '着陸料',
  parking: '駐機料',
  terminal: 'ターミナル使用料',
  groundHandling: '地上支援料',
  retail: '店舗売上',
  dining: '飲食売上',
  carPark: '駐車場収入',
  transit: '交通事業者の使用料（タクシー・バス・鉄道）',
  hotel: '空港ホテル収入',
  cargo: '貨物収入',
};

export const COST_LABEL: Record<CostCategory, string> = {
  salary: '人件費（作業員・整備士）',
  counterStaff: '窓口要員（カウンター・保安検査・ゲート）',
  vehicles: '車両維持費',
  maintenance: '施設維持費',
  utilities: '光熱費',
  accessOps: '交通施設・ホテルの運営費',
  staffCommute: '職員の通勤対策費（職員用駐車場の不足）',
  groundOps: '地上作業費',
  compensation: '補償・対応費',
  disruption: '障害の修理・早期復旧費',
  cargoHandling: '貨物荷役費',
  agtOps: 'AGT の運営費',
};

export const WINDOW_LABEL: Record<TimeWindow, string> = {
  morning: '朝（6〜11時）',
  daytime: '昼（10〜17時）',
  evening: '夕（16〜22時）',
  any: '終日',
};

export const CONTRACT_STATUS_LABEL: Record<Contract['status'], string> = {
  offered: '提案中',
  active: '契約中',
  ended: '満了',
  rejected: '辞退',
  withdrawn: '撤退',
  expired: '期限切れ',
};

export const AIRLINE_TYPE_LABEL: Record<AirlineType, string> = {
  fullService: 'フルサービス',
  lcc: 'LCC',
  regional: 'リージョナル',
};

export const CONTRACT_ACTION_LABEL: Record<Exclude<ContractActionResult, { ok: true }>['reason'], string> = {
  NOT_FOUND: '契約が見つかりません',
  NOT_OFFERED: '提案中の契約ではありません',
  NOT_ACTIVE: '契約中ではありません',
  UNSUPPORTED: 'この機種はこの空港では運航できません（滑走路・スポットの区分を確認してください）',
  AIRLINE_ROUTE_UNSUPPORTED: '航空会社がこの路線種別を運航していません',
  INTERNATIONAL_PROCESSING_REQUIRED: '国際旅客処理（出入国審査・税関）が未対応です',
  CAPACITY_INSUFFICIENT: '追加便を受け入れる空港処理能力が不足しています（能力画面で不足箇所を確認してください）',
  AIRLINE_REFUSED: '航空会社の満足度が低いため、増便に応じてもらえません',
  MIN_FREQUENCY: 'これ以上減便できません（1日1便が最小）',
  LOCKED: 'この種類の契約はまだ解放されていないか、有効化されていません',
  NO_CHANGE: '逆提案の内容が現在の条件と同じです',
  COUNTER_TOO_SOON: '逆提案は断られた当日には再提案できません',
  NOT_REASSIGNABLE: '付け替えできません（対象外の契約か、条件を満たす実在会社がありません）',
};

export const PLAN_ISSUE_LABEL: Record<PlanIssueCode, string> = {
  GROUND_SUPPORT_MISSING: '燃料施設・整備士・トーイングカーのいずれかがなく、折り返し（給油・点検・プッシュバック）ができない',
  SIZE_UNSUPPORTED: '運航できない機種（滑走路・スポットが未対応）',
  STAND_CONFLICT: 'スポット不足（到着時に空きスポットがない見込み）',
  NO_GATE: 'ゲートのないスポット（旅客が搭乗できない）',
  BUS_BOARDING: 'リモートスポット（ランプバスで搭乗）',
  INVALID_BUS_GATE: 'リモートスポットの接続バスゲートが未設定または利用不能',
  NO_TERMINAL: '旅客ターミナル（入口）がない',
  RUNWAY_OVERLOAD: '滑走路の処理能力の目安（30回/時・本）を超える',
  SECURITY_OVERLOAD: '保安検査の処理能力を超える見込み',
  CHECKIN_OVERLOAD: 'チェックインの処理能力を超える見込み',
  GROUND_OVERLOAD: '地上支援の能力を超えて折り返しが重なる',
  AIRLINE_ROUTE_UNSUPPORTED: '航空会社がこの路線種別を運航していない',
  INTERNATIONAL_PROCESSING_REQUIRED: '国際旅客処理（出入国審査・税関）が未対応',
  OUTSIDE_HOURS: '運用時間・契約の時間帯に収まらない（計画できない便）',
  OVERNIGHT_CAPACITY_EXCEEDED: '滞泊できる機数を超える',
  BASED_CONDITIONS_UNMET: '拠点契約の条件（滞泊の能力・整備・人員）を満たさない',
  INTL_GATE_MISSING: '国際のゲートがない',
  TERMINAL_RESTRICTED: '航空会社の使用ターミナル制限の範囲内にスポットがない',
  MCT_UNAVAILABLE: '乗継の経路がなく、最小乗継時間が出せない',
  FIRE_CATEGORY_LOW: '消防区分が不足（機体に必要な区分に届かない）',
  TOWER_CAPACITY_LOW: '管制塔の処理能力をピークの発着回数が超える',
};

/** KPI の名前と計算式（画面のツールチップに表示） */
export const KPI_LABEL: Record<keyof DailyKpi, { label: string; formula: string }> = {
  modePax: { label: '手段別の旅客', formula: '出発・到着旅客が空港への行き来に使った手段ごとの人数' },
  parkingFull: { label: '駐車場満車', formula: '自家用車で来たが満車で停められなかったグループ数' },
  roadDelayMin: { label: 'アクセス道路の遅れ', formula: '車で来た旅客の混雑による平均の遅れ（分）= 基本時間 × 0.15 × (交通量/容量)^4' },
  transitWaitMin: { label: '乗り場の待ち', formula: '到着旅客がタクシー・バス・鉄道の乗り場で待った平均時間（分）' },
  accessFactor: { label: 'アクセス係数', formula: 'min(1.1, 0.3 + 0.85 × (1 − exp(−A/0.2)))、A = Σ exp(手段の効用)。搭乗率に掛かる' },
  flights: { label: '運航便数', formula: '期間内に着陸した到着便 + ブロックアウトした出発便' },
  movements: { label: '離着陸回数', formula: '着陸 + 離陸の回数' },
  paxDeparted: { label: '出発旅客', formula: '搭乗した旅客数' },
  paxArrived: { label: '到着旅客', formula: '降機した旅客数' },
  otp: { label: '定時運航率', formula: '予定から15分以内の便 ÷ 全便（ダイバート・欠航は遅延扱い）。到着は着陸、出発はブロックアウトで判定' },
  avgDelayMin: { label: '評価対象の平均遅延', formula: '実遅延から記録済みの外部要因遅延と折返し猶予を控除した値（分）' },
  actualAvgDelayMin: { label: '実績の平均遅延', formula: '便の実際の運航時刻と予定時刻との差（分）' },
  runwayUtil: { label: '滑走路使用率', formula: '離着陸回数 ÷ (運用中の滑走路数 × 30回/時 × 経過時間)' },
  gateUtil: { label: 'スポット使用率', formula: 'スポットが機体に割り当てられていた時間 ÷ (運用中のスポット数 × 経過時間)' },
  facilityUtil: { label: '窓口稼働率', formula: 'チェックイン・保安検査で処理中の窓口・秒 ÷ 開いていた窓口・秒' },
  avgWaitMin: { label: '平均待ち時間', formula: '搭乗・退出した旅客の待ち時間の平均（分）' },
  avgWalkMin: { label: '平均歩行時間', formula: '搭乗・退出した旅客の歩行時間の平均（分）' },
  avgGroundMin: { label: '平均地上作業時間', formula: '出発準備完了 − ブロックイン の平均（分。夜間滞泊・貨物便を除く）' },
  unprocessedPax: { label: '未処理旅客', formula: '締めの時点でターミナル内に残り、手続きが終わっていない旅客' },
  missedPax: { label: '乗り遅れ', formula: '搭乗締切までに搭乗できなかった旅客' },
  leftBags: { label: '積み残し手荷物', formula: '搭乗した旅客の手荷物のうち、機体に積めなかった個数' },
  diverted: { label: 'ダイバート', formula: '到着できずにダイバートした便' },
  cancelled: { label: '欠航', formula: '出発できずに欠航した便' },
  paxSatisfaction: {
    label: '旅客満足度',
    formula: '100 − 2×平均待ち(分) − max(0, 平均歩行(分) − 10) − 平均遅延(分) − 300×乗り遅れ率 − 100×積み残し率（0〜100）',
  },
  paxSatisfactionDetail: {
    label: '旅客満足度の内訳',
    formula: '満足度の各減点（待ち時間・歩行・遅延・乗り遅れ・手荷物）と材料の平均値（5-04）',
  },
  airlineSatisfaction: { label: '航空会社満足度', formula: '契約中の航空会社の満足度の平均（定時率・乗り遅れ・積み残し・欠航・料金で日々変化）' },
  rating: { label: '空港評価', formula: '0.7 × 前日の評価 + 0.3 × (0.4×旅客満足度 + 0.4×航空会社満足度 + 0.2×定時運航率%)' },
};

export const MODE_LABEL = { career: 'キャリア', sandbox: 'サンドボックス' } as const;

// ---------------------------------------------------------------- 空港アクセス（docs/15_access_rules.md）

export const ACCESS_MODE_LABEL: Record<AccessMode, string> = {
  car: '自家用車（駐車）',
  dropoff: '送迎（車寄せ）',
  taxi: 'タクシー',
  bus: 'バス',
  rail: '鉄道',
  walk: '徒歩',
};

export const ACCESS_UNAVAILABLE_LABEL: Record<AccessUnavailable, string> = {
  noTerminal: '運用中のターミナルがない',
  noEntrance: '敷地の外へつながる一般道路（出入口）がない',
  noFacility: '施設がない',
  notConnected: '外部につながる道路・鉄道に接続されていない',
  tooFar: 'ターミナルから遠すぎる',
  noCurb: 'ターミナルが一般道路に接していない（車寄せなし）',
  noService: '都市側の鉄道整備度が不足している',
  noCapacity: '台数・本数が 0',
};

export const PROJECT_KIND_LABEL: Record<Project['kind'], string> = { build: '新設工事', renovation: '改修工事（閉鎖中）', closure: '一時閉鎖' };

/** 日内の分 → 06:30 */
export function formatMinute(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 機種・適合性・障害（Phase 7）

export const DATA_STATUS_LABEL: Record<DataStatus, string> = {
  official: '公式値',
  game: 'ゲーム値',
  unset: '未設定',
};

export const COMPAT_STATUS_LABEL: Record<CompatStatus, string> = { ok: '適合', ng: '不適合', unknown: '要確認' };

export const COMPAT_REASON_LABEL: Record<CompatReason, string> = {
  TYPE_UNRESOLVED: '機種データがない（未解決の機種ID）',
  NOT_OPERATIONAL: '施設が運用中でない（計画・建設中・閉鎖中）',
  RUNWAY_CLASS: '滑走路の区分（長さ・幅）が足りない',
  RUNWAY_TAKEOFF_LENGTH: '離陸に必要な長さ（ゲーム値）が足りない',
  RUNWAY_LANDING_LENGTH: '着陸に必要な長さ（ゲーム値）が足りない',
  RUNWAY_CODE_F: 'コード F の機体には幅 60 m の滑走路が必要',
  STAND_CLASS: 'スポットの区分が足りない',
  STAND_CODE_F: 'スポットがコード F 対応に指定されていない',
  STAND_NOT_CONNECTED: 'スポットが誘導路につながっていない',
  TAXIWAY_CLASS: '誘導路の幅の区分が足りない',
  TAXIWAY_CODE_F: '誘導路がコード F 対応に指定されていない',
  GATE_NO_STAND: 'ゲートにスポットが紐付いていない（判定不能）',
  GATE_BUS: 'バスゲート（リモートスポットの便をランプバスで運ぶ）',
  GATE_STAND_NG: '紐付いたスポットが適合しない',
  GATE_UPPER_DECK: '上階への搭乗橋はモデル化していない（使用は可）',
  GSE_NONE: '必要な車両・作業員が空港に1台もいない',
  GSE_FEWER: '車両・作業員が必要数より少ない（作業に時間がかかる）',
  NO_FUEL_FARM: '燃料施設がない',
  NO_ROUTE: '使える滑走路とスポットを結ぶ経路がない',
};

export const WEATHER_LABEL: Record<WeatherKind, string> = { clear: '晴れ', rain: '雨', snow: '雪', fog: '霧' };

export const DISRUPTION_KIND_LABEL: Record<DisruptionKind, string> = {
  weather: '天候の変化',
  runwayClosed: '滑走路の一時閉鎖',
  taxiwayClosed: '誘導路の使用不能',
  standClosed: '駐機スポットの使用不能',
  gateFailure: '搭乗ゲートの故障',
  baggageFailure: '手荷物設備の故障',
  vehicleFailure: '地上支援車両の故障',
  staffAbsence: '作業員の欠勤',
  demandSurge: '旅客需要の急増',
  inboundDelay: '到着便の遅延',
  maintenance: '整備による施設の一時停止',
};

export const DISRUPTION_STATUS_LABEL: Record<Disruption['status'], string> = { scheduled: '予定', active: '発生中', resolved: '復旧' };

export const FLEET_RESULT_LABEL: Record<Exclude<FleetResult, { ok: true }>['reason'], string> = {
  UNKNOWN_TYPE: 'カタログにない機種です',
  SEATS_INVALID: '座席数は1以上の整数にしてください',
  OVER_MAX_PAX: '座席数が最大旅客定員（公式値がない機種はゲーム上の上限）を超えています',
  NOT_IN_FLEET: 'その航空会社の保有機材にない機種です（先に保有機材に追加してください）',
  IN_USE: '契約で使っている機種は保有機材から外せません',
  NOT_FOUND: '見つかりません',
};

export const RESPONSE_LABEL: Record<Exclude<ResponseResult, { ok: true }>['reason'], string> = {
  NOT_FOUND: '対象が見つかりません',
  TOO_LATE: '着陸後・出発後の便は変更できません',
  INCOMPATIBLE: 'その機種に適合しないスポットです',
  OCCUPIED: 'そのスポット（ユニット）は使用中です',
  CLOSED: '閉鎖中のスポットです',
};

// ---------------------------------------------------------------- 分析・シナリオ（Phase 8）

export const GROUP_KEY_LABEL: Record<GroupKey, string> = {
  manufacturer: 'メーカー',
  family: '機種ファミリー',
  model: '機種・派生型',
  airline: '航空会社',
  flight: '運航便',
  runway: '滑走路',
  stand: '駐機スポット',
  gate: '搭乗ゲート',
};

export const SCENARIO_KPI_LABEL: Record<keyof ScenarioKpis, string> = {
  flights: '便数（機体の運航）',
  completed: '運航完了',
  failed: 'ダイバート・欠航',
  otp: '定時運航率（出発）',
  avgDepDelayMin: '平均出発遅延（分）',
  paxBoarded: '搭乗者数',
  seats: '座席数（運航完了分）',
  loadFactor: '座席利用率',
  missedPax: '乗り遅れ',
  avgTurnMin: '平均折り返し時間（分）',
  avgPaxWaitMin: '旅客の平均待ち（分）',
  bagsLeft: '積み残し手荷物',
  revenue: '収入（cr）',
  cost: '費用（cr）',
  operatingProfit: '営業利益（cr）',
};

export const BOTTLENECK_AREA_LABEL: Record<Bottleneck['area'], string> = {
  runway: '滑走路',
  taxiway: '誘導路・交差地点',
  stand: '駐機スポット',
  checkIn: 'チェックイン',
  security: '保安検査',
  gate: '搭乗ゲート',
  ground: '地上支援（作業員・車両）',
  baggage: '手荷物設備',
};

// ---------------------------------------------------------------- 滑走路（Phase 12: 自由方位・実寸）

/** 参考値の注意書き（RUNWAY_REFERENCE_DISCLAIMER と同文）。参考値・ゲーム値の表示には必ず添える */
export const RUNWAY_DISCLAIMER = '参考値。ゲーム内の判定であり、実際の安全基準への適合を保証しません';

export const RUNWAY_UI = {
  alignment: { grid8: '従来形（8 方向のグリッド）', free: '自由形（任意の方位・実寸）' },
  input: { drag: 'ドラッグ（始点 → 終点）', numeric: '数値入力（方位・長さ）' },
  gridSnap: { tile: 'タイル', half: '半タイル', off: 'なし' },
  angleSnap: { 0: 'なし（自由）', 1: '1°', 5: '5°', 10: '10°', 15: '15°', 45: '45°' } as Record<number, string>,
  lengthSnap: { 0: 'なし', 10: '10 m', 50: '50 m', 100: '100 m' } as Record<number, string>,
  anchor: { start: '始点', mid: '中点' },
  hintFreeDrag: '始点 → 終点をドラッグ（またはクリック 2 回）。方位・長さは下の吸着の設定に丸められます。R: 数値入力の方位を回す',
  hintFreeNumeric: '方位・長さを入力して、置きたい位置をクリック',
  freeNote: '方位は真方位（北 = 0°、時計回り）。磁方位と滑走路番号は「空港の設定」の磁気偏角から計算されます。',
  badgeLegacy: '従来',
  badgeFree: '実寸',
  legacyCriterion: '判定: 従来（ゲームの簡易判定）',
  freeCriterion: '判定: 実寸（舗装・肩・着陸帯・RESA の多角形で判定）',
  convertToFree: '自由形に変換（実寸の判定に切り替え）…',
  convertExplain:
    '自由形に変換すると、この滑走路の判定が実寸に切り替わります。位置・方位・長さは変わりませんが、次の点が変わります。',
  convertChanges: [
    '占有と検証が実寸の多角形になります（着陸帯の半幅 87.5 m → 140 m など。周囲の施設が「保護区域内」になることがあります）',
    '停止位置が 87.5 m から 90 m（60 m 幅は 107.5 m）になり、運航に影響します',
    'ほかの滑走路との交差・平行間隔・番号の重複の判定の対象になります',
    '任意の方位に回転でき、端のハンドルで操作できます',
  ],
  convertUndo: '元に戻すには Undo（Ctrl+Z）を使います。自動では変換しません。',
  convertDo: '自由形に変換する',
  cancel: 'やめる',
  snapToGrid: 'グリッドに合わせる（従来形に変換）…',
  snapExplain: '従来形（8 方向・整数タイル）に丸めます。',
  snapChanges: [
    '方位を 45° の倍数に、始点を整数タイルに、長さを整数のステップ数に丸めます（位置が少し動くことがあります）',
    '実寸の設定（肩・着陸帯・RESA・停止位置・標高）は捨てられます',
    '判定が従来のゲームの簡易判定に戻ります',
  ],
  snapDo: 'グリッドに合わせる',
  trueHeading: '真方位（°）',
  magHeading: '磁方位（°）',
  designators: '滑走路番号',
  suffix: '番号の接尾辞（始点側）',
  suffixOptions: { auto: '自動', L: 'L', C: 'C', R: 'R', none: 'なし' },
  lengthM: '長さ（m）',
  startEnd: '始点 / 終点（タイル座標）',
  dimsTitle: '実寸（ゲーム値・上書き）',
  dimsExplain: '空欄ではなく数値が入っている項目が、現在の値です。「ゲーム既定値に戻す」で上書きをすべて解除します。',
  dimsReset: 'ゲーム既定値に戻す',
  dimsOverridden: '上書き',
  dimLabels: {
    shoulderWidthM: '肩の幅（片側, m）',
    stripHalfWidthM: '着陸帯の半幅（m）',
    stripEndM: '着陸帯の端部延長（m）',
    resaLengthM: 'RESA の長さ（m。0 = なし）',
    resaWidthM: 'RESA の全幅（m）',
    holdingPositionM: '停止位置（中心線から, m）',
  },
  elevationStart: '標高 始点（m）',
  elevationEnd: '標高 終点（m）',
  slope: '勾配（表示のみ）',
  slopeNote: '標高差 ÷ 長さ。判定・3D には使いません（参考値がないため警告も出しません）',
  refTitle: '参考値と出典',
  refGame: 'ゲーム値',
  refRef: '参考値',
  settingsTitle: '空港の設定',
  // 空港設定の分割（決定B）: 低頻度項目は設定モーダルへ分離する
  settingsDetailOpen: '空港の詳細設定（磁偏角・判定ルール・アクセスモデル）',
  settingsDetailTitle: '空港の詳細設定',
  settingsDetailNote: 'めったに変えない項目です。変更は従来どおり即時に反映されます。',
  settingsClose: '閉じる',
  magVar: '磁気偏角（°、東を正）',
  magVarHelp: '東偏差を正で入力します（例: 10 = 10°E、-5 = 5°W）。公式の偏角（NOAA の磁場計算機など）を手入力します。滑走路番号は磁方位から決まります。',
  ruleSet: '判定ルール',
  ruleClassic: '従来（既定）',
  ruleRealistic: '実寸（参考値に基づく追加の警告）',
  ruleExplain:
    '「実寸」にすると、平行滑走路の間隔と番号の重複の警告が従来形の滑走路にも適用されます。今後の版（Phase 13 以降）で判定が追加される予定で、現時点では実寸の判定の大半は自由形の滑走路で行われます。',
  numbersTitle: '滑走路番号の一覧',
  noRunways: '滑走路がありません',
  tagReal: '実寸',
  crossingTitle: '交差する滑走路',
  crossingDependent: '従属運用（2 本の離着陸を同時に使いません）',
  handleHelp: '端のハンドルをドラッグ: 中点まわりに回転 / Shift + ドラッグ: 反対の端を固定して方位・長さを変更',
} as const;

export const MAG_VAR_LABEL = (v: number): string => (v === 0 ? '0°' : v > 0 ? `${v}°E` : `${-v}°W`);

// ---------------------------------------------------------------- 運航モードの画面（12B-1）

/** 運航モードの上部のボタン列（キーは従来のタブと同じ） */
export const OPS_NAV: readonly (readonly [string, string])[] = [
  ['flights', '運航表（全列）'],
  ['terminal', 'ターミナル'],
  ['ground', '地上支援'],
  ['baggage', '手荷物'],
  ['plan', '運航計画'],
  ['finance', '経営'],
  ['disruptions', '天候・障害'],
  ['analytics', '分析'],
  ['scenarios', 'シナリオ'],
  ['access', 'アクセス'],
  ['expansion', '拡張計画'],
  ['catalog', '機種カタログ'],
  ['project', 'プロジェクト'],
  ['events', 'イベント'],
  ['issues', '配置チェック'],
  ['airlines', '航空会社'],
  ['goals', '目標'],
  ['journal', '運航記録'],
];

/** 運航モードの常設カード・運航表・アラートの文言 */
export const OPS_UI = {
  dayUnit: '日目',
  jump: 'クリックでその場所へ移動',
  repair: '修理',
  closed: '閉鎖',
  // KPI
  kpiTitle: '本日の KPI（暫定）',
  kpiMovements: '完了した便',
  kpiOtp: '定時率',
  kpiDelay: '評価対象の平均遅延',
  kpiActualDelay: '実績の平均遅延',
  kpiPax: '旅客（出発＋到着）',
  kpiMissed: '乗り遅れ',
  kpiRevenue: '収入（本日）',
  kpiCost: '費用（本日）',
  kpiProfit: '営業利益（本日）',
  kpiNote: '日締め前の暫定値。詳細は「経営」',
  kpiNone: '経営の集計がありません',
  // 天候・障害
  weatherTitle: '天候・障害',
  weatherNow: '天候',
  closures: '閉鎖中',
  closuresText: (t: number, s: number, g: number) => `誘導路 ${t} · スポット ${s} · ゲート ${g}`,
  noDisruption: '発生中の障害はありません',
  // ターミナル
  terminalTitle: 'ターミナル',
  inTerminal: (n: number) => `館内 ${n}人`,
  paxMissed: '乗り遅れ',
  noTerminal: '処理施設がありません',
  queueText: (queued: number, avgWaitMin: number, crowd: number) => `待ち ${queued}人 · 平均 ${avgWaitMin}分 · 混雑 ${crowd}%`,
  // 地上支援・手荷物
  groundTitle: '地上支援・手荷物',
  busTrips: 'ランプバスの運行',
  busTripsText: (running: number, waiting: number, trips: number) => `運行中 ${running} · 配車待ち ${waiting} · 完了 ${trips}`,
  busWait: 'バス待ちの旅客',
  fidsBus: 'BUS',
  fidsBusTitle: (gate: string) => `ランプバスで搭乗・降機（${gate}）`,
  alertBusShortage: (n: number) => `ランプバス不足（${n} 件の運行が配車待ち）`,
  alertBusStalled: (pax: number) => `ランプバス故障（乗客 ${pax} 人が車内で救援待ち）`,
  brokenBadge: (n: number) => `故障 ${n}`,
  unitText: (working: number, total: number, broken: number) => `作業中 ${working}/${total}${broken > 0 ? ` · 故障 ${broken}` : ''}`,
  blockedTasks: '止まっている作業',
  bagsActive: '手荷物（処理中）',
  bagsLeft: '積み残し',
  equipment: '仕分け・ベルト',
  equipmentDown: (n: number) => `停止 ${n}`,
  equipmentOk: (n: number) => (n > 0 ? '稼働' : '—'),
  // アクセス
  accessTitle: 'アクセス',
  accessNone: 'アクセスの集計がありません',
  accessNoPax: 'まだ旅客が来ていません',
  paxCount: (n: number) => `${n}人`,
  waiting: (n: number) => `待ち ${n}人`,
  parking: '駐車場',
  parkingText: (used: number, spaces: number) => `${used} / ${spaces}台`,
  parkingFull: '満車で断った車',
  transitWait: '乗り場の待ち',
  // 工事
  constructionTitle: '工事',
  noProjects: '工事中の施設はありません',
  projectsCount: (n: number) => `${n}件`,
  remainingDays: (n: number) => `残り ${n}日`,
  // イベント
  eventsTitle: 'イベント（新しい順）',
  noEvents: '重要なイベントはありません',
  // 運航表（案内板風）
  fidsTitle: '運航表 FLIGHTS',
  fidsFilter: { all: 'すべて', departure: '出発', arrival: '到着' },
  fidsHideDone: '完了を隠す',
  fidsDrag: '見出しをドラッグして移動できます（位置はこのブラウザに記憶します）',
  fidsCompactLabel: (n: number) => `直近${n}便`,
  fidsAllLabel: '全件',
  fidsCompactOn: (n: number) => `直近 ${n} 便だけ表示します（クリックで全件）`,
  fidsCompactOff: '全件を表示中（クリックで直近の便だけ）',
  fidsOpen: '運航表を開く',
  fidsFold: '運航表を畳む',
  fidsCols: ['予定', '便名', '行先・出発地', '機種', 'スポット', '状態', '遅延'],
  fidsColsFull: ['便名', '区分', '機種', '予定', '予想/実績', '遅延', '滑走路', 'スポット', '旅客', '便の状態', '機体の状態', '遅延理由'],
  fidsFrom: 'FROM ',
  fidsTo: 'TO ',
  fidsActions: 'この便への操作',
  fidsEmpty: '表示する便はありません',
  delay15: '+15分',
  delay30: '+30分',
  reassign: 'スポット変更',
  apply: '変更',
  prio: '優先',
  cancelEarly: '先行欠航',
  cancelEarlyTitle: 'まだ現れていない折り返しを欠航にします（補償なし・航空会社の満足度 −1。悪天の前に使います）',
  cancelEarlyConfirm: (n: string) => `${n} の折り返しを先行欠航にしますか？（元には戻せません）`,
  prioOff: '優先を解除',
  goto: '機体へ移動',
  close: '閉じる',
  // アラート
  airlineTitle: '航空会社の評価',
  airlineNone: '契約している航空会社がありません',
  airlineNote: '既存のデータからの導出（表示のみ）。点数は 0〜100 のゲーム用の指標で、満足度の計算には使いません',
  satisfaction: '満足度',
  lackingNone: '足りないもの: 特になし',
  noContract: '契約なし',
  alertCritical: '重大',
  alertWarning: '注意',
  alertAction: { focus: '移動', repair: '修理', delay15: '+15分', reassign: 'スポット変更', openPanel: '詳細' } as Record<string, string>,
  alertMore: (n: number) => `他 ${n} 件を表示`,
  alertLess: '畳む',
  alertOpenEvents: 'イベントを開く',
  // アラートの出し分け（決定C）: 重大だけを地図上のスタックに出し、注意は要対応インボックスのみ
  alertInboxNote: (n: number) => `注意 ${n} 件は要対応インボックスにあります`,
  // FIDS の出し分け（決定C）: 浮動パネルは要約のみ、全列は運航ボード
  fidsOpenBoard: '全列表示（運航ボード）',
  fidsBoardNote: '全列表示です。浮動の運航表は要約表示で、行への操作（遅延・スポット変更など）は浮動側から行います',
} as const;

// ---------------------------------------------------------------- 航空会社の評価カード（12B-1）

export const SCORE_LABEL: Record<ScoreKey, string> = {
  otp: '定時性',
  turnaround: '折り返し',
  stand: 'スポット・ゲート',
  fees: '料金',
  slots: '枠（時間帯）',
  aircraft: '機材の対応',
  pax: '旅客体験',
  demand: '需要（搭乗率）',
};

export const SCORE_LEVEL_LABEL: Record<ScoreLevel, string> = { good: '良好', warn: '注意', bad: '不足', 'n/a': '—' };

const pctText = (v: number) => `${Math.round(v * 1000) / 10}%`;
const typeNames = (ids: string[] | undefined) => (ids ?? []).map((id) => resolveType(AIRCRAFT_TYPES, id).label).join('、');

/** 要素の一文の説明（良好なときは状況、注意・不足のときは足りないもの） */
export function scoreText(c: ScoreComponent): string {
  const f = c.facts;
  if (c.level === 'n/a') return 'まだ判定できません（実績・契約がありません）';
  switch (c.key) {
    case 'otp': {
      const cause = f.names?.[0] ? `。主な遅延理由: ${DELAY_CAUSE_LABEL[f.names[0] as DelayCause] ?? f.names[0]}` : '';
      return `定時率 ${pctText(f.value ?? 0)}（要求 ${pctText(f.target ?? 0)}）${f.fallback ? '・空港全体の値' : ''}${c.level === 'good' ? '' : cause}`;
    }
    case 'turnaround':
      return (f.value ?? 0) <= 0 ? `折り返しは標準（${f.target}分）以内` : `折り返しが標準（${f.target}分）より ${f.value}分長い`;
    case 'stand':
      if ((f.value ?? 0) > 0) return `明日 ${f.value}便でスポットが不足`;
      if ((f.target ?? 0) > 0) return `ゲートのないスポットに ${f.target}便が割り当てられる`;
      if ((f.n ?? 0) > 0) return `スポット待ちの遅れが ${f.n}便`;
      return 'スポット・ゲートは足りている';
    case 'fees':
      return `${c.level === 'good' ? '料金は許容範囲' : '料金が高いと感じている'}（倍率 ×${(f.value ?? 1).toFixed(2)}${f.target !== undefined && Math.abs((f.target ?? 0) - (f.value ?? 0)) > 0.005 ? `、割引後 ×${f.target.toFixed(2)}` : ''}）`;
    case 'slots':
      if ((f.n ?? 0) > 0) return `運用時間・時間帯に入らない契約が ${f.n}件`;
      if ((f.value ?? 0) > 0) return `希望の時間帯の枠に入らない便が ${f.value}便`;
      return '希望の枠に収まっている';
    case 'aircraft':
      if ((f.value ?? 0) > 0) return `${typeNames(f.names)} に対応するスポット・滑走路がない`;
      if ((f.target ?? 0) > 0) return `保有機材のうち ${typeNames(f.names)} は運航できない`;
      return '契約の機材はすべて運航できる';
    case 'pax': {
      const missed = `乗り遅れ ${pctText(f.missedRate ?? f.value ?? 0)}${f.missedCount !== undefined && f.bookedCount !== undefined ? `（${f.missedCount}/${f.bookedCount}人）` : ''}`;
      const left = `手荷物の積み残し ${pctText(f.leftRate ?? f.target ?? 0)}${f.leftCount !== undefined && f.bagsCount !== undefined ? `（${f.leftCount}/${f.bagsCount}個）` : ''}`;
      return `${missed}・${left}`;
    }
    case 'demand': {
      const worst = f.worstRoute && f.worstRouteLf !== undefined ? `。最も低いのは ${f.worstRoute}線 ${pctText(f.worstRouteLf)}` : '';
      return `搭乗率 ${pctText(f.value ?? 0)}（基準 ${pctText(f.target ?? 0)}）${worst}`;
    }
  }
}

/** 「足りないもの」の一行（なければ不足なし） */
export function lackingText(s: AirlineScore): string {
  if (s.lacking.length === 0) return '足りないもの: 特になし';
  return `足りないもの: ${s.lacking.map((c) => `${SCORE_LABEL[c.key]}（${scoreText(c)}）`).join(' / ')}`;
}

/** 率の差をポイント（百分率の差）で表す。例: 0.85 と 0.72 → 13 */
const pointDiff = (target: number, value: number) => Math.round((target - value) * 1000) / 10;

/**
 * 不満の内訳の一行（表示のみ）。要素の事実から「何が・どれだけ足りないか」を具体化する。
 * DayReview の不満行と経営画面の航空会社パネルの不満行で共通に使う。
 */
export function complaintDetailText(c: ScoreComponent): string {
  const f = c.facts;
  const label = SCORE_LABEL[c.key];
  switch (c.key) {
    case 'otp': {
      const short = pointDiff(f.target ?? 0, f.value ?? 0);
      const legs = f.lateCount !== undefined && f.n !== undefined ? `、遅延 ${f.lateCount}/${f.n} 区間` : '';
      const cause = f.names?.[0] ? `。主な遅延理由: ${DELAY_CAUSE_LABEL[f.names[0] as DelayCause] ?? f.names[0]}` : '';
      return `${label}: 定時率 ${pctText(f.value ?? 0)}（要求 ${pctText(f.target ?? 0)}${short > 0 ? `、${short}ポイント不足` : ''}${legs}）${f.fallback ? ' ※空港全体の値' : ''}${cause}`;
    }
    case 'turnaround': {
      const std = f.target ?? 0;
      const over = f.value ?? 0;
      return over > 0 ? `${label}: 標準 ${std}分に対し平均 ${std + over}分（+${over}分、対象 ${f.n ?? 0}便）` : `${label}: 折り返しは標準（${std}分）以内（対象 ${f.n ?? 0}便）`;
    }
    case 'stand': {
      const parts: string[] = [];
      if ((f.value ?? 0) > 0) parts.push(`スポット競合 ${f.value}便`);
      if ((f.target ?? 0) > 0) parts.push(`ゲートのないスポットへの割当 ${f.target}便`);
      if ((f.n ?? 0) > 0) parts.push(`スポット待ちの遅れ ${f.n}便`);
      if (f.busShare !== undefined && f.busShare > 0) parts.push(`ランプバス搭乗が全体の ${pctText(f.busShare)}`);
      return parts.length ? `${label}: ${parts.join('・')}` : `${label}: スポット・ゲートは足りている`;
    }
    case 'fees': {
      const eff = f.target ?? f.value ?? 1;
      const vsStd = eff > 1 ? `標準より ${Math.round((eff - 1) * 100)}% 高い` : '標準以下';
      return `${label}: 料金倍率 ×${(f.value ?? 1).toFixed(2)}（割引後 ×${eff.toFixed(2)}、${vsStd}）`;
    }
    case 'slots': {
      const parts: string[] = [];
      if ((f.value ?? 0) > 0) parts.push(`希望の時間帯の枠に入らない便 ${f.value}便`);
      if ((f.n ?? 0) > 0) parts.push(`運用時間・時間帯に入らない契約 ${f.n}件`);
      return parts.length ? `${label}: ${parts.join('・')}` : `${label}: 希望の枠に収まっている`;
    }
    case 'aircraft': {
      if ((f.value ?? 0) > 0) return `${label}: ${typeNames(f.names)} に対応するスポット・滑走路がない（契約機材 ${f.value}種）`;
      if ((f.target ?? 0) > 0) return `${label}: 保有機材のうち ${typeNames(f.names)} は運航できない（${f.target}種）`;
      return `${label}: 契約の機材はすべて運航できる`;
    }
    case 'pax': {
      const missed = `乗り遅れ ${pctText(f.missedRate ?? f.value ?? 0)}${f.missedCount !== undefined && f.bookedCount !== undefined ? `（${f.missedCount}/${f.bookedCount}人）` : ''}`;
      const left = `手荷物の積み残し ${pctText(f.leftRate ?? f.target ?? 0)}${f.leftCount !== undefined && f.bagsCount !== undefined ? `（${f.leftCount}/${f.bagsCount}個）` : ''}`;
      return `${label}: ${missed}・${left}`;
    }
    case 'demand': {
      const short = pointDiff(f.target ?? 0, f.value ?? 0);
      const worst = f.worstRoute && f.worstRouteLf !== undefined ? `。最も低いのは ${f.worstRoute}線 ${pctText(f.worstRouteLf)}` : '';
      return `${label}: 搭乗率 ${pctText(f.value ?? 0)}（基準 ${pctText(f.target ?? 0)}${short > 0 ? `、${short}ポイント不足` : ''}）${worst}`;
    }
  }
}

// ---------------------------------------------------------------- 1 日のループ（12B-2）

export const REVIEW_METRIC_LABEL: Record<ReviewMetric, string> = {
  totalRevenue: '収入',
  totalCost: '費用',
  operatingProfit: '営業利益',
  otp: '定時率',
  avgDelayMin: '平均遅延（分）',
  pax: '旅客数（出発＋到着）',
  paxSatisfaction: '旅客満足度',
  airlineSatisfaction: '航空会社満足度',
  rating: '空港評価',
  flights: '便数',
  missedPax: '乗り遅れ旅客',
  leftBags: '積み残し手荷物',
  diverted: 'ダイバート',
  cancelled: '欠航',
};

export const DAY_LOOP = {
  weatherTitle: '天候（5 段階）',
  weatherMax: (l: number) => `この日の最大は段階 ${l}`,
  weatherChange: '天候の段階が変わりました',
  skipDay: '▶▶ 1日スキップ',
  skipDayTitle: '残りの 1 日を画面を進めずに一気に進め、締めの振り返りを表示します（結果は画面で進めた場合と同じです）',
  prefPause: '0:00 で一時停止して振り返る',
  prefPauseTitle: '日付が変わる 0:00 に運航を止めて「1日の振り返り」を表示します（切ると止まらずに続きます）',
  prefAutoStop: 'スキップを重大な障害で止める',
  prefAutoStopTitle: '1 日スキップ中に滑走路の閉鎖・整備やダイバートが起きたら止めます',
  openReview: '前日の振り返り',
  openHistory: '履歴',
  // スキップ
  skipTitleDay: '1 日をスキップしています',
  skipTitleNight: '夜間を進めています（次の便の少し前まで）',
  skipHint: '画面は止めて計算だけを進めています。結果は画面で進めた場合と同じです',
  skipCancel: '中止',
  // 振り返り
  reviewTitle: (day: number) => `${day + 1}日目の振り返り`,
  reviewSub: '0:00 に日次の締めを行いました',
  reviewNext: '次の日へ（運航を続ける）',
  reviewBuild: '建設モードに戻る（次の日の準備）',
  reviewClose: '閉じる',
  reviewHistory: '履歴を見る',
  reviewArchive: '（履歴の振り返り。読み取り専用）',
  money: '収入と費用',
  revenue: '収入',
  cost: '費用',
  construction: '建設費（別枠）',
  profit: '営業利益',
  cashEnd: '締めの時点の資金',
  punctuality: '定時運航と遅延',
  otp: '定時率',
  avgDelay: '平均遅延',
  flights: '便数',
  causes: '主な遅延の理由',
  noCauses: '遅延の理由の記録はありません',
  flightsN: (n: number) => `${n}便`,
  paxTitle: '旅客と満足度',
  pax: '旅客（出発＋到着）',
  missed: '乗り遅れ',
  bags: '積み残し手荷物',
  paxSat: '旅客満足度',
  airSat: '航空会社満足度',
  rating: '空港評価',
  disruptionsTitle: '障害と対応',
  noDisruptions: 'この日は障害・天候の変化はありませんでした',
  resolvedByTime: '時間経過で復旧',
  resolvedByPlayer: '対応で復旧',
  unresolved: '続いています',
  responses: (r: { delays: number; reassigns: number; priorities: number; repairs: number }) =>
    `あなたの対応: 修理・解除 ${r.repairs}回 / スポット変更 ${r.reassigns}回 / 遅らせる ${r.delays}回 / 優先 ${r.priorities}回`,
  compareTitle: '前日との比較',
  noPrev: '前日の記録がないため比較できません（最初の日です）',
  improved: '改善',
  worse: '悪化',
  same: '変化なし',
  na: '—',
  airlinesTitle: '航空会社の評価の変化',
  noAirlines: '有効な契約のある航空会社はありません',
  lacking: '足りないもの',
  tomorrowTitle: '明日の見通し',
  tomorrowFlights: (n: number) => `運航計画: ${n}便`,
  tomorrowIssues: '計画の問題',
  noIssues: '計画の問題はありません',
  completing: '明日完成する工事',
  noCompleting: '明日完成する工事はありません',
  weather: '天候予報',
  weatherNone: '予報なし（天候予報は今後追加されます）',
  projectKind: { build: '新設工事', renovation: '改修工事' } as Record<string, string>,
  // 履歴
  historyTitle: '日ごとの履歴（その日の朝に戻れます）',
  historyEmpty: '履歴はまだありません。1 日を締めると、その日の朝の状態が自動で残ります',
  historyNote: '直近 7 日はすべて、それより古いものは週に 1 件（最大 8 件）残します。運航の途中の状態は含みません。シナリオは戻っても現在のものを保ちます',
  historyMemory: '履歴はこのタブを閉じると消えます（IndexedDB を使えない環境）',
  historyRestore: 'この日の朝に戻る',
  historyRestoreConfirm: (d: number) => `${d + 1}日目の朝に戻しますか？（現在の空港と経営の状態はこの日の朝のもので置き換わります。元には戻せません）`,
  historyDelete: '削除',
  historyView: '振り返り',
  historyRestoreBlocked: '運航中は戻れません。建設モードに戻ってから行ってください',
  historyDay: (d: number) => `${d + 1}日目の朝`,
};

/** ゲームのモデル（12B-3a Part B）の文言。数値はゲーム用の値で、実在の基準への適合をうたうものではない（docs/30） */
/** 区間ごとに進む地上走行（フェーズ 2、docs/41） */
export const TAXI_UI = {
  mode: '地上走行の方式',
  modeFull: '従来（経路の全区間を確保・既定）',
  modeBlock: '区間ごとに進む（途中まで進んで待つ）',
  modeExplain:
    '「区間ごとに進む」にすると、誘導路を区間（既定 250 m）に分け、機体は次の区間が空いている分だけ進んで待ちます。区間ごとの進入可能機数は機体の大きさ別の必要長（S 70 m・M 90 m・L 120 m）から決まります。ゲーム内の値で、実在の基準ではありません。',
  tiles: '区間の長さ（タイル、4〜40）',
  tilesHelp: '1 タイル = 25 m。既定は 10 タイル（250 m）。短いと大型機が止まれない区間が増えます。',
  summary: (blocks: number, corridors: number) => `区間 ${blocks} 個・回廊 ${corridors} 本（現在の配置から計算）`,
  operateLocked: '運航中は変更できません（建設モードで変更します）',
  blockMax: '区間の進入可能機数の上限',
  blockMaxAuto: '計算値のまま',
  blockMaxHelp: 'この誘導路を含む区間に同時に入れる機数の上限です（計算値より小さくする方向だけ）。区間ごとに進む方式のときだけ効きます。',
  blockMaxInactive: '（現在の地上走行の方式は従来のため、効きません）',
  blocksOf: (n: number, cap: string) => `区間 ${n} 個・M 機の進入可能機数 ${cap}`,
  legend: '区間の区切り（点線）と「機数 / 進入可能機数（M）」',
  // 実寸設計データ（5-17 T3 の UI。ゲーム内の設計参考値で、実在の基準への適合をうたうものではない）
  designSection: '実寸設計（5-17）',
  designExplain: '舗装幅・肩幅・設計プロファイルは設計用の記録で、通行可否の判定（幅区分・コードF）には影響しません。幅の適合は、想定する機体の主脚外幅（OMGWS）に対してのみ判定します（推測はしません）。',
  pavementWidth: '実舗装幅（m）',
  shoulderWidth: '肩幅（m）',
  designProfile: '設計プロファイル',
  profileNone: '未設定',
  profileFaa: 'FAA TDG',
  profileEasa: 'EASA OMGWS',
  profileLegacy: '従来（ゲーム内区分）',
  designGroup: '設計グループ（TDG）',
  groupNone: '未設定',
  role: '役割',
  roleNormal: '通常誘導路',
  roleRapidExit: '高速離脱誘導路（RET）',
  unset: '未設定（従来の幅区分で判定）',
  clear: 'クリア',
  assessBand: '判定に使う OMGWS 帯',
  assessResult: '幅の適合',
  assessLegacy: '実寸データなし（従来の幅区分・コードF で判定）',
  assessUnknown: '判定できません（必要幅が決まらないため推測しません）',
  assessSufficient: (req: string) => `適合（必要幅 ${req} m 以上）`,
  assessInsufficient: (req: string) => `不足（必要幅 ${req} m）`,
  requiredWidth: '必要舗装幅',
} as const;

/** 歩行ポータル（5-16）の編集 UI */
export const PORTAL_UI = {
  section: '歩行ポータル接続',
  explain: '交通施設とターミナル内エリアを明示的に接続します。座標が近いだけでは接続しません。接続は入口/出口エリアへの到達性で判定されます。',
  none: '接続なし',
  addLabel: '接続先エリア',
  add: 'ポータルを作成',
  remove: '削除',
  floor: (effectiveAreaLevel: number, mapLevel: number) => `エリア ${floorDisplayLabel(effectiveAreaLevel)} ・ 交通施設の地図階層 ${mapLevel >= 0 ? `+${mapLevel}` : `${mapLevel}`}`,
  access: '到達性（入口/出口）',
  accessValue: (toEntrance: string, fromExit: string) => `入口方向: ${toEntrance} ／ 出口方向: ${fromExit}`,
  statusOperational: '接続済み',
  statusPending: '完成待ち',
  statusUnreachable: '到達不能',
  fromFacility: '交通施設から作成します（このエリアへの接続は交通施設のプロパティで追加・削除できます）',
} as const;

/** 施設の外形（フットプリント、5-15 T3）の編集 UI */
export const FOOTPRINT_UI = {
  section: '外形（フットプリント）',
  rect: '矩形',
  free: (n: number) => `自由形状（頂点 ${n}）`,
  edit: '外形を編集',
  reset: '矩形に戻す',
  apply: '確定',
  cancel: 'キャンセル',
  help: '頂点をドラッグで移動、辺をクリックで頂点を追加、頂点をダブルクリックで削除できます。確定するまでは保存されません。',
  vertices: (n: number) => `頂点 ${n}`,
  valid: '有効な形状です',
  invalid: (issues: string) => `形状が不正です（${issues}）`,
  rotated: '回転している施設は外形編集の対象外です（回転を 0° に戻すと編集できます）',
  cannotDeleteVertex: 'この頂点は削除できません（直交ポリゴンとして成立しなくなります）',
} as const;

/** 配置・増設プレビュー（F6-02）の UI */
export const PREVIEW_UI = {
  placementSection: '配置プレビュー',
  placementHint: '地図上で配置位置を動かすと、配置後の能力（仮レイアウトで実計算した値）を表示します。',
  expansionSection: '増設プレビュー',
  expansionExplain: 'props の想定値を入れると、変更後の能力を仮レイアウトで計算して差分を表示します（確定はしません）。',
  propLabel: '対象の項目',
  valueLabel: '想定値',
  current: '現在',
  after: '変更後',
  delta: '差分',
  uncomputed: '未算出',
  kindTotal: (label: string) => `${label}の合計（有効）`,
} as const;

/** UIデザイン更新 第7段階b（表示系）: hubOd・portalUsage・就航範囲・階層切替・複合体・複合グラフ診断・ハブ設定 */
export const PHASE7B_UI = {
  // 日報ドロワー: OD 別の計画配分（5A の DailyReport.hubOd）
  hubOdTitle: '乗継の計画配分（OD別）',
  hubOdExplain: 'その日の計画で配分された乗継の記録です（計画値であり、上の実績とは一致しないのが通常です）。便ペアごとの見込みは経営ボード「乗継・拠点」にあります。',
  hubOdFrom: '到着路線（出発地）',
  hubOdTo: '出発路線（行き先）',
  // 日報ドロワー: 歩行ポータルの通過実績（B4 の DailyReport.portalUsage）
  portalUsageTitle: '歩行ポータルの通過実績',
  portalUsageExplain: 'ポータルを通って交通施設へ出入りした旅客の実績です（連絡設備・上下移動の利用実績とは別集計）。',
  // 会社詳細: 就航範囲（networkDestinations）
  networkScope: '就航範囲',
  networkUnrestricted: '全目的地（制限なし）',
  networkRestricted: (n: number) => `${n} 目的地のみ（範囲外の路線は提案されません）`,
  // 能力ビュー: 階層切替（B6 / F6-03）
  hierarchy: '階層',
  hierarchyAirport: '空港全体',
  hierarchyTerminal: 'ターミナル別',
  hierarchyDomain: '分野別',
  hierarchyFacility: '施設別',
  domainFacility: '施設',
  domainNight: '夜間滞泊',
  domainMaintenance: '整備',
  noTerminal: 'ターミナル外・空港全体',
  groupSummary: (total: number, attention: number) => `${total} 件（要確認 ${attention} 件）`,
  // 複合体（B7）
  complexSection: 'ターミナル複合体',
  complexPhysical: '物理複合体（隣接・連絡通路）',
  complexService: 'サービス複合体（運用中リンク）',
  complexAlone: '単独（他の建物と複合体を組みません）',
  complexMembers: (n: number) => `構成 ${n} 建物`,
  complexNote: '複合体は派生情報です。旅客が実際に通行できるかはエリアの経路とリンクが決めます。建物名を押すとその建物へ移動します。',
  // 複合グラフ診断（B8）
  diagSection: '複合グラフ診断（ポータル接続）',
  diagExplain: '複合グラフ（施設＋ポータル＋エリア）での到達分類です。アクセスの接続マトリクス（landside 側の判定）とは別系統で、検証・能力の disconnected と同じ判定です。',
  diagNone: 'ポータルを持つ交通施設はありません',
  diagToEntrance: '往路（入口まで）',
  diagFromExit: '復路（出口から）',
  diagRoute: 'このポータルの接続分類',
  diagRouteValue: (status: string, sec: number | null) => (sec !== null ? `${status}（経路 ${sec} 秒）` : status),
  diagFuture: '完成後に接続（建設中の経路のみ）',
  // ハブ設定の編集
  hubSettingsEdit: '乗継の設定（編集）',
  hubMaxConnect: '接続の上限（分）',
  hubBankArrive: 'バンク到着帯',
  hubBankDepart: 'バンク出発帯',
  hubBankAdd: 'バンクを追加',
  hubBankRemove: '削除',
  hubSettingsNote: '設定は会社の保存データ（hub）に記録され、次回の計画計算から反映されます。バンクは能力表示（バンク時の機数・処理能力）の算出に使います。',
  hubSettingsSaved: '乗継の設定を保存しました',
} as const;

/** 工程（ProcessStep）の表示名 9 工程分。DayReview の工程ピーク・工程別待ちと、core/attention の写しの正本 */
export const PROCESS_STEP_LABEL: Record<string, string> = {
  checkIn: 'チェックイン',
  security: '保安検査場',
  emigration: '出国審査',
  immigration: '入国審査',
  customs: '税関',
  transferSecurity: '乗継保安検査',
  restroom: 'トイレ',
  apronBus: 'ランプバス',
  access: 'アクセス到着',
};

/** バックエンド追随（5-21/5-23 日報項目）: ローリング 60 分ピーク・工程別待ち・外部境界の文言 */
export const REPORT_FOLLOWUP_UI = {
  processPeakNote: '60分窓は時計の区切りに縛られず、最も混んだ連続60分です',
  peakWindow: (hhmm: string) => `ピーク ${hhmm}〜の60分`,
  peakHourBand: (hour: number) => `ピーク ${hour} 時台`,
  noCapacity: '能力は算出しない（実績のみ）',
  stepWaitsTitle: '工程別の待ち時間（中央値 / 95%点）',
  stepWaitsNote: '処理時間ではなく、各工程で待った時間です',
  doorDepartureLabel: '出発（空港到着→搭乗）',
  doorDepartureNote: '出発の所要時間は、アクセス移動を含む空港への到着時点から測ります',
} as const;

/** バックエンド追随 第2弾（項目1 ラウンジ実績 / 項目3 貨物 Tier 6・7 / 項目4 F6-17）の文言 */
export const FOLLOWUP_UI = {
  // 項目3: 日報ドロワーの積替貨物（Tier 7・翌日便接続のみ）
  cargoTransshipmentLabel: 'うち積替',
  cargoTransshipmentValue: (m3: string) => `${m3} m³（翌日便へ接続します。当日便への積替はありません。空港外へ出ないためトラック輸送の対象外です）`,
  // 項目3: アクセスボードの貨物トラック時間帯配分（Tier 6・計画ベース）
  cargoTruckTitle: '貨物トラックの時間帯配分（計画ベースの見込み）',
  cargoTruckExplain:
    '貨物トラックの搬出入は、1日の計画台数を時間帯の重みで配分して道路の背景交通に使います。これは計画ベースの見込みで、実績の台数は日報の貨物行（トラック台数）が正です。',
  cargoTruckLocked: '格6でトラックの時間帯配分が有効になります（現在は24時間の均等配分です）。',
  cargoTruckTotal: (n: number) => `計画台数 ${n} 台/日`,
  cargoTruckPeak: (hour: number, trips: string) => `ピーク ${hour} 時台・約 ${trips} 台`,
  // 項目4: 直行競合の採用率（HubChoiceShare。係数は暫定）
  hubChoiceColumn: '乗継の採用率（対 直行便）',
  hubChoiceNote:
    '採用率は、同じ OD（出発地→行き先）に仮想の直行便があると仮定したときに、その需要のうち自空港での乗継が選ばれる割合です。実在の直行便の有無とは無関係で、表示される乗継人数には既に反映済みです（二重には掛かりません）。直行便への寄り方を決める係数は暫定値で、校正は未確定です。',
  hubOdExplainFollowup: '魅力は、直行競合の採用率を掛ける前の値です。採用率は暫定の前提での値です。',
  // 項目4: 路線表の基準搭乗率への脚注（LF への乗継統合）
  trafficLfTransferNote:
    '到着便の実際の搭乗率は、乗継需要が空席を埋める分だけ基準搭乗率より高くなることがあります（乗継の内訳は経営ボード「乗継・拠点」で確認できます）。',
} as const;

/** バックエンド追随 第3弾（項目2: docs/46 需要根拠・季節性の表示）の文言。数値は BALANCE / demand の正本から動的に読む */
export const DEMAND_UI = {
  basisToggle: '根拠',
  basisTitle: '需要の根拠（ゲーム値）',
  catchment: '利用圏人口',
  catchmentFallback: '未設定のため都市人口で代用',
  originMarket: '出発側の航空市場人口（自都市）',
  originFallback: '未設定のため都市人口',
  aviationDependency: '航空依存度',
  essential: '必須需要の指数',
  leisure: '観光指数',
  demandIndex: '需要指数',
  distance: (km: number) => `距離 ${km.toLocaleString('ja-JP')} km`,
  distanceFactor: '距離減衰',
  formula: (k: number, alpha: number, beta: number) =>
    `需要 = K ${k.toLocaleString('ja-JP')} × (出発側人口/100万)^${alpha} × (利用圏人口/100万)^${beta} × 需要指数 × 航空依存度 × 距離減衰 × ほか（料金・評価・アクセス）`,
  seasonalityTitle: '季節性',
  profile: '季節プロファイル',
  profileNone: 'なし（従来の月別表で計算）',
  todayFactor: '今日の季節・曜日係数',
  month: (m: number) => `${m} 月`,
  demandNote: '需要モデルは暫定校正中（K 値を含みます）で、一部の路線では実績より大きく出ることがあります。根拠の数値はすべてゲーム用の値です。',
} as const;

/** 季節プロファイルの表示名（内部名 URBAN 等をそのまま出さない） */
export const SEASONALITY_PROFILE_LABEL: Record<SeasonalityProfile, string> = {
  URBAN: '都市型',
  RAIL: '鉄道競合型',
  REGIONAL: '地方型',
  HOKKAIDO: '北海道型',
  SNOW: '雪国型',
  OKINAWA: '沖縄型',
  ISLAND: '離島型',
  SUMMER: '夏季型',
};

/** アクセスの区間能力モデル（フェーズ 4、docs/44） */
export const ACCESS_UI = {
  model: 'アクセスの能力モデル',
  modelAggregate: `集約（出入口数 × ${BALANCE.accessModel.roadPerEntrance} 台/時・既定）`,
  modelSegment: '区間（最も細い区間で決める）',
  modelExplain:
    '「区間」にすると、出入口から車寄せ・駐車場までの経路で最も細い区間の能力が上限になり、混雑の遅れも区間ごとに計算します。道路の車線数・線路の単線/複線・駅のホーム数が効きます。ゲーム内の値です。',
} as const;

/** 夜間の運用・出発時刻の制限（フェーズ 2、docs/40） */
export const NIGHT_UI = {
  title: '夜間の運用（出発時刻の制限）',
  note: `夜間の騒音規制（${formatMinute(CITY_NIGHT_CURFEW.fromMin)}〜${formatMinute(CITY_NIGHT_CURFEW.toMin)}）の前に出発を終えるための設定です。ゲーム内のモデルで、実在の空港の運用基準ではありません。`,
  enabled: '最終出発時刻を設ける（オフ = 従来の計画・運航）',
  cutoff: '最終出発時刻',
  cutoffHelp: `計画する出発はこの時刻までに収まります（制限開始の ${CITY_NIGHT_CURFEW.fromMin - NIGHT_OPS_RANGES.departureCutoffMin.min}〜${CITY_NIGHT_CURFEW.fromMin - NIGHT_OPS_RANGES.departureCutoffMin.max} 分前）。既定は ${formatMinute(NIGHT_OPS_DEFAULTS.departureCutoffMin)}。収まらない契約は「計画できない便」になります。`,
  airborneMax: '上空の夜間待機の上限（分）',
  airborneMaxHelp: '到着が夜間にかかっても、まず出発地で待機します。すでに上空にいる便はこの時間を超えるとダイバートします。',
  warnLead: '離陸見込みの警告（制限開始の何分前）',
  warnLeadHelp: '予測の離陸が制限開始のこの分数前を越える便を、運航画面で警告します。',
  prioritize: '持ち越しの危険がある便を滑走路の列で優先する',
  inboundPolicy: '夜間にかかる到着の扱い: 出発地で待機（現在はこの方式のみ）',
  readOnly: '運航中は変更できません（建設モードで変更します）',
  manualWarn: '手動の便が最終出発時刻を過ぎる場合は警告のみで、追加は止めません。',
  riskAlert: (flight: string, predicted: string) => `夜間の持ち越しの恐れ: ${flight} の離陸が ${predicted} 頃の見込みです`,
} as const;

/** 倍率の表示（1 → 「1.0」、0.6 → 「0.6」、0.75 → 「0.75」のように末尾の 0 を1つだけ残す） */
const mulText = (v: number): string => v.toFixed(2).replace(/0$/, '');

/** 難易度のヒント文を core の DIFFICULTY 表から生成する（数値の正本は game.ts の DIFFICULTY） */
function difficultyHintOf(d: DifficultyDef): string {
  return (
    `悪天 ×${mulText(d.weatherScale)} / 障害 ×${mulText(d.disruptionScale)} / 資金 ×${mulText(d.cashMul)} / 建設費 ×${mulText(d.costMul)}` +
    `${d.otpAdd > 0 ? ` / 定時率 +${Math.round(d.otpAdd * 100)}pt` : ''} / 予報 ${Math.round(d.forecastAccuracy * 100)}%`
  );
}

export const GAME_UI = {
  setupNew: '設定して新規',
  setupNewTitle: '難易度・気候・ルールを選んで新しいゲームを始めます',
  setupSettings: 'ルール',
  setupSettingsTitle: '天候・難易度・評価・目標のルールを選びます（以後の運航から反映）',
  setupDialog: 'ゲームの設定',
  setupMode: 'モード',
  setupModeCareer: 'キャリア（小さな飛行場から）',
  setupModeSandbox: 'サンドボックス（サンプル空港・潤沢な資金）',
  setupDifficulty: '難易度',
  setupClimate: '気候（天候の出方の傾向）',
  setupRules: '使うルール',
  setupCity: '都市・空港需要（ゲーム値）',
  setupCityEnabled: '都市規模を旅客需要・アクセス所要時間・人口成長に反映する',
  setupMarket: '路線需要モデル（就航先の利用圏人口・航空依存度・季節変動と、自都市の規模から路線ごとの需要・搭乗率を決めます）',
  setupFeatures: '新しい運航の仕組み（フェーズ 4）',
  setupFeatureOvernight: '夜間滞泊（夕方に着いて翌朝出る便と、拠点の土台）',
  setupFeatureBased: '拠点航空会社（常駐機と整備）',
  setupFeatureInternational: '国際線（出入国審査・税関・国際ゲート）',
  setupFeatureHub: '乗継と波（乗継旅客・バンク）',
  setupFeatureCargo: '貨物輸送（貨物契約・運搬量の集計）',
  // 人口は core の CITY_PROFILE が正本。表示側（GameSetup）が人口を付けて出すため、ここは種別名だけを持つ
  cityType: { regional: '地方都市', core: '中核都市', metropolitan: '大都市' } as Record<string, string>,
  setupWeather: '天候 5 段階・予報（オフ = 従来の 4 種の天候の障害）',
  setupEval: '航空会社の評価要素・不満・要望',
  setupGoals: '目標・空港の格',
  setupLegacy: '新しいルールを使わない（従来のルールのまま）',
  setupStart: 'この設定で始める',
  setupApply: '設定を反映',
  setupCancel: '閉じる',
  setupConfirm: '新しいゲームを始めますか？（現在の空港と経営データは失われます）',
  setupApplyConfirm: 'ルールを変更しますか？（運航の結果が変わります）',
  setupNote: '数値はすべてゲーム用の値です。難易度は初期資金・建設費・悪天の頻度・求める定時率・予報の的中率を変えます',
  difficulty: { normal: '標準', hard: '難しい', expert: '上級' } as Record<string, string>,
  // 倍率は core の DIFFICULTY 表が正本。ヒント文はそこから生成する（difficultyHintOf）
  difficultyHint: {
    normal: difficultyHintOf(DIFFICULTY.normal),
    hard: difficultyHintOf(DIFFICULTY.hard),
    expert: difficultyHintOf(DIFFICULTY.expert),
  } as Record<string, string>,
  climate: { temperate: '温帯', snowy: '雪国', humid: '多雨' } as Record<string, string>,
  difficultyBadge: (d: string) => d,
  rulesLegacy: '従来',
  // 天候（段階 0〜4。ゲーム用の区分）
  wxLevel: ['晴れ', '曇り・小雨', '雨', '荒天', '悪天'] as readonly string[],
  wxType: { clear: '晴れ', cloud: '曇り', rain: '雨', snow: '雪', fog: '霧', storm: '雷雨' } as Record<string, string>,
  wxTitle: '天候の段階',
  wxNow: '現在',
  wxForecast: '明日の予報',
  wxForecastToday: '今日の予報',
  wxForecastNote: (acc: number) => `予報の的中率 ${Math.round(acc * 100)}%（区間ごと。外れると段階が 1 ずれる）`,
  wxBlock: (a: number, b: number) => `${a}〜${b}時`,
  wxHourly: '今日の残りの時間',
  wxEffectNote: '段階が高いほど離着陸の間隔が広がり、走行が遅くなり、着陸復行・欠航が増えます（ゲーム用の値）',
  wxNoForecast: '予報なし（天候 5 段階を使っていません）',
  // 航空会社の評価（不満・要望）
  complaintTitle: '不満',
  complaintOf: (label: string) => `${label}への不満`,
  requestTitle: '要望',
  requestText: (kind: string, arg?: string) =>
    kind === 'standFor' ? `${arg ?? ''} に対応するスポット・滑走路がほしい` : kind === 'slot' ? '希望の時間帯に便を収めてほしい（枠の問題を解消）' : kind === 'contactGate' ? 'ゲート（ボーディングブリッジ）で搭乗できるようにしてほしい' : '定時率を要求の水準に戻してほしい',
  requestDue: (d: number) => `${d + 1}日目まで`,
  emaCol: '傾向（移動平均）',
  trendUp: '▲',
  trendDown: '▼',
  noComplaint: '不満はありません',
  newComplaint: (n: string, l: string) => `${n}: ${l}への不満が生じました`,
  fulfilled: '達成した要望',
  // 目標・空港の格
  goalsTitle: '目標',
  goalsNext: '次の目標',
  goalsAllDone: 'すべての目標を達成しました',
  goalsDone: (day: number) => `達成（${day + 1}日目）`,
  goalsOverlayNote: '報酬の現金は営業収支に入らず、別枠で資金に加わります（ゲーム用の値）',
  tier: ['飛行場', '地方空港', '地域拠点空港', '国内主要空港', '国際空港', '国際ハブ空港', '広域ハブ空港', 'メガハブ空港'] as readonly string[],
  tierLabel: (t: string) => `空港の格: ${t}`,
  tierUp: (t: string) => `空港の格が上がりました: ${t}`,
  // 次の格までの到達度（5-20 T6）
  nextTierTitle: (t: string) => `次の格（${t}）まで`,
  nextTierMax: '最高格に到達しています',
  nextTierMovements: '発着',
  nextTierPax: '旅客',
  nextTierRating: '評価',
  nextTierHeavy: '大型機の運航',
  nextTierIntlOps: '国際線の実績',
  nextTierTransferOps: '乗継の実績',
  nextTierRecordNote: '直近の締め日の記録で判定',
  nextTierStreak: (cur: number, req: number) => `連続達成 ${cur}/${req} 日`,
  nextTierShortfall: (n: string) => `あと ${n}`,
  nextTierMet: '✓',
  nextTierMissing: 'なし',
  nextTierCannot: '不可',
  nextTierUnknown: '—',
  nextTierBasedOn: (day: number) => `直近の日報（${day + 1}日目）時点の値`,
  nextTierNoReport: '日報はまだありません（発着・旅客は 0 として表示）',
  goalCompleted: (t: string) => `目標を達成しました: ${t}`,
  reviewGoals: '達成した目標',
  reviewNoGoals: 'この日に達成した目標はありません',
  goal: {
    flights10: { title: '1 日 10 便を完了', reward: '30 万 cr' },
    otp85x3: { title: '定時率 85% を 3 日連続', reward: '評価 +2' },
    mov50: { title: '1 日 50 発着', reward: '100 万 cr' },
    firstHeavy: { title: '大型機（L 区分）の初就航', reward: '30 日間 提案が増える' },
    firstBus: { title: 'バス搭乗の便を初めて完了', reward: '20 万 cr' },
    rail: { title: '鉄道駅が運用中', reward: '評価 +2' },
    noMiss: { title: '20 便以上で乗り遅れ 0', reward: '評価 +1' },
    pax10k: { title: '旅客 1 万人/日', reward: '200 万 cr' },
    mov200: { title: '1 日 200 発着', reward: '500 万 cr' },
    rating80: { title: '空港評価 80 以上', reward: '30 日間 提案が増える' },
    mov500: { title: '1 日 500 発着', reward: '1,000 万 cr' },
    otp95x7: { title: '定時率 95% を 7 日連続', reward: '300 万 cr・評価 +2' },
  } as Record<string, { title: string; reward: string }>,
};
