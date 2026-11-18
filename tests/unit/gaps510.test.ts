import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { validateProject } from '../../src/core/io/project';
import { createHistory } from '../../src/core/editor/history';
import { addCityEvent, editorStore, initialDayFlow, removeCityEvent } from '../../src/editor/store';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addDisruption } from '../../src/core/sim/disruptions';
import { checkInvariants } from '../../src/core/sim/invariants';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';

describe('5-10 テスト補完: 都市イベント（ストア）', () => {
  const setup = (cash: number) => {
    const company = createSandboxCompany('ev510');
    company.city = defaultCity('regional');
    company.cash = cash;
    editorStore.setState({ history: createHistory(createSampleAirport()), company, mode: 'build', ops: null, projectId: null, projectName: 'テスト', dayFlow: initialDayFlow() });
    return company;
  };

  it('開催には協力費がかかり、資金不足では予定できず、開始前の取消は全額返金', () => {
    setup(10_000_000);
    addCityEvent({ day: 5, kind: 'festival', location: 'cityCenter', scale: 2, durationDays: 3 });
    let s = editorStore.getState();
    expect(s.company.city?.events).toHaveLength(1);
    expect(s.company.city?.events?.[0]?.wagered).toBe(true);
    expect(s.company.cash).toBe(10_000_000 - 480_000); // 2^2 × 3日 × 40,000
    const id = s.company.city!.events![0]!.id;
    removeCityEvent(id);
    s = editorStore.getState();
    expect(s.company.city?.events).toHaveLength(0);
    expect(s.company.cash).toBe(10_000_000);
  });

  it('資金不足では予定できない', () => {
    setup(100_000);
    addCityEvent({ day: 5, kind: 'festival', location: 'cityCenter', scale: 2, durationDays: 3 });
    const s = editorStore.getState();
    expect(s.company.city?.events ?? []).toHaveLength(0);
    expect(s.company.cash).toBe(100_000);
  });

  it('開始後の取消は返金しない', () => {
    const c = setup(10_000_000);
    addCityEvent({ day: 0, kind: 'festival', location: 'cityCenter', scale: 1, durationDays: 2 });
    const s1 = editorStore.getState();
    const id = s1.company.city!.events![0]!.id;
    expect(s1.company.cash).toBe(10_000_000 - 80_000); // 1^2 × 2日 × 40,000
    expect(c.day).toBe(0);
    removeCityEvent(id);
    const s2 = editorStore.getState();
    expect(s2.company.city?.events).toHaveLength(0);
    expect(s2.company.cash).toBe(10_000_000 - 80_000);
  });
});

describe('5-10 テスト補完: 複合障害', () => {
  it('悪天候＋滑走路閉鎖＋スポット閉鎖が重なっても不変条件を保ち、復旧後に運航が続く', { timeout: 600000 }, () => {
    const layout = createSampleAirport();
    const company = createSandboxCompany('compound510');
    addContract(company, {
      airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 4, window: 'any',
      feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0,
    });
    const sim = createSimulation(layout, { company, seed: 'compound510' });
    const runwayId = Object.keys(layout.runways)[0]!;
    let disrupted = false;
    const end = 21600 + 6 * 3600; // 12:00
    while (sim.state.now < end) {
      stepSimulation(sim);
      if (!disrupted && sim.state.now >= 21600 + 3600) {
        disrupted = true;
        addDisruption(sim, { kind: 'weather', targetId: null, weather: 'fog', end: sim.state.now + 2 * 3600 });
        addDisruption(sim, { kind: 'runwayClosed', targetId: runwayId, end: sim.state.now + 3600 });
        addDisruption(sim, { kind: 'standClosed', targetId: 'std_1', end: sim.state.now + 2 * 3600 });
      }
      if (sim.state.now % 600 === 0) expect(checkInvariants(sim), `t=${sim.state.now}`).toEqual([]);
    }
    expect(disrupted).toBe(true);
    const departed = Object.values(sim.state.aircraft).filter((a) => a.state === 'departed').length;
    const active = Object.values(sim.state.flights).filter((f) => f.status === 'completed').length;
    expect(departed + active).toBeGreaterThan(0);
  });
});

describe('5-10 テスト補完: 実ファイルの読み込み', () => {
  it('実際のプレイヤーのセーブ（形式 v6）がプロジェクト検証を通る', () => {
    const text = readFileSync('/home/hatch/workspace/user/files/skyport-test2_hard-20261118-1052.skyport.json', 'utf8');
    const report = validateProject(text, { fallbackCompany: createSandboxCompany('real510') });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.project).not.toBeNull();
  });
});
