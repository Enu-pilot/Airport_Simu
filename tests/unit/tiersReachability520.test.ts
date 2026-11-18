import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext, operableTypes } from '../../src/core/sim/context';
import { acceptOffer, contractsOf, createCareerCompany } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { defaultGame, startGame } from '../../src/core/economy/game';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { checkInvariants } from '../../src/core/sim/invariants';
import { DAY_SEC } from '../../src/core/sim/rules';

/**
 * 5-20 T8: 空港の格の到達可能性の有機的検証（バランス検証用ハーネス。仕様の期待値ではない）。
 *
 * サンプル空港 + キャリア会社（実ゲームの新規開始と同じく game/goals・都市つき）で、
 * 締めごとに出た契約提案を「運航できる機種のものは全部受ける」貪欲方針で運航し、
 * 格 1・2・3 に初めて達した運航日数を seed ごとに記録する。
 * 計測結果は ~/workspace/test/tiers_t8_results.json に日次で追記する（タイムアウト時も残る）。
 * 不変条件は economy.test.ts の runDay と同じく確認するが、この VM の遅さのため日境界でのみ行う。
 */
const MAX_DAYS = 60;
const OUT = '/home/hatch/workspace/test/tiers_t8_results.json';

interface DayLog {
  day: number;
  tier: number;
  movements: number;
  pax: number;
  rating: number;
  flights: number;
  activeContracts: number;
  cash: number;
  bankrupt: boolean;
}

function runSeed(seed: string, useCity: boolean): { reached: Record<string, number>; log: DayLog[] } {
  const layout = createSampleAirport();
  const operable = new Set<string>(operableTypes(createContext(layout)));
  const c = createCareerCompany(seed);
  startGame(c, defaultGame());
  // seed A は新規ゲームの標準 pairing（地方都市つき）、seed B は都市需要の上限を外した対照条件
  if (useCity) c.city = defaultCity('regional');
  const sim = createSimulation(layout, { company: c });
  const reached: Record<string, number> = {};
  const log: DayLog[] = [];
  for (let d = 0; d < MAX_DAYS; d++) {
    const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
    while (sim.state.now <= target) stepSimulation(sim);
    const v = checkInvariants(sim);
    if (v.length > 0) throw new Error(`seed=${seed} day=${c.day}: ${v.join(' / ')}`);
    // 貪欲受諾: 運航できる機種の提案はすべて受ける
    for (const k of contractsOf(c, 'offered')) {
      if (operable.has(k.typeId)) acceptOffer(c, k.id, true);
    }
    const r = c.reports[c.reports.length - 1]!;
    const tier = c.goals?.tier ?? 0;
    const daysRun = log.length + 1;
    for (let t = 1; t <= tier; t++) if (reached[String(t)] === undefined) reached[String(t)] = daysRun;
    log.push({
      day: c.day,
      tier,
      movements: r.kpi.movements,
      pax: r.kpi.paxDeparted + r.kpi.paxArrived,
      rating: c.rating,
      flights: r.kpi.flights,
      activeContracts: contractsOf(c, 'active').length,
      cash: Math.round(c.cash),
      bankrupt: c.bankrupt,
    });
    const all = fs.existsSync(OUT) ? (JSON.parse(fs.readFileSync(OUT, 'utf-8')) as Record<string, unknown>) : {};
    all[seed] = { reached, log };
    fs.writeFileSync(OUT, JSON.stringify(all, null, 1));
    if (tier >= 3) break;
  }
  return { reached, log };
}

describe('5-20 T8 格の到達可能性（有機的検証）', () => {
  it('seed A: 貪欲運航で格の到達日数を記録する', () => {
    const { reached, log } = runSeed('t8-alpha', true);
    console.log('seed t8-alpha reached:', JSON.stringify(reached), 'days run:', log.length, 'final:', JSON.stringify(log[log.length - 1]));
    // 仕様の期待値ではなく、ハーネス自体の健全性だけを確認する（格は下がらない・日報が積まれる）
    expect(log.length).toBeGreaterThan(0);
    for (let i = 1; i < log.length; i++) expect(log[i]!.tier).toBeGreaterThanOrEqual(log[i - 1]!.tier);
  }, 900_000);

  it('seed B: 貪欲運航で格の到達日数を記録する', () => {
    const { reached, log } = runSeed('t8-beta', false);
    console.log('seed t8-beta reached:', JSON.stringify(reached), 'days run:', log.length, 'final:', JSON.stringify(log[log.length - 1]));
    expect(log.length).toBeGreaterThan(0);
    for (let i = 1; i < log.length; i++) expect(log[i]!.tier).toBeGreaterThanOrEqual(log[i - 1]!.tier);
  }, 900_000);
});
