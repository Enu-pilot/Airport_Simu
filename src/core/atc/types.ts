import type { AirportLayout, SizeClass } from '../model/types';
import type { RngState } from '../rng';

/**
 * 管制官モード（ATC）の専用型。
 *
 * 独立境界（計画書 air_traffic_control_mode_plan.md §0/§3）:
 * - ATC は経営モードの CompanyState / ProjectFile / SimState / EditorState を
 *   一切参照しない。本モジュールが import してよいのは静的な空港レイアウト型と
 *   汎用乱数だけである。
 * - 経営モードとの受け渡しは AirportLayout の一回限りのスナップショットのみ。
 */

export const ATC_MODEL_VERSION = 'skyport-atc-0.1';
export const ATC_SAVE_FORMAT_VERSION = 1;
export const ATC_SESSION_FILE_KIND = 'skyport-atc-session';

/** 空港レイアウトの読み取り専用スナップショット（取り込み元の識別情報付き） */
export interface AtcAirportSnapshot {
  id: string;
  name: string;
  /** 取り込み元レイアウトの名前（表示・追跡用。ライブ同期はしない） */
  sourceLayoutName: string;
  /** 取り込み元レイアウトの schemaVersion */
  sourceSchemaVersion: number;
  /** 取り込み時刻（ISO文字列。シミュレーションの決定性には使わない） */
  capturedAtIso: string;
  layout: AirportLayout;
}

export type AtcFlightKind = 'arrival' | 'departure';

/** 管制の進行段階。物理移動（ATC-04/06）の接続までは管制手順上の段階として扱う */
export type AtcAircraftPhase =
  | 'inbound' // 到着: 進入要求中
  | 'finalApproach' // 到着: 着陸許可を受け進入中
  | 'landingRoll' // 到着: 接地・滑走中
  | 'taxiIn' // 到着: スポットへ走行中
  | 'atStand' // 出発: スポットで準備中／到着完了
  | 'pushback' // 出発: プッシュバック中
  | 'taxiOut' // 出発: 滑走路手前へ走行中
  | 'holdShort' // 出発: 滑走路手前で待機
  | 'lineUp' // 出発: 滑走路へ進入・整列中
  | 'takeoffRoll' // 出発: 離陸滑走中
  | 'departed' // 出発完了
  | 'arrived'; // 到着完了

export type AtcRequestKind =
  | 'landing'
  | 'taxiIn'
  | 'pushback'
  | 'taxiOut'
  | 'runwayCrossing'
  | 'lineUp'
  | 'takeoff';

export type AtcRequestStatus = 'open' | 'cleared' | 'rejected' | 'cancelled';

/** 管制の担当区分。GROUND/TOWER 両方を初期版必須とし、キューと権限を分ける（PO決定 2026-11-18） */
export type AtcControlRole = 'ground' | 'tower';

/** 許可系要求（指示が必要）の担当区分 */
export const ATC_CLEARANCE_ROLE: Record<AtcRequestKind, AtcControlRole> = {
  pushback: 'ground',
  taxiOut: 'ground',
  runwayCrossing: 'ground',
  taxiIn: 'ground',
  landing: 'tower',
  lineUp: 'tower',
  takeoff: 'tower',
};

/** 割当系要求（シナリオから自動生成され、管制官が候補を選んで確定する。許可ではない） */
export type AtcAssignmentKind = 'standAssignment' | 'landingRunway' | 'takeoffRunway';

export const ATC_ASSIGNMENT_ROLE: Record<AtcAssignmentKind, AtcControlRole> = {
  standAssignment: 'ground',
  landingRunway: 'tower',
  takeoffRunway: 'tower',
};

export type AtcAssignmentStatus = 'scheduled' | 'open' | 'assigned' | 'rejected' | 'cancelled';

export interface AtcAssignmentRequest {
  /** seed・便ID・種別から決定的に生成するID（再評価・再開で重複しない） */
  id: string;
  trafficEntryId: string;
  /** 出現前は null（scheduled の間は航空機がまだ存在しない） */
  aircraftId: string | null;
  kind: AtcAssignmentKind;
  role: AtcControlRole;
  status: AtcAssignmentStatus;
  /** requested になる時刻（便の出現時刻） */
  scheduledAtSec: number;
  /** 生成時点の推奨候補（先頭が推奨）。確定は管制官が行う */
  recommendedId?: string;
  assignedId?: string;
}

export interface AtcRequest {
  id: string;
  aircraftId: string;
  kind: AtcRequestKind;
  createdAtSec: number;
  status: AtcRequestStatus;
  /** cleared のときに発行された指示 */
  clearanceId?: string;
}

export type AtcClearanceStatus =
  | 'issued' // 発行済み（復唱待ち）
  | 'readback' // 復唱済み（実行開始待ち）
  | 'executing' // 実行中
  | 'completed' // 完了
  | 'cancelled' // 管制官が取消（未実行のみ）
  | 'expired'; // 有効期限切れ（未実行）

export interface AtcClearance {
  id: string;
  /** 発行連番（セッション内で単調増加。二重発行の検出に使う） */
  seq: number;
  aircraftId: string;
  requestId: string;
  kind: AtcRequestKind;
  runwayId?: string;
  issuedAtSec: number;
  expiresAtSec: number;
  status: AtcClearanceStatus;
  /** 定型復唱文（復唱時に記録） */
  readbackText?: string;
  /** 実行開始時刻（executing 遷移時） */
  executionStartedAtSec?: number;
}

/** 航空機の現在位置（ネットワークノード＋タイル座標。UI/安全判定の正本） */
export interface AtcAircraftPosition {
  /** 現在いる（最後に通過した）ネットワークノード */
  nodeId: string;
  /** タイル座標（小数あり。ノード間の補間位置） */
  x: number;
  y: number;
}

/**
 * 移動経路上の滑走路横断ゲート（ATC-06 横断要求の自動生成）。
 * 地上走行経路が滑走路の舗装面を横切る区間ごとに1つ作られる。
 * 機体は holdNodeId（滑走路手前のノード）で停止し、対応する
 * runwayCrossing 要求が管制官に承認されるまで滑走路へ進入しない。
 */
export interface AtcMovementCrossing {
  /** 決定的IDの横断要求（xng_<機体ID>_<移動種別>_<滑走路ID>_<停止ノードID>） */
  requestId: string;
  /** 横断対象の滑走路 */
  runwayId: string;
  /** 滑走路手前で停止するノード（横断区間の直前のノード） */
  holdNodeId: string;
  /** 経路累積距離（m）。この距離で停止する */
  stopAtM: number;
  status: 'waiting' | 'cleared';
  /** 承認時刻（cleared のとき） */
  clearedAtSec?: number;
}

/**
 * 実行中の物理移動（ATC-06/07 の基礎表現）。
 * 経路は airside ネットワーク上のノード列であり、占有はこの経路と
 * 現在位置から導出する。経営側 simulation の Route/予約とは別物。
 */
export interface AtcMovement {
  kind: AtcRequestKind;
  /** 移動経路のノード列（先頭 = 開始ノード、末尾 = 目的地ノード） */
  nodeIds: string[];
  /** 経路全長（m） */
  totalLengthM: number;
  /** 移動開始からの累積移動距離（m） */
  traveledM: number;
  /** 移動速度（m/s。実行所要時間と経路長から決定的に決まる） */
  speedMps: number;
  /** 経路上の滑走路横断ゲート（なければ空配列） */
  crossings?: AtcMovementCrossing[];
  /** 管制官の停止指示（hold）中。true の間は位置が進まない */
  held?: boolean;
}

/** 走行前に再計画された経路（経路変更コマンドが保存し、実行開始時に使われる） */
export interface AtcPlannedRoute {
  kind: AtcRequestKind;
  nodeIds: string[];
}

export interface AtcAircraft {
  id: string;
  /** シナリオ交通エントリのID（割当要求との対応付け） */
  trafficEntryId: string;
  callsign: string;
  /** 機種カタログの ID（表示ラベルとして保持し、静的寸法はカタログ側を正とする） */
  aircraftTypeId: string;
  size: SizeClass;
  kind: AtcFlightKind;
  phase: AtcAircraftPhase;
  runwayId: string;
  standId: string;
  /** セッション内に出現した時刻 */
  spawnedAtSec: number;
  /** 出発機が出発準備完了になる時刻（到着機は spawnedAtSec と同じ） */
  readyAtSec: number;
  /** 現在の待機が始まった時刻（待機中でなければ null） */
  waitingSinceSec: number | null;
  /** 次の要求を出してよい時刻（却下後の再要求間隔など） */
  nextRequestAtSec: number;
  activeRequestId: string | null;
  activeClearanceId: string | null;
  /** 現在位置。到着機が着陸実行を開始するまでは null（上空） */
  position: AtcAircraftPosition | null;
  /** 実行中の物理移動。移動していなければ null */
  movement: AtcMovement | null;
  /** 経路変更で走行前に差し替えられた経路。実行開始時に消費される */
  plannedRoute?: AtcPlannedRoute | null;
  /** 復行した回数（到着機のみ意味を持つ。決定的再進入の監査用） */
  goAroundCount: number;
  completedAtSec: number | null;
  /** 累積待機秒（スコア用） */
  totalWaitSec: number;
}

export type AtcEventKind =
  | 'spawn'
  | 'request'
  | 'clearanceIssued'
  | 'clearanceRejected'
  | 'readback'
  | 'executionStarted'
  | 'phaseChanged'
  | 'clearanceCompleted'
  | 'clearanceCancelled'
  | 'clearanceExpired'
  | 'requestRejected'
  | 'safetyWarning'
  | 'holdStarted'
  | 'holdReleased'
  | 'rerouted'
  | 'goAround'
  | 'sequenceChanged'
  | 'completed';

export interface AtcEvent {
  id: string;
  atSec: number;
  kind: AtcEventKind;
  aircraftId?: string;
  clearanceId?: string;
  message: string;
}

export interface AtcScore {
  arrivalsHandled: number;
  departuresHandled: number;
  clearancesIssued: number;
  clearancesExpired: number;
  requestsRejected: number;
  /** 安全判定で拒否した指示の件数（ハード制約。スコアと相殺しない） */
  safetyDenials: number;
  totalWaitSec: number;
}

/** シナリオ内の交通エントリ（経営モードの契約便・便計画とは無関係） */
export interface AtcTrafficEntry {
  id: string;
  callsign: string;
  aircraftTypeId: string;
  size: SizeClass;
  kind: AtcFlightKind;
  runwayId: string;
  standId: string;
  /** 出現時刻（セッション開始からの秒） */
  atSec: number;
  /** 出発機の準備完了までの秒（出現からの相対。省略 = 0） */
  readyDelaySec?: number;
}

export interface AtcScenarioDefinition {
  id: string;
  name: string;
  airport: AtcAirportSnapshot;
  /** シナリオの制限時間（秒）。0 = 無制限 */
  durationSec: number;
  seed: string;
  traffic: AtcTrafficEntry[];
}

export interface AtcSessionState {
  modelVersion: string;
  scenarioId: string;
  clockSec: number;
  /** ATC専用乱数ストリームの状態（経営側 RNG とは共有しない） */
  rngState: RngState;
  nextClearanceSeq: number;
  nextEventSeq: number;
  nextRequestSeq: number;
  aircraft: Record<string, AtcAircraft>;
  requests: Record<string, AtcRequest>;
  /** シナリオから自動生成される割当要求（スポット/滑走路） */
  assignments: Record<string, AtcAssignmentRequest>;
  /** スポット予約（standId -> aircraftId）。二重割当を防ぐ正本 */
  standReservations: Record<string, string>;
  /**
   * 管制官が設定した到着順序（航空機IDの列。先頭が先行）。
   * 空配列 = 未指定（従来どおり順序制約なし）。実効順序の導出は
   * assignments.effectiveArrivalSequence を正とする。
   */
  arrivalSequence: string[];
  clearances: Record<string, AtcClearance>;
  events: AtcEvent[];
  score: AtcScore;
  finished: boolean;
}

/** 安全判定の理由コード（UI はコードから表示文を作る） */
export type AtcSafetyReasonCode =
  | 'runway-not-found'
  | 'runway-not-operational'
  | 'runway-occupied'
  | 'runway-reserved'
  | 'stand-not-found'
  | 'stand-not-operational'
  | 'stand-not-connected'
  | 'arrival-inbound-same-runway'
  | 'arrival-sequence-blocked';

export interface AtcSafetyVerdict {
  verdict: 'allow' | 'warn' | 'deny';
  reasons: AtcSafetyReasonCode[];
}

/**
 * 物理安全判定の接続口（ポート）。
 * ATC-04（共通物理カーネル抽出）が完了するまでは safety.ts の
 * セッション内判定が既定実装。抽出後は経営側と共有する純粋関数を
 * このインターフェース越しに差し替える。ATC から simulation.ts を
 * 直接呼ばないための境界であり、二重実装を避ける差し替え点である。
 */
export interface AtcSafetyProvider {
  check(input: {
    session: AtcSessionState;
    airport: AtcAirportSnapshot;
    aircraft: AtcAircraft;
    kind: AtcRequestKind;
    runwayId?: string;
  }): AtcSafetyVerdict;
}
