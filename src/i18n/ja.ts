import type { Disruption, DisruptionKind, WeatherKind, AircraftState, BagState, BlockReason, DelayCause, FlightPax, FlightStatus, HoldReason, MissReason, PaxState, RunwayMode, SimEvent, TaskKind, TaskState, UnitKind, UnitStatus } from '../core/sim/types';
import type { BuildState, EntityType, FacilityKind, PaxZone, RoadClass, SizeClass, TerminalAreaKind } from '../core/model/types';
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
import type { PlanIssueCode } from '../core/economy/planning';
import type { AirlineScore, ScoreComponent, ScoreKey, ScoreLevel } from '../core/economy/airlineScore';
import type { ReviewMetric } from '../core/analytics/review';
import { AIRCRAFT_TYPES, resolveType } from '../core/sim/aircraftTypes';

export const FACILITY_LABEL: Record<FacilityKind, string> = {
  apron: 'エプロン',
  terminal: 'ターミナル',
  gate: '搭乗ゲート',
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
  railStation: '空港連絡駅',
  staffParking: '職員用駐車場',
  hotel: '空港ホテル',
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
export const ROAD_CLASS_LABEL: Record<RoadClass, string> = { public: '一般道路', service: 'サービス道路（業務用）', rail: '鉄道（空港連絡線）' };

export const PROP_LABEL: Record<string, string> = {
  checkInCounters: 'チェックインカウンター数',
  securityLanes: '保安検査レーン数',
  standId: '紐付けスポット',
  jetBridge: 'ボーディングブリッジ',
  boardingMode: '搭乗方式',
  connectedTo: '接続先ターミナル',
  apronBuses: 'ランプバス',
  maxSize: '収容可能な最大機体',
  level: 'レベル',
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
  rooms: '客室数',
};

/** ゲートの搭乗方式（docs/29） */
export const BOARDING_MODE_LABEL = {
  contact: '通常（コンタクト）',
  bus: 'バス（ランプバスでリモートスポットへ）',
  connectAuto: '（自動: 隣接するターミナル）',
} as const;

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
};

/** エンティティの表示名（名前が無ければ種別名 + 番号） */
export function displayName(layout: AirportLayout, id: string): string {
  const type = entityTypeOf(id);
  const num = id.slice(id.indexOf('_') + 1);
  switch (type) {
    case 'runway': {
      const r = layout.runways[id];
      return r?.name || `滑走路 #${num}`;
    }
    case 'taxiway':
      return layout.taxiways[id]?.name ? `誘導路 ${layout.taxiways[id]!.name}` : `誘導路 #${num}`;
    case 'road':
      return layout.roads[id]?.name || `道路 #${num}`;
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
  STAND_MULTIPLE_GATES: (n) => `${n[0]} に複数のゲートが紐付いています`,
  GATE_NOT_AT_TERMINAL: (n) => `${n[0]} がターミナルに接していません`,
  GATE_NO_STAND: (n) => `${n[0]} にスポットが紐付いていません`,
  GATE_STAND_TOO_FAR: (n, p) => `${n[0]} と ${n[1]} が離れすぎています（${p.distance}タイル）`,
  GATE_BUS_HAS_STAND: (n) => `${n[0]} はバスゲートなので、紐付けたスポットは使われません`,
  GATE_BUS_NO_VEHICLES: (n) => `${n[0]} はバスゲートですが、運用中の GSE 基地にランプバスがありません（旅客を運べません）`,
  BUS_GATE_NO_REMOTE_STAND: (n) => `${n[0]} はバスゲートですが、リモートスポット（ゲートのないスポット）がありません`,
  GATE_CONNECTION_INVALID: (n) => `${n[0]} の接続先がターミナルではありません（存在しない・別の種類の施設）`,
  GATE_CONNECTOR_LONG: (n, p) => `${n[0]} と ${n[1]} をつなぐ通路が長すぎます（約 ${p.tiles} タイル。歩行に時間がかかります）`,
  NO_AIRSIDE_ACCESS: (n) => `${n[0]} がエプロン・誘導路・サービスエリア・サービス道路に接していません`,
  TERMINAL_NO_ROAD: (n) => `${n[0]} が一般道路に接していません`,
  TERMINAL_NO_GATE: (n) => `${n[0]} に搭乗ゲートがありません`,
  PARKING_NO_ROAD: (n) => `${n[0]} が道路に接していません`,
  ROAD_NO_ENTRANCE: (n, p) => `敷地の出入口につながらない道路があります（${n[0]} ほか計${p.count}区間）`,
  ROAD_CROSSING_NO_JUNCTION: (n) => `${n[0]} と ${n[1]} が交差点なしで交差しています`,
  ACCESS_NOT_CONNECTED: (n) => `${n[0]} が外部（敷地の出入口）につながる道路に接していません。利用されません`,
  STATION_NO_RAIL: (n) => `${n[0]} が敷地の外へつながる鉄道線に接続されていません。列車は来ません`,
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
  GATE_NO_BOARDING_ACCESS: (n) => `${n[0]} に接する出発区域のエリア（出発ロビー等）がありません`,
  GATE_NO_ARRIVAL_ACCESS: (n) => `${n[0]} に接する到着通路がありません`,
  GATE_UNREACHABLE: (n) => `出発旅客が入口から保安検査を経て ${n[0]} に到達できません`,
  GATE_ARRIVAL_NO_EXIT: (n) => `${n[0]} から降りた旅客が出口へ行けません`,
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
      return `${who} 着陸復行（滑走路が空いていない）`;
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
  baggageClaim: '手荷物受取所',
  hall: '通路・ホール',
  escalator: 'エスカレーター',
  elevator: 'エレベーター',
  shop: '店舗',
  restaurant: '飲食店',
};

export const ZONE_LABEL: Record<PaxZone, string> = {
  landside: '一般区域（保安検査前）',
  departure: '出発区域（保安検査後）',
  arrival: '到着区域',
};

export const AREA_PROP_LABEL: Record<string, string> = {
  counters: 'カウンター数',
  serviceSecPerPax: '1人あたり処理時間（秒）',
  lanes: 'レーン数',
  seats: '座席数',
  fixtures: '個室・設備数',
  belts: 'ベルト数',
  travelSec: '上下移動の所要時間（秒）',
  capacity: '同時に利用できるグループ数',
  levels: '階数',
};

export const PAX_STATE_LABEL: Record<PaxState, string> = {
  toAirport: '空港へ移動中',
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
  AIRLINE_REFUSED: '航空会社の満足度が低いため、増便に応じてもらえません',
  MIN_FREQUENCY: 'これ以上減便できません（1日1便が最小）',
};

export const PLAN_ISSUE_LABEL: Record<PlanIssueCode, string> = {
  SIZE_UNSUPPORTED: '運航できない機種（滑走路・スポットが未対応）',
  STAND_CONFLICT: 'スポット不足（到着時に空きスポットがない見込み）',
  NO_GATE: 'ゲートのないスポット（旅客が搭乗できない）',
  BUS_BOARDING: 'リモートスポット（ランプバスで搭乗）',
  NO_TERMINAL: '旅客ターミナル（入口）がない',
  RUNWAY_OVERLOAD: '滑走路の処理能力の目安（30回/時・本）を超える',
  SECURITY_OVERLOAD: '保安検査の処理能力を超える見込み',
  CHECKIN_OVERLOAD: 'チェックインの処理能力を超える見込み',
  GROUND_OVERLOAD: '地上支援の能力を超えて折り返しが重なる',
  OUTSIDE_HOURS: '運用時間・契約の時間帯に収まらない（計画できない便）',
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
  avgDelayMin: { label: '平均遅延', formula: '運航した便の (実績 − 予定) の平均（分）' },
  runwayUtil: { label: '滑走路使用率', formula: '離着陸回数 ÷ (運用中の滑走路数 × 30回/時 × 経過時間)' },
  gateUtil: { label: 'スポット使用率', formula: 'スポットが機体に割り当てられていた時間 ÷ (運用中のスポット数 × 経過時間)' },
  facilityUtil: { label: '窓口稼働率', formula: 'チェックイン・保安検査で処理中の窓口・秒 ÷ 開いていた窓口・秒' },
  avgWaitMin: { label: '平均待ち時間', formula: '搭乗・退出した旅客の待ち時間の平均（分）' },
  avgWalkMin: { label: '平均歩行時間', formula: '搭乗・退出した旅客の歩行時間の平均（分）' },
  avgGroundMin: { label: '平均地上作業時間', formula: '出発準備完了 − ブロックイン の平均（分）' },
  unprocessedPax: { label: '未処理旅客', formula: '締めの時点でターミナル内に残り、手続きが終わっていない旅客' },
  missedPax: { label: '乗り遅れ', formula: '搭乗締切までに搭乗できなかった旅客' },
  leftBags: { label: '積み残し手荷物', formula: '搭乗した旅客の手荷物のうち、機体に積めなかった個数' },
  diverted: { label: 'ダイバート', formula: '到着できずにダイバートした便' },
  cancelled: { label: '欠航', formula: '出発できずに欠航した便' },
  paxSatisfaction: {
    label: '旅客満足度',
    formula: '100 − 2×平均待ち(分) − max(0, 平均歩行(分) − 10) − 平均遅延(分) − 300×乗り遅れ率 − 100×積み残し率（0〜100）',
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
  kpiDelay: '平均遅延',
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
    case 'pax':
      return `乗り遅れ ${pctText(f.value ?? 0)}・手荷物の積み残し ${pctText(f.target ?? 0)}`;
  }
}

/** 「足りないもの」の一行（なければ不足なし） */
export function lackingText(s: AirlineScore): string {
  if (s.lacking.length === 0) return '足りないもの: 特になし';
  return `足りないもの: ${s.lacking.map((c) => `${SCORE_LABEL[c.key]}（${scoreText(c)}）`).join(' / ')}`;
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
