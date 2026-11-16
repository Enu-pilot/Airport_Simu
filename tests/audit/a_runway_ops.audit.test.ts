/**
 * 監査 docs/38 ID 05（滑走路運用）— 複数滑走路・交差/平行・横断予約・閉鎖・間隔・デッドロック。
 * 既存: tests/unit/sim/crossing*.test.ts, holdshort*.test.ts, runway*.test.ts（固定シナリオ）。
 * 本ファイルの追加分: ランダム化した便スケジュール × 複数シード × 複数レイアウトで、途中の不変条件・間隔・占有漏れ・全機終端到達を検査。
 */
import { describe, expect, it } from 'vitest';
import { createStressLayout } from '../golden/layouts';
import { Rng } from '../../src/core/rng';
import { addDisruption } from '../../src/core/sim/disruptions';
import { resolveType } from '../../src/core/sim/aircraftTypes';
import { SEPARATION_SEC } from '../../src/core/sim/rules';
import { addTurnaround, createSimulation, setRunwayConfig, type Simulation } from '../../src/core/sim/simulation';
import type { Aircraft } from '../../src/core/sim/types';
import type { AirportLayout } from '../../src/core/model/types';
import { legacyTwinAirport, freeShallowCrossingAirport } from '../unit/sim/chainLayouts';
import { crossingFreeAirport, parallelFreeAirport } from '../unit/sim/crossingLayouts';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { crossingAirport } from '../unit/sim/helpers';
import { allSettled, runWatched } from './a_helpers';

const manual = { autoSchedule: false, inboundDelayProb: 0 };
const SEEDS = ['a5-s1', 'a5-s2', 'a5-s3'];

/** シード付きのランダム便: 到着間隔・機種・折り返し時間を乱数で決める（M 以下の機種のみ。スポットは M 想定） */
function randomSchedule(sim: Simulation, seed: string, n: number, spanMin: number): Aircraft[] {
  const rng = new Rng(seed);
  const t0 = sim.state.now + 20 * 60;
  const types = ['narrow180', 'regional70'] as const;
  const out: Aircraft[] = [];
  for (let i = 0; i < n; i++) {
    const arr = t0 + Math.round(rng.next() * spanMin * 60);
    const turn = (35 + Math.round(rng.next() * 40)) * 60;
    out.push(addTurnaround(sim, types[rng.int(0, 1)]!, arr, { departureAt: arr + turn }));
  }
  return out;
}

const LAYOUTS: Record<string, () => AirportLayout> = {
  'single(crossingAirport)': crossingAirport,
  'legacyTwin(125m parallel + crossing taxiway)': legacyTwinAirport,
  'freeShallowCrossing(23deg)': freeShallowCrossingAirport,
  'crossingFree(45deg X)': crossingFreeAirport,
  'parallelFree(750m)': parallelFreeAirport,
};

describe('ID05 ランダム便 × 複数レイアウト × 複数シード: 途中の不変条件・デッドロックなし', () => {
  for (const [name, make] of Object.entries(LAYOUTS)) {
    for (const seed of SEEDS) {
      it(`${name} seed=${seed}: 12 機を 8 時間。不変条件違反ゼロ・競合ゼロ・全機が終端状態へ・占有/予約が残らない`, { timeout: 180_000 }, () => {
        const sim = createSimulation(make(), { seed, settings: manual });
        const acs = randomSchedule(sim, seed, 12, 120);
        const r = runWatched(sim, 6 * 3600, { every: 7 });
        const ctx = `layout=${name} seed=${seed}`;
        expect(r.violations, ctx).toEqual([]);
        expect(r.maxStandOwners, ctx).toBeLessThanOrEqual(1);
        expect(r.stuck, ctx).toEqual([]);
        expect(sim.state.stats.conflicts, ctx).toBe(0);
        // デッドロックなし: 全機が出発/ダイバート/欠航のいずれかで終端に到達
        expect(allSettled(sim), `${ctx} remaining=${acs.filter((a) => !['departed', 'diverted', 'cannotOperate'].includes(a.state)).map((a) => `${a.id}:${a.state}/${a.holdReason}`)}`).toBe(true);
        // 会計: 到着 = 着陸した機体数、出発 = departed の機数
        const departed = acs.filter((a) => a.state === 'departed').length;
        expect(sim.state.stats.departures, ctx).toBe(departed);
        expect(sim.state.stats.arrivals + sim.state.stats.diverted + sim.state.stats.cancelled, ctx).toBeGreaterThanOrEqual(acs.length - acs.filter((a) => a.state === 'cannotOperate').length);
        // 占有・予約の漏れなし
        for (const [rid, rs] of Object.entries(sim.state.runways)) {
          expect(rs.occupant, `${ctx} ${rid}`).toBeNull();
          expect(rs.booking, `${ctx} ${rid}`).toBeNull();
        }
        expect(sim.state.nodeReservations, ctx).toEqual({});
        expect(sim.state.edgeReservations, ctx).toEqual({});
        expect(sim.state.standAssignments, ctx).toEqual({});
        // 会計恒等式: 全機が出発/ダイバート/欠航のいずれか。ダイバート機は一度も駐機していない（スポット不足 = 能力問題であり不具合ではない）
        const diverted = acs.filter((a) => a.state === 'diverted');
        expect(departed + diverted.length + acs.filter((a) => a.state === 'cannotOperate').length, ctx).toBe(acs.length);
        for (const a of diverted) expect(a.history.some((h) => h.state === 'parked'), `${ctx} ${a.id}`).toBe(false);
        expect(departed, ctx).toBeGreaterThanOrEqual(2);
      });
    }
  }
});

describe('ID05 同一滑走路の着陸間隔（SEPARATION_SEC）', () => {
  it('同じ滑走路の連続する着陸開始は、先行機・後続機の区分に応じた最小間隔以上空く（seeds 3）', { timeout: 180_000 }, () => {
    for (const seed of SEEDS) {
      const sim = createSimulation(createSampleAirport(), { seed, settings: manual }); // 単一滑走路 rwy_1・スポット 9
      const acs = randomSchedule(sim, seed, 14, 40); // 密な到着
      const r = runWatched(sim, 6 * 3600, { every: 11 });
      expect(r.violations, seed).toEqual([]);
      const landings = acs
        .map((a) => ({ a, t: a.history.find((h) => h.state === 'landing')?.t, rwy: a.runwayId }))
        .filter((x): x is { a: Aircraft; t: number; rwy: string | null } => x.t !== undefined)
        .sort((p, q) => p.t - q.t);
      expect(landings.length, seed).toBeGreaterThanOrEqual(8);
      let minGap = Infinity;
      for (let i = 1; i < landings.length; i++) {
        const gap = landings[i]!.t - landings[i - 1]!.t;
        minGap = Math.min(minGap, gap);
        // 同じ滑走路の連続着陸: 先行機・後続機の区分の SEPARATION_SEC 以上（天候は晴れ = 倍率 1）
        const p = landings[i - 1]!;
        const q = landings[i]!;
        if (p.rwy !== q.rwy) continue;
        const need = SEPARATION_SEC[resolveType(sim.ctx.types, p.a.typeId).size][resolveType(sim.ctx.types, q.a.typeId).size];
        expect(gap, `${seed} ${p.a.id}->${q.a.id}`).toBeGreaterThanOrEqual(need);
      }
      expect(minGap).toBeLessThan(Infinity);
    }
  });
});

describe('ID05 滑走路閉鎖（障害）を途中で挟んでも詰まらない', () => {
  for (const seed of SEEDS) {
    it(`parallelFree seed=${seed}: 片側滑走路を 30 分閉鎖→復旧。不変条件維持・閉鎖中は閉鎖滑走路を離着陸に使わない・全機が終端`, { timeout: 180_000 }, () => {
      const sim = createSimulation(parallelFreeAirport(), { seed, settings: manual });
      const acs = randomSchedule(sim, seed, 10, 100);
      const rid = Object.keys(sim.ctx.layout.runways).sort()[0]!;
      let closedFrom = -1;
      let usedWhileClosed = 0;
      const r = runWatched(sim, 9 * 3600, {
        every: 9,
        onTick: (s, i) => {
          if (i === 40 * 60) {
            addDisruption(s, { kind: 'runwayClosed', targetId: rid, end: s.state.now + 30 * 60 });
            closedFrom = s.state.now;
          }
          if (closedFrom > 0 && s.state.now >= closedFrom + 1 && s.state.now < closedFrom + 30 * 60) {
            const occ = s.state.runways[rid]!.occupant;
            // 閉鎖「前」から占有していた機体の継続は許容（直後の数十秒）。それ以降の新規 landing/takeoff 占有は不可
            if (occ && occ.purpose !== 'crossing' && s.state.now > closedFrom + 180) usedWhileClosed++;
          }
        },
      });
      expect(r.violations, seed).toEqual([]);
      expect(usedWhileClosed, `seed=${seed} 閉鎖中に離着陸占有`).toBe(0);
      expect(allSettled(sim), `seed=${seed}`).toBe(true);
      expect(acs.filter((a) => a.state === 'departed').length, seed).toBeGreaterThanOrEqual(7);
    });
  }

  it('全滑走路を長時間閉鎖すると到着機はダイバート/待機し、復旧後は占有・予約が残らない（デッドロックしない）', { timeout: 180_000 }, () => {
    const sim = createSimulation(crossingAirport(), { seed: 'a5-allclosed', settings: manual });
    const acs = randomSchedule(sim, 'a5-allclosed', 6, 30);
    const rid = Object.keys(sim.ctx.layout.runways)[0]!;
    const r = runWatched(sim, 8 * 3600, {
      onTick: (s, i) => {
        if (i === 5 * 60) addDisruption(s, { kind: 'runwayClosed', targetId: rid, end: s.state.now + 90 * 60 });
      },
    });
    expect(r.violations).toEqual([]);
    expect(allSettled(sim)).toBe(true);
    expect(sim.state.runways[rid]!.occupant).toBeNull();
    expect(acs.every((a) => ['departed', 'diverted', 'cannotOperate'].includes(a.state))).toBe(true);
  });
});

describe('ID05 運用モード（到着専用/出発専用）と方向の切替', () => {
  it('2 本の平行滑走路で 1 本を arrivals 専用・他方を departures 専用にしても、全機が終端へ到達し不変条件を維持する（seeds 3）', { timeout: 180_000 }, () => {
    for (const seed of SEEDS) {
      const sim = createSimulation(parallelFreeAirport(), { seed, settings: manual });
      const [r0, r1] = Object.keys(sim.ctx.layout.runways).sort();
      setRunwayConfig(sim, r0!, { mode: 'arrivals' });
      setRunwayConfig(sim, r1!, { mode: 'departures' });
      const acs = randomSchedule(sim, seed, 10, 90);
      const r = runWatched(sim, 8 * 3600, { every: 9 });
      expect(r.violations, seed).toEqual([]);
      expect(allSettled(sim), seed).toBe(true);
      // 専用モードの遵守: 着陸は r0、離陸は r1
      for (const a of acs) {
        const landed = a.history.some((h) => h.state === 'landing');
        const took = a.history.some((h) => h.state === 'takeoff');
        if (landed) expect(a.history.find((h) => h.state === 'landing') && sim.state.flights[a.arrivalFlightId]!.runwayId, `${seed} ${a.id}`).toBe(r0);
        if (took) expect(sim.state.flights[a.departureFlightId]!.runwayId, `${seed} ${a.id}`).toBe(r1);
      }
    }
  });
});

describe('ID05 ストレス: 並列滑走路 + 滑走路横断が必須のレイアウト（createStressLayout）', () => {
  it('seed=a5-stress: 24 機・密な到着。横断予約が発生し、不変条件違反・競合・占有漏れがなく全機終端へ', { timeout: 300_000 }, () => {
    const sim = createSimulation(createStressLayout(), { seed: 'a5-stress', settings: manual });
    const acs = randomSchedule(sim, 'a5-stress', 24, 150);
    let crossings = 0;
    const r = runWatched(sim, 10 * 3600, {
      every: 13,
      onTick: (s) => {
        for (const a of Object.values(s.state.aircraft)) if (a.crossing) crossings++;
      },
    });
    expect(r.violations).toEqual([]);
    expect(r.stuck).toEqual([]);
    expect(sim.state.stats.conflicts).toBe(0);
    expect(allSettled(sim)).toBe(true);
    for (const rs of Object.values(sim.state.runways)) expect(rs.occupant).toBeNull();
    expect(crossings, '横断の許可が実際に使われていること').toBeGreaterThan(0);
    expect(acs.filter((a) => a.state === 'departed').length).toBeGreaterThanOrEqual(18);
  });
});
