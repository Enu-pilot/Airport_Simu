import { effectiveArrivalSequence, openQueueByRole } from '../core/atc/assignments';
import type {
  AtcAircraft,
  AtcAircraftPhase,
  AtcAssignmentKind,
  AtcAssignmentRequest,
  AtcControlRole,
  AtcRequest,
  AtcRequestKind,
  AtcSessionState,
} from '../core/atc/types';

/**
 * ATC-08: UI 表示用の純粋導出（読み取り専用）。
 * コア状態を変更せず、キュー・待機時間・順序・選択詳細を画面表示用に整える。
 * 単体テスト対象として store / React から切り離して置く。
 */

export const REQUEST_KIND_LABEL: Record<AtcRequestKind, string> = {
  landing: '着陸',
  taxiIn: 'スポットへの走行',
  pushback: 'プッシュバック',
  taxiOut: '滑走路への走行',
  runwayCrossing: '滑走路横断',
  lineUp: '滑走路進入・整列',
  takeoff: '離陸',
};

export const ASSIGNMENT_KIND_LABEL: Record<AtcAssignmentKind, string> = {
  standAssignment: 'スポット割当',
  landingRunway: '着陸滑走路割当',
  takeoffRunway: '離陸滑走路割当',
};

export const PHASE_LABEL: Record<AtcAircraftPhase, string> = {
  inbound: '進入要求中',
  finalApproach: '最終進入中',
  landingRoll: '着陸滑走中',
  taxiIn: 'スポットへ走行中',
  atStand: 'スポットで準備中',
  pushback: 'プッシュバック中',
  taxiOut: '滑走路へ走行中',
  holdShort: '滑走路手前で待機',
  lineUp: '滑走路で整列中',
  takeoffRoll: '離陸滑走中',
  departed: '出発完了',
  arrived: '到着完了',
};

export const ROLE_LABEL: Record<AtcControlRole, string> = {
  ground: 'GROUND（地上管制）',
  tower: 'TOWER（飛行場管制）',
};

/** セッション時計の表示（HH:MM:SS） */
export function formatAtcClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}

/** 待機時間などの短い表示（例: 1:05 / 12:30 / 45秒） */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}秒`;
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm < 60) return `${mm}:${String(ss).padStart(2, '0')}`;
  return `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** 現在の待機が続いている秒数（待機中でなければ 0） */
export function aircraftCurrentWaitSec(session: AtcSessionState, aircraft: AtcAircraft): number {
  if (aircraft.completedAtSec !== null) return 0;
  if (aircraft.waitingSinceSec === null) return 0;
  return Math.max(0, session.clockSec - aircraft.waitingSinceSec);
}

export interface AtcQueue {
  assignments: AtcAssignmentRequest[];
  requests: AtcRequest[];
}

/** 担当区分ごとの未処理キュー（割当は予定時刻順、要求は発生時刻順） */
export function queueForRole(session: AtcSessionState, role: AtcControlRole): AtcQueue {
  const { assignments, requestIds } = openQueueByRole(session, role);
  const requests = requestIds
    .map((id) => session.requests[id])
    .filter((r): r is AtcRequest => r !== undefined)
    .sort((a, b) => a.createdAtSec - b.createdAtSec || (a.id < b.id ? -1 : 1));
  return { assignments, requests };
}

/** 未処理件数（GROUND/TOWER 合計。バッジ表示用） */
export function openQueueCounts(session: AtcSessionState): Record<AtcControlRole, number> {
  const g = queueForRole(session, 'ground');
  const t = queueForRole(session, 'tower');
  return {
    ground: g.assignments.length + g.requests.length,
    tower: t.assignments.length + t.requests.length,
  };
}

/** 出現済み航空機の一覧（出現時刻順、同着は ID 順） */
export function aircraftList(session: AtcSessionState): AtcAircraft[] {
  return Object.values(session.aircraft).sort(
    (a, b) => a.spawnedAtSec - b.spawnedAtSec || (a.id < b.id ? -1 : 1),
  );
}

/** 指定航空機の未確定の割当要求（open のもの） */
export function openAssignmentsForAircraft(
  session: AtcSessionState,
  aircraftId: string,
): AtcAssignmentRequest[] {
  return Object.values(session.assignments)
    .filter((a) => a.aircraftId === aircraftId && a.status === 'open')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** 実効到着順序に並んだ到着機（順序パネル表示用） */
export function arrivalSequenceEntries(session: AtcSessionState): AtcAircraft[] {
  return effectiveArrivalSequence(session)
    .map((id) => session.aircraft[id])
    .filter((a): a is AtcAircraft => a !== undefined);
}

/**
 * 復行が可能な状態か（commands.goAroundAircraft の受理条件の読み取り専用ミラー）。
 * 進入開始前の到着機・地上機・出発機・完了機には復行指示を出せない。
 */
export function canGoAround(session: AtcSessionState, aircraftId: string): boolean {
  const aircraft = session.aircraft[aircraftId];
  if (!aircraft) return false;
  if (aircraft.kind !== 'arrival' || aircraft.completedAtSec !== null) return false;
  if (aircraft.phase === 'finalApproach') return true;
  const clearance = aircraft.activeClearanceId
    ? session.clearances[aircraft.activeClearanceId]
    : undefined;
  return (
    clearance !== undefined &&
    clearance.kind === 'landing' &&
    (clearance.status === 'issued' ||
      clearance.status === 'readback' ||
      clearance.status === 'executing')
  );
}

/** 停止指示が出せるか（移動中で地上走行系のとき。commands.holdAircraft の事前表示用） */
export function canHold(session: AtcSessionState, aircraftId: string): boolean {
  const aircraft = session.aircraft[aircraftId];
  if (!aircraft?.movement || aircraft.movement.held) return false;
  return ['pushback', 'taxiIn', 'taxiOut'].includes(aircraft.movement.kind);
}

/** 再開指示が出せるか（停止中のとき） */
export function canResume(session: AtcSessionState, aircraftId: string): boolean {
  const aircraft = session.aircraft[aircraftId];
  return aircraft?.movement?.held === true;
}
