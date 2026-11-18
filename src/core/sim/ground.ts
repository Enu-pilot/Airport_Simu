import { Rng } from '../rng';
import { compareIds } from '../model/ids';
import { TILE_M } from '../model/catalog';
import { mapToWorld } from '../geometry/frames';
import { resolveType } from './aircraftTypes';
import { lightningStop } from './weather';
import { CARGO_TASKS, TASK_DEFS, TURNAROUND_TASKS, cargoTaskSec, taskNeeds, taskWorkSec } from './tasks';
import { cargoHandlingCapacityM3PerHour } from '../economy/cargo';
import { recordCargoHandled } from './cargoStats';
import {
  BAG_CUTOFF_AFTER_BOARDING_SEC,
  HANDLE_SEC_PER_BAG,
  VEHICLE_SETUP_SEC,
  VEHICLE_SPEED,
  bagsOf,
  isDown,
  moveBag,
  reconcileDepartureBags,
  retagTransferBag,
  setEquipmentBroken,
} from './baggage';
import type { Simulation } from './simulation';
import { onBagLeftBehind, onTaskDone } from '../economy/ops';
import {
  EVENT_LOG_LIMIT,
  type Aircraft,
  type BlockReason,
  type GroundTask,
  type GroundUnit,
  type SimState,
  type TaskKind,
  type UnitKind,
} from './types';

/**
 * 地上支援（折り返し作業）。docs/13_ground_handling_rules.md
 *
 * - 作業員・車両は1人・1台ずつのユニットで、同時に1つの作業にしか割り当てない。
 * - 作業は依存関係を持ち、先行作業が終わるまで始めない。必要なユニットがそろわなければ停止理由を記録して待つ。
 * - 航空機は、プッシュバック以外の全作業が完了するまで出発準備完了にならない。
 */

export { TASK_DEFS, TURNAROUND_TASKS } from './tasks';
/** 点検で不具合が見つかる確率と、追加の整備時間 */
export const DEFECT_PROB = 0.1;
export const DEFECT_EXTRA_SEC = 30 * 60;
/** 積み込みを始める時刻（出発予定の何秒前か）と、トーイングカーを手配する時刻 */
export const LOAD_START_LEAD_SEC = 45 * 60;
export const PUSHBACK_DISPATCH_LEAD_SEC = 10 * 60;
/** 車両の故障からの復旧時間（手動で故障させた場合の既定値） */
export const UNIT_REPAIR_SEC = 45 * 60;
/** ランダム故障の平均故障間隔（時間） */
export const RANDOM_MTBF_HOURS = { unit: 80, sorter: 150, belt: 150 };

function log(state: SimState, e: SimState['events'][number]): void {
  state.events.push(e);
  if (state.events.length > EVENT_LOG_LIMIT) state.events.splice(0, state.events.length - EVENT_LOG_LIMIT);
}

function nextId(state: SimState, prefix: string): string {
  const n = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = n;
  return `${prefix}_${n}`;
}

function withRng<T>(state: SimState, fn: (rng: Rng) => T): T {
  const rng = new Rng(state.rng);
  const v = fn(rng);
  state.rng = rng.state();
  return v;
}

// ---------------------------------------------------------------- ユニット

/** 運航開始時に、基地ごとの作業員・車両を生成する */
export function createGroundUnits(sim: Simulation): void {
  const { state, ctx } = sim;
  const order: UnitKind[] = ['staff', 'engineer', 'tug', 'beltLoader', 'baggageTractor', 'fuelTruck', 'cateringTruck', 'cleaningVan', 'apronBus'];
  for (const base of ctx.bases) {
    for (const kind of order) {
      for (let i = 0; i < (base.units[kind] ?? 0); i++) {
        const id = nextId(state, 'gu');
        state.units[id] = {
          id,
          kind,
          baseId: base.id,
          status: 'idle',
          taskId: null,
          x: base.x,
          y: base.y,
          fromX: base.x,
          fromY: base.y,
          toX: base.x,
          toY: base.y,
          moveStart: state.now,
          moveEnd: state.now,
          repairUntil: null,
          busySec: 0,
        };
      }
    }
  }
}

function standPos(sim: Simulation, ac: Aircraft): { x: number; y: number } {
  const standId = ac.standId ?? sim.state.flights[ac.arrivalFlightId]!.standId;
  const node = standId ? sim.ctx.network.nodes[`${standId}:P`] : undefined;
  return node ? { x: node.pos.x, y: node.pos.y } : { x: ac.x, y: ac.y };
}

export function travelSec(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.round((Math.hypot(a.x - b.x, a.y - b.y) * TILE_M) / VEHICLE_SPEED) + VEHICLE_SETUP_SEC;
}

export function sendUnit(state: SimState, u: GroundUnit, to: { x: number; y: number }, status: 'enroute' | 'returning'): void {
  u.fromX = u.x;
  u.fromY = u.y;
  u.toX = to.x;
  u.toY = to.y;
  u.moveStart = state.now;
  u.moveEnd = state.now + travelSec(u, to);
  u.status = status;
}

export function basePos(sim: Simulation, u: GroundUnit): { x: number; y: number } {
  const b = sim.ctx.bases.find((x) => x.id === u.baseId);
  return b ? { x: b.x, y: b.y } : { x: u.x, y: u.y };
}

/** 作業からユニットを外して基地へ戻す（故障中のユニットはその場で修理待ち） */
function releaseUnits(sim: Simulation, task: GroundTask): void {
  for (const id of task.units) {
    const u = sim.state.units[id]!;
    u.taskId = null;
    if (u.status !== 'broken') sendUnit(sim.state, u, basePos(sim, u), 'returning');
  }
  task.units = [];
}

/** 車両・作業員を故障（使用不可）にする。作業中なら作業を止め、他のユニットで再割り当てする */
export function setUnitBroken(sim: Simulation, unitId: string, broken: boolean, repairSec = UNIT_REPAIR_SEC): void {
  const { state } = sim;
  const u = state.units[unitId];
  if (!u) return;
  setEquipmentBroken(sim, unitId, broken, broken ? repairSec : undefined);
  if (broken) {
    u.status = 'broken';
    u.repairUntil = state.now + repairSec;
    if (u.taskId) {
      const task = state.tasks[u.taskId]!;
      // 作業を中断して、他のユニットで再割り当てする（進捗は保持）
      releaseUnits(sim, task);
      block(state, task, 'unitBroken');
      task.state = 'blocked';
    }
  } else {
    u.repairUntil = null;
    if (u.status === 'broken') sendUnit(state, u, basePos(sim, u), 'returning');
  }
}

// ---------------------------------------------------------------- 作業の生成

/** ブロックイン時に折り返し作業を生成する。skip の作業は作らない（置き直しの合成機体など） */
export function createTurnaroundTasks(sim: Simulation, ac: Aircraft, opts: { skip?: readonly string[] } = {}): void {
  const { state } = sim;
  if ((state.aircraftTasks[ac.id] ?? []).length > 0) return;
  // 貨物便（5-12）は旅客の折り返し作業を作らず、貨物タスクだけを作る（手荷物タスクも流用しない）
  const cargo = state.flights[ac.arrivalFlightId]?.cargo;
  if (cargo) {
    createCargoTasks(sim, ac, cargo.volumeM3);
    return;
  }
  // 省略した作業を機体に記録する（出発準備完了の判定で「要求されていない作業」として扱うため。保存にも残る）
  if (opts.skip?.length) ac.skippedTasks = [...opts.skip] as TaskKind[];
  const type = resolveType(sim.ctx.types, ac.typeId);
  const defect = withRng(state, (rng) => rng.next() < DEFECT_PROB);
  const totals = unitTotals(sim);
  for (const kind of TURNAROUND_TASKS) {
    if (opts.skip?.includes(kind)) continue;
    const task = newTask(state, ac, kind);
    // 機種ごとの作業時間・必要なユニット。空港に必要数より少なければ、ある台数で時間をかけて行う（docs/16 §4）
    task.needs = taskNeeds(type, kind);
    task.workSec = taskWorkSec(type, kind);
    if (kind === 'fuel' && ac.standId && sim.ctx.hydrantStands.has(ac.standId)) {
      delete task.needs.fuelTruck;
      task.workSec = Math.round(task.workSec * 0.6);
      task.note = '燃料ハイドラント配管を使用（給油車不要・作業時間 0.6 倍）';
    }
    // 機種固有の追加分だけを減らせる。作業の基本の必要数（TASK_DEFS）を下回ってそろわない場合は従来どおり停止して待つ
    let slow = 1;
    const base = TASK_DEFS[kind].needs;
    for (const [k, n] of Object.entries(task.needs) as [UnitKind, number][]) {
      const total = totals[k] ?? 0;
      const reduced = Math.max(base[k] ?? 0, Math.min(n, total));
      if (reduced < n) {
        slow = Math.max(slow, n / reduced);
        task.needs[k] = reduced;
      }
    }
    if (slow > 1) {
      task.workSec = Math.round(task.workSec * slow);
      task.note = `必要な車両・作業員が足りないため時間がかかる（×${slow.toFixed(1)}）`;
    }
    if (kind === 'inspect' && defect) {
      task.workSec += DEFECT_EXTRA_SEC;
      task.note = '不具合あり（追加整備）';
    }
  }
}

/**
 * 貨物便の荷役タスクを生成する（5-12）。所要時間は搭載量 ÷ 貨物上屋の処理能力で決まる
 * （cargoTaskSec）ので、上屋の能力が折り返し時間に直接効く。必要ユニットは作業員のみ。
 * 旅客便の生成と同じく、空港にある作業員が基本の必要数より少なければ、ある人数で時間をかけて行う。
 */
export function createCargoTasks(sim: Simulation, ac: Aircraft, volumeM3: number): void {
  const { state } = sim;
  const type = resolveType(sim.ctx.types, ac.typeId);
  const throughput = cargoHandlingCapacityM3PerHour(sim.ctx.layout);
  const totals = unitTotals(sim);
  for (const kind of CARGO_TASKS) {
    const task = newTask(state, ac, kind);
    task.needs = taskNeeds(type, kind);
    task.workSec = cargoTaskSec(volumeM3, throughput);
    let slow = 1;
    const base = TASK_DEFS[kind].needs;
    for (const [k, n] of Object.entries(task.needs) as [UnitKind, number][]) {
      const total = totals[k] ?? 0;
      const reduced = Math.max(base[k] ?? 0, Math.min(n, total));
      if (reduced < n) {
        slow = Math.max(slow, n / reduced);
        task.needs[k] = reduced;
      }
    }
    if (slow > 1) {
      task.workSec = Math.round(task.workSec * slow);
      task.note = `必要な車両・作業員が足りないため時間がかかる（×${slow.toFixed(1)}）`;
    }
    if (throughput <= 0 && volumeM3 > 0) task.note = '貨物上屋がないため仮置きの時間で扱う';
  }
}

/** 空港にある作業員・車両の種類ごとの数 */
export function unitTotals(sim: Simulation): Partial<Record<UnitKind, number>> {
  const out: Partial<Record<UnitKind, number>> = {};
  for (const b of sim.ctx.bases) for (const [k, n] of Object.entries(b.units) as [UnitKind, number][]) out[k] = (out[k] ?? 0) + n;
  return out;
}

export function createPushbackTask(sim: Simulation, ac: Aircraft): GroundTask {
  const existing = tasksOf(sim.state, ac.id).find((t) => t.kind === 'pushback' && t.state !== 'cancelled');
  return existing ?? newTask(sim.state, ac, 'pushback');
}

function newTask(state: SimState, ac: Aircraft, kind: TaskKind): GroundTask {
  const def = TASK_DEFS[kind];
  const id = nextId(state, 'tk');
  const task: GroundTask = {
    id,
    aircraftId: ac.id,
    kind,
    state: 'pending',
    deps: [...def.deps],
    needs: { ...def.needs },
    units: [],
    workSec: 0,
    doneSec: 0,
    createdAt: state.now,
    startedAt: null,
    doneAt: null,
    blockedReason: null,
    blockedSince: null,
    blockedTotal: 0,
    phase: 'idle',
    phaseUntil: null,
    note: null,
  };
  state.tasks[id] = task;
  (state.aircraftTasks[ac.id] ??= []).push(id);
  state.activeTasks.push(id);
  return task;
}

export function tasksOf(state: SimState, acId: string): GroundTask[] {
  return (state.aircraftTasks[acId] ?? []).map((id) => state.tasks[id]!);
}

export function taskDone(state: SimState, acId: string, kind: TaskKind): boolean {
  // 省略された作業は「要求されていない作業」なので、依存判定では完了として扱う（夜間滞泊の持ち越し。OD 修正）。
  // 省略の記録はタスク生成と同時にだけ付くので、未生成の通常便が誤って完了扱いになることはない
  if (state.aircraft[acId]?.skippedTasks?.includes(kind)) return true;
  return tasksOf(state, acId).some((t) => t.kind === kind && t.state === 'done');
}

/**
 * 出発準備完了の判定: プッシュバック以外の必須作業がすべて存在し、完了している。
 * 省略された作業（skippedTasks。夜間滞泊の持ち越しの deplane/unload）は「要求されていない作業」として扱い、
 * 逆に必須作業の欠落・未着手・進行中・失敗は未完了として扱う（タスク数の一致では判定しない）。
 */
export function allTurnaroundDone(state: SimState, acId: string): boolean {
  const ac = state.aircraft[acId];
  if (!ac) return false;
  const skipped = new Set(ac.skippedTasks ?? []);
  const tasks = tasksOf(state, acId).filter((t) => t.kind !== 'pushback');
  // 必須タスクの集合は便種別で分ける（5-12）: 貨物便は貨物タスクだけ、旅客便は従来の折り返しタスクだけ
  const required = state.flights[ac.arrivalFlightId]?.cargo ? CARGO_TASKS : TURNAROUND_TASKS;
  for (const kind of required) {
    if (skipped.has(kind)) continue;
    if (!tasks.some((t) => t.kind === kind && t.state === 'done')) return false;
  }
  return tasks.every((t) => t.state === 'done');
}

/** 搭乗を始めてよいか（降機・清掃・ケータリング・給油・点検の完了） */
export function boardingAllowed(state: SimState, acId: string): boolean {
  return TASK_DEFS.board.deps.every((k) => taskDone(state, acId, k));
}

/**
 * 夜間のスポット待機（フェーズ 2）で、すでに作られたプッシュバックの作業を取り消してトーイングカーと作業員を返す。
 * 取り消した作業があれば true。朝にもう一度 createPushbackTask で作り直す。
 */
export function cancelPushbackTask(sim: Simulation, acId: string): boolean {
  let any = false;
  for (const t of tasksOf(sim.state, acId)) {
    if (t.kind !== 'pushback' || t.state === 'done' || t.state === 'cancelled') continue;
    releaseUnits(sim, t);
    t.state = 'cancelled';
    any = true;
  }
  return any;
}

/** 便がキャンセルされた機体の作業を止め、ユニットを戻す */
export function cancelTasks(sim: Simulation, acId: string): void {
  for (const t of tasksOf(sim.state, acId)) {
    if (t.state === 'done' || t.state === 'cancelled') continue;
    releaseUnits(sim, t);
    t.state = 'cancelled';
  }
}

// ---------------------------------------------------------------- 1ティック

export function stepGround(sim: Simulation): void {
  const { state } = sim;
  if (state.settings.randomFailures) randomFailures(sim);
  for (const u of Object.values(state.units)) stepUnit(sim, u);

  // 処理順: 出発予定の早い機体の作業から（同時刻は作業ID順）
  const active = state.activeTasks.map((id) => state.tasks[id]!).filter((t) => t.state !== 'done' && t.state !== 'cancelled');
  // プレイヤーが優先にした便（便の順序変更）は先に割り当てる
  const depOf = (t: GroundTask) => state.flights[state.aircraft[t.aircraftId]!.departureFlightId]!;
  active.sort((a, b) => Number(!!depOf(b).priority) - Number(!!depOf(a).priority) || depOf(a).estimated - depOf(b).estimated || compareIds(a.id, b.id));
  // 優先度の高い作業がそろわずに待っているユニットの種類は、後の作業が先に取らない（飢餓防止）
  const starved = new Set<UnitKind>();
  for (const t of active) stepTask(sim, t, starved);
  state.activeTasks = state.activeTasks.filter((id) => {
    const s = state.tasks[id]!.state;
    return s !== 'done' && s !== 'cancelled';
  });
}

function stepUnit(sim: Simulation, u: GroundUnit): void {
  const { state } = sim;
  if (u.status === 'broken') {
    if (u.repairUntil !== null && state.now >= u.repairUntil) setUnitBroken(sim, u.id, false);
    return;
  }
  if (u.status === 'enroute' || u.status === 'returning' || state.now <= u.moveEnd) {
    const t = u.moveEnd > u.moveStart ? Math.min(1, Math.max(0, (state.now - u.moveStart) / (u.moveEnd - u.moveStart))) : 1;
    u.x = u.fromX + (u.toX - u.fromX) * t;
    u.y = u.fromY + (u.toY - u.fromY) * t;
    if (state.now >= u.moveEnd && u.status === 'returning') u.status = 'idle';
  }
  if (u.taskId) u.busySec++;
}

function block(state: SimState, t: GroundTask, reason: BlockReason | null): void {
  if (t.blockedReason === reason) {
    if (reason) t.blockedTotal++;
    if (reason) state.groundStats.blockedSec[reason] = (state.groundStats.blockedSec[reason] ?? 0) + 1;
    return;
  }
  if (reason && reason !== 'dependency') {
    log(state, { t: state.now, kind: 'taskBlocked', aircraftId: t.aircraftId, note: `${t.kind}:${reason}` });
  }
  t.blockedReason = reason;
  t.blockedSince = reason ? state.now : null;
}

function finishTask(sim: Simulation, t: GroundTask): void {
  const { state } = sim;
  releaseUnits(sim, t);
  t.state = 'done';
  t.doneAt = state.now;
  t.blockedReason = null;
  state.groundStats.tasksDone++;
  // 貨物タスクの完了 = 実際に積み下ろしした量として記録する（5-12。締めで実績収支に使う）
  if (t.kind === 'cargoUnload' || t.kind === 'cargoLoad') {
    const ac = state.aircraft[t.aircraftId]!;
    const f = state.flights[t.kind === 'cargoUnload' ? ac.arrivalFlightId : ac.departureFlightId];
    if (f?.cargo) recordCargoHandled(state, t.kind === 'cargoUnload' ? 'unloaded' : 'loaded', f.cargo.volumeM3);
  }
  onTaskDone(sim, t);
  log(state, { t: state.now, kind: 'taskDone', aircraftId: t.aircraftId, note: t.kind });
}

function stepTask(sim: Simulation, t: GroundTask, starved: Set<UnitKind>): void {
  const { state, ctx } = sim;
  const ac = state.aircraft[t.aircraftId]!;
  const arr = state.flights[ac.arrivalFlightId]!;
  const dep = state.flights[ac.departureFlightId]!;

  if (t.state === 'pending' || t.state === 'blocked') {
    if (!t.deps.every((k) => taskDone(state, ac.id, k))) {
      t.state = 'blocked';
      block(state, t, 'dependency');
      return;
    }
    // 旅客が進める作業（降機・搭乗）
    if (t.kind === 'deplane') {
      if (arr.pax.generated && arr.pax.deplaneRemaining === 0) finishTask(sim, t);
      else {
        t.state = 'inProgress';
        t.startedAt ??= state.now;
        block(state, t, 'waitingPax');
      }
      return;
    }
    if (t.kind === 'board') {
      t.state = 'inProgress';
      t.startedAt ??= state.now;
      block(state, t, dep.pax.boarding === 'open' ? null : 'waitingPax');
      return;
    }
    // 手荷物のない便は荷下ろし・積み込みが不要
    if (t.kind === 'unload' && arr.pax.generated && arr.pax.deplaneRemaining === 0 && bagsOf(state, arr.id, ['onAircraft', 'onCart']).length === 0) {
      finishTask(sim, t);
      return;
    }
    if (t.kind === 'load' && dep.pax.generated && dep.pax.booked === 0 && taskDone(state, ac.id, 'board')) {
      finishTask(sim, t);
      return;
    }
    // 積み込みは出発の45分前から（車両を長時間拘束しない）
    if (t.kind === 'load' && state.now < dep.estimated - LOAD_START_LEAD_SEC && !taskDone(state, ac.id, 'board')) {
      t.state = 'blocked';
      block(state, t, 'waitingTime');
      return;
    }
    // 積み込みは、仕分け済みの手荷物があるか搭乗締切後にだけ車両を呼ぶ（手荷物待ちで車両を拘束しない）
    if (t.kind === 'load' && !taskDone(state, ac.id, 'board') && readyBags(state, dep.id).length === 0) {
      t.state = 'blocked';
      block(state, t, 'waitingBags');
      return;
    }
    if (t.kind === 'fuel' && !ctx.hasFuelFarm) {
      t.state = 'blocked';
      block(state, t, 'noFuelFarm');
      return;
    }
    const kinds = Object.keys(t.needs) as UnitKind[];
    const reason = kinds.some((k) => starved.has(k)) ? starvedReason(kinds.find((k) => starved.has(k))!) : allocate(sim, t, ac);
    if (reason) {
      t.state = 'blocked';
      block(state, t, reason);
      for (const k of kinds) starved.add(k);
    } else {
      t.state = 'dispatched';
      block(state, t, null);
    }
    return;
  }

  if (t.state === 'dispatched') {
    if (state.now >= t.phaseUntil!) {
      t.state = 'inProgress';
      t.startedAt ??= state.now;
      t.phaseUntil = null;
      for (const id of t.units) state.units[id]!.status = 'working';
      // 交代した牽引車に、カート上の手荷物を引き継ぐ
      const tractor = t.units.find((id) => state.units[id]!.kind === 'baggageTractor');
      if (tractor) {
        const flightId = t.kind === 'unload' ? arr.id : dep.id;
        for (const b of bagsOf(state, flightId, ['onCart'])) b.location = `cart:${tractor}`;
      }
    }
    return;
  }

  if (t.state !== 'inProgress') return;
  switch (t.kind) {
    case 'deplane':
      if (arr.pax.deplaneRemaining === 0) finishTask(sim, t);
      return;
    case 'board':
      if (dep.pax.boarding === 'closed') {
        reconcileDepartureBags(sim, dep.id, false);
        finishTask(sim, t);
      } else block(state, t, dep.pax.boarding === 'open' ? null : 'waitingPax');
      return;
    case 'unload':
      stepUnload(sim, t, ac);
      return;
    case 'load':
      stepLoad(sim, t, ac);
      return;
    case 'pushback':
      // 機体側（プッシュバック完了）で終了する
      return;
    default:
      // 雷雨（天候 5 段階の段階 4）の間は、屋外の地上作業を 20 分ごとに 5 分止める
      if (state.wx && lightningStop(state)) return;
      t.doneSec++;
      if (t.doneSec >= t.workSec) finishTask(sim, t);
  }
}

/** 手荷物1個の積み下ろし時間（ベルトローダーの台数で割る） */
function handleSec(state: SimState, t: GroundTask): number {
  const loaders = t.units.filter((id) => state.units[id]!.kind === 'beltLoader').length;
  return Math.max(1, Math.round(HANDLE_SEC_PER_BAG / Math.max(1, loaders)));
}

const starvedReason = (k: UnitKind): BlockReason => (k === 'staff' ? 'noStaff' : k === 'engineer' ? 'noEngineer' : 'noVehicle');

/** 積み込める（仕分け済み・旅客が乗り遅れていない）手荷物 */
function readyBags(state: SimState, flightId: string) {
  return bagsOf(state, flightId, ['madeUp']).filter((b) => {
    const g = state.paxGroups[b.paxGroupId]!;
    return g.state !== 'missed' && g.state !== 'cancelled';
  });
}

/** 必要なユニットを全部そろえて割り当てる（そろわなければ何も割り当てず理由を返す） */
function allocate(sim: Simulation, t: GroundTask, ac: Aircraft): BlockReason | null {
  const { state } = sim;
  const target = standPos(sim, ac);
  const chosen: GroundUnit[] = [];
  for (const [kind, n] of Object.entries(t.needs) as [UnitKind, number][]) {
    const free = Object.values(state.units)
      .filter((u) => u.kind === kind && u.status !== 'broken' && !u.taskId && (u.status === 'idle' || u.status === 'returning'))
      .sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y) || compareIds(a.id, b.id));
    if (free.length < n) return kind === 'staff' ? 'noStaff' : kind === 'engineer' ? 'noEngineer' : 'noVehicle';
    chosen.push(...free.slice(0, n));
  }
  let arrive = state.now;
  for (const u of chosen) {
    u.taskId = t.id;
    sendUnit(state, u, target, 'enroute');
    arrive = Math.max(arrive, u.moveEnd);
  }
  t.units = chosen.map((u) => u.id);
  t.phaseUntil = arrive;
  return null;
}

/** 荷下ろし: 1個ずつ貨物室からカートへ。降機が終わり貨物室が空になったら受取所へ搬送する */
function stepUnload(sim: Simulation, t: GroundTask, ac: Aircraft): void {
  const { state, ctx } = sim;
  const arr = state.flights[ac.arrivalFlightId]!;
  const tractor = t.units.find((id) => state.units[id]!.kind === 'baggageTractor')!;
  if (t.phase === 'transport') {
    if (state.now >= t.phaseUntil!) {
      const claim = arr.pax.claimAreaId ?? 'none';
      for (const b of bagsOf(state, arr.id, ['onCart'])) {
        // 乗継手荷物は受取所へ送らず、出発便の預け手荷物に付け替える（フェーズ 4 §5.5）
        if (b.transferToFlightId) retagTransferBag(state, b);
        else moveBag(state, b, 'atClaim', `claim:${claim}`);
      }
      finishTask(sim, t);
    }
    return;
  }
  t.doneSec++;
  if (t.doneSec >= handleSec(state, t)) {
    const next = bagsOf(state, arr.id, ['onAircraft'])[0];
    if (next) {
      moveBag(state, next, 'onCart', `cart:${tractor}`);
      t.doneSec = 0;
    }
  }
  const remaining = bagsOf(state, arr.id, ['onAircraft']).length;
  if (remaining === 0 && arr.pax.generated && arr.pax.deplaneRemaining === 0) {
    const claimArea = arr.pax.claimAreaId ? ctx.terminal.areas[arr.pax.claimAreaId] : undefined;
    const to = claimArea ? mapToWorld(claimArea.center) : standPos(sim, ac);
    t.phase = 'transport';
    t.phaseUntil = state.now + travelSec(standPos(sim, ac), to);
    const u = state.units[tractor]!;
    sendUnit(state, u, to, 'enroute');
    u.status = 'working';
  }
}

/**
 * 積み込み: 仕分け済み（madeUp）の手荷物をカートで機体へ運び、1個ずつ積む。
 * 搭乗締切後、パイプラインが空になったら完了。締切 + 10分で届いていない手荷物は積み残し。
 */
function stepLoad(sim: Simulation, t: GroundTask, ac: Aircraft): void {
  const { state, ctx } = sim;
  const dep = state.flights[ac.departureFlightId]!;
  const tractor = t.units.find((id) => state.units[id]!.kind === 'baggageTractor')!;
  const u = state.units[tractor]!;
  const sorter = ctx.sorters[0];
  const stand = standPos(sim, ac);

  if (t.phase === 'transport') {
    if (state.now >= t.phaseUntil!) {
      t.phase = 'working';
      t.doneSec = 0;
    }
    return;
  }
  if (t.phase === 'working') {
    t.doneSec++;
    if (t.doneSec >= handleSec(state, t)) {
      t.doneSec = 0;
      const b = bagsOf(state, dep.id, ['onCart'])[0];
      if (b) {
        // 自便の機体にだけ、1回だけ積む。貨物室の容量（機種のゲーム値）を超える分は積み残し
        if (b.loadedOn === null) {
          if (bagsOf(state, dep.id, ['loaded']).length >= resolveType(sim.ctx.types, ac.typeId).holdBags) {
            moveBag(state, b, 'leftBehind', `hold-full:${ac.id}`);
            state.groundStats.bagsLeftBehind++;
            onBagLeftBehind(sim);
          } else {
            b.loadedOn = ac.id;
            moveBag(state, b, 'loaded', `aircraft:${ac.id}`);
            state.groundStats.bagsLoaded++;
          }
        }
      }
      if (bagsOf(state, dep.id, ['onCart']).length === 0) t.phase = 'idle';
    }
    return;
  }

  // idle: 仕分け済みの手荷物があれば取りに行く（乗り遅れ旅客の分は積まない）
  const ready = readyBags(state, dep.id);
  if (ready.length > 0) {
    for (const b of ready) moveBag(state, b, 'onCart', `cart:${tractor}`);
    const from = sorter ? { x: sorter.x, y: sorter.y } : stand;
    // 仕分け場まで行って戻る
    t.phase = 'transport';
    t.phaseUntil = state.now + travelSec(stand, from) * 2;
    sendUnit(state, u, stand, 'enroute');
    u.fromX = from.x;
    u.fromY = from.y;
    u.moveStart = state.now + travelSec(stand, from);
    u.moveEnd = t.phaseUntil;
    u.status = 'working';
    block(state, t, null);
    return;
  }
  const boardDone = taskDone(state, ac.id, 'board');
  const pipeline = bagsOf(state, dep.id, ['checkedIn', 'sorting', 'madeUp', 'onCart']);
  if (boardDone) {
    const closedAt = tasksOf(state, ac.id).find((x) => x.kind === 'board')!.doneAt!;
    if (pipeline.length > 0 && state.now >= closedAt + BAG_CUTOFF_AFTER_BOARDING_SEC) {
      const left = reconcileDepartureBags(sim, dep.id, true);
      if (left > 0) log(state, { t: state.now, kind: 'bagsLeftBehind', aircraftId: ac.id, note: `${dep.number} ${left}個` });
    }
    if (bagsOf(state, dep.id, ['checkedIn', 'sorting', 'madeUp', 'onCart']).length === 0) {
      finishTask(sim, t);
      return;
    }
  }
  const sorterDown = !!sorter && isDown(state, sorter.id) && pipeline.some((b) => b.state === 'sorting');
  if (!boardDone && !sorterDown) {
    // 次の手荷物が仕分けられるまで車両・作業員を返す（進捗は保持）
    releaseUnits(sim, t);
    t.state = 'blocked';
    block(state, t, 'waitingBags');
    return;
  }
  block(state, t, sorterDown ? 'sorterDown' : 'waitingBags');
}

/** プッシュバックの車両が機体に着いているか */
export function pushbackReady(state: SimState, acId: string): boolean {
  return tasksOf(state, acId).some((t) => t.kind === 'pushback' && t.state === 'inProgress');
}

export function completePushback(sim: Simulation, acId: string): void {
  const t = tasksOf(sim.state, acId).find((x) => x.kind === 'pushback' && x.state === 'inProgress');
  if (t) finishTask(sim, t);
}

function randomFailures(sim: Simulation): void {
  const { state, ctx } = sim;
  withRng(state, (rng) => {
    for (const u of Object.values(state.units)) {
      if (u.status !== 'broken' && rng.next() < 1 / (RANDOM_MTBF_HOURS.unit * 3600)) setUnitBroken(sim, u.id, true, rng.int(30, 90) * 60);
    }
    for (const s of ctx.sorters) {
      if (!isDown(state, s.id) && rng.next() < 1 / (RANDOM_MTBF_HOURS.sorter * 3600)) setEquipmentBroken(sim, s.id, true, rng.int(20, 60) * 60);
    }
    for (const a of Object.values(ctx.terminal.areas)) {
      if (a.kind === 'baggageClaim' && !isDown(state, `belt:${a.id}`) && rng.next() < 1 / (RANDOM_MTBF_HOURS.belt * 3600)) {
        setEquipmentBroken(sim, `belt:${a.id}`, true, rng.int(20, 60) * 60);
      }
    }
  });
}
