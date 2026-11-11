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
  STAND_NOT_ON_APRON: (n) => `${n[0]} がエプロンの上にありません`,
  RUNWAY_TOO_SHORT: (n) => `${n[0]} が短すぎて、どの機体も使用できません（1,200m 以上必要）`,
  RUNWAY_NO_TAXIWAY: (n) => `${n[0]} に接続する誘導路がありません`,
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
  STAND_REMOTE: (n) => `${n[0]} にはゲートがありません（リモートスポット）`,
  STAND_MULTIPLE_GATES: (n) => `${n[0]} に複数のゲートが紐付いています`,
  GATE_NOT_AT_TERMINAL: (n) => `${n[0]} がターミナルに接していません`,
  GATE_NO_STAND: (n) => `${n[0]} にスポットが紐付いていません`,
  GATE_STAND_TOO_FAR: (n, p) => `${n[0]} と ${n[1]} が離れすぎています（${p.distance}タイル）`,
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
  missed: '乗り遅れ',
  cancelled: '欠航',
};

export const MISS_REASON_LABEL: Record<MissReason, string> = {
  late: '締切に間に合わず',
  unreachable: 'ゲートに到達できず',
  facilityClosed: '施設閉鎖で未処理',
  noGate: 'ゲートなし',
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
