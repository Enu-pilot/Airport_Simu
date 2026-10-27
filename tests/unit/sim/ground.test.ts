import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { moveEntity, updateEntity } from '../../../src/core/layout/operations';
import { addTurnaround, createSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { setUnitBroken, tasksOf } from '../../../src/core/sim/ground';
import { setEquipmentBroken } from '../../../src/core/sim/baggage';
import { checkGroundInvariants, checkPaxInvariants } from '../../../src/core/sim/invariants';
import type { AirportLayout, TerminalAreaKind } from '../../../src/core/model/types';
import type { Aircraft, Bag, TaskKind } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { runUntil } from './helpers';

const manual = { autoSchedule: false };

/** GSE基地のプロパティを変えたサンプル空港 */
function withGse(props: Record<string, number>): AirportLayout {
  const l = createSampleAirport();
  const base = Object.values(l.facilities).find((f) => f.kind === 'gseBase')!.id;
  return must(updateEntity(l, base, { props })).layout;
}

function turnaround(layout: AirportLayout, depAfterMin = 150, seed = 'ground') {
  const sim = createSimulation(layout, { seed, settings: manual });
  const t = sim.state.now + 20 * 60;
  const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + depAfterMin * 60 });
  return { sim, ac, t, dep: sim.state.flights[ac.departureFlightId]!, arr: sim.state.flights[ac.arrivalFlightId]! };
}

const task = (sim: Simulation, ac: Aircraft, kind: TaskKind) => tasksOf(sim.state, ac.id).find((t) => t.kind === kind)!;
const maybeTask = (sim: Simulation, ac: Aircraft, kind: TaskKind) => tasksOf(sim.state, ac.id).find((t) => t.kind === kind);
const bags = (sim: Simulation, flightId: string): Bag[] => (sim.state.flightBags[flightId] ?? []).map((id) => sim.state.bags[id]!);
const fullCheck = (sim: Simulation) => [...checkGroundInvariants(sim, true), ...checkPaxInvariants(sim, true)];

describe('正常な折り返し', () => {
  it('全作業が完了してから出発準備完了になり、手荷物は自便に1回ずつ積まれ、到着手荷物は受け取られる', () => {
    const { sim, ac, dep, arr } = turnaround(createSampleAirport());
    runUntil(sim, () => ac.state === 'departed', 6 * 3600);
    const tasks = tasksOf(sim.state, ac.id);
    expect(tasks.map((x) => x.kind).sort()).toEqual(['board', 'clean', 'cater', 'deplane', 'fuel', 'inspect', 'load', 'pushback', 'unload'].sort());
    expect(tasks.every((x) => x.state === 'done')).toBe(true);
    const ready = ac.history.find((h) => h.state === 'readyForPushback')!.t;
    expect(tasks.filter((x) => x.kind !== 'pushback').every((x) => x.doneAt! <= ready)).toBe(true);
    expect(dep.readyAt).toBe(ready);
    expect(dep.criticalTask).not.toBeNull();
    // 出発手荷物: 搭乗した旅客の手荷物がすべて自便の機体に積載
    const depBags = bags(sim, dep.id);
    expect(depBags.length).toBeGreaterThan(30);
    expect(depBags.every((b) => b.state === 'loaded' && b.loadedOn === ac.id)).toBe(true);
    // 到着手荷物: すべて受け取り済み
    const arrBags = bags(sim, arr.id);
    expect(arrBags.length).toBeGreaterThan(30);
    expect(arrBags.every((b) => b.state === 'collected')).toBe(true);
    expect(fullCheck(sim)).toEqual([]);
    // 作業員・車両はいずれ基地に戻る
    runUntil(sim, () => Object.values(sim.state.units).every((u) => u.status === 'idle'), 3600);
  });

  it('作業の依存関係: 清掃・ケータリングは降機後、搭乗は清掃・ケータリング・給油・点検の後、積み込みの完了は搭乗締切の後', () => {
    const { sim, ac } = turnaround(createSampleAirport());
    runUntil(sim, () => ac.state === 'departed', 6 * 3600);
    const done = (k: TaskKind) => task(sim, ac, k).doneAt!;
    const start = (k: TaskKind) => task(sim, ac, k).startedAt!;
    expect(start('clean')).toBeGreaterThanOrEqual(done('deplane'));
    expect(start('cater')).toBeGreaterThanOrEqual(done('deplane'));
    const boardingOpened = sim.state.flights[ac.departureFlightId]!.pax.boardingOpenedAt!;
    for (const k of ['clean', 'cater', 'fuel', 'inspect'] as const) expect(boardingOpened).toBeGreaterThanOrEqual(done(k));
    expect(start('load')).toBeGreaterThanOrEqual(done('unload'));
    expect(done('load')).toBeGreaterThanOrEqual(done('board'));
  });
});

describe('要員・車両の不足', () => {
  it('作業員不足: 必要人数がそろわない作業は停止理由「作業員不足」で待ち、出発準備完了にならない（出発しない）', () => {
    const { sim, ac, dep } = turnaround(withGse({ staff: 2 }), 90);
    runUntil(sim, () => sim.state.now >= dep.scheduled + 2 * 3600, 6 * 3600);
    expect(task(sim, ac, 'clean').state).toBe('blocked');
    expect(task(sim, ac, 'clean').blockedReason).toBe('noStaff');
    expect(ac.state).toBe('turnaround');
    expect(dep.block).toBeNull();
    expect(sim.state.groundStats.blockedSec.noStaff).toBeGreaterThan(3600);
  });

  it('車両不足: ケータリング車がなければ「車両不足」で止まり、出発しない', () => {
    const { sim, ac, dep } = turnaround(withGse({ cateringTrucks: 0 }), 90);
    runUntil(sim, () => sim.state.now >= dep.scheduled + 3600, 6 * 3600);
    expect(task(sim, ac, 'cater').blockedReason).toBe('noVehicle');
    expect(dep.pax.boarding).toBe('notStarted'); // 搭乗も始められない
    expect(ac.state).toBe('turnaround');
  });

  it('給油車が1台なら同時に着いた2機は順番に給油し、同じ車両を同時に使わない', () => {
    const sim = createSimulation(withGse({ fuelTrucks: 1 }), { seed: 'fuel', settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
    const b = addTurnaround(sim, 'narrow180', t + 2 * 60, { departureAt: t + 150 * 60 });
    runUntil(sim, () => a.state === 'departed' && b.state === 'departed', 8 * 3600);
    const fa = task(sim, a, 'fuel');
    const fb = task(sim, b, 'fuel');
    const [first, second] = fa.startedAt! < fb.startedAt! ? [fa, fb] : [fb, fa];
    expect(second.startedAt!).toBeGreaterThanOrEqual(first.doneAt!);
    expect(second.blockedTotal).toBeGreaterThan(0);
    expect(sim.state.groundStats.blockedSec.noVehicle).toBeGreaterThan(0);
  });
});

describe('設備・車両の停止', () => {
  it('作業中の給油車が故障すると作業を止め、別の給油車に再割り当てして続きから完了する', () => {
    const { sim, ac } = turnaround(createSampleAirport());
    runUntil(sim, () => maybeTask(sim, ac, 'fuel')?.state === 'inProgress' && maybeTask(sim, ac, 'fuel')!.doneSec > 300, 3600);
    const fuel = task(sim, ac, 'fuel');
    const broken = fuel.units.find((u) => sim.state.units[u]!.kind === 'fuelTruck')!;
    const progress = fuel.doneSec;
    setUnitBroken(sim, broken, true);
    expect(fuel.state).toBe('blocked');
    expect(fuel.blockedReason).toBe('unitBroken');
    runUntil(sim, () => fuel.state === 'done', 3600);
    expect(fuel.doneSec).toBeGreaterThanOrEqual(fuel.workSec);
    // 最初からやり直していない（故障前の進捗を保持）
    expect(fuel.doneAt! - fuel.startedAt!).toBeLessThan(fuel.workSec + 3600);
    expect(progress).toBeGreaterThan(300);
    expect(fuel.units).toEqual([]);
    expect(sim.state.units[broken]!.status).toBe('broken');
  });

  it('仕分け設備が停止すると手荷物が仕分けられず、積み込みは「仕分け設備停止」で待ち、締切後は積み残しになる', () => {
    const l = createSampleAirport();
    const sorter = Object.values(l.facilities).find((f) => f.kind === 'baggageSort')!.id;
    const { sim, ac, dep } = turnaround(l);
    setEquipmentBroken(sim, sorter, true);
    let sawSorterDown = false;
    runUntil(
      sim,
      () => {
        if (maybeTask(sim, ac, 'load')?.blockedReason === 'sorterDown') sawSorterDown = true;
        return ac.state === 'departed';
      },
      6 * 3600,
    );
    expect(sawSorterDown).toBe(true);
    const depBags = bags(sim, dep.id);
    expect(depBags.length).toBeGreaterThan(0);
    expect(depBags.every((b) => b.state === 'leftBehind' && b.loadedOn === null)).toBe(true);
    expect(sim.state.groundStats.bagsLeftBehind).toBe(depBags.length);
    // 積み残しの締切まで待った分、出発準備完了は搭乗締切より遅い
    expect(dep.readyAt!).toBeGreaterThanOrEqual(task(sim, ac, 'board').doneAt! + 10 * 60);
  });

  it('受取所のベルトが停止すると到着手荷物はベルト待ちになり、旅客は待ち、復旧すると受け取れる', () => {
    const l = createSampleAirport();
    const claim = Object.values(l.terminalAreas).find((a) => a.kind === 'baggageClaim')!.id;
    const { sim, arr } = turnaround(l);
    setEquipmentBroken(sim, `belt:${claim}`, true);
    runUntil(sim, () => bags(sim, arr.id).some((b) => b.state === 'atClaim'), 3600);
    runUntil(sim, () => sim.state.now >= arr.block! + 50 * 60, 3600);
    expect(bags(sim, arr.id).filter((b) => b.state === 'onBelt' || b.state === 'collected')).toEqual([]);
    const waiting = (sim.state.flightPax[arr.id] ?? []).map((id) => sim.state.paxGroups[id]!).filter((g) => g.state === 'waitingBaggage');
    expect(waiting.length).toBeGreaterThan(0);
    setEquipmentBroken(sim, `belt:${claim}`, false);
    runUntil(sim, () => bags(sim, arr.id).every((b) => b.state === 'collected'), 3600);
  });
});

describe('手荷物の追跡', () => {
  it('出発手荷物は 預け入れ→仕分け→仕分け済み→搬送→積載 の順に、所在とともに記録される', () => {
    const { sim, ac, dep } = turnaround(createSampleAirport());
    runUntil(sim, () => ac.state === 'departed', 6 * 3600);
    for (const b of bags(sim, dep.id)) {
      expect(b.history.map((h) => h.state).filter((s, i, a) => a[i - 1] !== s)).toEqual(['checkedIn', 'sorting', 'madeUp', 'onCart', 'loaded']);
      expect(b.history[0]!.location).toMatch(/^counter:ta_/);
      expect(b.history.at(-1)!.location).toBe(`aircraft:${ac.id}`);
      const g = sim.state.paxGroups[b.paxGroupId]!;
      expect(g.flightId).toBe(dep.id);
    }
  });

  it('ゲートに到達できない旅客の手荷物は積まれない（取り違え・積み過ぎがない）', () => {
    let l = createSampleAirport();
    const lobby = Object.values(l.terminalAreas).find((a) => a.kind === ('departureLobby' as TerminalAreaKind))!.id;
    l = must(updateEntity(l, lobby, { w: 34 })).layout;
    l = must(moveEntity(l, lobby, { x: 14, y: 0 })).layout;
    const { sim, ac, dep } = turnaround(l);
    runUntil(sim, () => ac.state === 'departed', 6 * 3600);
    expect(dep.pax.boarded).toBe(0);
    const depBags = bags(sim, dep.id);
    expect(depBags.length).toBeGreaterThan(0);
    expect(depBags.every((b) => b.state !== 'loaded' && b.loadedOn === null)).toBe(true);
    expect(fullCheck(sim)).toEqual([]);
  });
});

describe('地上支援の遅延と出発時刻', () => {
  it('作業員が少ないと作業が順番待ちになり、準備完了と出発が遅れる（遅延理由: 地上支援作業）', () => {
    const run = (staff: number) => {
      const { sim, ac, dep } = turnaround(withGse({ staff }), 60, 'delay');
      runUntil(sim, () => ac.state === 'departed', 8 * 3600);
      return dep;
    };
    const normal = run(20);
    const short = run(3);
    expect(short.readyAt!).toBeGreaterThan(normal.readyAt! + 10 * 60);
    expect(short.block!).toBeGreaterThan(short.scheduled);
    expect(short.block!).toBeGreaterThan(normal.block!);
    expect(short.delayCauses.some((c) => c === 'groundHandling' || c === 'boarding')).toBe(true);
    expect(short.criticalTask).not.toBeNull();
  });
});
