import type { AircraftState, DelayCause, FlightStatus, HoldReason, RunwayMode, SimEvent } from '../core/sim/types';
import type { BuildState, EntityType, FacilityKind, RoadClass, SizeClass } from '../core/model/types';
import { entityTypeOf, type AirportLayout } from '../core/model/types';
import type { Issue, IssueCode, OperabilityReason, Severity } from '../core/validation/validate';
import type { OpFailure } from '../core/layout/operations';
import type { AirsideNodeKind } from '../core/airside/network';

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
  serviceArea: 'サービスエリア',
  parking: '駐車場',
};

export const ENTITY_LABEL: Record<EntityType, string> = {
  runway: '滑走路',
  taxiNode: '誘導路ノード',
  taxiway: '誘導路',
  roadNode: '道路ノード',
  road: '道路',
  stand: '駐機スポット',
  facility: '施設',
};

export const NODE_KIND_LABEL: Record<AirsideNodeKind, string> = {
  taxiway: '中間点',
  intersection: '交差点',
  endpoint: '端点',
  runwayEntry: '滑走路入口',
  runwayThreshold: '滑走路端',
  stand: 'スポット',
};

export const BUILD_STATE_LABEL: Record<BuildState, string> = {
  planned: '計画',
  underConstruction: '建設中',
  operational: '運用中',
};

export const SIZE_LABEL: Record<SizeClass, string> = { S: 'S（小型）', M: 'M（中型）', L: 'L（大型）' };
export const ROAD_CLASS_LABEL: Record<RoadClass, string> = { public: '一般道路', service: 'サービス道路' };

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
  spaces: '駐車台数',
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
  NO_RUNWAY: () => '滑走路がありません',
  NO_TOWER: () => '管制塔がありません',
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
};

export const DELAY_CAUSE_LABEL: Record<DelayCause, string> = {
  inboundLate: '出発地からの遅れ',
  noStand: 'スポット不足',
  runwayQueue: '滑走路の混雑',
  taxiCongestion: '誘導路の混雑',
  turnaround: '折り返し作業',
  noRoute: '経路なし',
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
  }
}
