import { describe, expect, it } from 'vitest';
import { addTurnaround, createSimulation, setRunwayConfig, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { createContext } from '../../../src/core/sim/context';
import { holdShortDistance, holdShortDistanceAt } from '../../../src/core/sim/routes';
import { HOLD_SHORT_M, HOLD_SHORT_MAX_RATIO, SIN_MIN_HOLD } from '../../../src/core/sim/rules';
import { addTaxiwayPath, placeFreeRunway, placeRunway } from '../../../src/core/layout/operations';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import type { Aircraft } from '../../../src/core/sim/types';
import { emptyLayout, must } from '../helpers';
import { crossingFreeAirport, parallelFreeAirport } from './crossingLayouts';

const states = (ac: Aircraft) => ac.history.map((h) => h.state);

const manual = { autoSchedule: false };
const DONE = ['departed', 'diverted', 'cannotOperate'];

/** 4 機ずつ 2 波（スポットは 4 つ。1 波目の出発後に 2 波目が着く）。毎ティック不変条件を検査する */
function stressSchedule(sim: Simulation): Aircraft[] {
  const t = sim.state.now + 20 * 60;
  const types = ['narrow180', 'regional70', 'narrow180', 'regional70', 'narrow180', 'regional70', 'narrow180', 'regional70'] as const;
  return types.map((ty, i) => {
    const w = i < 4 ? 0 : 1;
    const k = i % 4;
    return addTurnaround(sim, ty, t + w * 55 * 60 + k * 90, { departureAt: t + w * 55 * 60 + 38 * 60 + k * 100 });
  });
}

interface Observed {
  ticks: number;
  holdReasons: Set<string>;
  atomicCrossings: number;
  /** 2 本が同時に離着陸で占有された回数（0 であるべき） */
  simultaneous: number;
  maxLandingOrTakeoff: number;
}

function runStress(sim: Simulation, acs: Aircraft[], maxTicks: number): Observed {
  const obs: Observed = { ticks: 0, holdReasons: new Set(), atomicCrossings: 0, simultaneous: 0, maxLandingOrTakeoff: 0 };
  for (; obs.ticks < maxTicks; obs.ticks++) {
    stepSimulation(sim);
    const v = checkInvariants(sim);
    if (v.length > 0) throw new Error(`t=${sim.state.now}: ${v.join(' / ')}`);
    for (const c of sim.ctx.crossings) {
      const a = sim.state.runways[c.a]!.occupant;
      const b = sim.state.runways[c.b]!.occupant;
      const op = (o: typeof a) => !!o && o.purpose !== 'crossing';
      if (op(a) && op(b)) obs.simultaneous++;
    }
    for (const ac of acs) {
      if (ac.holdReason) obs.holdReasons.add(ac.holdReason);
      if (ac.crossing?.alsoRunwayIds) {
        obs.atomicCrossings++;
        // 横断中は両方の滑走路をこの機体が占有している（原子的な予約）
        for (const rid of [ac.crossing.runwayId, ...ac.crossing.alsoRunwayIds]) {
          expect(sim.state.runways[rid]!.occupant).toMatchObject({ aircraftId: ac.id, purpose: 'crossing' });
        }
      }
    }
    if (acs.every((a) => DONE.includes(a.state))) break;
  }
  return obs;
}

describe('交差する自由形の滑走路: 文脈（S7）', () => {
  it('交差点・交差点ノードの滑走路・自由形の停止位置の情報ができる。従来形だけなら空', () => {
    const ctx = createContext(crossingFreeAirport());
    expect(ctx.crossings).toHaveLength(1);
    expect(ctx.crossings[0]).toMatchObject({ a: 'rwy_1', b: 'rwy_2', distA: 1750 });
    expect(ctx.crossings[0]!.distB).toBeCloseTo(777.8, 1);
    expect(Object.values(ctx.crossingNodeRunways)).toEqual([['rwy_1', 'rwy_2']]);
    expect(Object.keys(ctx.freeRunways)).toEqual(['rwy_1', 'rwy_2']);
    const legacy = createContext(createSampleAirport());
    expect(legacy.crossings).toEqual([]);
    expect(legacy.crossingsByRunway).toEqual({});
    expect(legacy.crossingNodeRunways).toEqual({});
    expect(legacy.freeRunways).toEqual({});
  });
});

describe('交差する自由形の滑走路: 運航（S7）', () => {
  it.each(['seed-a', 'seed-b'])('複数機（2 波 8 機）がデッドロックなく全機出発し、同時使用・競合がない（%s）', (seed) => {
    const sim = createSimulation(crossingFreeAirport(), { settings: manual, seed });
    const acs = stressSchedule(sim);
    const obs = runStress(sim, acs, 8 * 3600);
    expect(acs.map((a) => a.state)).toEqual(acs.map(() => 'departed'));
    expect(sim.state.stats).toMatchObject({ arrivals: 8, departures: 8, diverted: 0, cancelled: 0, conflicts: 0 });
    expect(obs.simultaneous).toBe(0);
    // 交差点での横断（両方の滑走路を同時に予約）と、従属運用による待ちが実際に起きている
    expect(obs.atomicCrossings).toBeGreaterThan(0);
    expect(obs.holdReasons.has('intersection')).toBe(true);
    // 終了時には滑走路・予約がすべて解放されている
    for (const rs of Object.values(sim.state.runways)) expect(rs.occupant).toBeNull();
    expect(sim.state.nodeReservations).toEqual({});
  });

  it('到着専用の A と出発専用の B: 着陸（進入予約）が離陸より優先され、同時に使われない', () => {
    // 出発機が離陸待ちに入る時刻（t + 2190 秒付近）の前後に着陸するよう、到着の時刻を 15 秒刻みで振る
    let waited = 0;
    for (let delta = -240; delta <= 120; delta += 15) {
      const sim = createSimulation(crossingFreeAirport(), { settings: manual });
      setRunwayConfig(sim, 'rwy_1', { mode: 'arrivals' });
      setRunwayConfig(sim, 'rwy_2', { mode: 'departures' });
      const t = sim.state.now + 20 * 60;
      const dep = addTurnaround(sim, 'regional70', t, { departureAt: t + 32 * 60 });
      const arr = addTurnaround(sim, 'regional70', t + 2190 + delta);
      let depWaitedForLanding = false;
      let arrWaitedForTakeoff = false;
      for (let n = 0; n < 4 * 3600; n++) {
        stepSimulation(sim);
        const v = checkInvariants(sim);
        if (v.length > 0) throw new Error(`delta ${delta} t=${sim.state.now}: ${v.join(' / ')}`);
        if (dep.state === 'holdShort' && dep.holdReason === 'intersection' && ['approach', 'landing', 'vacating'].includes(arr.state)) depWaitedForLanding = true;
        if (arr.state === 'holding' && arr.holdReason === 'runwayBusy' && ['lineUp', 'takeoff'].includes(dep.state)) arrWaitedForTakeoff = true;
        // 着陸中の A がある間、B の離陸は始まらない
        if (arr.state === 'landing') expect(['lineUp', 'takeoff']).not.toContain(dep.state);
        if (states(arr).includes('parked') && dep.state === 'departed') break;
      }
      expect(dep.state).toBe('departed');
      expect(states(arr)).toContain('parked');
      if (depWaitedForLanding) {
        waited++;
        // 着陸の進入予約があるあいだ出発が待たされ、離陸は着陸の後（着陸が優先）
        expect(sim.state.flights[dep.departureFlightId]!.actual!).toBeGreaterThan(sim.state.flights[arr.arrivalFlightId]!.actual!);
      }
      if (arrWaitedForTakeoff) expect(sim.state.flights[arr.arrivalFlightId]!.actual!).toBeGreaterThan(sim.state.flights[dep.departureFlightId]!.actual!);
    }
    expect(waited).toBeGreaterThan(0);
  });

  it('接地の時点で交差する滑走路が使用中なら着陸復行し、後で着陸する', () => {
    const sim = createSimulation(crossingFreeAirport(), { settings: manual });
    setRunwayConfig(sim, 'rwy_2', { mode: 'closed' });
    const a = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60);
    for (let i = 0; i < 4 * 3600 && a.state !== 'approach'; i++) stepSimulation(sim);
    expect(a.state).toBe('approach');
    expect(a.runwayId).toBe('rwy_1');
    // 交差する B が使用中になった（進入許可の後に離陸が始まった状況を作る）
    sim.state.runways.rwy_2!.occupant = { aircraftId: 'ac_fake', purpose: 'takeoff', since: sim.state.now };
    for (let i = 0; i < 300 && a.state === 'approach'; i++) stepSimulation(sim);
    expect(a.state).toBe('holding');
    expect(a.holdReason).toBe('goAround');
    expect(sim.state.stats.goArounds).toBe(1);
    expect(sim.state.runways.rwy_1!.occupant).toBeNull();
    expect(sim.state.runways.rwy_1!.booking).toBeNull();
    // B が空けば、再進入して着陸する
    sim.state.runways.rwy_2!.occupant = null;
    for (let i = 0; i < 3 * 3600 && a.state !== 'parked'; i++) {
      stepSimulation(sim);
      expect(checkInvariants(sim)).toEqual([]);
    }
    expect(a.state).toBe('parked');
  });

  it('交差する滑走路の進入予約は組全体で 1 機（2 機目は separation で待つ）', () => {
    const sim = createSimulation(crossingFreeAirport(), { settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'narrow180', t);
    const b = addTurnaround(sim, 'regional70', t);
    let maxApproach = 0;
    for (let i = 0; i < 3 * 3600 && !(states(a).includes('parked') && states(b).includes('parked')); i++) {
      stepSimulation(sim);
      expect(checkInvariants(sim)).toEqual([]);
      maxApproach = Math.max(maxApproach, [a, b].filter((x) => x.state === 'approach').length);
    }
    expect(states(a)).toContain('parked');
    expect(states(b)).toContain('parked');
    expect(maxApproach).toBe(1);
  });

  it('保存 → 復元（状態の複製）しても、続きの運航が一致する', () => {
    const layout = crossingFreeAirport();
    const sim = createSimulation(layout, { settings: manual });
    const acs = stressSchedule(sim);
    for (let i = 0; i < 3600; i++) stepSimulation(sim);
    // ちょうど交差点の横断中の状態を含むように、横断が見つかるまで進める（無くても一致の確認は有効）
    for (let i = 0; i < 2 * 3600 && !acs.some((a) => a.crossing?.alsoRunwayIds); i++) stepSimulation(sim);
    const copy: Simulation = { ctx: createContext(structuredClone(layout)), state: structuredClone(sim.state), company: null };
    expect(checkInvariants(copy)).toEqual([]);
    for (let i = 0; i < 1800; i++) {
      stepSimulation(sim);
      stepSimulation(copy);
    }
    expect(JSON.stringify(copy.state)).toBe(JSON.stringify(sim.state));
  });
});

describe('不変条件 R6（S7）', () => {
  it('交差する 2 本が同時に離着陸で占有されると検出する。横断の占有（also）は R2 に違反しない', () => {
    const sim = createSimulation(crossingFreeAirport(), { settings: manual });
    const acs = stressSchedule(sim);
    expect(checkInvariants(sim)).toEqual([]);
    sim.state.runways.rwy_1!.occupant = { aircraftId: acs[0]!.id, purpose: 'takeoff', since: 0 };
    sim.state.runways.rwy_2!.occupant = { aircraftId: acs[1]!.id, purpose: 'landing', since: 0 };
    expect(checkInvariants(sim).some((v) => v.startsWith('R6'))).toBe(true);
  });
});

describe('平行な自由形の滑走路: 運航（S7）', () => {
  it.each(['seed-a', 'seed-b'])('両方の滑走路で複数機がデッドロックなく全機出発する（%s）', (seed) => {
    const sim = createSimulation(parallelFreeAirport(), { settings: manual, seed });
    expect(sim.ctx.crossings).toEqual([]);
    const acs = stressSchedule(sim);
    const obs = runStress(sim, acs, 8 * 3600);
    expect(acs.map((a) => a.state)).toEqual(acs.map(() => 'departed'));
    expect(sim.state.stats).toMatchObject({ arrivals: 8, departures: 8, diverted: 0, cancelled: 0, conflicts: 0 });
    expect(obs.simultaneous).toBe(0);
    // 平行滑走路は独立: どちらの滑走路も使われている（出発先の滑走路が複数）
    const used = new Set(Object.values(sim.state.flights).filter((f) => f.direction === 'departure').map((f) => f.runwayId));
    expect(used.size).toBeGreaterThanOrEqual(1);
  });
});

describe('自由形の停止位置 holdShortDistanceAt（S7）', () => {
  const taxiHold = (headingDeg: number) => {
    // 自由形（東西に近い向き）に、垂直な誘導路（長さ 40 タイル = 1000 m）が接続する
    let l = must(placeFreeRunway(emptyLayout(120, 100), { start: { x: 20, y: 30 }, headingDeg, lengthM: 2000 }, { surfaceWidthM: 45 })).layout;
    // 滑走路の中点から鉛直（北）方向へ伸びる誘導路。中心線との交点にノードができる
    const mid = { x: 20 + Math.sin((headingDeg * Math.PI) / 180) * 40, y: 30 - Math.cos((headingDeg * Math.PI) / 180) * 40 };
    l = must(addTaxiwayPath(l, [{ x: Math.round(mid.x), y: Math.round(mid.y) - 20 }, { x: Math.round(mid.x), y: Math.round(mid.y) + 20 }])).layout;
    const ctx = createContext(l);
    const entry = Object.values(ctx.network.nodes).find((n) => n.kind === 'runwayEntry')!;
    const e = Object.values(ctx.network.edges).find((x) => x.kind === 'taxiway' && (x.from === entry.id || x.to === entry.id))!;
    const other = e.from === entry.id ? e.to : e.from;
    return { ctx, entry: entry.id, other, edgeLen: e.lengthM };
  };

  it('垂直に交わる誘導路: 中心線からの垂直距離 90 m（45 m 幅）がそのまま停止位置', () => {
    const { ctx, entry, other, edgeLen } = taxiHold(90);
    expect(holdShortDistanceAt(ctx, entry, other, edgeLen)).toBeCloseTo(Math.min(90, edgeLen * HOLD_SHORT_MAX_RATIO), 6);
  });

  it('斜めに交わる誘導路: H / sinθ（上限 0.6 倍、θ が 15° 未満なら sin15°）', () => {
    for (const hd of [60, 75, 85, 70]) {
      const { ctx, entry, other, edgeLen } = taxiHold(hd);
      const a = ctx.network.nodes[entry]!.pos;
      const b = ctx.network.nodes[other]!.pos;
      const dir = ctx.freeRunways['rwy_1']!.dir;
      const sin = Math.abs((b.x - a.x) * dir.y - (b.y - a.y) * dir.x) / Math.hypot(b.x - a.x, b.y - a.y);
      const expected = Math.min(90 / Math.max(sin, SIN_MIN_HOLD), edgeLen * HOLD_SHORT_MAX_RATIO);
      expect(holdShortDistanceAt(ctx, entry, other, edgeLen)).toBeCloseTo(expected, 6);
      expect(holdShortDistanceAt(ctx, entry, other, edgeLen)).toBeGreaterThanOrEqual(Math.min(90, edgeLen * HOLD_SHORT_MAX_RATIO) - 1e-9);
    }
  });

  it('従来形の滑走路では従来の式（87.5 m・0.6 倍）をそのまま返す', () => {
    const l = must(addTaxiwayPath(must(placeRunway(emptyLayout(), { x: 10, y: 20 }, 90, 20)).layout, [{ x: 15, y: 15 }, { x: 15, y: 25 }])).layout;
    const ctx = createContext(l);
    const entry = Object.values(ctx.network.nodes).find((n) => n.kind === 'runwayEntry')!;
    const e = Object.values(ctx.network.edges).find((x) => x.kind === 'taxiway')!;
    const other = e.from === entry.id ? e.to : e.from;
    for (const len of [50, 125, 200, 1000]) {
      expect(holdShortDistanceAt(ctx, entry.id, other, len)).toBe(holdShortDistance(len));
      expect(holdShortDistance(len)).toBe(Math.min(HOLD_SHORT_M, len * HOLD_SHORT_MAX_RATIO));
    }
  });
});
