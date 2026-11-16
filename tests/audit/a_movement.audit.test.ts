/**
 * 監査 docs/38 ID 06（航空機の移動）— 到着 → 誘導 → 駐機 → 折り返し → プッシュバック → 離陸の追跡。
 * 既存: tests/unit/sim/simulation.test.ts（単機の遷移）, ground.test.ts, resourceClosures.test.ts, invariants.test.ts。
 * 追加: ランダム多機 × 複数シード × 途中の閉鎖で、状態列の単調性・位置連続性（瞬間移動なし）・停滞なし・スポット二重占有なしを検査。
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { setManualResourceClosure } from '../../src/core/sim/disruptions';
import { addTurnaround, createSimulation, type Simulation } from '../../src/core/sim/simulation';
import type { Aircraft, AircraftState } from '../../src/core/sim/types';
import { keepOnlyStand } from '../unit/sim/helpers';
import { allSettled, runWatched } from './a_helpers';

const manual = { autoSchedule: false, inboundDelayProb: 0 };
const SEEDS = ['a6-s1', 'a6-s2', 'a6-s3'];

/** 状態の標準順序。履歴はこの順序に対して単調（飛ばしは可、逆行は不可） */
const ORDER: AircraftState[] = [
  'scheduled', 'inbound', 'holding', 'approach', 'landing', 'vacating', 'taxiIn', 'docking', 'parked',
  'turnaround', 'readyForPushback', 'pushback', 'taxiOut', 'holdShort', 'lineUp', 'takeoff', 'departed',
];

function schedule(sim: Simulation, seed: string, n: number, spanMin: number): Aircraft[] {
  const rng = new Rng(seed);
  const t0 = sim.state.now + 20 * 60;
  const out: Aircraft[] = [];
  for (let i = 0; i < n; i++) {
    const arr = t0 + Math.round(rng.next() * spanMin * 60);
    const ty = (['regional70', 'narrow180', 'narrow180'] as const)[rng.int(0, 2)]!;
    out.push(addTurnaround(sim, ty, arr, { departureAt: arr + (40 + rng.int(0, 40)) * 60 }));
  }
  return out;
}

describe('ID06 多機ランダム運航: 状態列・位置連続性・停滞なし・スポット二重占有なし', () => {
  for (const seed of SEEDS) {
    it(`sample airport seed=${seed}: 16 機 / 8h。履歴が標準順序に単調、1 tick の移動 ≤ 100 m、停滞なし、全機 departed`, { timeout: 240_000 }, () => {
      const sim = createSimulation(createSampleAirport(), { seed, settings: manual });
      const acs = schedule(sim, seed, 16, 150);
      const r = runWatched(sim, 8 * 3600, { every: 5 });
      expect(r.violations, seed).toEqual([]);
      expect(r.maxStandOwners, seed).toBeLessThanOrEqual(1);
      expect(r.maxStepM, `${seed} teleport`).toBeLessThanOrEqual(100 + 1e-6);
      expect(r.stuck, seed).toEqual([]);
      expect(allSettled(sim), seed).toBe(true);
      for (const a of acs) {
        const idx = a.history.map((h) => ORDER.indexOf(h.state)).filter((i) => i >= 0);
        for (let i = 1; i < idx.length; i++) expect(idx[i]!, `${seed} ${a.id} ${a.history.map((h) => h.state).join('>')}`).toBeGreaterThan(idx[i - 1]!);
        if (a.state === 'departed') {
          const names = a.history.map((h) => h.state);
          for (const s of ['landing', 'taxiIn', 'parked', 'turnaround', 'pushback', 'taxiOut', 'takeoff'] as const) expect(names, `${seed} ${a.id}`).toContain(s);
          // 履歴の時刻は単調非減少
          for (let i = 1; i < a.history.length; i++) expect(a.history[i]!.t).toBeGreaterThanOrEqual(a.history[i - 1]!.t);
          // 出発は予定より前に block off しない
          const dep = sim.state.flights[a.departureFlightId]!;
          expect(dep.block!, `${seed} ${a.id}`).toBeGreaterThanOrEqual(dep.scheduled);
          // 到着の block-in は actual（接地）の後
          const arr = sim.state.flights[a.arrivalFlightId]!;
          expect(arr.block!).toBeGreaterThan(arr.actual!);
        }
      }
    });
  }

  it('駐機中の機体の位置は、割り当てスポットの駐機ノード位置に一致する（seed=a6-s1 を途中で採取）', { timeout: 120_000 }, () => {
    const seed = 'a6-s1';
    const sim = createSimulation(createSampleAirport(), { seed, settings: manual });
    schedule(sim, seed, 12, 120);
    let checked = 0;
    runWatched(sim, 6 * 3600, {
      every: 50,
      onTick: (s) => {
        for (const a of Object.values(s.state.aircraft)) {
          if ((a.state === 'parked' || a.state === 'turnaround' || a.state === 'readyForPushback') && a.standId) {
            const n = s.ctx.network.nodes[`${a.standId}:P`]!.pos;
            expect([a.x, a.y], `${a.id}@${s.state.now}`).toEqual([n.x, n.y]);
            checked++;
          }
        }
      },
    });
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('ID06 混雑: スポット 1 つに多数の到着', () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 1 スポット × 6 機。使用区間が重ならず、待機理由 noStand が発生し、二重占有しない`, { timeout: 240_000 }, () => {
      const layout = keepOnlyStand(createSampleAirport(), 'std_1');
      const sim = createSimulation(layout, { seed, settings: manual });
      const acs = schedule(sim, seed, 6, 20);
      const holdReasons = new Set<string>();
      const r = runWatched(sim, 14 * 3600, {
        every: 5,
        onTick: (s) => {
          for (const a of Object.values(s.state.aircraft)) if (a.holdReason) holdReasons.add(a.holdReason);
        },
      });
      expect(r.violations, seed).toEqual([]);
      expect(r.maxStandOwners, seed).toBeLessThanOrEqual(1);
      expect(allSettled(sim), seed).toBe(true);
      expect(holdReasons.has('noStand'), `${seed} holds=${[...holdReasons]}`).toBe(true);
      // 駐機区間（parked 開始〜pushback 開始）が機体間で重ならない
      const spans = acs
        .filter((a) => a.state === 'departed')
        .map((a) => ({ id: a.id, from: a.history.find((h) => h.state === 'docking')!.t, to: a.history.find((h) => h.state === 'pushback')!.t }))
        .sort((p, q) => p.from - q.from);
      expect(spans.length, seed).toBeGreaterThanOrEqual(1); // 空中待機 45 分の上限でダイバートする機もある（能力不足であり不具合ではない）
      const divertedN = acs.filter((a) => a.state === 'diverted').length;
      expect(spans.length + divertedN, seed).toBe(acs.length);
      for (let i = 1; i < spans.length; i++) expect(spans[i]!.from, `${seed} ${spans[i - 1]!.id}->${spans[i]!.id}`).toBeGreaterThanOrEqual(spans[i - 1]!.to);
      // ダイバートした機体は駐機しない
      for (const a of acs.filter((x) => x.state === 'diverted')) expect(a.history.some((h) => h.state === 'parked')).toBe(false);
    });
  }
});

describe('ID06 途中閉鎖: 誘導路・スポットを運航中に閉鎖/再開', () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 運航中にスポット/誘導路 B1 を閉鎖。閉鎖後に着陸前に割り当てられた機は閉鎖スポットを使わず、不変条件・停滞なし・全機終端`, { timeout: 240_000 }, () => {
      const layout = createSampleAirport();
      const sim = createSimulation(layout, { seed, settings: manual });
      const acs = schedule(sim, seed, 14, 140);
      const b1 = Object.values(layout.taxiways).find((t) => t.name === 'B1')!.id;
      const rng = new Rng(`${seed}:inject`);
      const closeAt = 45 * 60 + rng.int(0, 30 * 60);
      const standsClosed = ['std_1', 'std_2', 'std_3'];
      const afterClose: Aircraft[] = [];
      const r = runWatched(sim, 10 * 3600, {
        every: 5,
        onTick: (s, i) => {
          if (i === closeAt) {
            for (const id of standsClosed) expect(setManualResourceClosure(s, 'stand', id, true)).toEqual({ ok: true });
            expect(setManualResourceClosure(s, 'taxiway', b1, true)).toEqual({ ok: true });
            for (const a of Object.values(s.state.aircraft)) if (a.state === 'scheduled') afterClose.push(a);
          }
          if (i === closeAt + 60 * 60) {
            for (const id of standsClosed) setManualResourceClosure(s, 'stand', id, false);
            setManualResourceClosure(s, 'taxiway', b1, false);
          }
        },
      });
      expect(r.violations, `${seed} closeAt=${closeAt}`).toEqual([]);
      expect(r.stuck, seed).toEqual([]);
      expect(r.maxStandOwners, seed).toBeLessThanOrEqual(1);
      expect(allSettled(sim), seed).toBe(true);
      expect(acs.filter((a) => a.state === 'departed').length, seed).toBeGreaterThanOrEqual(10);
      // 閉鎖中（再開前）に新規に着陸前→スポットを得た機体は閉鎖スポットでない: 駐機（parked）の時刻が閉鎖期間内なら使用スポットは閉鎖対象外
      for (const a of afterClose) {
        const parkedAt = a.history.find((h) => h.state === 'parked')?.t;
        const f = sim.state.flights[a.arrivalFlightId]!;
        if (parkedAt !== undefined && parkedAt > sim.state.now - 10 * 3600 + closeAt + 0 && parkedAt < sim.state.now - 10 * 3600 + closeAt + 60 * 60) {
          expect(standsClosed, `${seed} ${a.id} stand=${f.standId}`).not.toContain(f.standId);
        }
      }
    });
  }

  it('全誘導路を 25 分閉鎖（空中待機上限 45 分未満）: 新規到着機は noRoute で待機し、復旧後に運航を再開して終端へ到達する（デッドロックしない）', { timeout: 120_000 }, () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'a6-alltwy', settings: manual });
    const acs = schedule(sim, 'a6-alltwy', 3, 10);
    const twys = Object.keys(sim.ctx.layout.taxiways);
    const reasons = new Set<string>();
    const r = runWatched(sim, 12 * 3600, {
      every: 5,
      onTick: (s, i) => {
        if (i === 0) for (const t of twys) setManualResourceClosure(s, 'taxiway', t, true);
        if (i === 25 * 60) for (const t of twys) setManualResourceClosure(s, 'taxiway', t, false);
        for (const a of Object.values(s.state.aircraft)) if (a.holdReason) reasons.add(a.holdReason);
      },
    });
    expect(r.violations).toEqual([]);
    expect(reasons.has('noRoute')).toBe(true);
    expect(allSettled(sim)).toBe(true);
    expect(acs.filter((a) => a.state === 'departed').length).toBeGreaterThanOrEqual(1);
  });
});
