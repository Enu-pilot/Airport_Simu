import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATC_AUTOSAVE_INTERVAL_SEC,
  assignRunway,
  assignStand,
  atcSessionDigest,
  candidateRunways,
  candidateStands,
  createAtcAirportSnapshot,
  createAtcSession,
  createAutosaveSnapshot,
  createSessionSafetyProvider,
  createTutorialScenario,
  diagnoseAtcAirport,
  issueClearance,
  maybeAutosave,
  parseAtcSessionFile,
  serializeAtcSession,
  shouldAutosave,
  tickAtcSession,
  type AtcScenarioDefinition,
  type AtcSessionState,
} from '../../src/core/atc/index';
import {
  AtcSessionStore,
  MemoryAtcSessionBackend,
  autosaveSlotId,
  createMemoryAtcSessionStore,
  getAtcSessionStore,
  setAtcSessionStoreForTest,
} from '../../src/atc/sessions';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';

const capturedAtIso = '2026-11-19T00:00:00.000Z';
const savedAtIso = '2026-11-19T01:00:00.000Z';

function tutorialSetup(): { scenario: AtcScenarioDefinition; session: AtcSessionState } {
  const layout = createStarterAirfield();
  const snapshot = createAtcAirportSnapshot(layout, { id: 'snap_1', capturedAtIso });
  const diagnostics = diagnoseAtcAirport(snapshot);
  expect(diagnostics.errors).toEqual([]);
  const scenario = createTutorialScenario(snapshot, diagnostics);
  return { scenario, session: createAtcSession(scenario) };
}

/** atcCore.test.ts と同じ単純な自動管制（割当確定＋開いている要求へ許可） */
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

function runSeconds(session: AtcSessionState, scenario: AtcScenarioDefinition, sec: number): void {
  const safety = createSessionSafetyProvider();
  for (let t = 0; t < sec && !session.finished; t++) {
    autoControl(session, scenario);
    tickAtcSession(session, scenario, 1, { safety, airport: scenario.airport });
  }
}

function runToFinish(session: AtcSessionState, scenario: AtcScenarioDefinition, maxSec = 3600): void {
  runSeconds(session, scenario, maxSec);
}

describe('ATC-10 session store (memory backend)', () => {
  it('save -> list -> load -> continue matches the uninterrupted run', async () => {
    const a = tutorialSetup();
    runToFinish(a.session, a.scenario);
    expect(a.session.finished).toBe(true);

    const b = tutorialSetup();
    runSeconds(b.session, b.scenario, 200);
    const clockAtSave = b.session.clockSec;

    const store = createMemoryAtcSessionStore();
    expect(store.kind).toBe('memory');
    const saved = await store.save({
      id: 'slot-1',
      scenario: b.scenario,
      session: b.session,
      savedAtIso,
    });
    expect(saved.ok).toBe(true);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'slot-1',
      kind: 'manual',
      scenarioId: b.scenario.id,
      scenarioName: b.scenario.name,
      savedAtIso,
      clockSec: clockAtSave,
      finished: false,
    });
    // 一覧メタにセーブ本体は含まない
    expect(JSON.stringify(list[0])).not.toContain('rngState');

    const loaded = await store.load('slot-1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    runToFinish(loaded.file.session, loaded.file.scenario);
    expect(atcSessionDigest(loaded.file.session)).toBe(atcSessionDigest(a.session));
  });

  it('remove deletes the record and load then reports not-found', async () => {
    const { scenario, session } = tutorialSetup();
    const store = createMemoryAtcSessionStore();
    await store.save({ id: 'slot-x', scenario, session, savedAtIso });
    await store.remove('slot-x');
    expect(await store.list()).toHaveLength(0);
    expect(await store.load('slot-x')).toEqual({ ok: false, errors: ['not-found'] });
  });

  it('autosave slot is a single overwritten record per scenario', async () => {
    const { scenario, session } = tutorialSetup();
    const store = createMemoryAtcSessionStore();
    const slot = autosaveSlotId(scenario.id);
    runSeconds(session, scenario, 30);
    const first = await store.save({
      id: slot,
      kind: 'autosave',
      scenario,
      session,
      savedAtIso: '2026-11-19T01:00:00.000Z',
    });
    expect(first.ok).toBe(true);
    runSeconds(session, scenario, 30);
    const second = await store.save({
      id: slot,
      kind: 'autosave',
      scenario,
      session,
      savedAtIso: '2026-11-19T01:01:00.000Z',
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.summary.clockSec).toBeGreaterThan(30);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('autosave');
    expect(list[0]!.savedAtIso).toBe('2026-11-19T01:01:00.000Z');
  });

  it('save rejects a session with broken references and writes nothing', async () => {
    const { scenario, session } = tutorialSetup();
    runSeconds(session, scenario, 30);
    const broken = JSON.parse(JSON.stringify(session)) as AtcSessionState;
    const aircraft = Object.values(broken.aircraft)[0]!;
    aircraft.runwayId = 'rwy_missing';
    const store = createMemoryAtcSessionStore();
    const result = await store.save({ id: 'bad', scenario, session: broken, savedAtIso });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith('unknown-runway'))).toBe(true);
    expect(await store.list()).toHaveLength(0);
  });

  it('load rejects corrupted or unknown-version records without touching stored data or other records', async () => {
    const { scenario, session } = tutorialSetup();
    runSeconds(session, scenario, 30);
    const backend = new MemoryAtcSessionBackend();
    const store = new AtcSessionStore(backend);
    await store.save({ id: 'good', scenario, session, savedAtIso });
    await store.save({ id: 'corrupt', scenario, session, savedAtIso });
    await store.save({ id: 'future', scenario, session, savedAtIso });

    const corrupt = backend.records.get('corrupt')!;
    backend.records.set('corrupt', { ...corrupt, json: '{not-json' });
    const future = backend.records.get('future')!;
    const futureFile = JSON.parse(future.json) as { formatVersion: number };
    futureFile.formatVersion = 99;
    backend.records.set('future', { ...future, json: JSON.stringify(futureFile) });

    expect(await store.load('corrupt')).toEqual({ ok: false, errors: ['not-json'] });
    expect(await store.load('future')).toEqual({
      ok: false,
      errors: ['unsupported-format-version'],
    });
    // 失敗した読み込みで保存データも他のレコードも変わらない
    expect(backend.records.has('corrupt')).toBe(true);
    expect((await store.list()).map((s) => s.id).sort()).toEqual(['corrupt', 'future', 'good']);
    const good = await store.load('good');
    expect(good.ok).toBe(true);
    if (good.ok) expect(atcSessionDigest(good.file.session)).toBe(atcSessionDigest(session));
  });

  it('importJson rejects a management project file and unknown versions, storing nothing', async () => {
    const store = createMemoryAtcSessionStore();
    const management = await store.importJson(
      JSON.stringify({ kind: 'skyport-project', layout: {}, company: {} }),
    );
    expect(management).toEqual({ ok: false, errors: ['management-project-file'] });

    const { scenario, session } = tutorialSetup();
    const file = serializeAtcSession(scenario, session);
    const future = { ...file, formatVersion: 99 };
    expect(await store.importJson(JSON.stringify(future))).toEqual({
      ok: false,
      errors: ['unsupported-format-version'],
    });
    expect(await store.list()).toHaveLength(0);

    const ok = await store.importJson(JSON.stringify(file), { id: 'imported', savedAtIso });
    expect(ok.ok).toBe(true);
    const loaded = await store.load('imported');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(atcSessionDigest(loaded.file.session)).toBe(atcSessionDigest(session));
  });

  it('getAtcSessionStore falls back to memory when IndexedDB is unavailable', async () => {
    try {
      const store = await getAtcSessionStore();
      expect(store.kind).toBe('memory');
    } finally {
      setAtcSessionStoreForTest(null);
    }
  });

  it('src/atc does not import editor or management sim domains', () => {
    const dir = join(__dirname, '..', '..', 'src', 'atc');
    const forbidden = ['editor', '../sim/', 'CompanyState', 'ProjectFile'];
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
});

describe('ATC-10 autosave helpers (core)', () => {
  it('shouldAutosave follows the interval, finished state, and disabled interval', () => {
    const { session } = tutorialSetup();
    session.clockSec = ATC_AUTOSAVE_INTERVAL_SEC - 1;
    expect(shouldAutosave(session, null)).toBe(false);
    session.clockSec = ATC_AUTOSAVE_INTERVAL_SEC;
    expect(shouldAutosave(session, null)).toBe(true);
    expect(shouldAutosave(session, 0)).toBe(true);
    expect(shouldAutosave(session, session.clockSec)).toBe(false);
    // 巻き戻りでは保存しない
    expect(shouldAutosave(session, session.clockSec + 10)).toBe(false);
    // 間隔 0 以下は無効化
    expect(shouldAutosave(session, null, 0)).toBe(false);
    // 終了済みは自動保存しない
    session.finished = true;
    session.clockSec += ATC_AUTOSAVE_INTERVAL_SEC * 2;
    expect(shouldAutosave(session, null)).toBe(false);
  });

  it('maybeAutosave returns a validated deep-copied snapshot only when due', () => {
    const { scenario, session } = tutorialSetup();
    runSeconds(session, scenario, 30);
    expect(maybeAutosave(scenario, session, null)).toBeNull();

    runSeconds(session, scenario, ATC_AUTOSAVE_INTERVAL_SEC);
    const due = maybeAutosave(scenario, session, null);
    expect(due).not.toBeNull();
    if (!due) return;
    expect(due.savedClockSec).toBe(session.clockSec);
    // 通常保存と同じ検証を通ること
    const reparsed = parseAtcSessionFile(JSON.stringify(due.file));
    expect(reparsed.ok).toBe(true);
    // スナップショットは複製であり、書き換えても進行中のセッションは変わらない
    const before = atcSessionDigest(session);
    due.file.session.clockSec = 999999;
    expect(atcSessionDigest(session)).toBe(before);
    // 保存済み時計を渡せば、間隔が経つまでは null
    expect(maybeAutosave(scenario, session, due.savedClockSec)).toBeNull();
  });

  it('createAutosaveSnapshot throws instead of producing an invalid file', () => {
    const { scenario, session } = tutorialSetup();
    runSeconds(session, scenario, 30);
    const broken = JSON.parse(JSON.stringify(session)) as AtcSessionState;
    Object.values(broken.aircraft)[0]!.standId = 'std_missing';
    expect(() => createAutosaveSnapshot(scenario, broken)).toThrow('atc-autosave-invalid-session');
  });

  it('autosave snapshot saved through the store continues identically', async () => {
    const a = tutorialSetup();
    runToFinish(a.session, a.scenario);

    const b = tutorialSetup();
    runSeconds(b.session, b.scenario, ATC_AUTOSAVE_INTERVAL_SEC + 30);
    const due = maybeAutosave(b.scenario, b.session, null);
    expect(due).not.toBeNull();
    if (!due) return;

    const store = createMemoryAtcSessionStore();
    const saved = await store.save({
      id: autosaveSlotId(b.scenario.id),
      kind: 'autosave',
      scenario: due.file.scenario,
      session: due.file.session,
      savedAtIso,
    });
    expect(saved.ok).toBe(true);
    const loaded = await store.load(autosaveSlotId(b.scenario.id));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    runToFinish(loaded.file.session, loaded.file.scenario);
    expect(atcSessionDigest(loaded.file.session)).toBe(atcSessionDigest(a.session));
  });
});
