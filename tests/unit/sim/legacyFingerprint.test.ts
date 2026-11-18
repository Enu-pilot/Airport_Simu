/**
 * フェーズ 2 T1: 従来方式（taxiMode・nightOps なし）が、フェーズ 2 の作業で 1 ビットも変わらないことの証明。
 * 基準値は T0（型だけの共通準備）の状態で採取した SimState + company の JSON の SHA-256。
 * 基準値の更新は禁止（docs/design/impl_phase2_plan.md §5.3）。意図した結果変更は承認が必要。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { updateLayoutSettings } from '../../../src/core/layout/operations';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import type { AirportLayout } from '../../../src/core/model/types';
import { createStressLayout } from '../../golden/layouts';
import { cityCompany, citySim, linearLayout, manual } from '../../audit/d_helpers';
import { crossingAirport } from './helpers';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const fp = (sim: Simulation): string => sha(JSON.stringify({ state: sim.state, company: sim.company }));
const run = (sim: Simulation, sec: number): Simulation => {
  for (let i = 0; i < sec; i++) stepSimulation(sim);
  return sim;
};

function simultaneous(sim: Simulation, n: number, seed: string, typeId = 'narrow180'): void {
  const t0 = sim.state.now + 20 * 60;
  const rng = new Rng(`${seed}:arr`);
  for (let i = 0; i < n; i++) addTurnaround(sim, typeId, t0 + i * 60 + rng.int(0, 120), { departureAt: t0 + 3600 });
}

type Case = { name: string; build: () => Simulation; sec: number };

/** 交差する流れのための決定的な混雑シナリオ（crossingAirport に 2 機種を 6 機） */
function crossingSim(layout: AirportLayout = crossingAirport()): Simulation {
  const sim = createSimulation(layout, { seed: 'fp-cross', settings: manual });
  const t0 = sim.state.now + 600;
  for (let i = 0; i < 6; i++) addTurnaround(sim, i % 2 ? 'narrow180' : 'regional70', t0 + i * 150, { departureAt: t0 + 2400 + i * 90 });
  return sim;
}

const CASES: Case[] = [
  { name: 'd1a linear single entry 4 aircraft', sec: 5 * 3600, build: () => { const s = createSimulation(linearLayout({ stands: 4 }), { seed: 'd1-s1', settings: manual }); simultaneous(s, 4, 'd1-s1'); return s; } },
  { name: 'd1b linear dual entry 4 aircraft', sec: 5 * 3600, build: () => { const s = createSimulation(linearLayout({ stands: 4, dual: true }), { seed: 'd1-s2', settings: manual }); simultaneous(s, 4, 'd1-s2'); return s; } },
  {
    name: 'stress 30 aircraft 2h', sec: 2 * 3600,
    build: () => {
      const s = createSimulation(createStressLayout(), { seed: 'fp-stress', settings: manual });
      const rng = new Rng('fp-stress:arr');
      const t0 = s.state.now + 600;
      for (let i = 0; i < 30; i++) addTurnaround(s, i % 3 === 0 ? 'regional70' : 'narrow180', t0 + i * 120 + rng.int(0, 60), { departureAt: t0 + 3000 + i * 60 });
      return s;
    },
  },
  { name: 'crossingAirport 6 aircraft', sec: 4 * 3600, build: () => crossingSim() },
  { name: 'city core 3 days (no nightOps)', sec: 3 * 86400, build: () => citySim(createSampleAirport(), cityCompany('fp-city', 'core'), { seed: 'fp-city', settings: { autoSchedule: true, inboundDelayProb: 0.25 } }) },
  { name: 'sample airport 1 day', sec: 86400, build: () => createSimulation(createSampleAirport(), { company: createSandboxCompany(), seed: 'fp-sample' }) },
];

const BASELINE: Record<string, string> = {
  'd1a linear single entry 4 aircraft': '1f491d73729bc6295b5bc256c728010115567800484388ae8b56edfb8c698159',
  'd1b linear dual entry 4 aircraft': 'bbd1952b427da86d618d49dfe9725f64400f9ede79ae7eb0f4f95d5fa886b04c',
  'stress 30 aircraft 2h': 'eceefdb2828e21d391393d3579dadf83b9f7b3212d26f5487299972fc89c9d4f',
  'crossingAirport 6 aircraft': '1d1ce4ae34d8dfe58eb0d213ec84bb7d1d43fa781cb06d18bdeb7a6b6ced45ef',
  // 2026-11-18 再採取（ユーザー承認済み）: フェーズ 5 の 5-02/5-03/5-04 が日報へ記録項目
  // （リンク利用実績・資源別稼働率・満足度内訳）を追加したため、会社データを含む 2 件だけが変わった。
  // 追加項目を除いたハッシュは旧基準値と完全一致することを確認済みで、運航そのものは無変更。
  'city core 3 days (no nightOps)': '4ca1e5a0aad960812c2582ff56c4c291049d50050971c589f1bebef2f76730b9',
  'sample airport 1 day': '1957cfab08d0bf684826eb67a4958fd9e97281d33fae1d76b93bd1a7f0abb566',
};

describe('legacyFingerprint: taxiMode / nightOps なしの運航は T0 の基準値と一致', () => {
  for (const c of CASES) {
    it(c.name, { timeout: 120_000 }, () => {
      const h = fp(run(c.build(), c.sec));
      if (process.env.FP_CAPTURE) console.log(`[fingerprint] ${JSON.stringify({ name: c.name, h })}`);
      else expect(h).toBe(BASELINE[c.name]);
    });
  }

  it('taxiMode を block にして full へ戻したレイアウトは、キーなしと同じバイト列で同じ運航結果になる', { timeout: 120_000 }, () => {
    const base = crossingAirport();
    const a = updateLayoutSettings(base, { taxiMode: 'block' } as never);
    if (!a.ok) return; // 設定の操作が未導入（B 側の T2 が入るまで）。入った後は下の検査が有効になる
    const b = updateLayoutSettings(a.layout, { taxiMode: 'full' } as never);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(JSON.stringify(b.layout)).toBe(JSON.stringify(base));
    expect(fp(run(crossingSim(b.layout), 4 * 3600))).toBe(fp(run(crossingSim(base), 4 * 3600)));
  });
});
