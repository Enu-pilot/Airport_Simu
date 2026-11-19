import { describe, expect, it } from 'vitest';
import { markProcessQueueJoin, recordProcessStart, takeProcessStats } from '../../src/core/sim/processStats';
import { createSandboxCompany } from '../../src/core/economy/company';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { DAY_SEC } from '../../src/core/sim/rules';
import type { SimState } from '../../src/core/sim/types';

describe('5-21 工程別実績の記録（processStats）', () => {
  it('工程・時間帯ごとに処理人数と工程内待ちを集計し、窓の外は残す', () => {
    const state = {} as SimState;
    markProcessQueueJoin(state, 'g1', 100);
    recordProcessStart(state, 'checkIn', 'g1', 5, 160, 3600 * 3 + 10); // 待ち 60 秒 × 5 人
    recordProcessStart(state, 'checkIn', 'g2', 3, 0, 3600 * 3 + 20); // 基準なしは待ち 0
    recordProcessStart(state, 'security', 'g3', 2, 0, 3600 * 27); // 翌日の時間帯
    const taken = takeProcessStats(state, 0, 24);
    expect(taken).toHaveLength(1);
    expect(taken![0]).toMatchObject({ step: 'checkIn', hour: 3, processed: 8, waitSecTotal: 300, waitPax: 8 });
    // 窓の外（27 時）は残り、次の読み取りで取れる
    const rest = takeProcessStats(state, 24, 48);
    expect(rest).toHaveLength(1);
    expect(rest![0]!.step).toBe('security');
    expect(takeProcessStats(state, 0, 24)).toBeNull();
  });
});

describe('5-21 日報の工程別ピーク', () => {
  it('1 日運航すると processPeak に能力・需要・実績・使用率が付く', { timeout: 600000 }, () => {
    const c = createSandboxCompany('peak-521');
    const sim = createSimulation(createStarterAirfield(), { company: c, seed: 'peak-521' });
    const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
    while (sim.state.now <= target) stepSimulation(sim);
    const r = c.reports[c.reports.length - 1]!;
    expect(r.processPeak).toBeDefined();
    const checkIn = r.processPeak!.find((p) => p.step === 'checkIn');
    const security = r.processPeak!.find((p) => p.step === 'security');
    expect(checkIn).toBeDefined();
    expect(security).toBeDefined();
    expect(checkIn!.capacityPerHour).toBeGreaterThan(0);
    expect(checkIn!.peakProcessed).toBeGreaterThan(0);
    expect(checkIn!.demandPerHour).toBeGreaterThan(0);
    expect(checkIn!.utilization).toBeCloseTo(checkIn!.peakProcessed / checkIn!.capacityPerHour, 2);
    expect(security!.peakProcessed).toBeGreaterThan(0);
  });
});

describe('5-21 T5 工程ピークのターミナル別内訳', () => {
  it('記録はターミナルごとに分かれ、空港全体の合算と一致する', () => {
    const state = {} as SimState;
    recordProcessStart(state, 'checkIn', 'g1', 5, 0, 3600 * 3, 'fac_T1');
    recordProcessStart(state, 'checkIn', 'g2', 7, 0, 3600 * 3 + 60, 'fac_T2');
    recordProcessStart(state, 'checkIn', 'g3', 1, 0, 3600 * 3 + 120, 'fac_T1');
    const taken = takeProcessStats(state, 0, 24)!;
    expect(taken).toHaveLength(2);
    const t1 = taken.find((x) => x.terminalId === 'fac_T1')!;
    const t2 = taken.find((x) => x.terminalId === 'fac_T2')!;
    expect(t1.processed).toBe(6);
    expect(t2.processed).toBe(7);
    expect(t1.processed + t2.processed).toBe(13);
  });

  it('1 日運航すると processPeakByTerminal に所属ターミナル付きの行が付く', { timeout: 600000 }, () => {
    const c = createSandboxCompany('peak-521-t5');
    const sim = createSimulation(createStarterAirfield(), { company: c, seed: 'peak-521-t5' });
    const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
    while (sim.state.now <= target) stepSimulation(sim);
    const r = c.reports[c.reports.length - 1]!;
    expect(r.processPeakByTerminal).toBeDefined();
    const rows = r.processPeakByTerminal!;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((p) => p.terminalId !== '')).toBe(true);
    // 単一ターミナルでは、ターミナル別の実績合計が空港全体のピーク実績と一致する（ピーク時間帯が同じ工程）
    const checkInT = rows.filter((p) => p.step === 'checkIn');
    const checkInAll = r.processPeak!.find((p) => p.step === 'checkIn')!;
    expect(checkInT.reduce((s, p) => s + p.peakProcessed, 0)).toBe(checkInAll.peakProcessed);
    expect(checkInT[0]!.capacityPerHour).toBe(checkInAll.capacityPerHour);
  });
});
