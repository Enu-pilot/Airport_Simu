import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { deleteEntity } from '../../../src/core/layout/operations';
import { addTurnaround, createSimulation, setRunwayConfig, stepSimulation } from '../../../src/core/sim/simulation';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { advanceClock, createClock } from '../../../src/core/sim/clock';
import { SEPARATION_SEC } from '../../../src/core/sim/rules';
import type { AircraftState } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { crossingAirport, keepOnlyStand, runUntil, states } from './helpers';

const manual = { autoSchedule: false };
const ARRIVAL_SEQ: AircraftState[] = ['scheduled', 'inbound', 'approach', 'landing', 'vacating', 'taxiIn', 'docking', 'parked'];
const DEPARTURE_SEQ: AircraftState[] = ['turnaround', 'readyForPushback', 'pushback', 'taxiOut', 'holdShort', 'lineUp', 'takeoff', 'departed'];

describe('到着から駐機まで', () => {
  it('着陸 → 滑走路離脱 → 誘導路 → スポット進入 → 駐機の順に遷移する', () => {
    const sim = createSimulation(createSampleAirport(), { settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60);
    runUntil(sim, () => ac.state === 'parked', 3 * 3600);
    expect(states(sim, ac.id)).toEqual(ARRIVAL_SEQ);
    // スポットは割り当て済み、駐機位置はそのスポット
    expect(ac.standId).not.toBeNull();
    expect(sim.state.standAssignments[ac.standId!]).toBe(ac.id);
    const standNode = sim.ctx.network.nodes[`${ac.standId}:P`]!.pos;
    expect([ac.x, ac.y]).toEqual([standNode.x, standNode.y]);
    // 滑走路・予約は解放されている
    expect(sim.state.runways.rwy_1!.occupant).toBeNull();
    expect(sim.state.nodeReservations).toEqual({});
    expect(sim.state.edgeReservations).toEqual({});
    const arr = sim.state.flights[ac.arrivalFlightId]!;
    expect(arr.status).toBe('completed');
    expect(arr.block).toBeGreaterThan(arr.actual!);
  });
});

describe('駐機から離陸まで', () => {
  it('出発準備 → プッシュバック → 出発走行 → 離陸待ち → 離陸 → 出発完了', () => {
    const sim = createSimulation(createSampleAirport(), { settings: manual });
    const ac = addTurnaround(sim, 'regional70', sim.state.now + 20 * 60, { departureAt: sim.state.now + 80 * 60 });
    runUntil(sim, () => ac.state === 'departed', 6 * 3600);
    expect(states(sim, ac.id)).toEqual([...ARRIVAL_SEQ, ...DEPARTURE_SEQ]);
    expect(sim.state.standAssignments).toEqual({});
    expect(sim.state.runways.rwy_1!.occupant).toBeNull();
    const dep = sim.state.flights[ac.departureFlightId]!;
    expect(dep.status).toBe('completed');
    expect(dep.block).toBeGreaterThanOrEqual(dep.scheduled); // 予定時刻より前には出発しない
    expect(sim.state.stats).toMatchObject({ arrivals: 1, departures: 1, conflicts: 0 });
  });
});

describe('駐機スポットの競合', () => {
  it('スポットが1つなら2機目は空くまで空中待機し、同時に割り当てない', () => {
    const layout = keepOnlyStand(createSampleAirport(), 'std_1');
    const sim = createSimulation(layout, { settings: manual });
    const t = sim.state.now + 20 * 60;
    // a の折り返し（30分）が b の空中待機上限（45分）より先に終わるようにする
    const a = addTurnaround(sim, 'regional70', t, { departureAt: t + 35 * 60 });
    const b = addTurnaround(sim, 'narrow180', t + 2 * 60, { departureAt: t + 3 * 3600 });
    runUntil(sim, () => b.state === 'holding' && b.holdReason === 'noStand', 3600);
    expect(a.standId).toBe('std_1');
    expect(b.standId).toBeNull();
    // a が出発してスポットが空くと b が使う（runUntil が毎ティック二重割り当てを検査する）
    runUntil(sim, () => b.state === 'parked', 4 * 3600);
    expect(b.standId).toBe('std_1');
    expect(a.state === 'taxiOut' || a.state === 'holdShort' || a.state === 'lineUp' || a.state === 'takeoff' || a.state === 'departed').toBe(true);
    expect(sim.state.flights[b.arrivalFlightId]!.delayCauses).toContain('noStand');
  });
});

describe('滑走路の占有', () => {
  it('連続する到着は滑走路を同時に使わず、間隔を空けて着陸する', () => {
    const sim = createSimulation(createSampleAirport(), { settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'wide300', t);
    const b = addTurnaround(sim, 'regional70', t);
    const parked = (id: string) => states(sim, id).includes('parked');
    let maxApproaching = 0;
    runUntil(
      sim,
      () => {
        maxApproaching = Math.max(maxApproaching, [a, b].filter((x) => x.state === 'approach').length);
        return parked(a.id) && parked(b.id);
      },
      3 * 3600,
    );
    const la = sim.state.flights[a.arrivalFlightId]!.actual!;
    const lb = sim.state.flights[b.arrivalFlightId]!.actual!;
    // 先行 L 級 → 後続 S 級の間隔（120秒）以上空けて接地
    expect(lb - la).toBeGreaterThanOrEqual(SEPARATION_SEC.L.S);
    // 最終進入できるのは1機ずつ（2機目は間隔待ちで空中待機した）
    expect(maxApproaching).toBe(1);
    expect(b.history.some((h) => h.state === 'holding' && h.note === 'separation')).toBe(true);
  });

  it('到着機が着陸滑走中は出発機は滑走路に入らない', () => {
    const sim = createSimulation(createSampleAirport(), { settings: manual });
    const t = sim.state.now + 20 * 60;
    const dep = addTurnaround(sim, 'regional70', t, { departureAt: t + 32 * 60 });
    let arr: ReturnType<typeof addTurnaround> | null = null;
    runUntil(
      sim,
      () => {
        if (!arr && dep.state === 'taxiOut') arr = addTurnaround(sim, 'narrow180', sim.state.now + 2 * 60);
        const rs = sim.state.runways.rwy_1!;
        // 同時に2機が滑走路を使う状態は無い（占有は1機分しか持てない）
        if (arr && dep.state === 'lineUp') expect(['landing', 'approach'].includes(arr.state) && rs.occupant?.aircraftId !== dep.id).toBe(false);
        return dep.state === 'departed' && arr !== null && (arr as { state: AircraftState }).state === 'parked';
      },
      4 * 3600,
    );
  });

  it('閉鎖した滑走路には進入せず、空中待機の上限でダイバート（運航不能）', () => {
    const sim = createSimulation(createSampleAirport(), { settings: manual });
    setRunwayConfig(sim, 'rwy_1', { mode: 'closed' });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 16 * 60);
    runUntil(sim, () => ac.state === 'diverted', 2 * 3600);
    expect(ac.history.some((h) => h.state === 'landing')).toBe(false);
    expect(sim.state.flights[ac.arrivalFlightId]!.status).toBe('diverted');
    expect(sim.state.flights[ac.departureFlightId]!.status).toBe('cancelled');
  });
});

describe('到達不能な経路', () => {
  it('滑走路とスポットがつながっていなければ着陸せず待機し、最後はダイバート', () => {
    let layout = createSampleAirport();
    for (const t of Object.values(layout.taxiways).filter((e) => /^A\d$/.test(e.name))) {
      layout = must(deleteEntity(layout, t.id)).layout;
    }
    const sim = createSimulation(layout, { settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 16 * 60);
    runUntil(sim, () => ac.holdReason === 'noRoute', 3600);
    expect(ac.state).toBe('holding');
    runUntil(sim, () => ac.state === 'diverted', 2 * 3600);
    // 地上には一度も降りていない（瞬間移動もしない）
    expect(ac.history.map((h) => h.state)).toEqual(['scheduled', 'inbound', 'holding', 'diverted']);
  });
});

describe('滑走路の横断', () => {
  it('横断が必要な経路では許可を得てから横断し、到着・出発とも完了する', () => {
    const sim = createSimulation(crossingAirport(), { settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { departureAt: sim.state.now + 90 * 60 });
    let crossings = 0;
    let wasCrossing = false;
    runUntil(
      sim,
      () => {
        const crossing = sim.state.runways.rwy_1!.occupant?.purpose === 'crossing';
        if (crossing && !wasCrossing) crossings++;
        wasCrossing = crossing;
        return ac.state === 'departed';
      },
      6 * 3600,
    );
    expect(crossings).toBe(2); // 到着後と出発前に1回ずつ
    expect(states(sim, ac.id)).toEqual([...ARRIVAL_SEQ, ...DEPARTURE_SEQ]);
  });
});

describe('一日の運航（サンプル空港）', () => {
  it('不変条件を保ったまま全便が完了し、同じシードなら結果が同じ', () => {
    const run = () => {
      const sim = createSimulation(createSampleAirport(), { seed: 'test-day', settings: { flightsPerDay: 24 } });
      runUntil(sim, () => sim.state.now >= 26 * 3600, 21 * 3600);
      return sim;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    // 0日目に到着した24機（48便）が、到着・出発とも完了している
    const day0 = Object.values(a.state.aircraft).filter((ac) => a.state.flights[ac.arrivalFlightId]!.scheduled < 24 * 3600);
    expect(day0.length).toBe(24);
    expect(day0.every((ac) => ac.state === 'departed')).toBe(true);
    expect(a.state.stats.conflicts).toBe(0);
  }, 30_000);
});

describe('一時停止・再開・時間倍率', () => {
  it('一時停止中はティックが進まない', () => {
    const clock = createClock(0);
    expect(advanceClock(clock, 1).ticks).toBe(0);
  });

  it('倍率に応じたティック数になり、端数は持ち越される', () => {
    let clock = createClock(60);
    let total = 0;
    for (let i = 0; i < 60; i++) {
      const r = advanceClock(clock, 1 / 60);
      total += r.ticks;
      clock = r.clock;
    }
    expect(total).toBe(60);
    const fast = advanceClock(createClock(600), 0.1);
    expect(fast.ticks).toBe(60);
  });

  it('処理落ちで積み残したティックは捨てる（時間を飛ばさない）', () => {
    const r = advanceClock(createClock(600), 0.2, 50);
    expect(r).toMatchObject({ ticks: 50, dropped: true });
    expect(r.clock.acc).toBe(0);
    // 長時間の停止（タブ非表示）からの復帰でも 1 フレーム分しか進めない
    expect(advanceClock(createClock(60), 30).ticks).toBe(15);
  });

  it('フレームの刻み方・一時停止を挟んでも、同じティック数なら同じ結果になる', () => {
    const make = () => {
      const sim = createSimulation(createSampleAirport(), { seed: 'pause', settings: { flightsPerDay: 12 } });
      return sim;
    };
    const a = make();
    for (let i = 0; i < 4 * 3600; i++) stepSimulation(a);

    const b = make();
    let clock = createClock(240);
    let ticks = 0;
    const frames = [1 / 60, 1 / 30, 0.2, 1 / 144, 0.05];
    for (let f = 0; ticks < 4 * 3600; f++) {
      // 途中で一時停止 → 再開
      if (f === 100) clock = { ...clock, speed: 0 };
      if (f === 150) clock = { ...clock, speed: 600 };
      const r = advanceClock(clock, frames[f % frames.length]!);
      clock = r.clock;
      const n = Math.min(r.ticks, 4 * 3600 - ticks);
      for (let i = 0; i < n; i++) {
        stepSimulation(b);
        if (checkInvariants(b).length) throw new Error('invariant');
      }
      ticks += n;
    }
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  }, 30_000);
});
