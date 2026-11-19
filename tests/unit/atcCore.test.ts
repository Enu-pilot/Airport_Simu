import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveCrossing,
  assignRunway,
  assignStand,
  assignmentId,
  atcSessionDigest,
  buildAtcReport,
  buildCommunicationLog,
  communicationLogDigest,
  candidateRunways,
  candidateStands,
  cancelClearance,
  createAtcAirportSnapshot,
  createAtcSession,
  createSessionSafetyProvider,
  createTutorialScenario,
  crossingRequestId,
  diagnoseAtcAirport,
  effectiveArrivalSequence,
  getAtcNetwork,
  goAroundAircraft,
  holdAircraft,
  isMovementBlocked,
  issueClearance,
  moveArrivalInSequence,
  nodePosition,
  planRouteNodeIds,
  recommendedArrivalSequence,
  rerouteAircraft,
  resumeAircraft,
  standNodeId,
  openQueueByRole,
  parseAtcSessionFile,
  recordReadback,
  rejectRequest,
  serializeAtcSession,
  setArrivalSequence,
  tickAtcSession,
  type AtcAircraft,
  type AtcScenarioDefinition,
  type AtcSessionState,
} from '../../src/core/atc/index';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createSite } from '../../src/core/model/site';
import type { AirportLayout } from '../../src/core/model/types';
import {
  addTaxiwayPath,
  createEmptyLayout,
  placeFacility,
  placeRunway,
  placeStand,
  type OpResult,
} from '../../src/core/layout/operations';

const capturedAtIso = '2026-11-18T00:00:00.000Z';

function tutorialSetup(): { scenario: AtcScenarioDefinition; session: AtcSessionState } {
  const layout = createStarterAirfield();
  const snapshot = createAtcAirportSnapshot(layout, { id: 'snap_1', capturedAtIso });
  const diagnostics = diagnoseAtcAirport(snapshot);
  expect(diagnostics.errors).toEqual([]);
  const scenario = createTutorialScenario(snapshot, diagnostics);
  return { scenario, session: createAtcSession(scenario) };
}

/** 割当要求を推奨候補で確定し、開いている要求すべてに許可を出す単純な自動管制（テスト用） */
function autoControl(session: AtcSessionState, scenario: AtcScenarioDefinition): void {
  for (const a of Object.values(session.assignments).filter((x) => x.status === 'open')) {
    if (a.aircraftId === null) continue;
    if (a.kind === 'standAssignment') {
      const c = candidateStands(session, scenario.airport, a.aircraftId);
      if (c[0]) assignStand(session, scenario.airport, a.id, c[0]);
    } else {
      const c = candidateRunways(session, scenario.airport, a.aircraftId);
      if (c[0]) assignRunway(session, scenario.airport, a.id, c[0]);
    }
  }
  const safety = createSessionSafetyProvider();
  const open = Object.values(session.requests)
    .filter((r) => r.status === 'open')
    .sort((a, b) => a.createdAtSec - b.createdAtSec || (a.id < b.id ? -1 : 1));
  for (const request of open) {
    issueClearance(session, scenario.airport, safety, {
      aircraftId: request.aircraftId,
      requestId: request.id,
    });
  }
}

function runToFinish(session: AtcSessionState, scenario: AtcScenarioDefinition, maxSec = 3600): void {
  const safety = createSessionSafetyProvider();
  for (let t = 0; t < maxSec && !session.finished; t++) {
    autoControl(session, scenario);
    tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
  }
}

describe('ATC-02/03 snapshot and session independence', () => {
  it('snapshot is a deep copy: mutating it does not change the source layout', () => {
    const layout = createStarterAirfield();
    const before = JSON.stringify(layout);
    const snapshot = createAtcAirportSnapshot(layout, { id: 'snap_x', capturedAtIso });
    const firstRunway = Object.values(snapshot.layout.runways)[0]!;
    firstRunway.name = 'MUTATED';
    snapshot.layout.stands = {};
    expect(JSON.stringify(layout)).toBe(before);
  });

  it('atc core modules do not import management/sim/editor domains', () => {
    const dir = join(__dirname, '..', '..', 'src', 'core', 'atc');
    const forbidden = ['../economy', '../sim/', '../editor', '../../editor', '../passengers', '../access', 'dayloop', 'CompanyState'];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const lines = readFileSync(join(dir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.startsWith('import')) continue;
        for (const bad of forbidden) {
          expect(line, `${file}: ${line}`).not.toContain(bad);
        }
      }
    }
  });

  it('session state contains no management data keys', () => {
    const { session } = tutorialSetup();
    const json = JSON.stringify(session);
    for (const bad of ['company', 'contract', 'paxGroup', 'baggage', 'journal', 'finance']) {
      expect(json.toLowerCase()).not.toContain(bad);
    }
  });

  it('diagnostics report an airport without operational runways as an error', () => {
    const layout = createStarterAirfield();
    for (const r of Object.values(layout.runways)) r.buildState = 'planned';
    const snapshot = createAtcAirportSnapshot(layout, { id: 'snap_bad', capturedAtIso });
    const diagnostics = diagnoseAtcAirport(snapshot);
    expect(diagnostics.errors).toContain('no-operational-runway');
    expect(() => createAtcSession(createTutorialScenario(snapshot, diagnostics))).toThrow();
  });
});

describe('ATC-05 command lifecycle', () => {
  it('aircraft does not move without a clearance', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 600);
    const dep = Object.values(session.aircraft).find((a) => a.kind === 'departure');
    expect(dep?.phase).toBe('atStand');
    expect(Object.keys(session.clearances)).toHaveLength(0);
  });

  it('full flow: departure and arrival complete under clearances, deterministically', () => {
    const a = tutorialSetup();
    runToFinish(a.session, a.scenario);
    expect(a.session.finished).toBe(true);
    expect(a.session.score.departuresHandled).toBe(2);
    expect(a.session.score.arrivalsHandled).toBe(2);

    const b = tutorialSetup();
    runToFinish(b.session, b.scenario);
    expect(atcSessionDigest(b.session)).toBe(atcSessionDigest(a.session));
  });

  it('duplicate clearance for the same aircraft is refused', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 61);
    const request = Object.values(session.requests).find((r) => r.status === 'open');
    expect(request).toBeDefined();
    const first = issueClearance(session, scenario.airport, safety, {
      aircraftId: request!.aircraftId,
      requestId: request!.id,
    });
    expect(first.ok).toBe(true);
    const second = issueClearance(session, scenario.airport, safety, {
      aircraftId: request!.aircraftId,
      requestId: request!.id,
    });
    expect(second.ok).toBe(false);
  });

  it('clearance expires before readback and the request reopens', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 61);
    const request = Object.values(session.requests).find((r) => r.status === 'open')!;
    const issued = issueClearance(session, scenario.airport, safety, {
      aircraftId: request.aircraftId,
      requestId: request.id,
      ttlSec: 3,
    });
    expect(issued.ok).toBe(true);
    tickAtcSession(session, scenario, 5);
    expect(session.clearances[issued.clearance!.id]!.status).toBe('expired');
    expect(session.requests[request.id]!.status).toBe('open');
    expect(session.score.clearancesExpired).toBe(1);
  });

  it('executing clearance cannot be cancelled; issued one can', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 61);
    const request = Object.values(session.requests).find((r) => r.status === 'open')!;
    const issued = issueClearance(session, scenario.airport, safety, {
      aircraftId: request.aircraftId,
      requestId: request.id,
    });
    expect(cancelClearance(session, issued.clearance!.id).ok).toBe(true);
    expect(session.requests[request.id]!.status).toBe('open');

    const again = issueClearance(session, scenario.airport, safety, {
      aircraftId: request.aircraftId,
      requestId: request.id,
    });
    tickAtcSession(session, scenario, 6, { safety, airport: scenario.airport });
    expect(session.clearances[again.clearance!.id]!.status).toBe('executing');
    expect(cancelClearance(session, again.clearance!.id).ok).toBe(false);
  });

  it('readback mismatch does not advance the clearance', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 61);
    const request = Object.values(session.requests).find((r) => r.status === 'open')!;
    const issued = issueClearance(session, scenario.airport, safety, {
      aircraftId: request.aircraftId,
      requestId: request.id,
    });
    const bad = recordReadback(session, issued.clearance!.id, 'wrong phrase');
    expect(bad.ok).toBe(false);
    expect(session.clearances[issued.clearance!.id]!.status).toBe('issued');
    const good = recordReadback(session, issued.clearance!.id);
    expect(good.ok).toBe(true);
    expect(session.clearances[issued.clearance!.id]!.status).toBe('readback');
  });

  it('rejected request is re-issued after the re-request delay', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 61);
    const request = Object.values(session.requests).find((r) => r.status === 'open')!;
    expect(rejectRequest(session, request.id).ok).toBe(true);
    tickAtcSession(session, scenario, 31);
    const aircraft = session.aircraft[request.aircraftId]!;
    expect(aircraft.activeRequestId).not.toBeNull();
    expect(session.requests[aircraft.activeRequestId!]!.status).toBe('open');
  });
});

describe('ATC-05 safety', () => {
  it('second line-up on the same runway is denied while the first is reserved', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    // 2機目の出発機（300秒出現）まで進める。許可は出していないので全機待機中
    tickAtcSession(session, scenario, 301);
    const deps = Object.values(session.aircraft).filter((a) => a.kind === 'departure');
    expect(deps.length).toBe(2);
    const first = deps[0]!;
    const mkRequest = (aircraftId: string, n: number) => {
      const id = `req_manual_${n}`;
      session.requests[id] = {
        id,
        aircraftId,
        kind: 'lineUp',
        createdAtSec: session.clockSec,
        status: 'open',
      };
      session.aircraft[aircraftId]!.activeRequestId = id;
      session.aircraft[aircraftId]!.phase = 'holdShort';
      return id;
    };
    const second = Object.values(session.aircraft).find(
      (a) => a.kind === 'departure' && a.id !== first.id,
    );
    expect(second).toBeDefined();
    const r1 = mkRequest(first.id, 1);
    const okFirst = issueClearance(session, scenario.airport, safety, {
      aircraftId: first.id,
      requestId: r1,
    });
    expect(okFirst.ok).toBe(true);
    const r2 = mkRequest(second!.id, 2);
    const denied = issueClearance(session, scenario.airport, safety, {
      aircraftId: second!.id,
      requestId: r2,
    });
    expect(denied.ok).toBe(false);
    expect(denied.reasons).toContain('runway-reserved');
    expect(session.score.safetyDenials).toBe(1);
  });

  it('clearance is revoked at execution start if the runway became occupied', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    // 到着機の着陸許可を出す（先にTOWERが着陸RWYを割当てる）
    tickAtcSession(session, scenario, 121);
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival');
    expect(arrival).toBeDefined();
    const rwyAssignment = session.assignments[assignmentId(arrival!.trafficEntryId, 'landingRunway')]!;
    expect(assignRunway(session, scenario.airport, rwyAssignment.id, arrival!.runwayId).ok).toBe(true);
    tickAtcSession(session, scenario, 1);
    const request = Object.values(session.requests).find(
      (r) => r.aircraftId === arrival!.id && r.status === 'open',
    );
    expect(request).toBeDefined();
    const issued = issueClearance(session, scenario.airport, safety, {
      aircraftId: arrival!.id,
      requestId: request!.id,
    });
    expect(issued.ok).toBe(true);
    // 実行開始前に同滑走路が占有された状況を作る
    const intruder = Object.values(session.aircraft).find((a) => a.id !== arrival!.id)!;
    intruder.phase = 'takeoffRoll';
    intruder.runwayId = arrival!.runwayId;
    tickAtcSession(session, scenario, 6, { safety, airport: scenario.airport });
    expect(session.clearances[issued.clearance!.id]!.status).toBe('expired');
    expect(session.aircraft[arrival!.id]!.phase).toBe('inbound');
  });
});

describe('ATC §3.4.1 auto-generated assignments (GROUND/TOWER)', () => {
  it('assignments are pre-generated as scheduled with deterministic ids, idempotently', () => {
    const { session } = tutorialSetup();
    const ids = Object.keys(session.assignments).sort();
    expect(ids).toEqual([
      assignmentId('traffic_1', 'takeoffRunway'),
      assignmentId('traffic_2', 'landingRunway'),
      assignmentId('traffic_2', 'standAssignment'),
      assignmentId('traffic_3', 'takeoffRunway'),
      assignmentId('traffic_4', 'landingRunway'),
      assignmentId('traffic_4', 'standAssignment'),
    ].sort());
    expect(Object.values(session.assignments).every((a) => a.status === 'scheduled')).toBe(true);
    const again = tutorialSetup();
    expect(Object.keys(again.session.assignments).sort()).toEqual(ids);
  });

  it('assignments activate on spawn and split into ground/tower queues', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 121);
    const ground = openQueueByRole(session, 'ground');
    const tower = openQueueByRole(session, 'tower');
    expect(ground.assignments.map((a) => a.kind)).toContain('standAssignment');
    expect(tower.assignments.map((a) => a.kind)).toContain('landingRunway');
    expect(tower.assignments.map((a) => a.kind)).toContain('takeoffRunway');
    // 将来便の割当は scheduled のまま
    const future = Object.values(session.assignments).filter((a) => a.status === 'scheduled');
    expect(future.length).toBeGreaterThan(0);
  });

  it('arrival cannot request landing before its runway assignment; stand is reserved once', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 121);
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
    expect(
      Object.values(session.requests).some((r) => r.aircraftId === arrival.id && r.kind === 'landing'),
    ).toBe(false);
    const rwy = session.assignments[assignmentId(arrival.trafficEntryId, 'landingRunway')]!;
    expect(assignRunway(session, scenario.airport, rwy.id, arrival.runwayId).ok).toBe(true);
    tickAtcSession(session, scenario, 1);
    expect(
      Object.values(session.requests).some((r) => r.aircraftId === arrival.id && r.kind === 'landing'),
    ).toBe(true);

    const stand = session.assignments[assignmentId(arrival.trafficEntryId, 'standAssignment')]!;
    const candidates = candidateStands(session, scenario.airport, arrival.id);
    expect(candidates.length).toBeGreaterThan(0);
    expect(assignStand(session, scenario.airport, stand.id, candidates[0]!).ok).toBe(true);
    expect(session.standReservations[candidates[0]!]).toBe(arrival.id);
    // 二重割当: 別の到着機の候補からそのスポットは消える
    tickAtcSession(session, scenario, 360);
    const arrival2 = Object.values(session.aircraft).find(
      (a) => a.kind === 'arrival' && a.id !== arrival.id,
    );
    expect(arrival2).toBeDefined();
    expect(candidateStands(session, scenario.airport, arrival2!.id)).not.toContain(candidates[0]);
  });

  it('assigning a non-candidate stand is refused without silent fallback', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 121);
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
    const stand = session.assignments[assignmentId(arrival.trafficEntryId, 'standAssignment')]!;
    const result = assignStand(session, scenario.airport, stand.id, 'std_does_not_exist');
    expect(result.ok).toBe(false);
    expect(session.assignments[stand.id]!.status).toBe('open');
  });
});

describe('ATC-06/07 physical movement', () => {
  it('departure starts at its stand node; pushback moves it to the stand link node', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    const net = getAtcNetwork(scenario.airport);
    tickAtcSession(session, scenario, 61);
    const dep = Object.values(session.aircraft).find((a) => a.kind === 'departure')!;
    expect(dep.position?.nodeId).toBe(standNodeId(dep.standId));
    const request = Object.values(session.requests).find(
      (r) => r.aircraftId === dep.id && r.status === 'open',
    )!;
    expect(request.kind).toBe('pushback');
    expect(issueClearance(session, scenario.airport, safety, {
      aircraftId: dep.id,
      requestId: request.id,
    }).ok).toBe(true);
    tickAtcSession(session, scenario, 70, { safety, airport: scenario.airport });
    expect(session.clearances[request.clearanceId!]!.status).toBe('completed');
    expect(dep.phase).toBe('pushback');
    expect(dep.movement).toBeNull();
    expect(dep.position?.nodeId).toBe(net.standLinks[dep.standId]);
  });

  it('position never changes without a clearance', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 600);
    for (const ac of Object.values(session.aircraft)) {
      expect(ac.movement).toBeNull();
      if (ac.kind === 'departure') {
        expect(ac.position?.nodeId).toBe(standNodeId(ac.standId));
      } else {
        expect(ac.position).toBeNull();
      }
    }
  });

  it('taxiOut progresses along a connected route and stops at a hold-short node', () => {
    const { scenario, session } = tutorialSetup();
    const net = getAtcNetwork(scenario.airport);
    const dep = () => Object.values(session.aircraft).find((a) => a.callsign === 'ANA101')!;
    let sawMoving = false;
    for (let t = 0; t < 2000; t++) {
      autoControl(session, scenario);
      tickAtcSession(session, scenario, 1, {
        safety: createSessionSafetyProvider(),
        airport: scenario.airport,
      });
      if (!Object.values(session.aircraft).some((a) => a.callsign === 'ANA101')) continue;
      if (dep().phase === 'holdShort') break;
      const mv = dep().movement;
      if (mv?.kind === 'taxiOut') {
        sawMoving = true;
        expect(mv.traveledM).toBeGreaterThanOrEqual(0);
        expect(mv.traveledM).toBeLessThanOrEqual(mv.totalLengthM);
        // 経路は実在エッジでつながっている
        for (let i = 0; i + 1 < mv.nodeIds.length; i++) {
          const edges = (net.outgoing[mv.nodeIds[i]!] ?? []).map((eid) => net.edges[eid]!);
          expect(
            edges.some((e) => e.to === mv.nodeIds[i + 1] || (e.bidirectional && e.from === mv.nodeIds[i + 1])),
          ).toBe(true);
        }
      }
    }
    expect(sawMoving).toBe(true);
    expect(dep().phase).toBe('holdShort');
    const pos = dep().position!.nodeId;
    const isHoldShort = Object.values(net.edges).some(
      (e) => e.holdShortAt?.nodeId === pos && e.holdShortAt.runwayId === dep().runwayId,
    );
    expect(isHoldShort).toBe(true);
  });

  it('planned taxiOut route is a connected sequence ending at a hold-short node', () => {
    const { scenario, session } = tutorialSetup();
    const net = getAtcNetwork(scenario.airport);
    tickAtcSession(session, scenario, 1);
    const dep = Object.values(session.aircraft).find((a) => a.kind === 'departure')!;
    const nodes = planRouteNodeIds(net, dep, 'taxiOut');
    expect(nodes).not.toBeNull();
    expect(nodes![0]).toBe(standNodeId(dep.standId));
    const last = nodes![nodes!.length - 1]!;
    expect(
      Object.values(net.edges).some(
        (e) => e.holdShortAt?.nodeId === last && e.holdShortAt.runwayId === dep.runwayId,
      ),
    ).toBe(true);
  });

  it('after the full flow, arrivals are at their stand node and departures on the runway', () => {
    const { scenario, session } = tutorialSetup();
    const net = getAtcNetwork(scenario.airport);
    runToFinish(session, scenario);
    expect(session.finished).toBe(true);
    for (const ac of Object.values(session.aircraft)) {
      expect(ac.movement).toBeNull();
      if (ac.kind === 'arrival') {
        expect(ac.position?.nodeId).toBe(standNodeId(ac.standId));
      } else {
        expect(net.runwayNodes[ac.runwayId]).toContain(ac.position?.nodeId);
      }
    }
  });

  it('an aircraft still on the runway during taxiIn blocks a line-up clearance', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    const net = getAtcNetwork(scenario.airport);
    tickAtcSession(session, scenario, 121);
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
    const dep = Object.values(session.aircraft).find((a) => a.kind === 'departure')!;
    const runwayNodes = net.runwayNodes[arrival.runwayId]!;
    arrival.phase = 'taxiIn';
    arrival.position = nodePosition(net, runwayNodes[runwayNodes.length - 1]!);
    dep.phase = 'holdShort';
    const id = 'req_manual_lineup';
    session.requests[id] = {
      id,
      aircraftId: dep.id,
      kind: 'lineUp',
      createdAtSec: session.clockSec,
      status: 'open',
    };
    dep.activeRequestId = id;
    const denied = issueClearance(session, scenario.airport, safety, {
      aircraftId: dep.id,
      requestId: id,
    });
    expect(denied.ok).toBe(false);
    expect(denied.reasons).toContain('runway-occupied');
  });

  it('movement state survives save/load mid-execution and finishes identically', () => {
    const a = tutorialSetup();
    runToFinish(a.session, a.scenario);

    const b = tutorialSetup();
    const safety = createSessionSafetyProvider();
    for (let t = 0; t < 1200; t++) {
      autoControl(b.session, b.scenario);
      tickAtcSession(b.session, b.scenario, 1, { safety, airport: b.scenario.airport });
      if (Object.values(b.session.aircraft).some((ac) => ac.movement && ac.movement.traveledM > 0)) break;
    }
    expect(
      Object.values(b.session.aircraft).some((ac) => ac.movement && ac.movement.traveledM > 0),
    ).toBe(true);
    const parsed = parseAtcSessionFile(JSON.stringify(serializeAtcSession(b.scenario, b.session)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    runToFinish(parsed.file.session, parsed.file.scenario);
    expect(atcSessionDigest(parsed.file.session)).toBe(atcSessionDigest(a.session));
  });
});

describe('ATC-10 persistence', () => {
  it('save -> load -> continue matches the uninterrupted run', () => {
    const a = tutorialSetup();
    runToFinish(a.session, a.scenario);

    const b = tutorialSetup();
    const safety = createSessionSafetyProvider();
    for (let t = 0; t < 200 && !b.session.finished; t++) {
      autoControl(b.session, b.scenario);
      tickAtcSession(b.session, b.scenario, 1, { safety, airport: b.scenario.airport });
    }
    const parsed = parseAtcSessionFile(JSON.stringify(serializeAtcSession(b.scenario, b.session)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    runToFinish(parsed.file.session, parsed.file.scenario);
    expect(atcSessionDigest(parsed.file.session)).toBe(atcSessionDigest(a.session));
  });

  it('rejects a management project file and corrupted references', () => {
    const management = parseAtcSessionFile(JSON.stringify({ layout: {}, company: {} }));
    expect(management).toEqual({ ok: false, errors: ['management-project-file'] });

    const { scenario, session } = tutorialSetup();
    const file = serializeAtcSession(scenario, session);
    const bad = JSON.parse(JSON.stringify(file)) as typeof file;
    bad.session.aircraft['ac_x'] = {
      ...Object.values(bad.session.aircraft)[0]!,
      id: 'ac_x',
      runwayId: 'rwy_missing',
    };
    // traffic 由来でない航空機はスポーン整合の対象外だが、滑走路参照は検証される
    const result = parseAtcSessionFile(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith('unknown-runway'))).toBe(true);
  });
});

/**
 * 横断テスト用レイアウト: 平行滑走路2本（rwy_1 が北、rwy_2 が南）。
 * スポットは rwy_2 の南側にあり、rwy_1 との地上走行は必ず rwy_2 を横断する。
 * 横断誘導路は x=62 と x=20 の2本（経路変更の代替経路になる）。
 *
 *   y=30 ═══ rwy_1 ═══
 *   y=38 ─── 誘導路A ───
 *        │(x=20)  │(x=62)   ← rwy_2 横断誘導路
 *   y=46 ═══ rwy_2 ═══
 *   y=55 ─── 誘導路B ───  [スポット]
 */
function createCrossingAirfield(): AirportLayout {
  let layout = createEmptyLayout(createSite({ seed: 'atc-crossing' }), '横断テスト空港');
  const run = (r: OpResult): string[] => {
    if (!r.ok) throw new Error(`crossing generation failed: ${r.reason}`);
    layout = r.layout;
    return r.created;
  };
  run(placeRunway(layout, { x: 20, y: 30 }, 90, 84, { surfaceWidthM: 45, name: 'A' }));
  run(placeRunway(layout, { x: 20, y: 46 }, 90, 84, { surfaceWidthM: 45, name: 'B' }));
  run(addTaxiwayPath(layout, [{ x: 20, y: 38 }, { x: 104, y: 38 }], { widthClass: 'M', name: 'A' }));
  for (const x of [20, 62, 104]) {
    run(addTaxiwayPath(layout, [{ x, y: 30 }, { x, y: 38 }], { widthClass: 'M', name: `A${x}` }));
  }
  for (const x of [20, 62]) {
    run(addTaxiwayPath(layout, [{ x, y: 38 }, { x, y: 46 }], { widthClass: 'M', name: `C${x}a` }));
    run(addTaxiwayPath(layout, [{ x, y: 46 }, { x, y: 55 }], { widthClass: 'M', name: `C${x}b` }));
  }
  run(addTaxiwayPath(layout, [{ x: 20, y: 55 }, { x: 62, y: 55 }], { widthClass: 'M', name: 'B' }));
  run(placeFacility(layout, 'apron', { x: 40, y: 55 }, { w: 26, h: 10 }));
  for (let i = 0; i < 3; i++) {
    run(placeStand(layout, { x: 48 + i * 5, y: 56 }, 'M', 180, 'operational', String(i + 1)));
  }
  return layout;
}

function crossingSetup(
  traffic: AtcScenarioDefinition['traffic'],
): { scenario: AtcScenarioDefinition; session: AtcSessionState } {
  const layout = createCrossingAirfield();
  const snapshot = createAtcAirportSnapshot(layout, { id: 'snap_cross', capturedAtIso });
  const diagnostics = diagnoseAtcAirport(snapshot);
  expect(diagnostics.errors).toEqual([]);
  const scenario: AtcScenarioDefinition = {
    id: 'atc-crossing-1',
    name: '滑走路横断',
    airport: snapshot,
    durationSec: 3600,
    seed: 'atc-crossing-1',
    traffic,
  };
  return { scenario, session: createAtcSession(scenario) };
}

const crossingDeparture = {
  id: 'cx_dep',
  callsign: 'CXD101',
  aircraftTypeId: 'B737-800',
  size: 'M' as const,
  kind: 'departure' as const,
  runwayId: 'rwy_1',
  standId: 'std_1',
  atSec: 0,
  readyDelaySec: 0,
};

const crossingArrival = {
  id: 'cx_arr',
  callsign: 'CXA202',
  aircraftTypeId: 'B737-800',
  size: 'M' as const,
  kind: 'arrival' as const,
  runwayId: 'rwy_1',
  standId: 'std_1',
  atSec: 0,
};

/** 横断ゲートで停止するまで autoControl で進める */
function runUntilCrossingGate(
  session: AtcSessionState,
  scenario: AtcScenarioDefinition,
  aircraftId: string,
): void {
  const safety = createSessionSafetyProvider();
  for (let t = 0; t < 2000; t++) {
    autoControl(session, scenario);
    tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
    const ac = session.aircraft[aircraftId]!;
    if (ac.movement && isMovementBlocked(ac.movement)) return;
  }
  throw new Error('aircraft never reached a crossing gate');
}

describe('ATC-06 runway crossing requests', () => {
  it('departure stops before the crossed runway until the crossing is approved, then completes', () => {
    const { scenario, session } = crossingSetup([crossingDeparture]);
    const safety = createSessionSafetyProvider();
    const net = getAtcNetwork(scenario.airport);
    runUntilCrossingGate(session, scenario, 'ac_cx_dep');
    const dep = session.aircraft['ac_cx_dep']!;
    const movement = dep.movement!;
    expect(movement.kind).toBe('taxiOut');
    expect(movement.crossings).toHaveLength(1);
    const crossing = movement.crossings![0]!;
    expect(crossing.runwayId).toBe('rwy_2');
    expect(crossing.status).toBe('waiting');
    // 要求は決定的IDで GROUND キューに1件だけ生成されている
    expect(crossing.requestId).toBe(
      crossingRequestId(dep.id, 'taxiOut', 'rwy_2', crossing.holdNodeId),
    );
    const crossingRequests = Object.values(session.requests).filter((r) => r.kind === 'runwayCrossing');
    expect(crossingRequests).toHaveLength(1);
    expect(crossingRequests[0]!.status).toBe('open');
    expect(openQueueByRole(session, 'ground').requestIds).toContain(crossing.requestId);
    expect(openQueueByRole(session, 'tower').requestIds).not.toContain(crossing.requestId);
    // 停止位置は滑走路手前のノードで、滑走路 rwy_2 上には入っていない
    expect(dep.position?.nodeId).toBe(crossing.holdNodeId);
    expect(net.nodes[dep.position!.nodeId]!.runwayIds).not.toContain('rwy_2');
    expect(movement.traveledM).toBeCloseTo(crossing.stopAtM, 6);
    // 承認なしでは時間が進んでも進まない・完了しない
    const stoppedAt = movement.traveledM;
    for (let t = 0; t < 60; t++) {
      autoControl(session, scenario);
      tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
    }
    expect(dep.movement!.traveledM).toBe(stoppedAt);
    expect(dep.phase).not.toBe('holdShort');
    expect(Object.values(session.requests).filter((r) => r.kind === 'runwayCrossing')).toHaveLength(1);
    // 横断要求は通常の却下では消せない
    expect(rejectRequest(session, crossing.requestId).ok).toBe(false);
    // 承認すると横断して走行を完了し、最後まで運航できる
    expect(approveCrossing(session, scenario.airport, safety, { requestId: crossing.requestId }).ok).toBe(true);
    expect(session.requests[crossing.requestId]!.status).toBe('cleared');
    runToFinish(session, scenario);
    expect(session.finished).toBe(true);
    expect(session.score.departuresHandled).toBe(1);
  });

  it('crossing approval is denied while the crossed runway is occupied', () => {
    const { scenario, session } = crossingSetup([crossingDeparture]);
    const safety = createSessionSafetyProvider();
    runUntilCrossingGate(session, scenario, 'ac_cx_dep');
    const dep = session.aircraft['ac_cx_dep']!;
    const crossing = dep.movement!.crossings![0]!;
    // rwy_2 を占有する別機を置く（段階ベース占有）
    const intruder: AtcAircraft = {
      ...dep,
      id: 'ac_intruder',
      callsign: 'INT999',
      phase: 'takeoffRoll',
      runwayId: 'rwy_2',
      movement: null,
      position: null,
    };
    session.aircraft[intruder.id] = intruder;
    const denied = approveCrossing(session, scenario.airport, safety, {
      requestId: crossing.requestId,
    });
    expect(denied.ok).toBe(false);
    expect(denied.reasons).toContain('runway-occupied');
    expect(session.requests[crossing.requestId]!.status).toBe('open');
    expect(dep.movement!.crossings![0]!.status).toBe('waiting');
    delete session.aircraft[intruder.id];
    expect(approveCrossing(session, scenario.airport, safety, { requestId: crossing.requestId }).ok).toBe(true);
  });

  it('arrival taxiIn crosses with a gate; leaving the landing runway needs no crossing', () => {
    const { scenario, session } = crossingSetup([crossingArrival]);
    const safety = createSessionSafetyProvider();
    runUntilCrossingGate(session, scenario, 'ac_cx_arr');
    const arr = session.aircraft['ac_cx_arr']!;
    expect(arr.movement!.kind).toBe('taxiIn');
    const crossings = Object.values(session.requests).filter((r) => r.kind === 'runwayCrossing');
    // 横断要求は rwy_2 の分だけ。着陸した rwy_1 からの離脱には要求が出ない
    expect(crossings).toHaveLength(1);
    expect(arr.movement!.crossings![0]!.runwayId).toBe('rwy_2');
    expect(arr.position?.nodeId).toBe(arr.movement!.crossings![0]!.holdNodeId);
    expect(
      approveCrossing(session, scenario.airport, safety, { requestId: crossings[0]!.id }).ok,
    ).toBe(true);
    runToFinish(session, scenario);
    expect(session.finished).toBe(true);
    expect(session.score.arrivalsHandled).toBe(1);
    expect(arr.position?.nodeId).toBe(standNodeId('std_1'));
    void safety;
  });

  it('crossing wait survives save/load and the run stays deterministic', () => {
    const runScript = (saveLoadAtGate: boolean): AtcSessionState => {
      const { scenario, session } = crossingSetup([crossingDeparture]);
      const safety = createSessionSafetyProvider();
      let sess = session;
      let scen = scenario;
      let saved = false;
      for (let t = 0; t < 3600 && !sess.finished; t++) {
        autoControl(sess, scen);
        const req = Object.values(sess.requests).find(
          (r) => r.kind === 'runwayCrossing' && r.status === 'open',
        );
        const ac = req ? sess.aircraft[req.aircraftId] : undefined;
        if (req && ac?.movement && isMovementBlocked(ac.movement)) {
          if (saveLoadAtGate && !saved) {
            const parsed = parseAtcSessionFile(JSON.stringify(serializeAtcSession(scen, sess)));
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) throw new Error('parse failed');
            sess = parsed.file.session;
            scen = parsed.file.scenario;
            saved = true;
            // 復元後も横断ゲートと要求が保持されている
            const restored = sess.aircraft[ac.id]!;
            expect(restored.movement!.crossings![0]!.status).toBe('waiting');
            expect(sess.requests[req.id]!.status).toBe('open');
          }
          expect(
            approveCrossing(sess, scen.airport, safety, { requestId: req.id }).ok,
          ).toBe(true);
        }
        tickAtcSession(sess, scen, 1, { safety, airport: scen.airport });
      }
      return sess;
    };
    const plain = runScript(false);
    const restored = runScript(true);
    expect(plain.finished).toBe(true);
    expect(atcSessionDigest(restored)).toBe(atcSessionDigest(plain));
  });
});

describe('ATC-06 hold and resume', () => {
  it('hold freezes a taxiing aircraft, wait accumulates, resume continues the route', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 61);
    const dep = Object.values(session.aircraft).find((a) => a.kind === 'departure')!;
    // 移動がなければ停止指示は受け付けない
    expect(holdAircraft(session, scenario.airport, dep.id).reasons).toContain('no-active-movement');
    // taxiOut の移動中まで進める
    for (let t = 0; t < 2000; t++) {
      autoControl(session, scenario);
      tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
      if (dep.movement?.kind === 'taxiOut' && dep.movement.traveledM > 0) break;
    }
    expect(dep.movement?.kind).toBe('taxiOut');
    // 滑走路上にいる間は停止できない（位置を滑走路ノードへ置いて確認）
    const net = getAtcNetwork(scenario.airport);
    const savedPosition = dep.position;
    dep.position = nodePosition(net, net.runwayNodes[dep.runwayId]![0]!);
    expect(holdAircraft(session, scenario.airport, dep.id).reasons).toContain('unsafe-hold-position');
    dep.position = savedPosition;
    // 停止 → 位置が進まず、待機時間が累積する
    expect(holdAircraft(session, scenario.airport, dep.id).ok).toBe(true);
    expect(holdAircraft(session, scenario.airport, dep.id).reasons).toContain('already-held');
    const frozenM = dep.movement!.traveledM;
    const frozenPos = { ...dep.position! };
    const waitBefore = dep.totalWaitSec;
    for (let t = 0; t < 20; t++) {
      tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
    }
    expect(dep.movement!.traveledM).toBe(frozenM);
    expect(dep.position).toEqual(frozenPos);
    expect(dep.totalWaitSec).toBeGreaterThan(waitBefore);
    // 再開 → 残り経路を進み、最後まで完了する
    expect(resumeAircraft(session, dep.id).ok).toBe(true);
    expect(resumeAircraft(session, dep.id).reasons).toContain('not-held');
    tickAtcSession(session, scenario, 5, { safety, airport: scenario.airport });
    expect(dep.movement === null || dep.movement.traveledM > frozenM).toBe(true);
    runToFinish(session, scenario);
    expect(session.finished).toBe(true);
  });
});

describe('ATC-06 reroute', () => {
  it('pre-movement reroute stores a planned route that execution uses', () => {
    const { scenario, session } = crossingSetup([crossingDeparture]);
    const safety = createSessionSafetyProvider();
    const net = getAtcNetwork(scenario.airport);
    const dep = () => session.aircraft['ac_cx_dep']!;
    // taxiOut 要求が出るまで進める（プッシュバック完了後）
    for (let t = 0; t < 2000; t++) {
      autoControl(session, scenario);
      tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
      const req = dep().activeRequestId ? session.requests[dep().activeRequestId!] : undefined;
      if (req?.kind === 'taxiOut' && req.status === 'open') break;
    }
    const defaultRoute = planRouteNodeIds(net, dep(), 'taxiOut')!;
    const crossedNode = defaultRoute.find((n) => net.nodes[n]!.runwayIds.includes('rwy_2'))!;
    const defaultHoldNode = defaultRoute[defaultRoute.indexOf(crossedNode) - 1]!;
    const otherCrossNode = Object.values(net.nodes)
      .filter((n) => n.runwayIds.includes('rwy_2') && n.id !== crossedNode)
      .map((n) => n.id);
    // 両方の横断ノードを避けると経路が取れず、変更は拒否される
    const failed = rerouteAircraft(session, scenario.airport, dep().id, {
      avoidNodeIds: [crossedNode, ...otherCrossNode],
    });
    expect(failed.ok).toBe(false);
    expect(failed.reasons).toContain('no-route');
    expect(dep().plannedRoute ?? null).toBeNull();
    // 既定の横断ノードを避けると代替経路（もう一方の横断誘導路）が保存される
    const ok = rerouteAircraft(session, scenario.airport, dep().id, {
      avoidNodeIds: [crossedNode],
    });
    expect(ok.ok).toBe(true);
    expect(ok.changed).toBe(true);
    expect(ok.nodeIds).not.toContain(crossedNode);
    expect(dep().plannedRoute?.nodeIds).toEqual(ok.nodeIds);
    // 実行すると保存した経路が使われ、横断要求も代替側で生成される
    for (let t = 0; t < 2000; t++) {
      autoControl(session, scenario);
      tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
      if (dep().movement?.kind === 'taxiOut') break;
    }
    expect(dep().movement!.nodeIds).toEqual(ok.nodeIds);
    expect(dep().movement!.crossings![0]!.holdNodeId).not.toBe(defaultHoldNode);
    const req = Object.values(session.requests).find((r) => r.kind === 'runwayCrossing')!;
    expect(req).toBeDefined();
    expect(dep().movement!.crossings![0]!.requestId).toBe(req.id);
  });

  it('mid-movement reroute replaces the remaining route and re-issues crossing gates', () => {
    const { scenario, session } = crossingSetup([crossingDeparture]);
    const safety = createSessionSafetyProvider();
    const net = getAtcNetwork(scenario.airport);
    const dep = () => session.aircraft['ac_cx_dep']!;
    // taxiOut 移動開始直後まで進める
    let oldCrossingId = '';
    for (let t = 0; t < 2000; t++) {
      autoControl(session, scenario);
      tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
      const mv = dep().movement;
      if (mv?.kind === 'taxiOut' && mv.traveledM > 0) {
        oldCrossingId = mv.crossings![0]!.requestId;
        break;
      }
    }
    expect(oldCrossingId).not.toBe('');
    const oldRoute = [...dep().movement!.nodeIds];
    const crossedNode = oldRoute.find((n) => net.nodes[n]!.runwayIds.includes('rwy_2'))!;
    // 経路が取れない回避指定は拒否され、元の経路が維持される
    const allCrossNodes = Object.values(net.nodes)
      .filter((n) => n.runwayIds.includes('rwy_2'))
      .map((n) => n.id);
    const failed = rerouteAircraft(session, scenario.airport, dep().id, {
      avoidNodeIds: allCrossNodes,
    });
    expect(failed.ok).toBe(false);
    expect(dep().movement!.nodeIds).toEqual(oldRoute);
    // 既定の横断ノードを避けて再計画すると残り経路が差し替わる
    const ok = rerouteAircraft(session, scenario.airport, dep().id, {
      avoidNodeIds: [crossedNode],
    });
    expect(ok.ok).toBe(true);
    expect(ok.changed).toBe(true);
    expect(dep().movement!.nodeIds).not.toContain(crossedNode);
    expect(dep().movement!.nodeIds[dep().movement!.nodeIds.length - 1]).toBe(
      oldRoute[oldRoute.length - 1],
    );
    // 旧横断要求は cancelled、新しい横断要求が open で生成される
    expect(session.requests[oldCrossingId]!.status).toBe('cancelled');
    const newCrossing = dep().movement!.crossings![0]!;
    expect(newCrossing.requestId).not.toBe(oldCrossingId);
    expect(session.requests[newCrossing.requestId]!.status).toBe('open');
    // 新しいゲートで停止し、承認後に完了まで進める
    for (let t = 0; t < 2000; t++) {
      tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
      const mv = dep().movement;
      if (mv && isMovementBlocked(mv)) break;
    }
    expect(dep().position?.nodeId).toBe(newCrossing.holdNodeId);
    expect(
      approveCrossing(session, scenario.airport, safety, { requestId: newCrossing.requestId }).ok,
    ).toBe(true);
    runToFinish(session, scenario);
    expect(session.finished).toBe(true);
  });

  it('reroute with no active movement or request is refused', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 121);
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
    // 到着機は割当待ちで要求も移動もない
    const result = rerouteAircraft(session, scenario.airport, arrival.id);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('nothing-to-reroute');
  });
});

/** 割当だけを推奨候補で確定する（許可は出さない） */
function assignAll(session: AtcSessionState, scenario: AtcScenarioDefinition): void {
  for (const a of Object.values(session.assignments).filter((x) => x.status === 'open')) {
    if (a.aircraftId === null) continue;
    if (a.kind === 'standAssignment') {
      const c = candidateStands(session, scenario.airport, a.aircraftId);
      if (c[0]) assignStand(session, scenario.airport, a.id, c[0]);
    } else {
      const c = candidateRunways(session, scenario.airport, a.aircraftId);
      if (c[0]) assignRunway(session, scenario.airport, a.id, c[0]);
    }
  }
}

/** 到着機を着陸許可の実行開始（finalApproach）まで進める */
function driveToFinalApproach(
  session: AtcSessionState,
  scenario: AtcScenarioDefinition,
  aircraftId: string,
): { requestId: string; clearanceId: string } {
  const safety = createSessionSafetyProvider();
  assignAll(session, scenario);
  tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
  const request = Object.values(session.requests).find(
    (r) => r.aircraftId === aircraftId && r.kind === 'landing' && r.status === 'open',
  );
  expect(request).toBeDefined();
  const issued = issueClearance(session, scenario.airport, safety, {
    aircraftId,
    requestId: request!.id,
  });
  expect(issued.ok).toBe(true);
  tickAtcSession(session, scenario, 6, { safety, airport: scenario.airport });
  expect(session.aircraft[aircraftId]!.phase).toBe('finalApproach');
  return { requestId: request!.id, clearanceId: issued.clearance!.id };
}

describe('ATC-07 go-around', () => {
  it('go-around releases clearance, runway and assignment; requests regenerate deterministically', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    const net = getAtcNetwork(scenario.airport);
    tickAtcSession(session, scenario, 121);
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
    const { requestId, clearanceId } = driveToFinalApproach(session, scenario, arrival.id);
    // 実行中: 滑走路上に位置し、移動を持っている
    expect(arrival.movement).not.toBeNull();
    expect(net.runwayNodes[arrival.runwayId]).toContain(arrival.position?.nodeId);

    const result = goAroundAircraft(session, arrival.id);
    expect(result.ok).toBe(true);
    // 後片付け: 許可・要求は cancelled、割当は再オープン、位置と移動は消える
    expect(session.clearances[clearanceId]!.status).toBe('cancelled');
    expect(session.requests[requestId]!.status).toBe('cancelled');
    expect(arrival.activeClearanceId).toBeNull();
    expect(arrival.activeRequestId).toBeNull();
    expect(arrival.phase).toBe('inbound');
    expect(arrival.position).toBeNull();
    expect(arrival.movement).toBeNull();
    expect(arrival.goAroundCount).toBe(1);
    const rwyAssignment = session.assignments[assignmentId(arrival.trafficEntryId, 'landingRunway')]!;
    expect(rwyAssignment.status).toBe('open');
    expect(rwyAssignment.assignedId).toBeUndefined();
    // スポット割当と予約は再進入のために維持される
    const standAssignment = session.assignments[assignmentId(arrival.trafficEntryId, 'standAssignment')]!;
    expect(standAssignment.status).toBe('assigned');
    expect(session.standReservations[arrival.standId]).toBe(arrival.id);
    // 漏れ確認: この機体に起因する滑走路占有・予約が残っていない
    expect(
      Object.values(session.clearances).some(
        (c) =>
          c.aircraftId === arrival.id &&
          (c.status === 'issued' || c.status === 'readback' || c.status === 'executing'),
      ),
    ).toBe(false);
    expect(session.events.some((e) => e.kind === 'goAround' && e.aircraftId === arrival.id)).toBe(true);

    // 再生成: RWY を再割当しても、再要求間隔（30秒）が過ぎるまでは要求が出ない
    expect(assignRunway(session, scenario.airport, rwyAssignment.id, arrival.runwayId).ok).toBe(true);
    tickAtcSession(session, scenario, 10, { safety, airport: scenario.airport });
    expect(
      Object.values(session.requests).some(
        (r) => r.aircraftId === arrival.id && r.kind === 'landing' && r.status === 'open',
      ),
    ).toBe(false);
    tickAtcSession(session, scenario, 25, { safety, airport: scenario.airport });
    const regenerated = Object.values(session.requests).filter(
      (r) => r.aircraftId === arrival.id && r.kind === 'landing' && r.status === 'open',
    );
    expect(regenerated).toHaveLength(1);
    expect(regenerated[0]!.id).not.toBe(requestId);
    // 再進入して最後まで着陸できる（復行は1回だけ数える）
    runToFinish(session, scenario);
    expect(session.finished).toBe(true);
    expect(session.score.arrivalsHandled).toBe(2);
    expect(arrival.completedAtSec).not.toBeNull();
    expect(arrival.goAroundCount).toBe(1);
  });

  it('go-around also aborts an issued (not yet executing) landing clearance', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 121);
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
    assignAll(session, scenario);
    tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
    const request = Object.values(session.requests).find(
      (r) => r.aircraftId === arrival.id && r.kind === 'landing' && r.status === 'open',
    )!;
    const issued = issueClearance(session, scenario.airport, safety, {
      aircraftId: arrival.id,
      requestId: request.id,
    });
    expect(issued.ok).toBe(true);
    expect(session.clearances[issued.clearance!.id]!.status).toBe('issued');
    expect(goAroundAircraft(session, arrival.id).ok).toBe(true);
    expect(session.clearances[issued.clearance!.id]!.status).toBe('cancelled');
    expect(arrival.phase).toBe('inbound');
    expect(arrival.goAroundCount).toBe(1);
  });

  it('go-around is refused for departures, un-cleared arrivals, and after touchdown', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 121);
    const dep = Object.values(session.aircraft).find((a) => a.kind === 'departure')!;
    expect(goAroundAircraft(session, dep.id).reasons).toContain('go-around-not-applicable');
    expect(goAroundAircraft(session, 'ac_missing').reasons).toContain('aircraft-not-found');
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
    // 着陸許可がない進入中の到着機は打ち切る対象がない
    expect(goAroundAircraft(session, arrival.id).reasons).toContain('no-landing-clearance');
    // 接地後（landingRoll）は復行できない
    driveToFinalApproach(session, scenario, arrival.id);
    tickAtcSession(session, scenario, 120, { safety, airport: scenario.airport });
    expect(arrival.phase).toBe('landingRoll');
    expect(goAroundAircraft(session, arrival.id).reasons).toContain('go-around-not-applicable');
    expect(arrival.goAroundCount).toBe(0);
  });

  it('go-around state survives save/load and the continued run is identical', () => {
    const script = (saveLoad: boolean): AtcSessionState => {
      const { scenario, session } = tutorialSetup();
      tickAtcSession(session, scenario, 121);
      const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
      driveToFinalApproach(session, scenario, arrival.id);
      expect(goAroundAircraft(session, arrival.id).ok).toBe(true);
      // 順序も設定しておき、保存対象に含まれることをあわせて確認する
      expect(setArrivalSequence(session, [arrival.id]).ok).toBe(true);
      if (!saveLoad) {
        runToFinish(session, scenario);
        return session;
      }
      const parsed = parseAtcSessionFile(JSON.stringify(serializeAtcSession(scenario, session)));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('parse failed');
      const loaded = parsed.file.session;
      const loadedArrival = loaded.aircraft[arrival.id]!;
      expect(loadedArrival.goAroundCount).toBe(1);
      expect(loadedArrival.phase).toBe('inbound');
      expect(loaded.arrivalSequence).toEqual([arrival.id]);
      runToFinish(loaded, parsed.file.scenario);
      return loaded;
    };
    const uninterrupted = script(false);
    const restored = script(true);
    expect(atcSessionDigest(restored)).toBe(atcSessionDigest(uninterrupted));
  });
});

describe('ATC-07 arrival sequencing', () => {
  it('recommended order is by scheduled arrival; set/move validate and reorder', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 481);
    const arr1 = session.aircraft['ac_traffic_2']!;
    const arr2 = session.aircraft['ac_traffic_4']!;
    expect(arr1.phase).toBe('inbound');
    expect(arr2.phase).toBe('inbound');
    // 推奨順序は予定到着時刻順（120秒の便が 480秒の便より先）
    expect(recommendedArrivalSequence(session)).toEqual([arr1.id, arr2.id]);
    expect(effectiveArrivalSequence(session)).toEqual([arr1.id, arr2.id]);
    // 管制官が順序を入れ替える
    const set = setArrivalSequence(session, [arr2.id, arr1.id]);
    expect(set.ok).toBe(true);
    expect(set.sequence).toEqual([arr2.id, arr1.id]);
    expect(session.arrivalSequence).toEqual([arr2.id, arr1.id]);
    // 前後入れ替えで元に戻る
    const moved = moveArrivalInSequence(session, arr2.id, 1);
    expect(moved.ok).toBe(true);
    expect(moved.sequence).toEqual([arr1.id, arr2.id]);
    // バリデーション: 重複・不存在・出発機は拒否
    expect(setArrivalSequence(session, [arr1.id, arr1.id]).reasons).toContain('duplicate-aircraft');
    expect(setArrivalSequence(session, ['ac_missing']).reasons).toContain('aircraft-not-found');
    expect(setArrivalSequence(session, ['ac_traffic_1']).reasons).toContain('not-arrival');
    expect(moveArrivalInSequence(session, 'ac_traffic_1', 1).reasons).toContain('not-arrival');
    // 空配列で順序を解除できる
    expect(setArrivalSequence(session, []).ok).toBe(true);
    expect(session.arrivalSequence).toEqual([]);
    void scenario;
  });

  it('landing clearance for a follower is denied until the leader resolves; go-around resolves it', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 481);
    assignAll(session, scenario);
    tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
    const arr1 = session.aircraft['ac_traffic_2']!;
    const arr2 = session.aircraft['ac_traffic_4']!;
    const landingRequestOf = (aircraftId: string) =>
      Object.values(session.requests).find(
        (r) => r.aircraftId === aircraftId && r.kind === 'landing' && r.status === 'open',
      )!;
    expect(landingRequestOf(arr1.id)).toBeDefined();
    expect(landingRequestOf(arr2.id)).toBeDefined();
    // JAL404（arr2）を先行に設定する
    expect(setArrivalSequence(session, [arr2.id, arr1.id]).ok).toBe(true);
    // 後続の arr1 への着陸許可は順序制約で拒否される
    const denied = issueClearance(session, scenario.airport, safety, {
      aircraftId: arr1.id,
      requestId: landingRequestOf(arr1.id).id,
    });
    expect(denied.ok).toBe(false);
    expect(denied.reasons).toContain('arrival-sequence-blocked');
    // 先行の arr2 は許可できる
    const lead = issueClearance(session, scenario.airport, safety, {
      aircraftId: arr2.id,
      requestId: landingRequestOf(arr2.id).id,
    });
    expect(lead.ok).toBe(true);
    // arr2 が復行すると列の末尾へ移り、arr1 が先行になって許可が通る
    tickAtcSession(session, scenario, 6, { safety, airport: scenario.airport });
    expect(arr2.phase).toBe('finalApproach');
    expect(goAroundAircraft(session, arr2.id).ok).toBe(true);
    expect(effectiveArrivalSequence(session)).toEqual([arr1.id, arr2.id]);
    const after = issueClearance(session, scenario.airport, safety, {
      aircraftId: arr1.id,
      requestId: landingRequestOf(arr1.id).id,
    });
    expect(after.ok).toBe(true);
  });

  it('without an explicit sequence, a later arrival can be cleared first (backward compatible)', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 481);
    assignAll(session, scenario);
    tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
    const arr2 = session.aircraft['ac_traffic_4']!;
    const request = Object.values(session.requests).find(
      (r) => r.aircraftId === arr2.id && r.kind === 'landing' && r.status === 'open',
    )!;
    const issued = issueClearance(session, scenario.airport, safety, {
      aircraftId: arr2.id,
      requestId: request.id,
    });
    expect(issued.ok).toBe(true);
  });

  it('sequence survives save/load and still gates clearances after restore', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 481);
    assignAll(session, scenario);
    tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
    const arr1 = session.aircraft['ac_traffic_2']!;
    const arr2 = session.aircraft['ac_traffic_4']!;
    expect(setArrivalSequence(session, [arr2.id, arr1.id]).ok).toBe(true);
    const parsed = parseAtcSessionFile(JSON.stringify(serializeAtcSession(scenario, session)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const loaded = parsed.file.session;
    expect(loaded.arrivalSequence).toEqual([arr2.id, arr1.id]);
    const request = Object.values(loaded.requests).find(
      (r) => r.aircraftId === arr1.id && r.kind === 'landing' && r.status === 'open',
    )!;
    const denied = issueClearance(loaded, parsed.file.scenario.airport, safety, {
      aircraftId: arr1.id,
      requestId: request.id,
    });
    expect(denied.ok).toBe(false);
    expect(denied.reasons).toContain('arrival-sequence-blocked');
  });
});

describe('ATC-09 scoring report', () => {
  it('report is deterministic and consistent with the session score', () => {
    const { scenario, session } = tutorialSetup();
    runToFinish(session, scenario);
    const report = buildAtcReport(session);
    expect(buildAtcReport(session)).toEqual(report);
    // 集計は session.score（ダイジェスト対象）と一致する
    expect(report.throughput.arrivalsHandled).toBe(session.score.arrivalsHandled);
    expect(report.throughput.departuresHandled).toBe(session.score.departuresHandled);
    expect(report.throughput.clearancesIssued).toBe(session.score.clearancesIssued);
    expect(report.throughput.totalWaitSec).toBe(session.score.totalWaitSec);
    expect(report.throughput.totalWaitSec).toBe(
      Object.values(session.aircraft).reduce((sum, a) => sum + a.totalWaitSec, 0),
    );
    expect(report.throughput.aircraftHandled).toBe(4);
    expect(report.throughput.aircraftSpawned).toBe(4);
    expect(report.throughput.completionRatio).toBe(1);
    expect(report.throughput.maxWaitSec).toBeGreaterThan(0);
    expect(report.throughput.avgWaitSecPerHandled).toBeGreaterThan(0);
    // 時間帯別バケットの合計は全体と一致する
    const hourly = report.throughput.hourly;
    expect(hourly.length).toBeGreaterThan(0);
    expect(hourly.reduce((s, b) => s + b.arrivalsHandled + b.departuresHandled, 0)).toBe(4);
    expect(hourly.reduce((s, b) => s + b.clearancesIssued, 0)).toBe(session.score.clearancesIssued);
    expect(report.throughput.peakHourlyClearances).toBe(
      Math.max(...hourly.map((b) => b.clearancesIssued)),
    );
    // 応答時間は許可が発行された要求から導出される
    expect(report.throughput.response.count).toBeGreaterThan(0);
    expect(report.throughput.response.maxSec).toBeGreaterThanOrEqual(report.throughput.response.avgSec);
    expect(report.safety.goArounds).toBe(0);
    expect(report.safety.clearancesExpired).toBe(session.score.clearancesExpired);
    expect(report.safety.requestsRejected).toBe(session.score.requestsRejected);
    // 保存→復元しても同じレポートになる
    const parsed = parseAtcSessionFile(JSON.stringify(serializeAtcSession(scenario, session)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(buildAtcReport(parsed.file.session)).toEqual(report);
  });

  it('empty session report is zeroed, clean, and uncapped', () => {
    const { session } = tutorialSetup();
    const report = buildAtcReport(session);
    expect(report.safety.rating).toBe('clean');
    expect(report.safety.safetyDenials).toBe(0);
    expect(report.throughput.score).toBe(0);
    expect(report.throughput.hourly).toEqual([]);
    expect(report.overall.grade).toBe('D');
    expect(report.overall.cappedBySafety).toBe(false);
  });

  it('safety is separated: denials change only the safety section and cap the grade', () => {
    const { scenario, session } = tutorialSetup();
    runToFinish(session, scenario);
    const base = buildAtcReport(session);
    const cloneWith = (mutate: (s: AtcSessionState) => void): AtcSessionState => {
      const parsed = parseAtcSessionFile(JSON.stringify(serializeAtcSession(scenario, session)));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('parse failed');
      mutate(parsed.file.session);
      return parsed.file.session;
    };
    // 安全拒否を消しても処理能力の数値は一切変わらない（相殺しない）
    const noDenials = buildAtcReport(cloneWith((s) => { s.score.safetyDenials = 0; }));
    expect(noDenials.throughput).toEqual(base.throughput);
    expect(noDenials.safety.safetyDenials).toBe(0);
    expect(noDenials.safety.rating).not.toBe('denials');
    expect(noDenials.overall.throughputScore).toBe(base.overall.throughputScore);
    // 安全拒否を増やすと rating が denials になり、グレードは C で頭打ちになる。
    // スコア自体は書き換わらない
    const moreDenials = buildAtcReport(cloneWith((s) => { s.score.safetyDenials += 3; }));
    expect(moreDenials.throughput).toEqual(base.throughput);
    expect(moreDenials.safety.rating).toBe('denials');
    expect(moreDenials.overall.grade).toBe('C');
    expect(moreDenials.overall.cappedBySafety).toBe(true);
    expect(moreDenials.overall.throughputScore).toBe(base.throughput.score);
  });

  it('go-arounds are counted on the safety side only', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 121);
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
    driveToFinalApproach(session, scenario, arrival.id);
    expect(goAroundAircraft(session, arrival.id).ok).toBe(true);
    const report = buildAtcReport(session);
    expect(report.safety.goArounds).toBe(1);
    expect(report.safety.safetyDenials).toBe(0);
    expect(report.safety.rating).toBe('events');
    expect(report.throughput.aircraftHandled).toBe(0);
  });
});

describe('ATC-09 communication log', () => {
  it('log is deterministic, chronological, and identical after save/load', () => {
    const { scenario, session } = tutorialSetup();
    runToFinish(session, scenario);
    const log = buildCommunicationLog(session);
    expect(buildCommunicationLog(session)).toEqual(log);
    expect(log.length).toBeGreaterThan(0);
    for (let i = 1; i < log.length; i++) {
      expect(log[i]!.atSec).toBeGreaterThanOrEqual(log[i - 1]!.atSec);
    }
    for (const entry of log) {
      expect(entry.callsign).not.toBe('');
      expect(entry.text.startsWith(`${entry.callsign},`)).toBe(true);
      expect(entry.id.startsWith('com_')).toBe(true);
    }
    const parsed = parseAtcSessionFile(JSON.stringify(serializeAtcSession(scenario, session)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = buildCommunicationLog(parsed.file.session);
    expect(restored).toEqual(log);
    expect(communicationLogDigest(restored)).toBe(communicationLogDigest(log));
  });

  it('contains request, clearance, readback and assignment exchanges in phraseology', () => {
    const { scenario, session } = tutorialSetup();
    runToFinish(session, scenario);
    const log = buildCommunicationLog(session);
    const byCategory = (c: string) => log.filter((e) => e.category === c);
    // パイロットの要求（コールサイン・種別入り）
    expect(byCategory('request').some((e) => e.speaker === 'pilot' && e.text.includes('request pushback'))).toBe(true);
    expect(byCategory('request').some((e) => e.text.includes('request landing runway'))).toBe(true);
    // 管制官の許可（滑走路入り。復唱文の流儀に一致）
    const clearance = byCategory('clearance').find((e) => e.text.includes('cleared pushback'));
    expect(clearance).toBeDefined();
    expect(clearance!.speaker).toBe('controller');
    expect(clearance!.text).toContain('runway');
    expect(clearance!.role).toBe('ground');
    // 復唱は同じ指示に紐づき、記録された復唱文と一致する
    const readback = byCategory('readback').find((e) => e.clearanceId === clearance!.clearanceId);
    expect(readback).toBeDefined();
    expect(readback!.speaker).toBe('pilot');
    expect(readback!.text).toBe(session.clearances[clearance!.clearanceId!]!.readbackText);
    // 割当通知（スポット=GROUND、滑走路=TOWER）
    expect(byCategory('assignment').some((e) => e.role === 'ground' && e.text.includes('stand'))).toBe(true);
    expect(byCategory('assignment').some((e) => e.role === 'tower' && e.text.includes('runway'))).toBe(true);
    // 実行開始・完了の報告がある
    expect(byCategory('execution').length).toBeGreaterThan(0);
    expect(byCategory('completion').length).toBeGreaterThan(0);
    // 内部イベント（出現・段階変化）は通信に含まれない
    expect(log.some((e) => e.text.includes('appeared'))).toBe(false);
  });

  it('go-around produces a pilot report and a controller acknowledgement', () => {
    const { scenario, session } = tutorialSetup();
    tickAtcSession(session, scenario, 121);
    const arrival = Object.values(session.aircraft).find((a) => a.kind === 'arrival')!;
    driveToFinalApproach(session, scenario, arrival.id);
    expect(goAroundAircraft(session, arrival.id).ok).toBe(true);
    const log = buildCommunicationLog(session);
    const entries = log.filter((e) => e.category === 'goAround');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.speaker).toBe('pilot');
    expect(entries[0]!.text).toContain('going around runway');
    expect(entries[1]!.speaker).toBe('controller');
    expect(entries[1]!.text).toContain('roger, go around');
    expect(entries[0]!.role).toBe('tower');
  });

  it('safety denial produces a controller denial entry with the reason code', () => {
    const { scenario, session } = tutorialSetup();
    const safety = createSessionSafetyProvider();
    tickAtcSession(session, scenario, 301);
    const deps = Object.values(session.aircraft).filter((a) => a.kind === 'departure');
    const mkRequest = (aircraftId: string, n: number) => {
      const id = `req_manual_${n}`;
      session.requests[id] = {
        id,
        aircraftId,
        kind: 'lineUp',
        createdAtSec: session.clockSec,
        status: 'open',
      };
      session.aircraft[aircraftId]!.activeRequestId = id;
      session.aircraft[aircraftId]!.phase = 'holdShort';
      return id;
    };
    const first = deps[0]!;
    expect(issueClearance(session, scenario.airport, safety, {
      aircraftId: first.id,
      requestId: mkRequest(first.id, 1),
    }).ok).toBe(true);
    const second = deps.find((a) => a.id !== first.id)!;
    expect(issueClearance(session, scenario.airport, safety, {
      aircraftId: second.id,
      requestId: mkRequest(second.id, 2),
    }).ok).toBe(false);
    const log = buildCommunicationLog(session);
    const denial = log.find((e) => e.category === 'denial');
    expect(denial).toBeDefined();
    expect(denial!.speaker).toBe('controller');
    expect(denial!.text).toContain('lineUp clearance denied: runway-reserved');
    expect(denial!.callsign).toBe(second.callsign);
  });
});
