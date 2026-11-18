import type {
  AtcClearance,
  AtcSafetyProvider,
  AtcSafetyReasonCode,
  AtcSessionState,
} from './types';
import { pushEvent } from './events';

/**
 * ATC-05: 管制指示の発行・復唱・取消・却下。
 * 状態機械: requested → issued → readback → executing → completed。
 * 発行時の安全判定で deny の場合は指示を作らず、要求は open のまま残す。
 */

export const DEFAULT_CLEARANCE_TTL_SEC = 300;

export interface IssueClearanceResult {
  ok: boolean;
  clearance?: AtcClearance;
  /** ok=false の理由（安全判定コードまたは状態機械の理由文字列） */
  reasons: string[];
  warnings: AtcSafetyReasonCode[];
}

export function issueClearance(
  state: AtcSessionState,
  airport: Parameters<AtcSafetyProvider['check']>[0]['airport'],
  safety: AtcSafetyProvider,
  input: { aircraftId: string; requestId: string; ttlSec?: number },
): IssueClearanceResult {
  const fail = (reasons: string[]): IssueClearanceResult => ({ ok: false, reasons, warnings: [] });
  const aircraft = state.aircraft[input.aircraftId];
  if (!aircraft) return fail(['aircraft-not-found']);
  const request = state.requests[input.requestId];
  if (!request) return fail(['request-not-found']);
  if (request.aircraftId !== aircraft.id) return fail(['request-aircraft-mismatch']);
  if (request.status !== 'open') return fail(['request-not-open']);
  if (aircraft.activeRequestId !== request.id) return fail(['request-not-active']);
  if (aircraft.activeClearanceId !== null) return fail(['aircraft-already-has-clearance']);
  if (aircraft.completedAtSec !== null) return fail(['aircraft-completed']);

  const verdict = safety.check({
    session: state,
    airport,
    aircraft,
    kind: request.kind,
    runwayId: aircraft.runwayId,
  });
  if (verdict.verdict === 'deny') {
    state.score.safetyDenials += 1;
    pushEvent(state, {
      kind: 'clearanceRejected',
      aircraftId: aircraft.id,
      message: `${aircraft.callsign}: ${request.kind} denied (${verdict.reasons.join(', ')})`,
    });
    return { ok: false, reasons: [...verdict.reasons], warnings: [] };
  }

  const seq = state.nextClearanceSeq;
  state.nextClearanceSeq += 1;
  const clearance: AtcClearance = {
    id: `clr_${seq}`,
    seq,
    aircraftId: aircraft.id,
    requestId: request.id,
    kind: request.kind,
    runwayId: aircraft.runwayId,
    issuedAtSec: state.clockSec,
    expiresAtSec: state.clockSec + (input.ttlSec ?? DEFAULT_CLEARANCE_TTL_SEC),
    status: 'issued',
  };
  state.clearances[clearance.id] = clearance;
  request.status = 'cleared';
  request.clearanceId = clearance.id;
  aircraft.activeClearanceId = clearance.id;
  state.score.clearancesIssued += 1;
  pushEvent(state, {
    kind: 'clearanceIssued',
    aircraftId: aircraft.id,
    clearanceId: clearance.id,
    message: `${aircraft.callsign}: cleared ${request.kind} (${clearance.id})`,
  });
  if (verdict.verdict === 'warn') {
    pushEvent(state, {
      kind: 'safetyWarning',
      aircraftId: aircraft.id,
      clearanceId: clearance.id,
      message: `${aircraft.callsign}: warning (${verdict.reasons.join(', ')})`,
    });
  }
  return { ok: true, clearance, reasons: [], warnings: verdict.verdict === 'warn' ? verdict.reasons : [] };
}

/** 定型復唱文。復唱内容は指示と一致することを前提に決定的に生成する */
export function readbackTextFor(clearance: AtcClearance, callsign: string): string {
  return `${callsign}, cleared ${clearance.kind}${clearance.runwayId ? ` runway ${clearance.runwayId}` : ''}, ${clearance.id}`;
}

export function recordReadback(
  state: AtcSessionState,
  clearanceId: string,
  providedText?: string,
): { ok: boolean; reasons: string[] } {
  const clearance = state.clearances[clearanceId];
  if (!clearance) return { ok: false, reasons: ['clearance-not-found'] };
  if (clearance.status !== 'issued') return { ok: false, reasons: ['clearance-not-issued'] };
  const aircraft = state.aircraft[clearance.aircraftId];
  const expected = readbackTextFor(clearance, aircraft?.callsign ?? clearance.aircraftId);
  if (providedText !== undefined && providedText !== expected) {
    // 復唱不一致: 状態は変えず、イベントだけ残す（再復唱を求める）
    pushEvent(state, {
      kind: 'readback',
      aircraftId: clearance.aircraftId,
      clearanceId,
      message: `${aircraft?.callsign ?? clearance.aircraftId}: readback mismatch`,
    });
    return { ok: false, reasons: ['readback-mismatch'] };
  }
  clearance.status = 'readback';
  clearance.readbackText = expected;
  pushEvent(state, {
    kind: 'readback',
    aircraftId: clearance.aircraftId,
    clearanceId,
    message: expected,
  });
  return { ok: true, reasons: [] };
}

/** 取消は未実行（issued/readback）のみ。実行中は安全に止まれる保証がないため拒否する */
export function cancelClearance(
  state: AtcSessionState,
  clearanceId: string,
): { ok: boolean; reasons: string[] } {
  const clearance = state.clearances[clearanceId];
  if (!clearance) return { ok: false, reasons: ['clearance-not-found'] };
  if (clearance.status === 'executing') return { ok: false, reasons: ['already-executing'] };
  if (clearance.status !== 'issued' && clearance.status !== 'readback') {
    return { ok: false, reasons: ['clearance-not-active'] };
  }
  clearance.status = 'cancelled';
  const aircraft = state.aircraft[clearance.aircraftId];
  if (aircraft && aircraft.activeClearanceId === clearanceId) {
    aircraft.activeClearanceId = null;
    // 要求は open に戻し、管制官が再発行できるようにする
    const request = state.requests[clearance.requestId];
    if (request && request.status === 'cleared') {
      request.status = 'open';
      request.clearanceId = undefined;
      aircraft.activeRequestId = request.id;
      if (aircraft.waitingSinceSec === null) aircraft.waitingSinceSec = state.clockSec;
    }
  }
  pushEvent(state, {
    kind: 'clearanceCancelled',
    aircraftId: clearance.aircraftId,
    clearanceId,
    message: `${aircraft?.callsign ?? clearance.aircraftId}: clearance ${clearanceId} cancelled`,
  });
  return { ok: true, reasons: [] };
}

/** 要求の却下（待機指示）。航空機は一定間隔後に再要求する */
export const RE_REQUEST_DELAY_SEC = 30;

export function rejectRequest(
  state: AtcSessionState,
  requestId: string,
): { ok: boolean; reasons: string[] } {
  const request = state.requests[requestId];
  if (!request) return { ok: false, reasons: ['request-not-found'] };
  if (request.status !== 'open') return { ok: false, reasons: ['request-not-open'] };
  request.status = 'rejected';
  const aircraft = state.aircraft[request.aircraftId];
  if (aircraft && aircraft.activeRequestId === requestId) {
    aircraft.activeRequestId = null;
    aircraft.nextRequestAtSec = state.clockSec + RE_REQUEST_DELAY_SEC;
    if (aircraft.waitingSinceSec === null) aircraft.waitingSinceSec = state.clockSec;
  }
  state.score.requestsRejected += 1;
  pushEvent(state, {
    kind: 'requestRejected',
    aircraftId: request.aircraftId,
    message: `${aircraft?.callsign ?? request.aircraftId}: ${request.kind} request rejected, hold`,
  });
  return { ok: true, reasons: [] };
}
