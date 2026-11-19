import { describe, expect, it } from 'vitest';
import { markProcessQueueJoin, recordProcessStart, recordSimpleProcess, rollingPeak60, takeProcessStats, type ProcessBucketStat } from '../../src/core/sim/processStats';
import { createSandboxCompany } from '../../src/core/economy/company';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { DAY_SEC } from '../../src/core/sim/rules';
import type { SimState } from '../../src/core/sim/types';

describe('5-21 工程別実績の記録（processStats）', () => {
  it('工程・分バケットごとに処理人数と工程内待ちを集計し、窓の外は残す', () => {
    const state = {} as SimState;
    markProcessQueueJoin(state, 'g1', 100);
    recordProcessStart(state, 'checkIn', 'g1', 5, 160, 3600 * 3 + 10); // 待ち 60 秒 × 5 人
    recordProcessStart(state, 'checkIn', 'g2', 3, 0, 3600 * 3 + 20); // 基準なしは待ち 0
    recordProcessStart(state, 'security', 'g3', 2, 0, 3600 * 27); // 翌日の時間帯
    const taken = takeProcessStats(state, 0, 24 * 60);
    expect(taken).toHaveLength(1);
    expect(taken![0]).toMatchObject({ step: 'checkIn', minute: 180, processed: 8, waitSecTotal: 300, waitPax: 8 });
    // 窓の外（27 時）は残り、次の読み取りで取れる
    const rest = takeProcessStats(state, 24 * 60, 48 * 60);
    expect(rest).toHaveLength(1);
    expect(rest![0]!.step).toBe('security');
    expect(takeProcessStats(state, 0, 24 * 60)).toBeNull();
  });

  it('ローリング 60 分: 時計の 00 分境界をまたぐ窓が最大になる（5-21 T3）', () => {
    const row = (minute: number, processed: number): ProcessBucketStat => ({ minute, step: 'checkIn', terminalId: '', processed, waitSecTotal: 0, waitPax: 0 });
    // 10:50 に 10 人、11:10 に 10 人、11:49 に 10 人: 時計時間では最大 20 人だが、
    // 10:50〜11:50 のローリング窓では 30 人になる
    const peak = rollingPeak60([row(650, 10), row(670, 10), row(709, 10), row(800, 5)])!;
    expect(peak.processed).toBe(30);
    expect(peak.startMinute).toBe(650);
    // 同数なら早い開始時刻
    const tie = rollingPeak60([row(100, 10), row(300, 10)])!;
    expect(tie.startMinute).toBe(100);
    expect(rollingPeak60([])).toBeNull();
  });

  it('窓口のない工程（access / apronBus）も recordSimpleProcess で記録できる', () => {
    const state = {} as SimState;
    recordSimpleProcess(state, 'access', 12, 3600 * 5, 'fac_T1');
    recordSimpleProcess(state, 'apronBus', 40, 3600 * 5 + 60, 'fac_T1');
    recordSimpleProcess(state, 'restroom', 0, 3600 * 5, 'fac_T1'); // 0 人は記録しない
    const taken = takeProcessStats(state, 0, 24 * 60)!;
    expect(taken).toHaveLength(2);
    expect(taken.find((x) => x.step === 'access')!.processed).toBe(12);
    expect(taken.find((x) => x.step === 'apronBus')!.processed).toBe(40);
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
    // ローリング 60 分（5-21 T3）: ピーク開始分が付き、peakHour と整合する
    expect(checkIn!.peakStartMin).toBeGreaterThanOrEqual(0);
    expect(checkIn!.peakStartMin).toBeLessThan(1440);
    expect(checkIn!.peakHour).toBe(Math.floor(checkIn!.peakStartMin! / 60));
    // 追加工程（5-21 残件）: アクセスは全出発旅客が通るため行が立つ。能力は算出しない
    const access = r.processPeak!.find((p) => p.step === 'access');
    expect(access).toBeDefined();
    expect(access!.peakProcessed).toBeGreaterThan(0);
    expect(access!.capacityPerHour).toBe(0);
    expect(access!.utilization).toBeNull();
    // トイレは確率利用のため、利用があった日だけ行が立つ（能力は fixtures から算出）
    const restroom = r.processPeak!.find((p) => p.step === 'restroom');
    if (restroom) {
      expect(restroom.peakProcessed).toBeGreaterThan(0);
      expect(restroom.capacityPerHour).toBeGreaterThan(0);
    }
  });
});

describe('5-21 T5 工程ピークのターミナル別内訳', () => {
  it('記録はターミナルごとに分かれ、空港全体の合算と一致する', () => {
    const state = {} as SimState;
    recordProcessStart(state, 'checkIn', 'g1', 5, 0, 3600 * 3, 'fac_T1');
    recordProcessStart(state, 'checkIn', 'g2', 7, 0, 3600 * 3 + 60, 'fac_T2');
    recordProcessStart(state, 'checkIn', 'g3', 1, 0, 3600 * 3 + 120, 'fac_T1');
    const taken = takeProcessStats(state, 0, 24 * 60)!;
    // 分バケット化で fac_T1 は 180 分と 182 分の 2 行に分かれる（合計は従来どおり）
    const sum = (tid: string) => taken.filter((x) => x.terminalId === tid).reduce((s, x) => s + x.processed, 0);
    expect(sum('fac_T1')).toBe(6);
    expect(sum('fac_T2')).toBe(7);
    expect(sum('fac_T1') + sum('fac_T2')).toBe(13);
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
