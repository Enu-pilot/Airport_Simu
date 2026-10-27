import type { RngState } from '../rng';
import type { AircraftTypeId } from './aircraftTypes';

/**
 * 運航シミュレーションの状態。JSON シリアライズ可能な plain object とし、
 * 空港レイアウトとは独立に保持する（レイアウトから導出するネットワークは SimContext）。
 */

/**
 * 航空機の状態（docs/04 §3 を Phase 2 の実装に合わせて具体化）
 *
 * scheduled → inbound ⇄ holding → approach → landing → vacating → taxiIn → docking → parked
 *   → turnaround → readyForPushback → pushback → taxiOut → holdShort → lineUp → takeoff → departed
 * 異常終了: diverted（到着できずダイバート）/ cannotOperate（出発できず欠航）
 */
export type AircraftState =
  | 'scheduled' // 到着予定（まだ空域にいない）
  | 'inbound' // 到着処理中（空域に進入、スポット・滑走路・経路を確保中）
  | 'holding' // 空中待機（遅延）
  | 'approach' // 最終進入（滑走路を予約済み）
  | 'landing' // 着陸滑走（滑走路を占有）
  | 'vacating' // 滑走路からの離脱
  | 'taxiIn' // 誘導路を到着走行中
  | 'docking' // 駐機スポットへの進入
  | 'parked' // 駐機中（ブロックイン）
  | 'turnaround' // 出発準備中（地上作業）
  | 'readyForPushback' // 出発準備完了・出発時刻/走行許可待ち
  | 'pushback' // プッシュバック・エンジン始動
  | 'taxiOut' // 誘導路を出発走行中
  | 'holdShort' // 離陸待ち（滑走路手前で停止）
  | 'lineUp' // 滑走路へ進入・整列
  | 'takeoff' // 離陸滑走
  | 'departed' // 出発完了
  | 'diverted' // 運航不能（到着できずダイバート）
  | 'cannotOperate'; // 運航不能（出発できず欠航）

export const TERMINAL_STATES: readonly AircraftState[] = ['departed', 'diverted', 'cannotOperate'];
export const AIRBORNE_STATES: readonly AircraftState[] = ['inbound', 'holding', 'approach'];
/** 地上で誘導路ネットワーク上を移動する状態 */
export const GROUND_MOVING_STATES: readonly AircraftState[] = [
  'landing',
  'vacating',
  'taxiIn',
  'docking',
  'pushback',
  'taxiOut',
  'holdShort',
  'lineUp',
  'takeoff',
];

/** 待機の理由 */
export type HoldReason =
  | 'noStand' // 空きスポットがない
  | 'noRunway' // 使用できる滑走路がない
  | 'noRoute' // ネットワーク上に経路がない
  | 'routeBusy' // 経路上の区間が他機に予約されている
  | 'separation' // 先行機との間隔待ち
  | 'runwayBusy' // 滑走路が使用中
  | 'departurePriority' // 出発優先のため進入保留
  | 'crossing' // 滑走路横断の許可待ち
  | 'goAround' // 着陸復行
  | 'boarding'; // 搭乗手続きの完了待ち

export type DelayCause = 'inboundLate' | 'noStand' | 'runwayQueue' | 'taxiCongestion' | 'turnaround' | 'noRoute' | 'boarding';

export interface Route {
  kind: 'landing' | 'taxiIn' | 'pushback' | 'taxiOut' | 'takeoff';
  /** 経路上のノード（ネットワークのノードID） */
  nodes: string[];
  /** nodes[i] → nodes[i+1] のエッジ */
  edges: string[];
  /** 各ノードまでの累積距離（m） */
  cum: number[];
  /** 予約を解放済みのノード数（先頭から） */
  released: number;
  /** 滑走路の上を走る区間の終わり（着陸: 離脱ノード、離陸: 浮揚） のノード番号。無ければ -1 */
  runwayEnd: number;
}

export interface HistoryEntry {
  t: number;
  state: AircraftState;
  note?: string;
}

export interface Aircraft {
  id: string;
  typeId: AircraftTypeId;
  callsign: string;
  arrivalFlightId: string;
  departureFlightId: string;
  state: AircraftState;
  stateSince: number;
  runwayId: string | null;
  standId: string | null;
  route: Route | null;
  /** 経路上の位置（m） */
  dist: number;
  /** 速度（m/s） */
  speed: number;
  /** 表示位置（タイル番号空間）と機首方位（度、0 = 北）。前ティックの値は描画の補間用 */
  x: number;
  y: number;
  heading: number;
  px: number;
  py: number;
  pheading: number;
  holdReason: HoldReason | null;
  /** 現在の待機が始まった時刻 */
  waitSince: number | null;
  /** 滑走路端への到着予定（進入中） */
  eta: number | null;
  /** 地上作業・エンジン始動・整列の完了時刻 */
  timerUntil: number | null;
  /** 離陸待ちに入った時刻（出発キューの順序） */
  queuedSince: number | null;
  /** 次に経路や許可を再試行する時刻 */
  retryAt: number;
  /** 地上走行の開始時刻（統計用） */
  taxiStartedAt: number | null;
  /** 横断許可を得ている滑走路ノード（経路上の番号） */
  crossing: { index: number; runwayId: string } | null;
  history: HistoryEntry[];
}

export type FlightStatus = 'scheduled' | 'active' | 'completed' | 'diverted' | 'cancelled';

/** 便ごとの旅客の集計（旅客グループの状態から更新し、常に一致させる） */
export interface FlightPax {
  /** 出発便: 予約旅客数 / 到着便: 搭乗してきた旅客数 */
  booked: number;
  generated: boolean;
  /** 出発便 */
  boarded: number;
  missed: number;
  boarding: 'notStarted' | 'open' | 'closed';
  boardingOpenedAt: number | null;
  /** 搭乗締切 */
  deadline: number | null;
  gateId: string | null;
  /** 到着便 */
  deplaned: number;
  exited: number;
  deplaneRemaining: number;
  deplaneAcc: number;
  claimAreaId: string | null;
  bagsReadyAt: number | null;
}

export interface Flight {
  id: string;
  number: string;
  direction: 'arrival' | 'departure';
  aircraftId: string;
  /** 到着便: 着陸予定 / 出発便: 出発（プッシュバック）予定 */
  scheduled: number;
  /** 遅延を反映した予定 */
  estimated: number;
  /** 到着便: 着陸時刻 / 出発便: 離陸時刻 */
  actual: number | null;
  /** 到着便: ブロックイン / 出発便: ブロックアウト（プッシュバック開始） */
  block: number | null;
  status: FlightStatus;
  runwayId: string | null;
  standId: string | null;
  delayCauses: DelayCause[];
  pax: FlightPax;
}

// ---------------------------------------------------------------- 旅客

/**
 * 旅客グループの状態
 * 出発: toAirport → walking ⇄ queuing → inService → … → dwelling → boardingQueue → boarded
 * 到着: walking → waitingBaggage → inService(受取) → walking → exited
 * 異常: stranded（到達不能）/ waitingFacility（施設閉鎖で待機）/ missed（乗り遅れ）/ cancelled（欠航）
 */
export type PaxState =
  | 'toAirport'
  | 'walking'
  | 'queuing'
  | 'inService'
  | 'dwelling'
  | 'boardingQueue'
  | 'boarded'
  | 'waitingBaggage'
  | 'exited'
  | 'stranded'
  | 'waitingFacility'
  | 'missed'
  | 'cancelled';

export const PAX_FINAL_STATES: readonly PaxState[] = ['boarded', 'exited', 'missed', 'cancelled'];

export type PaxStep = 'checkIn' | 'security' | 'restroom' | 'gate' | 'claim' | 'exit';
export type MissReason = 'late' | 'unreachable' | 'facilityClosed' | 'noGate' | 'cancelled';

export interface PaxGroup {
  id: string;
  flightId: string;
  direction: 'departure' | 'arrival';
  terminalId: string | null;
  count: number;
  bags: number;
  state: PaxState;
  steps: PaxStep[];
  stepIndex: number;
  /** 現在いるエリア（歩行中は出発側のエリア）。空港到着前・搭乗後は null */
  area: string | null;
  /** これから通るエリア（先頭が次のエリア） */
  route: string[];
  /** 歩行中の区間の進み具合（m） */
  legProgress: number;
  legLength: number;
  /** 並んでいる / 処理中の施設キー（エリアID または gate:ゲートID） */
  facility: string | null;
  serviceUntil: number | null;
  appearAt: number;
  finishedAt: number | null;
  /** 保安検査を通過済み */
  securityCleared: boolean;
  boardedGate: string | null;
  /** 累計の待ち時間・歩行時間（秒） */
  waitSec: number;
  walkSec: number;
  reason: MissReason | null;
  retryAt: number;
}

export interface FacilityRuntime {
  queue: string[];
  inService: string[];
  /** 処理した旅客数・待ち時間の合計（人・秒）・最大待ち人数 */
  served: number;
  waitTotal: number;
  maxQueue: number;
}

export interface PaxStats {
  spawned: number;
  boarded: number;
  missed: number;
  deplaned: number;
  exited: number;
  /** 搭乗・退出した旅客の待ち時間・歩行時間の合計（人・秒） */
  waitTotal: number;
  walkTotal: number;
  finished: number;
}

export type RunwayMode = 'mixed' | 'arrivals' | 'departures' | 'closed';

export interface RunwayConfig {
  /** forward: 始点 → 終点の向きに離着陸 / reverse: その逆 */
  direction: 'forward' | 'reverse';
  mode: RunwayMode;
}

export interface RunwayOccupant {
  aircraftId: string;
  purpose: 'landing' | 'takeoff' | 'crossing';
  since: number;
}

export interface RunwayState {
  /** 滑走路を物理的に使用している機体（高々1機）。単一情報源 */
  occupant: RunwayOccupant | null;
  /** 最終進入中の到着機（高々1機）と滑走路端への到着予定 */
  booking: { aircraftId: string; eta: number } | null;
  /** 直前の運用（到着 = 接地時刻、出発 = 滑走開始時刻） */
  lastOp: { kind: 'arr' | 'dep'; size: 'S' | 'M' | 'L'; at: number } | null;
}

export type SimEventKind =
  | 'spawn'
  | 'state'
  | 'hold'
  | 'goAround'
  | 'diverted'
  | 'cannotOperate'
  | 'conflict'
  | 'scheduleGenerated'
  | 'boardingOpen'
  | 'boardingClosed'
  | 'paxMissed'
  | 'areaClosed'
  | 'areaOpened';

export interface SimEvent {
  t: number;
  kind: SimEventKind;
  aircraftId?: string;
  state?: AircraftState;
  reason?: HoldReason;
  note?: string;
}

export interface SimStats {
  arrivals: number;
  departures: number;
  diverted: number;
  cancelled: number;
  goArounds: number;
  conflicts: number;
  taxiInSecTotal: number;
  taxiOutSecTotal: number;
}

export interface SimSettings {
  /** 1日あたりの往復便数（到着+出発のペア数） */
  flightsPerDay: number;
  /** 到着便が遅れて来る確率と最大遅延（分） */
  inboundDelayProb: number;
  inboundDelayMaxMin: number;
  /** 日ごとのスケジュールを自動生成する */
  autoSchedule: boolean;
}

export interface SimState {
  version: 1;
  seed: string;
  now: number;
  rng: RngState;
  counters: Record<string, number>;
  settings: SimSettings;
  runwayConfig: Record<string, RunwayConfig>;
  runways: Record<string, RunwayState>;
  flights: Record<string, Flight>;
  aircraft: Record<string, Aircraft>;
  /** スポットID → 割り当て機体（単一情報源。1スポットに高々1機） */
  standAssignments: Record<string, string>;
  /** 予約: ネットワークのノード/エッジID → 機体ID（排他） */
  nodeReservations: Record<string, string>;
  edgeReservations: Record<string, string>;
  /** スケジュール生成済みの日 */
  scheduledDays: number[];
  events: SimEvent[];
  stats: SimStats;
  paxGroups: Record<string, PaxGroup>;
  /** 処理中（終了していない）のグループ ID（発行順） */
  activePax: string[];
  /** 便 → グループ ID（発行順） */
  flightPax: Record<string, string[]>;
  facilities: Record<string, FacilityRuntime>;
  /** 閉鎖中のターミナル内エリア（ID 順） */
  closedAreas: string[];
  /** 手荷物受取所のベルト使用予定 */
  claimBelts: Record<string, { flightId: string; until: number }[]>;
  paxStats: PaxStats;
}

export const EVENT_LOG_LIMIT = 1000;
