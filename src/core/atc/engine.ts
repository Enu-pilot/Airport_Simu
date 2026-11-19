import type { AirsideNetwork } from '../airside/network';
import { Rng } from '../rng';
import {
  advanceMovement,
  createMovement,
  finishMovement,
  getAtcNetwork,
  isMovementBlocked,
  nodePosition,
  positionAlongRoute,
  standNodeId,
} from './movement';
import {
  activateAssignmentsForAircraft,
  ensureCrossingRequests,
  generateScheduledAssignments,
  isAssignmentResolved,
} from './assignments';
import { pushEvent } from './events';
import { diagnoseAtcAirport } from './scenario';
import type {
  AtcAircraftPhase,
  AtcRequestKind,
  AtcScenarioDefinition,
  AtcSessionState,
} from './types';
import { ATC_MODEL_VERSION } from './types';

/**
 * ATC-02/05/06/07 の基盤エンジン。
 * ATC専用時計（1秒サブステップ）で進み、経営モードの時計・日次締めとは無関係。
 * 許可が必要な段階遷移は、対応する指示が発行・復唱・実行されるまで開始しない。
 * 物理移動の詳細（経路・区間占有）は ATC-04/06 で共通カーネルへ接続する。
 * 現段階の所要時間は根拠を明示したゲーム値（固定）であり、実測値ではない。
 */

export const READBACK_DELAY_SEC = 5;

export const ATC_STEP_DURATION_SEC: Record<AtcRequestKind, number> = {
  pushback: 60,
  taxiOut: 120,
  lineUp: 30,
  takeoff: 45,
  landing: 90,
  taxiIn: 120,
  runwayCrossing: 30,
};

/** 実行開始時に遷移する段階（なければ開始では変わらない） */
const PHASE_ON_EXECUTION_START: Partial<Record<AtcRequestKind, AtcAircraftPhase>> = {
  landing: 'finalApproach',
  takeoff: 'takeoffRoll',
  taxiIn: 'taxiIn',
};

/** 実行完了時に遷移する段階 */
const PHASE_ON_COMPLETION: Record<AtcRequestKind, AtcAircraftPhase> = {
  pushback: 'pushback',
  taxiOut: 'holdShort',
  lineUp: 'lineUp',
  takeoff: 'departed',
  landing: 'landingRoll',
  taxiIn: 'arrived',
  runwayCrossing: 'holdShort',
};

function nextRequestKind(
  state: AtcSessionState,
  aircraft: { kind: string; phase: AtcAircraftPhase; trafficEntryId: string },
): AtcRequestKind | null {
  // 割当（スポット/滑走路）が未確定の間は、対応する許可要求を出さない（§3.4.1）
  if (aircraft.kind === 'arrival') {
    if (aircraft.phase === 'inbound') {
      return isAssignmentResolved(state, aircraft.trafficEntryId, 'landingRunway') ? 'landing' : null;
    }
    if (aircraft.phase === 'landingRoll') {
      return isAssignmentResolved(state, aircraft.trafficEntryId, 'standAssignment') ? 'taxiIn' : null;
    }
    return null;
  }
  switch (aircraft.phase) {
    case 'atStand':
      return 'pushback';
    case 'pushback':
      return 'taxiOut';
    case 'holdShort':
      return isAssignmentResolved(state, aircraft.trafficEntryId, 'takeoffRunway') ? 'lineUp' : null;
    case 'lineUp':
      return 'takeoff';
    default:
      return null;
  }
}

export function createAtcSession(scenario: AtcScenarioDefinition): AtcSessionState {
  const diagnostics = diagnoseAtcAirport(scenario.airport);
  if (diagnostics.errors.length > 0) {
    throw new Error(`atc-airport-not-usable: ${diagnostics.errors.join(', ')}`);
  }
  for (const entry of scenario.traffic) {
    if (!scenario.airport.layout.runways[entry.runwayId]) {
      throw new Error(`atc-traffic-runway-not-found: ${entry.id}`);
    }
    if (!scenario.airport.layout.stands[entry.standId]) {
      throw new Error(`atc-traffic-stand-not-found: ${entry.id}`);
    }
  }
  const session: AtcSessionState = {
    modelVersion: ATC_MODEL_VERSION,
    scenarioId: scenario.id,
    clockSec: 0,
    rngState: new Rng(`atc:${scenario.seed}`).state(),
    nextClearanceSeq: 1,
    nextEventSeq: 1,
    nextRequestSeq: 1,
    aircraft: {},
    requests: {},
    assignments: {},
    standReservations: {},
    arrivalSequence: [],
    clearances: {},
    events: [],
    score: {
      arrivalsHandled: 0,
      departuresHandled: 0,
      clearancesIssued: 0,
      clearancesExpired: 0,
      requestsRejected: 0,
      safetyDenials: 0,
      totalWaitSec: 0,
    },
    finished: false,
  };
  generateScheduledAssignments(session, scenario);
  return session;
}

function spawnDue(
  state: AtcSessionState,
  scenario: AtcScenarioDefinition,
  network: AirsideNetwork,
): void {
  const due = scenario.traffic
    .filter((e) => e.atSec <= state.clockSec && state.aircraft[`ac_${e.id}`] === undefined)
    .sort((a, b) => a.atSec - b.atSec || (a.id < b.id ? -1 : 1));
  for (const entry of due) {
    const id = `ac_${entry.id}`;
    state.aircraft[id] = {
      id,
      trafficEntryId: entry.id,
      callsign: entry.callsign,
      aircraftTypeId: entry.aircraftTypeId,
      size: entry.size,
      kind: entry.kind,
      phase: entry.kind === 'arrival' ? 'inbound' : 'atStand',
      runwayId: entry.runwayId,
      standId: entry.standId,
      spawnedAtSec: state.clockSec,
      readyAtSec:
        entry.kind === 'departure' ? state.clockSec + (entry.readyDelaySec ?? 0) : state.clockSec,
      waitingSinceSec: null,
      nextRequestAtSec: state.clockSec,
      activeRequestId: null,
      activeClearanceId: null,
      position:
        entry.kind === 'departure' ? nodePosition(network, standNodeId(entry.standId)) : null,
      movement: null,
      plannedRoute: null,
      goAroundCount: 0,
      completedAtSec: null,
      totalWaitSec: 0,
    };
    if (entry.kind === 'departure') {
      // 出発機はシナリオ開始時にスポット駐機済みとして予約する
      state.standReservations[entry.standId] = id;
    }
    activateAssignmentsForAircraft(state, entry.id, id);
    pushEvent(state, {
      kind: 'spawn',
      aircraftId: id,
      message: `${entry.callsign}: ${entry.kind} appeared`,
    });
  }
}

function generateRequests(state: AtcSessionState): void {
  for (const aircraft of Object.values(state.aircraft).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (aircraft.completedAtSec !== null) continue;
    if (aircraft.activeRequestId !== null || aircraft.activeClearanceId !== null) continue;
    if (state.clockSec < aircraft.nextRequestAtSec) continue;
    if (aircraft.kind === 'departure' && aircraft.phase === 'atStand' && state.clockSec < aircraft.readyAtSec) {
      continue;
    }
    const kind = nextRequestKind(state, aircraft);
    if (kind === null) continue;
    const seq = state.nextRequestSeq;
    state.nextRequestSeq += 1;
    const request = {
      id: `req_${seq}`,
      aircraftId: aircraft.id,
      kind,
      createdAtSec: state.clockSec,
      status: 'open' as const,
    };
    state.requests[request.id] = request;
    aircraft.activeRequestId = request.id;
    if (aircraft.waitingSinceSec === null) aircraft.waitingSinceSec = state.clockSec;
    pushEvent(state, {
      kind: 'request',
      aircraftId: aircraft.id,
      message: `${aircraft.callsign}: request ${kind}`,
    });
  }
}

function stepClearances(
  state: AtcSessionState,
  network: AirsideNetwork,
  revalidate?: {
    safety: import('./types').AtcSafetyProvider;
    airport: import('./types').AtcAirportSnapshot;
  },
): void {
  const ordered = Object.values(state.clearances).sort((a, b) => a.seq - b.seq);
  for (const clearance of ordered) {
    const aircraft = state.aircraft[clearance.aircraftId];
    if (!aircraft) continue;
    if (clearance.status === 'issued' || clearance.status === 'readback') {
      if (state.clockSec > clearance.expiresAtSec) {
        clearance.status = 'expired';
        state.score.clearancesExpired += 1;
        if (aircraft.activeClearanceId === clearance.id) aircraft.activeClearanceId = null;
        const request = state.requests[clearance.requestId];
        if (request && request.status === 'cleared') {
          request.status = 'open';
          request.clearanceId = undefined;
          aircraft.activeRequestId = request.id;
          if (aircraft.waitingSinceSec === null) aircraft.waitingSinceSec = state.clockSec;
        }
        pushEvent(state, {
          kind: 'clearanceExpired',
          aircraftId: aircraft.id,
          clearanceId: clearance.id,
          message: `${aircraft.callsign}: clearance ${clearance.id} expired`,
        });
        continue;
      }
    }
    if (clearance.status === 'issued' && state.clockSec >= clearance.issuedAtSec + READBACK_DELAY_SEC) {
      clearance.status = 'readback';
      clearance.readbackText = `${aircraft.callsign}, cleared ${clearance.kind}, ${clearance.id}`;
      pushEvent(state, {
        kind: 'readback',
        aircraftId: aircraft.id,
        clearanceId: clearance.id,
        message: clearance.readbackText,
      });
      continue;
    }
    if (clearance.status === 'readback') {
      // 実行直前の再検証（計画 §3.5）。発行後に状況が変わっていたら失効させる
      if (revalidate) {
        const verdict = revalidate.safety.check({
          session: state,
          airport: revalidate.airport,
          aircraft,
          kind: clearance.kind,
          runwayId: clearance.runwayId,
        });
        if (verdict.verdict === 'deny') {
          clearance.status = 'expired';
          if (aircraft.activeClearanceId === clearance.id) aircraft.activeClearanceId = null;
          const request = state.requests[clearance.requestId];
          if (request && request.status === 'cleared') {
            request.status = 'open';
            request.clearanceId = undefined;
            aircraft.activeRequestId = request.id;
            if (aircraft.waitingSinceSec === null) aircraft.waitingSinceSec = state.clockSec;
          }
          pushEvent(state, {
            kind: 'safetyWarning',
            aircraftId: aircraft.id,
            clearanceId: clearance.id,
            message: `${aircraft.callsign}: clearance ${clearance.id} revoked before execution (${verdict.reasons.join(', ')})`,
          });
          continue;
        }
      }
      clearance.status = 'executing';
      clearance.executionStartedAtSec = state.clockSec;
      aircraft.waitingSinceSec = null;
      // 物理移動の開始（ATC-06/07 基礎）: 実行開始時にだけ経路を計画し、
      // 許可のない機体には移動を作らない。経路が取れない場合は時間のみの
      // 実行にフォールバックし、警告を残す（黙って瞬間移動はしない）。
      const movement = createMovement(
        network,
        aircraft,
        clearance.kind,
        ATC_STEP_DURATION_SEC[clearance.kind],
      );
      // 経路変更で保存された経路はこの実行で消費する
      aircraft.plannedRoute = null;
      if (movement) {
        aircraft.movement = movement;
        const startPos = positionAlongRoute(network, movement, 0);
        if (startPos) aircraft.position = startPos;
        // §3.4.1: 経路上の滑走路横断要求を GROUND キューへ自動生成する
        ensureCrossingRequests(state, aircraft, movement);
      } else if (clearance.kind !== 'runwayCrossing') {
        pushEvent(state, {
          kind: 'safetyWarning',
          aircraftId: aircraft.id,
          clearanceId: clearance.id,
          message: `${aircraft.callsign}: no route for ${clearance.kind}; timed movement only`,
        });
      }
      const startPhase = PHASE_ON_EXECUTION_START[clearance.kind];
      if (startPhase) {
        aircraft.phase = startPhase;
        pushEvent(state, {
          kind: 'phaseChanged',
          aircraftId: aircraft.id,
          clearanceId: clearance.id,
          message: `${aircraft.callsign}: phase ${startPhase}`,
        });
      }
      pushEvent(state, {
        kind: 'executionStarted',
        aircraftId: aircraft.id,
        clearanceId: clearance.id,
        message: `${aircraft.callsign}: executing ${clearance.kind}`,
      });
      continue;
    }
    if (clearance.status === 'executing' && clearance.executionStartedAtSec !== undefined) {
      const durationElapsed =
        state.clockSec >= clearance.executionStartedAtSec + ATC_STEP_DURATION_SEC[clearance.kind];
      // 完了判定: 移動がある場合は「目的地へ到達したか」で決める。
      // 停止指示・未承認の横断ゲートで止まっている間は、所要時間を過ぎても
      // 完了させない（機体はまだ目的地に着いていない）。移動がない
      // （経路が取れなかった）場合は従来どおり時間のみで完了する。
      let complete: boolean;
      if (aircraft.movement) {
        const done = advanceMovement(network, aircraft, 1);
        const nearDone = aircraft.movement.totalLengthM - aircraft.movement.traveledM < 1e-6;
        complete = done || (durationElapsed && nearDone && !isMovementBlocked(aircraft.movement));
      } else {
        complete = durationElapsed;
      }
      if (complete) {
        finishMovement(network, aircraft);
        clearance.status = 'completed';
        if (aircraft.activeClearanceId === clearance.id) aircraft.activeClearanceId = null;
        if (aircraft.activeRequestId === clearance.requestId) aircraft.activeRequestId = null;
        const next = PHASE_ON_COMPLETION[clearance.kind];
        aircraft.phase = next;
        if (clearance.kind === 'pushback' && state.standReservations[aircraft.standId] === aircraft.id) {
          delete state.standReservations[aircraft.standId];
        }
        pushEvent(state, {
          kind: 'clearanceCompleted',
          aircraftId: aircraft.id,
          clearanceId: clearance.id,
          message: `${aircraft.callsign}: completed ${clearance.kind}`,
        });
        if (next === 'departed' || next === 'arrived') {
          aircraft.completedAtSec = state.clockSec;
          if (aircraft.kind === 'departure') state.score.departuresHandled += 1;
          else state.score.arrivalsHandled += 1;
          pushEvent(state, {
            kind: 'completed',
            aircraftId: aircraft.id,
            message: `${aircraft.callsign}: ${next}`,
          });
        }
      }
    }
  }
}

function accumulateWait(state: AtcSessionState): void {
  for (const aircraft of Object.values(state.aircraft)) {
    if (aircraft.completedAtSec !== null) continue;
    const clearance = aircraft.activeClearanceId
      ? state.clearances[aircraft.activeClearanceId]
      : undefined;
    // 実行中でも、停止指示・横断ゲートで止まっている間は待機として数える
    if (
      clearance &&
      clearance.status === 'executing' &&
      !(aircraft.movement && isMovementBlocked(aircraft.movement))
    ) {
      continue;
    }
    aircraft.totalWaitSec += 1;
    state.score.totalWaitSec += 1;
  }
}

/** 1秒サブステップで dtSec 進める。同じ入力列では常に同じ結果になる */
export function tickAtcSession(
  state: AtcSessionState,
  scenario: AtcScenarioDefinition,
  dtSec: number,
  opts?: {
    safety: import('./types').AtcSafetyProvider;
    airport: import('./types').AtcAirportSnapshot;
  },
): void {
  if (!Number.isInteger(dtSec) || dtSec < 0) throw new Error('atc-dt-must-be-nonnegative-integer');
  const network = getAtcNetwork(scenario.airport);
  for (let i = 0; i < dtSec; i++) {
    if (state.finished) return;
    state.clockSec += 1;
    spawnDue(state, scenario, network);
    generateRequests(state);
    stepClearances(state, network, opts);
    accumulateWait(state);
    const allSpawned = scenario.traffic.every((e) => state.aircraft[`ac_${e.id}`] !== undefined);
    const allCompleted =
      allSpawned &&
      Object.values(state.aircraft).every((a) => a.completedAtSec !== null) &&
      scenario.traffic.length > 0;
    if (allCompleted) state.finished = true;
    if (scenario.durationSec > 0 && state.clockSec >= scenario.durationSec) state.finished = true;
  }
}

/** 決定性・保存復元比較用の安定ダイジェスト */
export function atcSessionDigest(state: AtcSessionState): string {
  const canonical = JSON.stringify({
    clockSec: state.clockSec,
    aircraft: Object.values(state.aircraft)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((a) => [
        a.id,
        a.phase,
        a.completedAtSec,
        a.totalWaitSec,
        a.position?.nodeId ?? '',
        Math.round((a.position?.x ?? 0) * 100),
        Math.round((a.position?.y ?? 0) * 100),
        a.movement ? Math.round(a.movement.traveledM) : -1,
        a.movement?.held ? 1 : 0,
        (a.movement?.crossings ?? []).map((c) => `${c.requestId}:${c.status}`).join(','),
        a.plannedRoute ? a.plannedRoute.nodeIds.join('>') : '',
        a.goAroundCount ?? 0,
      ]),
    arrivalSequence: [...(state.arrivalSequence ?? [])],
    requests: Object.values(state.requests)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((r) => [r.id, r.kind, r.status]),
    clearances: Object.values(state.clearances)
      .sort((a, b) => a.seq - b.seq)
      .map((c) => [c.id, c.status]),
    assignments: Object.values(state.assignments)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((a) => [a.id, a.status, a.assignedId ?? '']),
    standReservations: Object.entries(state.standReservations).sort(),
    score: state.score,
    events: state.events.map((e) => [e.atSec, e.kind, e.aircraftId ?? '']),
    finished: state.finished,
  });
  let h = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
