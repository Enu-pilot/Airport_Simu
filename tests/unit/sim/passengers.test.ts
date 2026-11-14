import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { moveEntity, placeTerminalArea, updateEntity } from '../../../src/core/layout/operations';
import { addTurnaround, createSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { addDepartureGroup, setAreaClosed } from '../../../src/core/sim/passengers';
import { checkPaxInvariants } from '../../../src/core/sim/invariants';
import { analyzeLayout } from '../../../src/core/validation/validate';
import type { AirportLayout, TerminalAreaKind } from '../../../src/core/model/types';
import type { Aircraft, PaxGroup } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { runUntil } from './helpers';

const manual = { autoSchedule: false };
const areaId = (l: AirportLayout, kind: TerminalAreaKind) => Object.values(l.terminalAreas).find((a) => a.kind === kind)!.id;
const groups = (sim: Simulation, flightId: string): PaxGroup[] => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);

/** 到着後に折り返して出発する1機（出発は2時間半後。旅客は運航開始直後から空港に来る） */
function oneTurnaround(layout: AirportLayout, seed = 'pax') {
  const sim = createSimulation(layout, { seed, settings: manual });
  const t = sim.state.now + 20 * 60;
  const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
  return { sim, ac, dep: sim.state.flights[ac.departureFlightId]!, arr: sim.state.flights[ac.arrivalFlightId]! };
}

const departed = (ac: Aircraft) => () => ac.state === 'departed';

describe('出発旅客', () => {
  it('通常生成グループにも段差なし需要を決定的に割り当て、明示的な設定を優先する', () => {
    const { sim, dep } = oneTurnaround(createSampleAirport(), 'step-free-groups');
    const generated = Array.from({ length: 100 }, () => addDepartureGroup(sim, dep.id, 1, sim.state.now)!);
    const stepFree = generated.filter((group) => group.stepFree);
    expect(stepFree.length).toBeGreaterThan(0);
    expect(stepFree.length).toBeLessThan(20);

    const explicitlyAccessible = addDepartureGroup(sim, dep.id, 1, sim.state.now, 0, { stepFree: true })!;
    const explicitlyStandard = addDepartureGroup(sim, dep.id, 1, sim.state.now, 0, { stepFree: false })!;
    expect(explicitlyAccessible.stepFree).toBe(true);
    expect(explicitlyStandard.stepFree).toBeUndefined();
  });

  it('正常な搭乗: 予約旅客が入口→チェックイン→保安検査→ゲートを経て搭乗し、便の搭乗人数と一致する', () => {
    const { sim, ac, dep } = oneTurnaround(createSampleAirport());
    runUntil(sim, departed(ac), 6 * 3600);
    expect(dep.pax.booked).toBeGreaterThan(100);
    expect(dep.pax.boarded).toBe(dep.pax.booked);
    expect(dep.pax.missed).toBe(0);
    const gs = groups(sim, dep.id);
    expect(gs.every((g) => g.state === 'boarded' && g.boardedGate === dep.pax.gateId && g.securityCleared)).toBe(true);
    // チェックインは手荷物ありの旅客が必ず通る
    expect(gs.filter((g) => g.bags > 0).every((g) => g.steps.includes('checkIn'))).toBe(true);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
    // 搭乗締切後にプッシュバックしている
    expect(dep.block!).toBeGreaterThanOrEqual(ac.history.find((h) => h.state === 'readyForPushback')!.t);
  });

  it('締切超過: 締切までにゲートへ着けなかった旅客は乗り遅れとして記録され、搭乗済みにならない', () => {
    const { sim, ac, dep } = oneTurnaround(createSampleAirport());
    const late = addDepartureGroup(sim, dep.id, 3, dep.scheduled - 12 * 60, 2)!;
    runUntil(sim, departed(ac), 6 * 3600);
    expect(late.state).toBe('missed');
    expect(late.reason).toBe('late');
    expect(dep.pax.missed).toBe(3);
    expect(dep.pax.boarded).toBe(dep.pax.booked - 3);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('到達不能なゲート: 出発ロビーから切り離されたゲートの便は搭乗できず、到達不能として記録される', () => {
    let l = createSampleAirport();
    const lobby = areaId(l, 'departureLobby');
    // 出発ロビーを東側だけにし、ゲート1の前には保安検査とつながらない待合を置く
    l = must(updateEntity(l, lobby, { w: 34 })).layout;
    l = must(moveEntity(l, lobby, { x: 14, y: 0 })).layout;
    const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!.id;
    l = must(placeTerminalArea(l, terminal, 1, 'waiting', { x: 46, y: 49 }, { w: 6, h: 2 })).layout;
    const gate1 = Object.values(l.facilities).find((f) => f.kind === 'gate' && f.name === '1')!.id;
    expect(analyzeLayout(l).byTarget[gate1]!.map((i) => i.code)).toContain('GATE_UNREACHABLE');

    const { sim, ac, dep } = oneTurnaround(l);
    runUntil(sim, departed(ac), 6 * 3600);
    expect(ac.standId === null && dep.pax.gateId).toBe(gate1);
    expect(dep.pax.boarded).toBe(0);
    expect(dep.pax.missed).toBe(dep.pax.booked);
    expect(groups(sim, dep.id).every((g) => g.state === 'missed' && g.reason === 'unreachable')).toBe(true);
  });
});

describe('施設の処理能力と混雑', () => {
  const securityWait = (lanes: number) => {
    let l = createSampleAirport();
    const sec = areaId(l, 'security');
    l = must(updateEntity(l, sec, { props: { lanes } })).layout;
    const sim = createSimulation(l, { seed: 'crowd', settings: manual });
    const t = sim.state.now + 20 * 60;
    const acs = [0, 1, 2, 3].map((i) => addTurnaround(sim, 'narrow180', t + i * 3 * 60, { departureAt: t + 150 * 60 + i * 5 * 60 }));
    runUntil(sim, () => acs.every((a) => a.state === 'departed'), 8 * 3600);
    const fac = sim.state.facilities[sec]!;
    return { avgWait: fac.waitTotal / fac.served, maxQueue: fac.maxQueue, sim };
  };

  it('保安検査のレーンが少ないと待ち時間・待ち人数が増える（処理中は常にレーン数以下）', () => {
    const many = securityWait(4);
    const one = securityWait(1);
    expect(one.avgWait).toBeGreaterThan(many.avgWait * 3);
    expect(one.maxQueue).toBeGreaterThan(many.maxQueue);
    expect(checkPaxInvariants(one.sim, true)).toEqual([]);
  });

  it('チェックインカウンター1台では、処理能力を超えた旅客は列に並び即座には処理されない', () => {
    let l = createSampleAirport();
    const ci = areaId(l, 'checkIn');
    l = must(updateEntity(l, ci, { props: { counters: 1 } })).layout;
    const { sim, ac } = oneTurnaround(l);
    let maxInService = 0;
    runUntil(
      sim,
      () => {
        maxInService = Math.max(maxInService, sim.state.facilities[ci]?.inService.length ?? 0);
        return ac.state === 'departed';
      },
      6 * 3600,
    );
    const fac = sim.state.facilities[ci]!;
    expect(maxInService).toBe(1);
    expect(fac.maxQueue).toBeGreaterThan(20);
  });
});

describe('施設の閉鎖', () => {
  it('唯一の保安検査場を閉鎖すると旅客はその場で待機し、再開すると進んで搭乗する', () => {
    const l = createSampleAirport();
    const sec = areaId(l, 'security');
    const { sim, ac, dep } = oneTurnaround(l);
    setAreaClosed(sim, sec, true);
    runUntil(sim, () => sim.state.now >= dep.scheduled - 100 * 60, 3 * 3600);
    const gs = groups(sim, dep.id).filter((g) => g.state !== 'toAirport');
    expect(gs.length).toBeGreaterThan(0);
    expect(gs.some((g) => g.state === 'waitingFacility')).toBe(true);
    expect(gs.every((g) => !g.securityCleared)).toBe(true);
    setAreaClosed(sim, sec, false);
    runUntil(sim, departed(ac), 6 * 3600);
    expect(dep.pax.boarded).toBe(dep.pax.booked);
  });

  it('閉鎖時に別の保安検査場があれば迂回する', () => {
    let l = createSampleAirport();
    const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!.id;
    l = must(placeTerminalArea(l, terminal, 1, 'security', { x: 56, y: 51 }, { w: 4, h: 2, props: { lanes: 2 } })).layout;
    const sec1 = areaId(l, 'security');
    const sec2 = Object.values(l.terminalAreas).filter((a) => a.kind === 'security').at(-1)!.id;
    // 元の保安検査場は1レーンにして、閉鎖する前に列ができるようにする
    l = must(updateEntity(l, sec1, { props: { lanes: 1 } })).layout;
    const { sim, ac, dep } = oneTurnaround(l);
    runUntil(sim, () => (sim.state.facilities[sec1]?.queue.length ?? 0) > 0, 3 * 3600);
    const servedBefore = sim.state.facilities[sec2]?.served ?? 0;
    setAreaClosed(sim, sec1, true);
    runUntil(sim, () => (sim.state.facilities[sec1]?.queue.length ?? 0) === 0, 60);
    runUntil(sim, departed(ac), 6 * 3600);
    // 閉鎖後は sec1 で新たに処理されず、sec2 が処理を引き受けた
    expect(sim.state.facilities[sec1]!.inService).toEqual([]);
    expect(sim.state.facilities[sec2]!.served).toBeGreaterThan(servedBefore);
    expect(dep.pax.boarded).toBe(dep.pax.booked);
  });

  it('閉鎖したまま締切を過ぎた旅客は「施設閉鎖による未処理」で乗り遅れになる', () => {
    const l = createSampleAirport();
    const { sim, ac, dep } = oneTurnaround(l);
    setAreaClosed(sim, areaId(l, 'security'), true);
    runUntil(sim, departed(ac), 6 * 3600);
    expect(dep.pax.boarded).toBe(0);
    const reasons = new Set(groups(sim, dep.id).map((g) => g.reason));
    expect(reasons.has('facilityClosed')).toBe(true);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });
});

describe('到着旅客', () => {
  it('到着旅客にも通常生成時の段差なし需要を割り当てる', () => {
    const { sim, arr } = oneTurnaround(createSampleAirport(), 'step-free-arrivals');
    runUntil(sim, () => arr.pax.deplaned >= 100, 4 * 3600);
    expect(groups(sim, arr.id).some((group) => group.stepFree)).toBe(true);
  });

  it('降機 → 到着通路 → 手荷物受取（手荷物ありのみ）→ 出口へ。全員が退出し、受取は手荷物が出てから', () => {
    const { sim, arr } = oneTurnaround(createSampleAirport());
    runUntil(sim, () => arr.pax.generated && arr.pax.deplaneRemaining === 0 && arr.pax.exited === arr.pax.deplaned, 4 * 3600);
    expect(arr.pax.deplaned).toBeGreaterThan(100);
    const gs = groups(sim, arr.id);
    expect(gs.every((g) => g.state === 'exited')).toBe(true);
    const withBags = gs.filter((g) => g.bags > 0);
    expect(withBags.length).toBeGreaterThan(0);
    expect(withBags.every((g) => g.steps.includes('claim') && g.finishedAt! >= arr.pax.bagsReadyAt! + 90)).toBe(true);
    expect(gs.filter((g) => g.bags === 0).every((g) => !g.steps.includes('claim'))).toBe(true);
  });
});

describe('ターミナル配置の影響', () => {
  it('保安検査場をエスカレーターから遠ざけると出発旅客の歩行時間が増える', () => {
    const avgWalk = (l: AirportLayout) => {
      const { sim, ac, dep } = oneTurnaround(l, 'layout');
      runUntil(sim, departed(ac), 6 * 3600);
      const gs = groups(sim, dep.id);
      return gs.reduce((s, g) => s + g.walkSec * g.count, 0) / gs.reduce((s, g) => s + g.count, 0);
    };
    const base = createSampleAirport();
    const far = must(moveEntity(base, areaId(base, 'security'), { x: -16, y: 0 })).layout;
    expect(analyzeLayout(far).counts.error).toBe(0);
    expect(avgWalk(far)).toBeGreaterThan(avgWalk(base) + 60);
  });
});
