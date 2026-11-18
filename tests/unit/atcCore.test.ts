import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignRunway,
  assignStand,
  assignmentId,
  atcSessionDigest,
  candidateRunways,
  candidateStands,
  cancelClearance,
  createAtcAirportSnapshot,
  createAtcSession,
  createSessionSafetyProvider,
  createTutorialScenario,
  diagnoseAtcAirport,
  issueClearance,
  openQueueByRole,
  parseAtcSessionFile,
  recordReadback,
  rejectRequest,
  serializeAtcSession,
  tickAtcSession,
  type AtcScenarioDefinition,
  type AtcSessionState,
} from '../../src/core/atc/index';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';

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
