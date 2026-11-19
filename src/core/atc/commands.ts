import type {
  AtcAirportSnapshot,
  AtcClearance,
  AtcSafetyProvider,
  AtcSafetyReasonCode,
  AtcSessionState,
} from './types';
import { pushEvent } from './events';
import {
  assignmentFor,
  effectiveArrivalSequence,
  ensureCrossingRequests,
} from './assignments';
import {
  crossingsForRoute,
  findAtcRoute,
  getAtcNetwork,
  planRouteNodeIds,
  routeCumulativeM,
  routeLengthM,
} from './movement';

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
  // 横断要求は横断ゲートと対になっており、却下すると機体が永久に停止する。
  // 承認は approveCrossing で行い、ここでの却下は受け付けない
  if (request.kind === 'runwayCrossing') {
    return { ok: false, reasons: ['crossing-request-not-rejectable'] };
  }
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

export interface ApproveCrossingResult {
  ok: boolean;
  reasons: string[];
  warnings: AtcSafetyReasonCode[];
}

/**
 * 滑走路横断の承認（GROUND。ATC-06）。
 * 横断は実行中の地上走行に付随するゲートであり、通常の指示ライフサイクル
 * （発行→復唱→実行で段階遷移する）には載せない。承認は安全判定
 * （対象滑走路の占有・予約を AtcSafetyProvider で再検証）を通した場合だけ
 * ゲートを開き、機体は親の走行指示の残り経路として横断区間を進む。
 */
export function approveCrossing(
  state: AtcSessionState,
  airport: AtcAirportSnapshot,
  safety: AtcSafetyProvider,
  input: { requestId: string },
): ApproveCrossingResult {
  const fail = (reasons: string[]): ApproveCrossingResult => ({ ok: false, reasons, warnings: [] });
  const request = state.requests[input.requestId];
  if (!request) return fail(['request-not-found']);
  if (request.kind !== 'runwayCrossing') return fail(['request-not-crossing']);
  if (request.status !== 'open') return fail(['request-not-open']);
  const aircraft = state.aircraft[request.aircraftId];
  if (!aircraft) return fail(['aircraft-not-found']);
  const crossing = (aircraft.movement?.crossings ?? []).find(
    (c) => c.requestId === request.id && c.status === 'waiting',
  );
  if (!crossing) return fail(['crossing-not-pending']);

  const verdict = safety.check({
    session: state,
    airport,
    aircraft,
    kind: 'runwayCrossing',
    runwayId: crossing.runwayId,
  });
  if (verdict.verdict === 'deny') {
    state.score.safetyDenials += 1;
    pushEvent(state, {
      kind: 'clearanceRejected',
      aircraftId: aircraft.id,
      message: `${aircraft.callsign}: runwayCrossing ${crossing.runwayId} denied (${verdict.reasons.join(', ')})`,
    });
    return { ok: false, reasons: [...verdict.reasons], warnings: [] };
  }

  request.status = 'cleared';
  crossing.status = 'cleared';
  crossing.clearedAtSec = state.clockSec;
  pushEvent(state, {
    kind: 'clearanceIssued',
    aircraftId: aircraft.id,
    message: `${aircraft.callsign}: cleared runwayCrossing ${crossing.runwayId} at ${crossing.holdNodeId} (ground)`,
  });
  if (verdict.verdict === 'warn') {
    pushEvent(state, {
      kind: 'safetyWarning',
      aircraftId: aircraft.id,
      message: `${aircraft.callsign}: warning (${verdict.reasons.join(', ')})`,
    });
  }
  return { ok: true, reasons: [], warnings: verdict.verdict === 'warn' ? verdict.reasons : [] };
}

/** 停止指示が意味を持つ移動種別（地上走行系のみ。離着陸・整列中は停止できない） */
const HOLDABLE_KINDS: ReadonlySet<string> = new Set(['pushback', 'taxiIn', 'taxiOut']);

/**
 * 停止指示（hold。ATC-06）。
 * 意味づけ: 移動中の機体を現在位置で停止させる。停止は「最後に通過した
 * ノード」を基準に判定し、そのノードが滑走路上（runwayIds を持つ）場合は
 * 滑走路を塞ぐため受け付けない（unsafe-hold-position）。交差点ノードは
 * 誘導路交差点であれば停止可（滑走路交差点ノードは runwayIds を持つため
 * 上記で拒否される）。停止中は移動が進まず、待機時間として累積する。
 * 制約: 停止は現在の移動区間の途中で効くため、機体はノード間の中間に
 * 止まりうる。位置の正本は traveledM であり、再開は残り経路をそのまま進む。
 */
export function holdAircraft(
  state: AtcSessionState,
  airport: AtcAirportSnapshot,
  aircraftId: string,
): { ok: boolean; reasons: string[] } {
  const aircraft = state.aircraft[aircraftId];
  if (!aircraft) return { ok: false, reasons: ['aircraft-not-found'] };
  const movement = aircraft.movement;
  if (!movement) return { ok: false, reasons: ['no-active-movement'] };
  if (movement.held) return { ok: false, reasons: ['already-held'] };
  if (!HOLDABLE_KINDS.has(movement.kind)) return { ok: false, reasons: ['hold-not-applicable'] };
  const network = getAtcNetwork(airport);
  const node = aircraft.position ? network.nodes[aircraft.position.nodeId] : undefined;
  if (node && node.runwayIds.length > 0) return { ok: false, reasons: ['unsafe-hold-position'] };
  movement.held = true;
  pushEvent(state, {
    kind: 'holdStarted',
    aircraftId: aircraft.id,
    message: `${aircraft.callsign}: hold position (${movement.kind})`,
  });
  return { ok: true, reasons: [] };
}

/** 再開指示（resume）。停止中の機体が残り経路を継続する */
export function resumeAircraft(
  state: AtcSessionState,
  aircraftId: string,
): { ok: boolean; reasons: string[] } {
  const aircraft = state.aircraft[aircraftId];
  if (!aircraft) return { ok: false, reasons: ['aircraft-not-found'] };
  const movement = aircraft.movement;
  if (!movement) return { ok: false, reasons: ['no-active-movement'] };
  if (!movement.held) return { ok: false, reasons: ['not-held'] };
  movement.held = false;
  pushEvent(state, {
    kind: 'holdReleased',
    aircraftId: aircraft.id,
    message: `${aircraft.callsign}: resume ${movement.kind}`,
  });
  return { ok: true, reasons: [] };
}

export interface GoAroundResult {
  ok: boolean;
  reasons: string[];
}

/**
 * 復行（go-around。ATC-07、TOWER）。
 * 進入/着陸段階の到着機にのみ適用できる。着陸許可が発行済み
 * （issued/readback）か実行中（finalApproach）であることが条件で、
 * 接地後（landingRoll 以降）・地上の機体・出発機には適用できない。
 *
 * 復行時の後片付け（受入条件「復行時に予約/占有/誘導路確保が漏れない」）:
 * - 実行中/発行済みの着陸許可は cancelled にし、要求も cancelled にする
 *   （通常の cancelClearance は実行中を拒否するが、復行は管制官の緊急指示
 *   として別経路で打ち切る）。
 * - 着陸移動（滑走路上の位置・移動状態）は破棄し、機体は上空（position
 *   null）へ戻る。移動に未承認の横断ゲートがあればその要求も cancelled。
 * - 着陸RWY割当は open に戻し、TOWER キューへ再提示する（割当要求の
 *   「再生成」は決定的ID asg_<便>_<landingRunway> の再オープンで表す。
 *   重複レコードは作らない）。スポット割当とスポット予約は、機体が
 *   再進入して着陸するため維持する（漏れではない）。
 * - 到着順序に掲載されている場合は列の末尾へ移す（後続機にとっては
 *   「復行で解消」となり、着陸許可が通るようになる）。
 *
 * 再進入: 段階は inbound に戻り、再要求は既存の却下後間隔
 * RE_REQUEST_DELAY_SEC（30秒）経過後＋着陸RWY割当の再確定後に、
 * 通常の要求自動生成（req_<連番>）で決定的に再生成される。
 * 管制官が再度許可しない限り機体は進入を開始しない。
 */
export function goAroundAircraft(
  state: AtcSessionState,
  aircraftId: string,
): GoAroundResult {
  const fail = (reasons: string[]): GoAroundResult => ({ ok: false, reasons });
  const aircraft = state.aircraft[aircraftId];
  if (!aircraft) return fail(['aircraft-not-found']);
  if (aircraft.kind !== 'arrival') return fail(['go-around-not-applicable']);
  if (aircraft.completedAtSec !== null) return fail(['aircraft-completed']);
  const clearance = aircraft.activeClearanceId
    ? state.clearances[aircraft.activeClearanceId]
    : undefined;
  const hasLandingClearance =
    clearance !== undefined &&
    clearance.kind === 'landing' &&
    (clearance.status === 'issued' ||
      clearance.status === 'readback' ||
      clearance.status === 'executing');
  if (aircraft.phase !== 'finalApproach' && !hasLandingClearance) {
    // 進入を開始していない到着機には、打ち切る着陸許可がない
    if (aircraft.phase === 'inbound') return fail(['no-landing-clearance']);
    return fail(['go-around-not-applicable']);
  }

  // 横断ゲート要求の後片付け（着陸移動には通常含まれないが、残さない）
  for (const crossing of aircraft.movement?.crossings ?? []) {
    if (crossing.status !== 'waiting') continue;
    const request = state.requests[crossing.requestId];
    if (request && request.status === 'open') request.status = 'cancelled';
  }
  aircraft.movement = null;
  aircraft.position = null;
  aircraft.plannedRoute = null;

  if (clearance && hasLandingClearance) {
    clearance.status = 'cancelled';
    const request = state.requests[clearance.requestId];
    if (request && request.status === 'cleared') request.status = 'cancelled';
  }
  aircraft.activeClearanceId = null;
  aircraft.activeRequestId = null;
  aircraft.phase = 'inbound';
  aircraft.waitingSinceSec = state.clockSec;
  aircraft.nextRequestAtSec = state.clockSec + RE_REQUEST_DELAY_SEC;
  aircraft.goAroundCount += 1;

  // 着陸RWY割当を再オープンし、TOWER に再提示する
  const runwayAssignment = assignmentFor(state, aircraft.trafficEntryId, 'landingRunway');
  let assignmentReopened = false;
  if (runwayAssignment && runwayAssignment.status === 'assigned') {
    runwayAssignment.status = 'open';
    runwayAssignment.assignedId = undefined;
    assignmentReopened = true;
  }
  // 到着順序では列の末尾へ（後続機の着陸許可が通るようになる）
  const sequence = state.arrivalSequence ?? [];
  if (sequence.includes(aircraftId)) {
    state.arrivalSequence = [...sequence.filter((id) => id !== aircraftId), aircraftId];
  }
  pushEvent(state, {
    kind: 'goAround',
    aircraftId: aircraft.id,
    clearanceId: clearance?.id,
    message: `${aircraft.callsign}: go-around runway ${aircraft.runwayId} (#${aircraft.goAroundCount})`,
  });
  if (assignmentReopened) {
    pushEvent(state, {
      kind: 'request',
      aircraftId: aircraft.id,
      message: `${aircraft.callsign}: landingRunway assignment reopened after go-around (tower)`,
    });
  }
  return { ok: true, reasons: [] };
}

export interface SetArrivalSequenceResult {
  ok: boolean;
  reasons: string[];
  /** 設定後の実効順序 */
  sequence: string[];
}

/**
 * 到着順序の設定（ATC-07、TOWER）。
 * 管制官が到着機の着陸順序を明示する。空配列は順序の解除
 * （未指定＝順序制約なし）として受理する。掲載は到着機のみで、
 * 重複・不存在は拒否する。設定自体は許可ではなく、安全判定
 * （safety の arrival-sequence-blocked）が着陸許可の可否に効く。
 */
export function setArrivalSequence(
  state: AtcSessionState,
  orderedAircraftIds: string[],
): SetArrivalSequenceResult {
  const fail = (reasons: string[]): SetArrivalSequenceResult => ({
    ok: false,
    reasons,
    sequence: effectiveArrivalSequence(state),
  });
  const seen = new Set<string>();
  for (const id of orderedAircraftIds) {
    if (seen.has(id)) return fail(['duplicate-aircraft']);
    seen.add(id);
    const aircraft = state.aircraft[id];
    if (!aircraft) return fail(['aircraft-not-found']);
    if (aircraft.kind !== 'arrival') return fail(['not-arrival']);
  }
  state.arrivalSequence = [...orderedAircraftIds];
  pushEvent(state, {
    kind: 'sequenceChanged',
    message: `arrival sequence set: ${
      orderedAircraftIds
        .map((id) => state.aircraft[id]?.callsign ?? id)
        .join(' > ') || '(cleared)'
    }`,
  });
  return { ok: true, reasons: [], sequence: effectiveArrivalSequence(state) };
}

/**
 * 到着順序内での前後入れ替え（ATC-07）。
 * 現在の実効順序を基準に、対象機を offset 分（負=前へ、正=後ろへ）
 * 移動した順序を明示順序として保存する。順序未指定の状態からでも、
 * 推奨順序を土台に変更できる。
 */
export function moveArrivalInSequence(
  state: AtcSessionState,
  aircraftId: string,
  offset: number,
): SetArrivalSequenceResult {
  const fail = (reasons: string[]): SetArrivalSequenceResult => ({
    ok: false,
    reasons,
    sequence: effectiveArrivalSequence(state),
  });
  const aircraft = state.aircraft[aircraftId];
  if (!aircraft) return fail(['aircraft-not-found']);
  if (aircraft.kind !== 'arrival') return fail(['not-arrival']);
  const current = effectiveArrivalSequence(state);
  const idx = current.indexOf(aircraftId);
  if (idx < 0) return fail(['not-in-arrival-sequence']);
  const target = Math.max(0, Math.min(current.length - 1, idx + offset));
  if (target === idx) return { ok: true, reasons: [], sequence: current };
  const next = [...current];
  next.splice(idx, 1);
  next.splice(target, 0, aircraftId);
  state.arrivalSequence = next;
  pushEvent(state, {
    kind: 'sequenceChanged',
    aircraftId,
    message: `arrival sequence: ${aircraft.callsign} moved to #${target + 1} (${
      next.map((id) => state.aircraft[id]?.callsign ?? id).join(' > ')
    })`,
  });
  return { ok: true, reasons: [], sequence: effectiveArrivalSequence(state) };
}

export interface RerouteResult {
  ok: boolean;
  reasons: string[];
  /** 経路が実際に差し替わったか（再計画結果が同じ場合は false） */
  changed: boolean;
  nodeIds?: string[];
}

/**
 * 経路変更（reroute。ATC-06）。
 * - 走行中: 現在位置の次のノードまでは現経路を維持し、そこから目的地
 *   （現経路の最終ノード）までを再計画して差し替える。速度は維持する
 *   （到着時刻は経路長に応じて変わる）。横断ゲートは新しい経路で
 *   再計算し、通過済みのゲートは cleared 扱い、不要になった未承認の
 *   横断要求は cancelled にする。
 * - 走行前（要求が open、または指示が発行済みで未実行）: 経路は実行開始時に
 *   現在位置から計画されるため、再計画結果を plannedRoute として保存し、
 *   実行開始時に使わせる。
 * - 再計画で経路が取れない場合は変更を拒否し、元の経路を維持する。
 * - avoidNodeIds を渡すとそのノードを避けて再計画する（混雑・閉鎖想定）。
 */
export function rerouteAircraft(
  state: AtcSessionState,
  airport: AtcAirportSnapshot,
  aircraftId: string,
  opts?: { avoidNodeIds?: string[] },
): RerouteResult {
  const fail = (reasons: string[]): RerouteResult => ({ ok: false, reasons, changed: false });
  const aircraft = state.aircraft[aircraftId];
  if (!aircraft) return fail(['aircraft-not-found']);
  const network = getAtcNetwork(airport);
  const avoid = new Set(opts?.avoidNodeIds ?? []);
  const movement = aircraft.movement;

  if (movement) {
    if (movement.traveledM >= movement.totalLengthM) return fail(['movement-complete']);
    const cum = routeCumulativeM(network, movement.nodeIds);
    let nextIdx = -1;
    for (let i = 0; i < movement.nodeIds.length; i++) {
      if (cum[i]! > movement.traveledM + 1e-6) {
        nextIdx = i;
        break;
      }
    }
    if (nextIdx < 0) return fail(['movement-complete']);
    const from = movement.nodeIds[nextIdx]!;
    const destination = movement.nodeIds[movement.nodeIds.length - 1]!;
    const avoidForSearch = new Set([...avoid].filter((id) => id !== from && id !== destination));
    const suffix = findAtcRoute(network, {
      from,
      targets: new Set([destination]),
      size: aircraft.size,
      ownStandId: aircraft.standId,
      avoidNodeIds: avoidForSearch,
    });
    if (!suffix) return fail(['no-alternative-route']);
    const newNodeIds = [...movement.nodeIds.slice(0, nextIdx + 1), ...suffix.slice(1)];
    const unchanged =
      newNodeIds.length === movement.nodeIds.length &&
      newNodeIds.every((id, i) => id === movement.nodeIds[i]);
    if (unchanged) return { ok: true, reasons: [], changed: false, nodeIds: newNodeIds };

    const oldCrossings = movement.crossings ?? [];
    movement.nodeIds = newNodeIds;
    movement.totalLengthM = routeLengthM(network, newNodeIds);
    movement.crossings = crossingsForRoute(network, aircraft, movement.kind, newNodeIds).map(
      (c) => (c.stopAtM <= movement.traveledM + 1e-6 ? { ...c, status: 'cleared' as const } : c),
    );
    // 不要になった未承認の横断要求は取り消す（黙って残さない）
    const kept = new Set(
      (movement.crossings ?? []).filter((c) => c.status === 'waiting').map((c) => c.requestId),
    );
    for (const old of oldCrossings) {
      if (old.status !== 'waiting' || kept.has(old.requestId)) continue;
      const request = state.requests[old.requestId];
      if (request && request.status === 'open') {
        request.status = 'cancelled';
        pushEvent(state, {
          kind: 'requestRejected',
          aircraftId: aircraft.id,
          message: `${aircraft.callsign}: runwayCrossing ${old.runwayId} request cancelled by reroute`,
        });
      }
    }
    ensureCrossingRequests(state, aircraft, movement);
    pushEvent(state, {
      kind: 'rerouted',
      aircraftId: aircraft.id,
      message: `${aircraft.callsign}: rerouted ${movement.kind} (${newNodeIds.length} nodes)`,
    });
    return { ok: true, reasons: [], changed: true, nodeIds: newNodeIds };
  }

  // 走行前: 対応する要求（open または許可済み・未実行）に対して再計画する
  const request = aircraft.activeRequestId ? state.requests[aircraft.activeRequestId] : undefined;
  if (!request) return fail(['nothing-to-reroute']);
  const nodeIds = planRouteNodeIds(network, aircraft, request.kind, avoid);
  if (!nodeIds) return fail(['no-route']);
  const prev = aircraft.plannedRoute ?? null;
  const unchanged =
    prev !== null &&
    prev.kind === request.kind &&
    prev.nodeIds.length === nodeIds.length &&
    prev.nodeIds.every((id, i) => id === nodeIds[i]);
  if (unchanged) return { ok: true, reasons: [], changed: false, nodeIds };
  aircraft.plannedRoute = { kind: request.kind, nodeIds };
  pushEvent(state, {
    kind: 'rerouted',
    aircraftId: aircraft.id,
    message: `${aircraft.callsign}: route planned for ${request.kind} (${nodeIds.length} nodes)`,
  });
  return { ok: true, reasons: [], changed: true, nodeIds };
}
