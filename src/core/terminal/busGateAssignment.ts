import { compareIds } from '../model/ids';
import { gateMode } from '../model/gates';
import type { Vec2 } from '../geometry/vec';
import type { AirportLayout } from '../model/types';
import type { TerminalModel } from './model';
import type { TerminalAreaKind } from '../model/types';
import { findPaxRoute } from './route';

export type BusGateProblem =
  | 'missing'
  | 'notBusGate'
  | 'building'
  | 'closed'
  | 'unconnected'
  | 'missingBoarding'
  | 'missingDeplane'
  | 'crossTerminal'
  | 'missingDepartureRoute'
  | 'missingArrivalRoute';

export interface BusGateStatus {
  usable: boolean;
  terminalId: string | null;
  problem?: BusGateProblem;
}

export interface BusGateAssignment {
  gateId: string | null;
  terminalId: string | null;
  failure?: 'disabled' | 'unconfigured' | 'invalidGate';
}

/** A bus gate can serve a remote stand only when both passenger directions
 * connect to the same terminal. The terminal model is derived from the current
 * layout, so this check also rejects dangling and cross-terminal access nodes.
 */
export function busGateStatus(
  layout: AirportLayout,
  terminal: TerminalModel,
  gateId: string | null | undefined,
  closedGateIds: readonly string[] = [],
): BusGateStatus {
  if (!gateId) return { usable: false, terminalId: null, problem: 'missing' };
  const facility = layout.facilities[gateId];
  if (!facility || facility.kind !== 'gate') return { usable: false, terminalId: null, problem: 'missing' };
  if (gateMode(facility) !== 'bus') return { usable: false, terminalId: null, problem: 'notBusGate' };
  const access = terminal.gates[gateId];
  if (!access?.terminalId || layout.facilities[access.terminalId]?.kind !== 'terminal') {
    return { usable: false, terminalId: access?.terminalId ?? null, problem: 'unconnected' };
  }
  if (facility.buildState !== 'operational') return { usable: false, terminalId: access.terminalId, problem: 'building' };
  if (closedGateIds.includes(gateId)) return { usable: false, terminalId: access.terminalId, problem: 'closed' };
  if (!access.boarding) return { usable: false, terminalId: access.terminalId, problem: 'missingBoarding' };
  if (!access.deplane) return { usable: false, terminalId: access.terminalId, problem: 'missingDeplane' };
  const boarding = terminal.areas[access.boarding];
  const deplane = terminal.areas[access.deplane];
  if (!boarding || !deplane || boarding.terminalId !== access.terminalId || deplane.terminalId !== access.terminalId) {
    return { usable: false, terminalId: access.terminalId, problem: 'crossTerminal' };
  }
  const ids = terminal.byTerminal[access.terminalId] ?? [];
  const ofKind = (kind: TerminalAreaKind) => ids.filter((id) => terminal.areas[id]?.kind === kind);
  const usable = (id: string) => {
    const area = layout.terminalAreas[id];
    return !area || !['checkIn', 'security'].includes(area.kind) || Number(area.props.counters ?? area.props.lanes ?? 0) > 0;
  };
  const checkIns = ofKind('checkIn').filter(usable);
  const securities = ofKind('security').filter(usable);
  const departurePath = ofKind('entrance').some((entry) => checkIns.some((checkIn) =>
    !!findPaxRoute(terminal, { from: entry, goals: new Map([[checkIn, 0]]) }) && securities.some((security) =>
      !!findPaxRoute(terminal, { from: checkIn, goals: new Map([[security, 0]]), uncleared: true }) &&
      !!findPaxRoute(terminal, { from: security, goals: new Map([[access.boarding!, 0]]) }),
    ),
  ));
  if (!departurePath) return { usable: false, terminalId: access.terminalId, problem: 'missingDepartureRoute' };
  const exits = new Map(ofKind('exit').map((id) => [id, 0] as const));
  if (!findPaxRoute(terminal, { from: access.deplane, goals: exits })) {
    return { usable: false, terminalId: access.terminalId, problem: 'missingArrivalRoute' };
  }
  const claims = ofKind('baggageClaim').filter((id) => Number(layout.terminalAreas[id]?.props.belts ?? 0) > 0);
  const baggageRoute = claims.length === 0 || claims.some((claim) =>
    !!findPaxRoute(terminal, { from: access.deplane!, goals: new Map([[claim, 0]]) }) &&
    !!findPaxRoute(terminal, { from: claim, goals: exits }),
  );
  if (!baggageRoute) return { usable: false, terminalId: access.terminalId, problem: 'missingArrivalRoute' };
  return { usable: true, terminalId: access.terminalId };
}

/** One deterministic spot-to-gate rule shared by preview and live operations.
 * Explicit assignments never fall back. Automatic assignments choose the
 * nearest usable gate, with gate ID as a stable tie breaker.
 * `Stand.terminalId`（1-11 / K-1）: 'none' では無視。'bus' ではゲートの所属が一致するときだけ使い、不一致は invalidGate。
 * 'auto' / 欠落では候補をそのターミナルのゲートに絞り、なければ unconfigured。固定スポット（ゲート付き）はこの関数を通らず、ゲートで決まる。
 */
export function resolveBusGateForStand(
  layout: AirportLayout,
  terminal: TerminalModel,
  standId: string,
  standPoint: Vec2 | null,
  availableBusGateIds: readonly string[],
  closedGateIds: readonly string[] = [],
): BusGateAssignment {
  const stand = layout.stands[standId];
  if (!stand || stand.remoteBoarding === 'none') return { gateId: null, terminalId: null, ...(stand ? { failure: 'disabled' as const } : { failure: 'unconfigured' as const }) };

  if (stand.remoteBoarding === 'bus') {
    const gateId = stand.busGateId ?? null;
    const status = busGateStatus(layout, terminal, gateId, closedGateIds);
    // 所属ターミナル（Stand.terminalId）の指定があるときは、ゲートの所属が一致するものだけ。食い違いは代わりを探さず invalidGate（1-11 / K-1）
    const terminalMatches = !stand.terminalId || status.terminalId === stand.terminalId;
    return status.usable && terminalMatches
      ? { gateId, terminalId: status.terminalId }
      : { gateId: null, terminalId: null, failure: gateId ? 'invalidGate' : 'unconfigured' };
  }

  if (!standPoint) return { gateId: null, terminalId: null, failure: 'unconfigured' };
  const candidates = availableBusGateIds.flatMap((gateId) => {
    const status = busGateStatus(layout, terminal, gateId, closedGateIds);
    const facility = layout.facilities[gateId];
    if (!status.usable || !facility) return [];
    // 'auto' / 欠落 + 所属ターミナルの指定: そのターミナルのゲートだけを候補にする（別のターミナルへは移さない）
    if (stand.terminalId && status.terminalId !== stand.terminalId) return [];
    const distance = Math.hypot(facility.origin.x + 0.5 - standPoint.x, facility.origin.y + 0.5 - standPoint.y);
    return [{ gateId, terminalId: status.terminalId, distance }];
  });
  candidates.sort((a, b) => a.distance - b.distance || compareIds(a.gateId, b.gateId));
  const chosen = candidates[0];
  return chosen ? { gateId: chosen.gateId, terminalId: chosen.terminalId } : { gateId: null, terminalId: null, failure: 'unconfigured' };
}

