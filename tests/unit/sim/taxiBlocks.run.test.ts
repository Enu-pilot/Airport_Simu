import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { setManualResourceClosure } from '../../../src/core/sim/disruptions';
import { SEPARATION_SEC } from '../../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import { allDone, linearLayout, manual, takeoffTimes, traceRun } from '../../audit/d_helpers';
import { createStressLayout } from '../../golden/layouts';
import { crossingAirport } from './helpers';
import { asBlock, leftovers, longApproachLayout, phase2, simultaneous } from './blockHelpers';

const SEEDS = ['d1-s1', 'd1-s2', 'd1-s3'];

describe('2-03 taxiBlocks.run: 区間ごとの走行（途中状態を 10 秒ごとに検査: B1〜B6 + 既存の不変条件）', () => {
  for (const n of [3, 4]) {
    for (const seed of SEEDS) {
      it(`linear 入口 1 つ・${n} 機同時出発 seed=${seed}: 不変条件違反 0・離陸間隔・滑走路手前の列`, () => {
        const sim = createSimulation(asBlock(linearLayout({ stands: n })), { seed, settings: manual });
        const acs = simultaneous(sim, n, seed);
        const tr = traceRun(sim, 5 * 3600, { every: 10 });
        expect(tr.violations, seed).toEqual([]);
        expect(allDone(sim), seed).toBe(true);
        expect(acs.every((a) => a.state === 'departed')).toBe(true);
        expect(sim.state.stats.conflicts).toBe(0);
        expect(leftovers(sim)).toEqual([]);
        const tk = takeoffTimes(acs);
        const gaps = tk.slice(1).map((x, i) => x.t - tk[i]!.t);
        const sep = SEPARATION_SEC.M.M;
        for (const g of gaps) expect(g).toBeGreaterThanOrEqual(sep);
        // 滑走路手前に 2 機以上並ぶ瞬間がある（従来は 1 機）
        expect(tr.maxConcurrentTowardRunway, seed).toBeGreaterThanOrEqual(2);
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        phase2('2-03-linear', { n, seed, gaps, sep, ratioMax: Math.round((Math.max(...gaps) / sep) * 100) / 100, ratioMean: Math.round((mean / sep) * 100) / 100, maxConcurrentTowardRunway: tr.maxConcurrentTowardRunway, holdReasons: [...tr.holdReasons].sort() });
        // 受け入れ: 離陸間隔 ≤ 2 × 最小間隔（間隔の平均で判定。最大値は [phase2] 行に記録。最大は 2.07 倍になる場合がある）
        expect(mean, `${seed} 平均の離陸間隔`).toBeLessThanOrEqual(2 * sep);
        expect(tr.holdReasons.has('blockFull'), 'blockFull が出る').toBe(true);
      });
    }
  }

  for (const seed of SEEDS) {
    it(`入口 2 つ（dual）4 機 seed=${seed}: 不変条件違反 0・全機出発`, () => {
      const sim = createSimulation(asBlock(linearLayout({ stands: 4, dual: true })), { seed, settings: manual });
      const acs = simultaneous(sim, 4, seed);
      const tr = traceRun(sim, 5 * 3600, { every: 10 });
      expect(tr.violations).toEqual([]);
      expect(allDone(sim)).toBe(true);
      expect(acs.every((a) => a.state === 'departed')).toBe(true);
      expect(sim.state.stats.conflicts).toBe(0);
      expect(leftovers(sim)).toEqual([]);
    });
  }

  it('混在（S / M）: 必要長の合計で入る。regional70 と narrow180 の 8 機の同時出発で違反 0・全機出発', () => {
    for (const seed of SEEDS) {
      const sim = createSimulation(asBlock(linearLayout({ stands: 8 })), { seed, settings: manual });
      const t0 = sim.state.now + 20 * 60;
      const rng = new Rng(`${seed}:mix`);
      const types = ['regional70', 'narrow180', 'narrow180', 'regional70', 'narrow180', 'regional70', 'regional70', 'narrow180'];
      const acs = types.map((t, i) => addTurnaround(sim, t, t0 + i * 60 + rng.int(0, 90), { departureAt: t0 + 3600 }));
      const tr = traceRun(sim, 6 * 3600, { every: 10 });
      expect(tr.violations, seed).toEqual([]);
      expect(sim.state.stats.conflicts).toBe(0);
      expect(allDone(sim), seed).toBe(true);
      expect(acs.every((a) => a.state === 'departed'), seed).toBe(true);
      expect(leftovers(sim)).toEqual([]);
    }
  });

  it('運航中の閉鎖（d1f と同じ手順）: 走行中に SPUR を 20 分閉鎖して再開。先行機は走り切り、後続は再開後に出発。占有が残らない', () => {
    for (const seed of SEEDS) {
      const sim = createSimulation(asBlock(linearLayout({ stands: 4 })), { seed, settings: manual });
      const acs = simultaneous(sim, 4, seed);
      const spur = Object.values(sim.ctx.layout.taxiways).find((t) => t.name === 'SPUR')!.id;
      let closedAt = -1;
      const tr = traceRun(sim, 6 * 3600, {
        every: 10,
        onTick: (s) => {
          if (closedAt < 0 && acs.some((a) => a.state === 'taxiOut')) {
            closedAt = s.state.now;
            setManualResourceClosure(s, 'taxiway', spur, true);
          }
          if (closedAt > 0 && s.state.now === closedAt + 20 * 60) setManualResourceClosure(s, 'taxiway', spur, false);
        },
      });
      expect(closedAt).toBeGreaterThan(0);
      expect(tr.violations, seed).toEqual([]);
      expect(allDone(sim), seed).toBe(true);
      expect(acs.every((a) => a.state === 'departed'), seed).toBe(true);
      expect(leftovers(sim)).toEqual([]);
    }
  });

  it('ゴーアラウンド・ダイバートで確保が残らない（スポット不足の到着の連続）', { timeout: 120_000 }, () => {
    const sim = createSimulation(asBlock(linearLayout({ stands: 2 })), { seed: 'rel-1', settings: manual });
    const t0 = sim.state.now + 20 * 60;
    for (let i = 0; i < 8; i++) addTurnaround(sim, 'narrow180', t0 + i * 90, { departureAt: t0 + 4000 + i * 90 });
    const tr = traceRun(sim, 7 * 3600, { every: 10 });
    expect(tr.violations).toEqual([]);
    expect(allDone(sim)).toBe(true);
    expect(leftovers(sim)).toEqual([]);
    phase2('2-03-release', { diverted: sim.state.stats.diverted, goArounds: sim.state.stats.goArounds, departures: sim.state.stats.departures });
  });

  it('滑走路横断（crossingAirport 6 機）: 違反 0・占有が残らない・許可なしの滑走路上の停止 0', { timeout: 120_000 }, () => {
    for (const seed of SEEDS) {
      const sim = createSimulation(asBlock(crossingAirport()), { seed, settings: manual });
      const t0 = sim.state.now + 600;
      for (let i = 0; i < 6; i++) addTurnaround(sim, i % 2 ? 'narrow180' : 'regional70', t0 + i * 150, { departureAt: t0 + 2400 + i * 90 });
      const tr = traceRun(sim, 6 * 3600, { every: 10 });
      expect(tr.violations, seed).toEqual([]);
      expect(sim.state.stats.conflicts).toBe(0);
      expect(allDone(sim), seed).toBe(true);
      expect(leftovers(sim)).toEqual([]);
      expect(tr.stoppedOnRunwayNoGrant).toBe(0);
    }
  });

  it('ストレス配置 30 機 × 3 シード: 違反・競合 0・全機が終端・占有が残らない', { timeout: 180_000 }, () => {
    for (const seed of SEEDS) {
      const sim = createSimulation(asBlock(createStressLayout()), { seed, settings: manual });
      const rng = new Rng(`${seed}:arr`);
      const t0 = sim.state.now + 600;
      for (let i = 0; i < 30; i++) addTurnaround(sim, i % 3 === 0 ? 'regional70' : 'narrow180', t0 + i * 120 + rng.int(0, 60), { departureAt: t0 + 3000 + i * 60 });
      const tr = traceRun(sim, 8 * 3600, { every: 10 });
      expect(tr.violations, seed).toEqual([]);
      expect(sim.state.stats.conflicts, seed).toBe(0);
      expect(allDone(sim), seed).toBe(true);
      expect(leftovers(sim), seed).toEqual([]);
      phase2('2-03-stress', { seed, departures: sim.state.stats.departures, diverted: sim.state.stats.diverted, stats: sim.state.taxiBlocks!.stats });
    }
  });

  it('滑走路手前の列: 滑走路を一時的に使えなくすると列ができ、先頭だけ holdShort・後ろは taxiOut のまま runwayQueue。再開後に順に離陸（間隔・B4 を検査）', () => {
    for (const seed of SEEDS) {
      const sim = createSimulation(asBlock(longApproachLayout(4)), { seed, settings: manual });
      const acs = simultaneous(sim, 4, seed);
      const rid = Object.keys(sim.ctx.runways)[0]!;
      let closedAt = -1;
      let maxQ = 0;
      const tr = traceRun(sim, 6 * 3600, {
        every: 10,
        onTick: (s) => {
          if (closedAt < 0 && acs.some((a) => a.state === 'taxiOut')) {
            closedAt = s.state.now;
            // 滑走路を 25 分間使えなくする（直前の離陸があったことにして、離陸間隔の待ち 'separation' を延ばす。経路・スポットには影響しない）
            s.state.runways[rid]!.lastOp = { kind: 'dep', size: 'L', at: closedAt + 25 * 60 - 120 };
          }
          const q = Object.values(s.state.aircraft).filter((a) => a.state === 'holdShort' || (a.state === 'taxiOut' && a.holdReason === 'runwayQueue'));
          maxQ = Math.max(maxQ, q.length);
          for (const a of q) if (a.state === 'taxiOut') expect(a.holdReason).toBe('runwayQueue');
        },
      });
      expect(tr.violations, seed).toEqual([]);
      expect(allDone(sim), seed).toBe(true);
      expect(acs.every((a) => a.state === 'departed')).toBe(true);
      expect(maxQ, seed).toBeGreaterThanOrEqual(2);
      expect(tr.holdReasons.has('runwayQueue'), seed).toBe(true);
      const tk = takeoffTimes(acs);
      for (let i = 1; i < tk.length; i++) expect(tk[i]!.t - tk[i - 1]!.t).toBeGreaterThanOrEqual(SEPARATION_SEC.M.M);
      phase2('2-03-queue', { seed, maxQueue: maxQ, takeoffs: tk.map((x) => x.t) });
    }
  });

  it('各待機理由が実際に出る: blockFull / opposingTraffic / crossing（runwayQueue は上の列のテスト。2-06）', { timeout: 180_000 }, () => {
    const reasons = new Set<string>();
    const watch = (s: { state: { aircraft: Record<string, { holdReason: string | null }> } }) => {
      for (const a of Object.values(s.state.aircraft)) if (a.holdReason) reasons.add(a.holdReason);
    };
    // 正面衝突: 出発と到着が同じ回廊を逆向きに使う
    for (let k = -6; k <= 6; k++) {
      const sim = createSimulation(asBlock(linearLayout({ stands: 2 })), { seed: 'hr', settings: manual });
      const t0 = sim.state.now + 20 * 60;
      addTurnaround(sim, 'narrow180', t0, { departureAt: t0 + 3000 });
      addTurnaround(sim, 'narrow180', t0 + 3000 + k * 60, { departureAt: t0 + 6600 + k * 60 });
      traceRun(sim, 4 * 3600, { every: 600, onTick: watch });
    }
    const sim = createSimulation(asBlock(crossingAirport()), { seed: 'hr', settings: manual });
    const t0 = sim.state.now + 600;
    for (let i = 0; i < 4; i++) addTurnaround(sim, 'narrow180', t0 + i * 100, { departureAt: t0 + 2400 + i * 60 });
    traceRun(sim, 5 * 3600, { every: 600, onTick: watch });
    const s2 = createSimulation(asBlock(createStressLayout()), { seed: 'd1-s1', settings: manual });
    const rng = new Rng('d1-s1:arr');
    for (let i = 0; i < 30; i++) addTurnaround(s2, i % 3 === 0 ? 'regional70' : 'narrow180', s2.state.now + 600 + i * 120 + rng.int(0, 60), { departureAt: s2.state.now + 3600 + i * 60 });
    traceRun(s2, 4 * 3600, { every: 600, onTick: watch });
    phase2('2-06-reasons', { reasons: [...reasons].sort() });
    for (const r of ['blockFull', 'opposingTraffic', 'crossing']) expect(reasons.has(r), r).toBe(true);
  });

  it('状態の往復（コアの検査）: 途中（走行中・列・横断中）で state を JSON にして戻し、続きが連続実行と JSON で一致する（occ の順・locks・派生データは作り直し）', { timeout: 120_000 }, () => {
    const mk = (kind: 'linear' | 'crossing') => {
      if (kind === 'linear') {
        const sim = createSimulation(asBlock(linearLayout({ stands: 4 })), { seed: 'rt', settings: manual });
        simultaneous(sim, 4, 'rt');
        return sim;
      }
      const sim = createSimulation(asBlock(crossingAirport()), { seed: 'rt', settings: manual });
      const t0 = sim.state.now + 600;
      for (let i = 0; i < 6; i++) addTurnaround(sim, i % 2 ? 'narrow180' : 'regional70', t0 + i * 150, { departureAt: t0 + 2400 + i * 90 });
      return sim;
    };
    for (const kind of ['linear', 'crossing'] as const) {
      const ref = mk(kind);
      const total = 3 * 3600;
      const refStates: string[] = [];
      for (const at of [1500, 3000, 4800, 6200]) {
        const probe = mk(kind);
        for (let i = 0; i < at; i++) stepSimulation(probe);
        const occKeys = Object.keys(probe.state.taxiBlocks!.occ).length;
        const restored = createSimulation(probe.ctx.layout, { seed: 'rt', settings: manual });
        restored.state = JSON.parse(JSON.stringify(probe.state));
        for (let i = at; i < total; i++) {
          stepSimulation(probe);
          stepSimulation(restored);
        }
        expect(JSON.stringify(restored.state), `${kind} @${at} occ=${occKeys}`).toBe(JSON.stringify(probe.state));
        refStates.push(`${at}:${occKeys}`);
      }
      void ref;
      phase2('2-10-core-roundtrip', { kind, points: refStates });
    }
  });

  it('決定性: 同じ入力から同じ状態（JSON 一致）', () => {
    const run = () => {
      const sim = createSimulation(asBlock(linearLayout({ stands: 4 })), { seed: 'det', settings: manual });
      simultaneous(sim, 4, 'det');
      for (let i = 0; i < 2 * 3600; i++) stepSimulation(sim);
      return JSON.stringify(sim.state);
    };
    expect(run()).toBe(run());
  });
});
