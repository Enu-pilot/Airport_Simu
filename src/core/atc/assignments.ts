import { sizeAtLeast } from '../model/types';
import { pushEvent } from './events';
import { diagnoseAtcAirport } from './scenario';
import type {
  AtcAircraft,
  AtcAirportSnapshot,
  AtcAssignmentKind,
  AtcAssignmentRequest,
  AtcMovement,
  AtcScenarioDefinition,
  AtcSessionState,
} from './types';
import { ATC_ASSIGNMENT_ROLE, ATC_CLEARANCE_ROLE } from './types';

/**
 * §3.4.1 シナリオ起点の要求自動生成（PO決定 2026-11-18）。
 *
 * - スポット割当（GROUND）・着陸RWY/離陸RWY（TOWER）の要求を、便予定から
 *   決定的IDで自動生成する。生成は冪等で、再評価・保存復元で重複しない。
 * - 自動生成するのは要求と候補・推奨まで。確定割当は管制官の選択・承認であり、
 *   割当そのものは管制許可（プッシュバック/走行/着陸/離陸）を意味しない。
 * - 候補がない場合は理由付きで未解決のまま残し、黙って別設備へ割り当てない。
 */

export function assignmentId(trafficEntryId: string, kind: AtcAssignmentKind): string {
  return `asg_${trafficEntryId}_${kind}`;
}

const KINDS_BY_FLIGHT: Record<'arrival' | 'departure', AtcAssignmentKind[]> = {
  arrival: ['standAssignment', 'landingRunway'],
  departure: ['takeoffRunway'],
};

/** セッション作成時に scheduled として全便分を生成する（冪等） */
export function generateScheduledAssignments(
  state: AtcSessionState,
  scenario: AtcScenarioDefinition,
): void {
  for (const entry of scenario.traffic) {
    for (const kind of KINDS_BY_FLIGHT[entry.kind]) {
      const id = assignmentId(entry.id, kind);
      if (state.assignments[id]) continue;
      state.assignments[id] = {
        id,
        trafficEntryId: entry.id,
        aircraftId: null,
        kind,
        role: ATC_ASSIGNMENT_ROLE[kind],
        status: 'scheduled',
        scheduledAtSec: entry.atSec,
        recommendedId: kind === 'standAssignment' ? entry.standId : entry.runwayId,
      };
    }
  }
}

/** 出現した航空機に割当要求を結び付け、scheduled -> open にする */
export function activateAssignmentsForAircraft(
  state: AtcSessionState,
  trafficEntryId: string,
  aircraftId: string,
): void {
  for (const assignment of Object.values(state.assignments)) {
    if (assignment.trafficEntryId !== trafficEntryId) continue;
    if (assignment.status !== 'scheduled') continue;
    assignment.aircraftId = aircraftId;
    assignment.status = 'open';
    pushEvent(state, {
      kind: 'request',
      aircraftId,
      message: `${assignment.id}: ${assignment.kind} requested (${assignment.role})`,
    });
  }
}

export function assignmentFor(
  state: AtcSessionState,
  trafficEntryId: string,
  kind: AtcAssignmentKind,
): AtcAssignmentRequest | undefined {
  return state.assignments[assignmentId(trafficEntryId, kind)];
}

export function isAssignmentResolved(
  state: AtcSessionState,
  trafficEntryId: string,
  kind: AtcAssignmentKind,
): boolean {
  const a = assignmentFor(state, trafficEntryId, kind);
  return a === undefined || a.status === 'assigned';
}

/** スポット候補: 運用中・接続あり・機体適合・他機に予約されていないもの（推奨を先頭に） */
export function candidateStands(
  state: AtcSessionState,
  airport: AtcAirportSnapshot,
  aircraftId: string,
): string[] {
  const aircraft = state.aircraft[aircraftId];
  if (!aircraft) return [];
  const diag = diagnoseAtcAirport(airport);
  const connected = new Set(diag.connectedStandIds);
  const candidates = Object.values(airport.layout.stands)
    .filter((s) => s.buildState === 'operational')
    .filter((s) => connected.has(s.id))
    .filter((s) => sizeAtLeast(s.size, aircraft.size))
    .filter((s) => {
      const holder = state.standReservations[s.id];
      return holder === undefined || holder === aircraftId;
    })
    .map((s) => s.id)
    .sort();
  const assignment = Object.values(state.assignments).find(
    (a) => a.aircraftId === aircraftId && a.kind === 'standAssignment',
  );
  const recommended = assignment?.recommendedId;
  if (recommended && candidates.includes(recommended)) {
    return [recommended, ...candidates.filter((id) => id !== recommended)];
  }
  return candidates;
}

/** 滑走路候補: 運用中のもの（推奨を先頭に） */
export function candidateRunways(
  state: AtcSessionState,
  airport: AtcAirportSnapshot,
  aircraftId: string,
): string[] {
  const aircraft = state.aircraft[aircraftId];
  if (!aircraft) return [];
  const candidates = Object.values(airport.layout.runways)
    .filter((r) => r.buildState === 'operational')
    .map((r) => r.id)
    .sort();
  const assignment = Object.values(state.assignments).find(
    (a) => a.aircraftId === aircraftId && (a.kind === 'landingRunway' || a.kind === 'takeoffRunway'),
  );
  const recommended = assignment?.recommendedId;
  if (recommended && candidates.includes(recommended)) {
    return [recommended, ...candidates.filter((id) => id !== recommended)];
  }
  return candidates;
}

export interface AssignResult {
  ok: boolean;
  reasons: string[];
}

/** スポット割当の確定（GROUND）。候補外・予約済みは拒否し、黙って代替しない */
export function assignStand(
  state: AtcSessionState,
  airport: AtcAirportSnapshot,
  assignmentIdValue: string,
  standId: string,
): AssignResult {
  const assignment = state.assignments[assignmentIdValue];
  if (!assignment) return { ok: false, reasons: ['assignment-not-found'] };
  if (assignment.kind !== 'standAssignment') return { ok: false, reasons: ['assignment-kind-mismatch'] };
  if (assignment.status !== 'open' || assignment.aircraftId === null) {
    return { ok: false, reasons: ['assignment-not-open'] };
  }
  const candidates = candidateStands(state, airport, assignment.aircraftId);
  if (candidates.length === 0) return { ok: false, reasons: ['no-candidate-stand'] };
  if (!candidates.includes(standId)) return { ok: false, reasons: ['stand-not-a-candidate'] };
  const aircraft = state.aircraft[assignment.aircraftId];
  assignment.status = 'assigned';
  assignment.assignedId = standId;
  if (aircraft) {
    aircraft.standId = standId;
    state.standReservations[standId] = aircraft.id;
    pushEvent(state, {
      kind: 'request',
      aircraftId: aircraft.id,
      message: `${aircraft.callsign}: stand assigned ${standId} (ground)`,
    });
  }
  return { ok: true, reasons: [] };
}

/** 滑走路割当の確定（TOWER）。着陸/離陸許可そのものではない */
export function assignRunway(
  state: AtcSessionState,
  airport: AtcAirportSnapshot,
  assignmentIdValue: string,
  runwayId: string,
): AssignResult {
  const assignment = state.assignments[assignmentIdValue];
  if (!assignment) return { ok: false, reasons: ['assignment-not-found'] };
  if (assignment.kind !== 'landingRunway' && assignment.kind !== 'takeoffRunway') {
    return { ok: false, reasons: ['assignment-kind-mismatch'] };
  }
  if (assignment.status !== 'open' || assignment.aircraftId === null) {
    return { ok: false, reasons: ['assignment-not-open'] };
  }
  const candidates = candidateRunways(state, airport, assignment.aircraftId);
  if (candidates.length === 0) return { ok: false, reasons: ['no-candidate-runway'] };
  if (!candidates.includes(runwayId)) return { ok: false, reasons: ['runway-not-a-candidate'] };
  const aircraft = state.aircraft[assignment.aircraftId];
  assignment.status = 'assigned';
  assignment.assignedId = runwayId;
  if (aircraft) {
    aircraft.runwayId = runwayId;
    pushEvent(state, {
      kind: 'request',
      aircraftId: aircraft.id,
      message: `${aircraft.callsign}: runway assigned ${runwayId} (tower)`,
    });
  }
  return { ok: true, reasons: [] };
}

/**
 * §3.4.1 横断要求の自動生成（GROUND）。
 * 地上走行の経路が確定した時点（移動の生成時・経路変更時）で、経路上の
 * 未承認の横断ゲートごとに runwayCrossing 要求を GROUND キューへ登録する。
 * 要求IDは内容から決定的に生成されるため、再評価・保存復元・経路変更の
 * 再スキャンで重複しない（冪等）。生成だけでは許可・移動は発生しない。
 * 戻り値は今回新規に生成した要求ID。
 */
export function ensureCrossingRequests(
  state: AtcSessionState,
  aircraft: AtcAircraft,
  movement: AtcMovement,
): string[] {
  const created: string[] = [];
  for (const crossing of movement.crossings ?? []) {
    if (crossing.status !== 'waiting') continue;
    if (state.requests[crossing.requestId]) continue;
    state.requests[crossing.requestId] = {
      id: crossing.requestId,
      aircraftId: aircraft.id,
      kind: 'runwayCrossing',
      createdAtSec: state.clockSec,
      status: 'open',
    };
    created.push(crossing.requestId);
    pushEvent(state, {
      kind: 'request',
      aircraftId: aircraft.id,
      message: `${aircraft.callsign}: request runwayCrossing ${crossing.runwayId} at ${crossing.holdNodeId} (ground)`,
    });
  }
  return created;
}

/**
 * 到着順序の対象になる機体（未完了で進入前/進入中）。
 * 着陸済み（landingRoll 以降）・完了済みの機体は順序から自動的に外れる
 * ＝「先行機が着陸で解消する」ことを表現する。
 */
function arrivalSequenceCandidates(state: AtcSessionState): AtcAircraft[] {
  return Object.values(state.aircraft).filter(
    (a) =>
      a.kind === 'arrival' &&
      a.completedAtSec === null &&
      (a.phase === 'inbound' || a.phase === 'finalApproach'),
  );
}

/**
 * 決定的な推奨到着順序（ATC-07 進入順序管理）。
 * 予定到着時刻順 ＝ シナリオ出現時刻（spawnedAtSec）順とし、同着は
 * 航空機ID順で安定させる。管制官が順序を設定する際の初期案であり、
 * この関数自体は状態を変更しない。
 */
export function recommendedArrivalSequence(state: AtcSessionState): string[] {
  return arrivalSequenceCandidates(state)
    .sort((a, b) => a.spawnedAtSec - b.spawnedAtSec || (a.id < b.id ? -1 : 1))
    .map((a) => a.id);
}

/**
 * 実効到着順序。管制官の設定（session.arrivalSequence）を正とし、
 * 対象外になった機体（着陸済み・完了等）は落とし、設定後に出現した
 * 未掲載の到着機は推奨順序で末尾へ追加する（決定的）。
 * 設定が空なら推奨順序そのものになるが、安全判定の順序制約は
 * 「設定がある場合だけ」効く（commands/safety 側の規則）。
 */
export function effectiveArrivalSequence(state: AtcSessionState): string[] {
  const candidates = recommendedArrivalSequence(state);
  const candidateSet = new Set(candidates);
  const explicit = (state.arrivalSequence ?? []).filter((id) => candidateSet.has(id));
  const listed = new Set(explicit);
  return [...explicit, ...candidates.filter((id) => !listed.has(id))];
}

/** 担当区分ごとの未処理要求（許可系＋割当系）。UIキューの基礎 */
export function openQueueByRole(
  state: AtcSessionState,
  role: 'ground' | 'tower',
): { assignments: AtcAssignmentRequest[]; requestIds: string[] } {
  const assignments = Object.values(state.assignments)
    .filter((a) => a.role === role && a.status === 'open')
    .sort((a, b) => a.scheduledAtSec - b.scheduledAtSec || (a.id < b.id ? -1 : 1));
  const requestIds = Object.values(state.requests)
    .filter((r) => r.status === 'open' && ATC_CLEARANCE_ROLE[r.kind] === role)
    .map((r) => r.id)
    .sort();
  return { assignments, requestIds };
}
