import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import { setFacilityEventModeForTest, setPaxEventModeForTest } from '../../../src/core/sim/passengers';
import { setBagEventModeForTest } from '../../../src/core/sim/baggage';
import {
  peekPerfSnapshot,
  resetPerfStats,
  setPaxDetailEnabled,
  setPerfClock,
  takePerfSnapshot,
} from '../../../src/core/sim/perfStats';

/**
 * 性能改善 第4弾の実規模ベンチ: ユーザーの実プレイセーブ（105日目）の
 * レイアウト＋会社（契約 456 件）から運航を生成し、実規模（発着 876/日・旅客 10万人/日級）
 * での tick 時間を従来経路とイベント経路で比較する。
 *
 * 注意: セーブの versions.simModel は旧版（10.8）のため運航状態は復元せず、
 * レイアウトと会社だけを取り込んで新規に運航を立ち上げる（規模の再現が目的）。
 * ウォームアップで旅客グループ数が十分に育ってから 3,600 tick を計測する。
 */
const SAVE_PATH = resolve(__dirname, '../../../../..', 'user/files/skyport-mainplay1-20261120-2333.skyport.json');
const MEASURE_TICKS = 3600;

function loadRealProject(): { layout: never; company: never } {
  const project = JSON.parse(readFileSync(SAVE_PATH, 'utf8')) as { layout: never; company: never };
  return { layout: project.layout, company: project.company };
}

function runMode(paxEvent: boolean, facilityEvent: boolean): { msPerTick: number; snap: ReturnType<typeof peekPerfSnapshot>; flights: number } {
  setPaxEventModeForTest(paxEvent);
  setFacilityEventModeForTest(facilityEvent);
  setBagEventModeForTest(paxEvent);
  const { layout, company } = loadRealProject();
  const sim = createSimulation(layout, { company });
  // 旅客が育つまでウォームアップ（上限 1 日分。定常状態の規模で測る）
  let warm = 0;
  while (warm < 86400 && sim.state.activePax.length < 1500) {
    stepSimulation(sim);
    warm++;
  }
  resetPerfStats();
  takePerfSnapshot();
  const t0 = performance.now();
  for (let i = 0; i < MEASURE_TICKS; i++) stepSimulation(sim);
  const ms = performance.now() - t0;
  return { msPerTick: ms / MEASURE_TICKS, snap: peekPerfSnapshot(), flights: Object.keys(sim.state.flights).length };
}

describe('PERF4 実規模ベンチ（ユーザーの105日目セーブのレイアウト＋会社）', () => {
  afterEach(() => {
    setPaxEventModeForTest(true);
    setFacilityEventModeForTest(true);
    setBagEventModeForTest(true);
    setPaxDetailEnabled(false);
    setPerfClock(() => 0);
    resetPerfStats();
  });

  it('従来経路とイベント経路の tick 時間を比較する', { timeout: 1_800_000 }, () => {
    setPerfClock(() => performance.now());
    setPaxDetailEnabled(true);
    const legacy = runMode(false, false);
    const event = runMode(true, true);
    const step = (snap: ReturnType<typeof peekPerfSnapshot>, key: string): number => snap.steps.find((s) => s.key === key)?.avgMs ?? 0;
    console.log(
      `[perf4-real] legacy: ${legacy.msPerTick.toFixed(3)} ms/tick (perfStats ${legacy.snap.tickAvgMs.toFixed(3)}), passengers ${step(legacy.snap, 'passengers').toFixed(3)}, baggage ${step(legacy.snap, 'baggage').toFixed(3)}, scale pax=${legacy.snap.scale.paxGroups} bags=${legacy.snap.scale.bags} flights=${legacy.flights}`,
    );
    console.log(
      `[perf4-real] event: ${event.msPerTick.toFixed(3)} ms/tick (perfStats ${event.snap.tickAvgMs.toFixed(3)}), passengers ${step(event.snap, 'passengers').toFixed(3)}, baggage ${step(event.snap, 'baggage').toFixed(3)}, scale pax=${event.snap.scale.paxGroups} sleeping=${event.snap.scale.paxSleeping ?? '-'} awake=${event.snap.scale.paxAwake ?? '-'} bags=${event.snap.scale.bags} flights=${event.flights}`,
    );
    console.log(`[perf4-real] paxDetail(event) ${JSON.stringify(Object.fromEntries(event.snap.paxDetail.map((d) => [d.key, Math.round(d.avgMs * 1000) / 1000])))}`);
    expect(legacy.snap.scale.paxGroups).toBeGreaterThan(500);
    expect(event.msPerTick).toBeLessThan(legacy.msPerTick);
  });
});
