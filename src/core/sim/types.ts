import type { RngState } from '../rng';
import type { AircraftTypeId } from './aircraftTypes';
import type { SimEconomy } from '../economy/ops';
import type { AccessMode } from '../access/model';
import type { AccessRuntime } from '../access/runtime';
import type { AnalyticsState } from '../analytics/records';

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
  | 'intersection' // 交差する滑走路が使用中（従属運用）
  | 'goAround' // 着陸復行
  | 'boarding' // 搭乗手続きの完了待ち
  | 'groundCrew' // プッシュバックの車両・作業員待ち
  | 'weather' // 天候による欠航（天候 5 段階のモデルだけ。欠航の理由に使う）
  | 'noiseCurfew' // 都市の夜間騒音規制による運航待機
  | 'blockFull' // 前の区間が満杯（区間ごとに進む地上走行）
  | 'opposingTraffic' // 対向する機体の通過待ち（区間ごとに進む地上走行）
  | 'runwayQueue'; // 滑走路手前の待機列（区間ごとに進む地上走行）

export type DelayCause = 'inboundLate' | 'noStand' | 'runwayQueue' | 'taxiCongestion' | 'turnaround' | 'noRoute' | 'boarding' | 'groundHandling' | 'apronBus' | 'weather' | 'noiseRestriction' | 'technical';
export type ExternalDelayCause = 'inboundDelay' | 'weather' | 'airTraffic';

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
  /** alsoRunwayIds: 交差点ノードで横断するとき、同時に予約している交差する滑走路（交差点のときだけ書く） */
  crossing: CrossingGrant | null;
  /** 先に許可を得て、まだ尾部が抜けていない横断（crossing より前の滑走路ノード）。空なら書かない */
  heldCrossings?: CrossingGrant[];
  /** 運航者が指定したスポット（reassignStand, E-3）。割り当てたら消す */
  requestedStandId?: string;
  /** 折り返し作業のうち、この機体では生成しない作業（夜間滞泊の持ち越しは deplane/unload を省略する）。出発準備完了の判定で「未完了」ではなく「要求されていない作業」として扱う */
  skippedTasks?: TaskKind[];
  history: HistoryEntry[];
}

export interface CrossingGrant { index: number; runwayId: string; alsoRunwayIds?: string[] }

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
  /** ランプバスで搭乗・降機する便（バスゲートがあり、スポットがコンタクトでない便）だけが持つ。従来の便にはキーがない */
  bus?: { gateId: string | null; gateClosedAt: number | null; /** バスで運んだ旅客数と、その待ち時間の合計（人・秒。運行の作成からバスの出発まで） */ paxCarried: number; waitPaxSec: number };
  /** 明示したリモートスポットのバス接続設定が無効・未設定の場合の診断 */
  busFailure?: 'disabled' | 'unconfigured' | 'invalidGate';
  /** 到着便: 乗継として降機した人数（フェーズ 4） */
  transferOut?: number;
  /** 出発便: 乗継グループとして生成した人数（フェーズ 4） */
  transferIn?: number;
  /** 出発便: 到着便の欠航・未降機で来なかった乗継人数（フェーズ 4） */
  transferNoShow?: number;
  /** 乗継グループ専用の乱数の状態（フェーズ 4） */
  transferRng?: RngState;
}

export interface Flight {
  id: string;
  /** 夜間滞泊の便（フェーズ 4）: 出発便は翌日発・到着便は夜間滞泊 */
  overnight?: true;
  /** 持ち越しの記録から置き直した合成の到着便（フェーズ 4）。集計から除外する */
  carryOver?: true;
  /** 国際線の便（フェーズ 4） */
  routeType?: 'international';
  /** 拠点契約の所属機 ID */
  basedAircraftId?: string;
  /** 整備の不具合でプッシュバックを保留する時刻 */
  techHoldUntil?: number;
  /** 乗継の計画（到着便）: 出発便 ID への人数 */
  transferPlan?: { depFlightId: string; pax: number; kind: 'DD' | 'DI' | 'ID' | 'II' }[];
  /** 乗継で入ってくる予定人数（出発便） */
  plannedTransferIn?: number;
  /** 夜間制限で止めた便（フェーズ 2。値があるときだけ書く） */
  nightHold?: { kind: 'stand' | 'origin' | 'airborne'; decidedAt: number; releaseAt: number };
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
  /** 外部要因として実際に加えた遅延秒数（原因ラベルから推定しない）。古い保存では欠落する。 */
  externalDelaySec?: Partial<Record<ExternalDelayCause, number>>;
  pax: FlightPax;
  /** 出発便: 地上作業がすべて完了した時刻と、最後に完了した作業（遅延の主因） */
  readyAt: number | null;
  criticalTask: TaskKind | null;
  /** 運航計画（契約）の情報。手動・ランダム生成の便は契約なし */
  airlineId: string | null;
  contractId: string | null;
  destinationId: string | null;
  /** 計画上の旅客数（null なら搭乗率の既定範囲から決める） */
  plannedPax: number | null;
  /** 計画上のスポット（空いていれば優先して割り当てる） */
  plannedStandId: string | null;
  /** 地上作業を優先する（プレイヤーの「便の順序変更」） */
  priority?: boolean;
  /** 座席数（航空会社の座席構成。なければ機種の既定値） */
  seats?: number;
}

// ---------------------------------------------------------------- 地上支援

export type UnitKind = 'staff' | 'engineer' | 'tug' | 'beltLoader' | 'baggageTractor' | 'fuelTruck' | 'cateringTruck' | 'cleaningVan' | 'apronBus';
export type UnitStatus = 'idle' | 'enroute' | 'working' | 'returning' | 'broken';

/** 作業員・車両（1人・1台ずつ） */
export interface GroundUnit {
  id: string;
  kind: UnitKind;
  /** 所属する基地（GSE基地・整備施設） */
  baseId: string;
  status: UnitStatus;
  taskId: string | null;
  /** 表示位置（タイル番号空間）と移動の始点・終点・時刻 */
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  moveStart: number;
  moveEnd: number;
  repairUntil: number | null;
  /** 作業に割り当てられていた累計時間（稼働率用） */
  busySec: number;
  /** ランプバスが担当している運行の ID（バスだけ。欠落 = なし） */
  trip?: string;
}

export type TaskKind = 'deplane' | 'unload' | 'fuel' | 'clean' | 'cater' | 'inspect' | 'board' | 'load' | 'pushback';
export type TaskState = 'pending' | 'blocked' | 'dispatched' | 'inProgress' | 'done' | 'cancelled';
export type BlockReason =
  | 'dependency' // 先行作業の完了待ち
  | 'waitingTime' // 作業開始時刻待ち（積み込み・プッシュバック）
  | 'noStaff' // 作業員不足
  | 'noEngineer' // 整備士不足
  | 'noVehicle' // 車両不足
  | 'noFuelFarm' // 燃料施設なし
  | 'unitBroken' // 作業中の車両が故障
  | 'waitingPax' // 旅客の降機・搭乗待ち
  | 'waitingBags' // 手荷物の到着待ち
  | 'sorterDown'; // 仕分け設備の停止

export interface GroundTask {
  id: string;
  aircraftId: string;
  kind: TaskKind;
  state: TaskState;
  deps: TaskKind[];
  /** 必要な作業員・車両の数 */
  needs: Partial<Record<UnitKind, number>>;
  units: string[];
  /** 作業時間（秒）と進捗（秒）。旅客・手荷物の作業は内部の段階で進む */
  workSec: number;
  doneSec: number;
  createdAt: number;
  startedAt: number | null;
  doneAt: number | null;
  /** 現在の停止理由と、停止の累計時間 */
  blockedReason: BlockReason | null;
  blockedSince: number | null;
  blockedTotal: number;
  /** 手荷物作業の段階（loading: 積み下ろし中、transport: 搬送中）と終了時刻 */
  phase: 'idle' | 'working' | 'transport';
  phaseUntil: number | null;
  note: string | null;
}

export type BagState =
  // 出発
  | 'checkedIn' // 預け入れ（コンベヤーで仕分け場へ）
  | 'sorting' // 仕分け待ち・仕分け中
  | 'madeUp' // 便ごとに仕分け済み（積み込み待ち）
  | 'onCart' // 搬送中（牽引車のカート）
  | 'loaded' // 機内に積載
  | 'leftBehind' // 積み残し
  | 'offloaded' // 乗り遅れ旅客の手荷物を取り下ろし
  // 到着
  | 'onAircraft' // 到着機の貨物室
  | 'atClaim' // 受取所でベルト待ち
  | 'onBelt' // ベルト上
  | 'collected'; // 旅客が受け取り済み

export interface Bag {
  id: string;
  /** 所属する便（出発手荷物は出発便、到着手荷物は到着便） */
  flightId: string;
  /** 乗継手荷物: 付け替え先の出発便（フェーズ 4） */
  transferToFlightId?: string;
  /** 乗継手荷物: 付け替え元の到着便（フェーズ 4） */
  transferFromFlightId?: string;
  paxGroupId: string;
  direction: 'departure' | 'arrival';
  state: BagState;
  /** 所在（例: sorter:fac_3 / cart:gu_12 / aircraft:ac_4 / belt:ta_2） */
  location: string;
  since: number;
  /** 積載した機体（出発手荷物、1回だけ） */
  loadedOn: string | null;
  history: { t: number; state: BagState; location: string }[];
}

export interface EquipmentState {
  /** 停止中（故障）か、復旧予定時刻 */
  broken: boolean;
  repairUntil: number | null;
  /** 停止中の累計時間 */
  downSec: number;
}

export interface GroundStats {
  tasksDone: number;
  /** 停止理由ごとの累計停止時間（秒） */
  blockedSec: Partial<Record<BlockReason, number>>;
  /** 地上作業が原因で出発予定より準備完了が遅れた便数と遅れの合計（秒） */
  lateReadyFlights: number;
  lateReadySec: number;
  bagsLoaded: number;
  bagsLeftBehind: number;
  bagsOffloaded: number;
  bagsCollected: number;
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
  | 'waitingTransport'
  | 'waitingBus'
  | 'onBus'
  | 'missed'
  | 'cancelled';

export const PAX_FINAL_STATES: readonly PaxState[] = ['boarded', 'exited', 'missed', 'cancelled'];

export type PaxStep = 'checkIn' | 'security' | 'shop' | 'restroom' | 'gate' | 'claim' | 'exit' | 'emigration' | 'immigration' | 'customs' | 'transferSecurity';
export type MissReason = 'late' | 'unreachable' | 'facilityClosed' | 'noGate' | 'noBus' | 'cancelled';

export interface PaxGroup {
  id: string;
  flightId: string;
  direction: 'departure' | 'arrival';
  terminalId: string | null;
  /** Spot/gate change destination while the passenger is walking between terminals. */
  targetTerminalId?: string | null;
  /** 乗継グループ（フェーズ 4）: 乗継元の到着便と種類 */
  transfer?: { fromFlightId: string; kind: 'DD' | 'DI' | 'ID' | 'II' };
  /** 国際の審査の通過印（フェーズ 4） */
  ciq?: { emigration?: true; immigration?: true; customs?: true };
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
  /** グループ全員が階段を避ける必要がある簡略モデル */
  stepFree?: boolean;
  boardedGate: string | null;
  /** 累計の待ち時間・歩行時間（秒） */
  waitSec: number;
  walkSec: number;
  reason: MissReason | null;
  retryAt: number;
  /** 乗車待ち・乗車中のランプバスの運行（バス扱いの旅客だけ） */
  busTrip?: string;
  /** 空港アクセスの手段（アクセスを扱う運航のみ）と、到着時のアクセス処理を済ませたか */
  mode?: AccessMode | null;
  accessDone?: boolean;
  /** Active elevated/inter-terminal link; the group finishes this segment before rerouting after a gate change. */
  terminalLinkId?: string;
  terminalLinkReservedHour?: number;
  terminalLinkWaitingId?: string;
  /** Capacity already consumed in prior hourly windows while this indivisible group waits to enter a constrained link. */
  terminalLinkPaxAccumulated?: number;
  replanAfterTerminalLink?: boolean;
}

export interface TerminalTransitRuntime {
  /** Simulation-hour bucket used to enforce each link's finite passengers/hour capacity. */
  hour: number;
  passengersByLink: Record<string, number>;
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
  | 'areaOpened'
  | 'taskBlocked'
  | 'taskDone'
  | 'equipmentDown'
  | 'equipmentUp'
  | 'bagsLeftBehind'
  | 'finance'
  | 'busRescue'
  | 'standAssigned'
  | 'disruption';

export interface SimEvent {
  t: number;
  kind: SimEventKind;
  aircraftId?: string;
  airlineId?: string;
  standId?: string;
  standAssignmentReason?: 'initial' | 'home' | 'overflow' | 'fallback';
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
  /** 車両・仕分け設備・ベルトのランダム故障 */
  randomFailures: boolean;
  /** 天候・障害のランダム発生（sim/disruptions.ts） */
  randomDisruptions?: boolean;
  /** ランダムな障害の頻度の倍率（難易度。欠落 = 1）。会社の game があるときだけ設定する */
  randomDisruptionScale?: number;
}

export interface SimState {
  version: 1;
  /** 区間ごとに進む地上走行の状態（taxiMode 'block' のときだけ作る。フェーズ 2） */
  taxiBlocks?: {
    occ: Record<string, string[]>;
    locks: Record<string, { dir: 1 | -1; holders: string[] }>;
    oppWait?: Record<string, { acId: string; since: number }>;
    priority?: string;
    /** 優先を始めた時刻（規則 4） */
    priorityAt?: number;
    stats: { resolutions: number; reroutes: number; overruns: number; unresolved: number; nightStranded: number };
  };
  /** 兼用ゲートの現在の種類と切替の保留（フェーズ 4） */
  swingGates?: Record<string, { routeType: 'domestic' | 'international'; busyUntil: number }>;
  /** 乗継の集計（フェーズ 4） */
  hubStats?: { spawned: number; connected: number; missed: number; noShow: number; byLink: Record<string, number> };
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
  /** 日次の航空会社別ホームスポット。実際の占有は standAssignments が管理する。旧セーブでは未定義可。 */
  airlineStandHomes?: { day: number; byAirline: Record<string, string[]> };
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
  /** Per-link throughput reservations for the current simulation hour. */
  terminalTransit?: TerminalTransitRuntime;
  paxStats: PaxStats;
  units: Record<string, GroundUnit>;
  tasks: Record<string, GroundTask>;
  /** 機体 → 作業ID（生成順） */
  aircraftTasks: Record<string, string[]>;
  /** 処理中の作業（未完了）の ID（生成順） */
  activeTasks: string[];
  bags: Record<string, Bag>;
  /** 便 → 手荷物ID / 旅客グループ → 手荷物ID */
  flightBags: Record<string, string[]>;
  groupBags: Record<string, string[]>;
  /** 処理中の手荷物（終了状態でないもの）の ID */
  activeBags: string[];
  /** 仕分け設備・受取所ベルト・車両の故障状態（キー: 施設ID / `belt:エリアID` / 車両ID） */
  equipment: Record<string, EquipmentState>;
  /** 仕分け設備の処理の端数（個） */
  sorterAcc: Record<string, number>;
  groundStats: GroundStats;
  /** 経営の集計（会社と一緒に運航するときのみ） */
  economy: SimEconomy | null;
  /** 空港アクセス（会社と一緒に運航し、ターミナルがあるときのみ） */
  access: AccessRuntime | null;
  /** 天候・障害（sim/disruptions.ts） */
  weather: { kind: WeatherKind; since: number };
  disruptions: Disruption[];
  /** 障害・整備で使えない施設（ID 順）。新しい機体・旅客・作業を割り当てない */
  closures: { taxiways: string[]; stands: string[]; gates: string[] };
  /** 閉鎖要因の独立台帳。旧保存は closures から復元する */
  closureReasons?: import('./closureState').ClosureReasonMap;
  /** 分析用の運航記録（analytics/records.ts） */
  analytics: AnalyticsState;
  /** ランプバスの運行（バスゲートがある運航だけ。従来の運航にはキーがない） */
  bus?: ApronBusRuntime;
  /** 天候 5 段階（会社の game.weather === 'levels' の運航だけ。従来の運航にはキーがない。sim/weather.ts） */
  wx?: WxRuntime;
}

export type WxLevel = 0 | 1 | 2 | 3 | 4;
export type WxType = 'clear' | 'cloud' | 'rain' | 'snow' | 'fog' | 'storm';
export interface WxHour {
  level: WxLevel;
  type: WxType;
}

/** 天候 5 段階の運航状態。乱数は専用（`${state.seed}:wx`）で state.rng を消費しない */
export interface WxRuntime {
  /** 計画の暦の日と、その日の 24 時間分の計画 */
  day: number;
  hours: WxHour[];
  /** 現在の時間の計画の値 */
  level: WxLevel;
  type: WxType;
  /** 手動・シナリオの天候の障害による上書き（発生中の障害から毎ティック導く。なければ null） */
  override: { level: WxLevel; type: WxType; until: number } | null;
  rng: RngState;
}

/** ランプバスの運行の状態（sim/apronBus.ts） */
export interface ApronBusRuntime {
  /** ID `bt_n`（counters.bt） */
  trips: Record<string, BusTrip>;
  /** 未完了の運行（発行順） */
  active: string[];
  stats: { trips: number; pax: number; waitSec: number; shortageSec: number; rescues: number };
}

export type BusTripPhase = 'waiting' | 'toPickup' | 'loading' | 'driving' | 'unloading' | 'stalled' | 'done' | 'cancelled';

export interface BusTrip {
  id: string;
  /** dep: ゲート → スポット（出発旅客） / arr: スポット → ゲート（到着旅客） */
  dir: 'dep' | 'arr';
  flightId: string;
  gateId: string;
  standId: string;
  /** 配車されたバス（未配車・救援待ち = null） */
  busId: string | null;
  phase: BusTripPhase;
  phaseSince: number;
  phaseUntil: number | null;
  groups: string[];
  pax: number;
  createdAt: number;
  /** 故障したバスの位置（救援の合流点）と、乗り換え後に再開する段階 */
  stallAt?: { x: number; y: number };
  resume?: 'driving' | 'unloading';
}

export type WeatherKind = 'clear' | 'rain' | 'snow' | 'fog';

export type DisruptionKind =
  | 'weather' // 天候の変化
  | 'runwayClosed' // 滑走路の一時閉鎖
  | 'taxiwayClosed' // 誘導路の使用不能
  | 'standClosed' // 駐機スポットの使用不能
  | 'gateFailure' // 搭乗ゲートの故障
  | 'baggageFailure' // 手荷物設備（仕分け場・受取所ベルト）の故障
  | 'vehicleFailure' // 地上支援車両の故障
  | 'staffAbsence' // 作業員の欠勤
  | 'demandSurge' // 旅客需要の急増
  | 'inboundDelay' // 到着便の遅延
  | 'maintenance'; // 整備による施設の一時停止

export interface Disruption {
  id: string;
  kind: DisruptionKind;
  /** 対象（施設・ユニット・設備キー）。全体に及ぶもの（天候・需要・遅延）は null */
  targetId: string | null;
  weather?: WeatherKind;
  /** 量（欠勤人数・需要の倍率・遅延の分） */
  amount?: number;
  start: number;
  /** 復旧予定（null = プレイヤーが修理するまで） */
  end: number | null;
  status: 'scheduled' | 'active' | 'resolved';
  resolvedAt: number | null;
  resolvedBy: 'time' | 'player' | null;
  /** 開始時に影響を受けた作業・便・ユニット（原因の記録） */
  affected: { tasks: string[]; flights: string[]; units: string[] };
  /** 開始前の状態（滑走路の運用モードなど。復旧時に戻す） */
  prev?: string;
  /** 発生源（プレイヤーの設定・ランダム） */
  origin: 'manual' | 'random' | 'scenario';
}

export const EVENT_LOG_LIMIT = 1000;
