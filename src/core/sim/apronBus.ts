import { compareIds } from '../model/ids';
import { gateMode } from '../model/gates';
import { resolveBusGateForStand } from '../terminal/busGateAssignment';
import { onBusTrip } from '../economy/ops';
import {
  APRON_BUS_CAPACITY,
  BUS_DOOR_SEC,
  BUS_GIVEUP_SEC,
  BUS_LOAD_SEC_PER_PAX,
  BUS_MAX_LOAD_SEC,
  BUS_TRANSFER_SEC,
  BUS_UNLOAD_SEC_PER_PAX,
} from './busRules';
import { basePos, sendUnit } from './ground';
import { finishBusBoarded, groupsOfFlight, missGroups, releaseBusArrival, returnToBusQueue, setGroupArea } from './passengers';
import { recordSimpleProcess } from './processStats';
import type { Simulation } from './simulation';
import { EVENT_LOG_LIMIT, PAX_FINAL_STATES, type Aircraft, type ApronBusRuntime, type BusTrip, type Flight, type GroundUnit, type PaxGroup, type SimState } from './types';

/**
 * ランプバス（バス搭乗）の運行。docs/29_remote_stands_and_bus_boarding.md
 *
 * バスゲート（boardingMode 'bus'）がある運航（state.bus がある）だけで動く。ゲートのないスポット（リモート）に着いた便は、
 * 出発旅客がバスゲートで搭乗券を確認 → ランプバスでスポットへ → タラップで機内へ、到着旅客はスポットでバスに乗って降機口へ運ばれる。
 * バスは基地の GSE ユニット（kind 'apronBus'）で、移動は既存の直線の移動時間モデル（ground.ts）。決定的（乱数を引かない）。
 */

export function createApronBusRuntime(): ApronBusRuntime {
  return { trips: {}, active: [], stats: { trips: 0, pax: 0, waitSec: 0, shortageSec: 0, rescues: 0 } };
}

function log(state: SimState, e: SimState['events'][number]): void {
  state.events.push(e);
  if (state.events.length > EVENT_LOG_LIMIT) state.events.splice(0, state.events.length - EVENT_LOG_LIMIT);
}

function nextId(state: SimState, prefix: string): string {
  const n = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = n;
  return `${prefix}_${n}`;
}

type Pos = { x: number; y: number };

function gatePos(sim: Simulation, gateId: string): Pos {
  const f = sim.ctx.layout.facilities[gateId]!;
  return { x: f.origin.x, y: f.origin.y };
}

function standPos(sim: Simulation, standId: string): Pos {
  const n = sim.ctx.network.nodes[`${standId}:P`];
  return n ? { x: n.pos.x, y: n.pos.y } : { x: 0, y: 0 };
}

const isBusGate = (sim: Simulation, gateId: string | null): boolean => !!gateId && sim.ctx.busGates.includes(gateId);

/** バス扱いの便（便がバスゲートを持ち、バスの状態がある）か */
export function isBusFlight(f: Flight): boolean {
  return !!f.pax.bus;
}

// ---------------------------------------------------------------- バスゲートの選択

/** Plan preview and live operation use the same nearest-usable-gate rule. */
export function pickBusGate(sim: Simulation, f: Flight, need: 'boarding' | 'deplane', standId: string): string | null {
  void f;
  void need;
  const point = sim.ctx.network.nodes[sim.ctx.stands[standId]?.node ?? '']?.pos ?? null;
  return resolveBusGateForStand(sim.ctx.layout, sim.ctx.terminal, standId, point, sim.ctx.busGates, sim.state.closures.gates).gateId;
}

function configuredBusGate(sim: Simulation, f: Flight, standId: string, need: 'boarding' | 'deplane'): { gateId: string | null; failure?: 'disabled' | 'unconfigured' | 'invalidGate' } {
  void f;
  void need;
  const point = sim.ctx.network.nodes[sim.ctx.stands[standId]?.node ?? '']?.pos ?? null;
  const assignment = resolveBusGateForStand(sim.ctx.layout, sim.ctx.terminal, standId, point, sim.ctx.busGates, sim.state.closures.gates);
  return { gateId: assignment.gateId, ...(assignment.failure ? { failure: assignment.failure } : {}) };
}

/**
 * 固定したゲートが今のスポットの設定を満たすか（閉鎖は無視）。'bus' なら busGateId と一致、そうでなければ所属ターミナルの指定がないか、ゲートの所属が一致。
 * 満たさないとき（機体のスポットが変わった等）は選び直し、ターミナル間の移動は reconcileDepartureGate に任せる。
 */
function pinnedGateStillValid(sim: Simulation, standId: string, gateId: string): boolean {
  if (!isBusGate(sim, gateId)) return false;
  const layoutStand = sim.ctx.layout.stands[standId];
  if (!layoutStand) return false;
  if (layoutStand.remoteBoarding === 'bus') return gateId === layoutStand.busGateId;
  return !layoutStand.terminalId || sim.ctx.terminal.gates[gateId]?.terminalId === layoutStand.terminalId;
}

/** 出発便: スポットがコンタクトでなければバスゲートを決める（搭乗開始前なら、使えなくなったゲートは選び直す）。p.gateId を設定する */
export function applyBusDeparture(sim: Simulation, f: Flight, ac: Aircraft): void {
  const { state, ctx } = sim;
  const p = f.pax;
  const stand = ac.standId ? ctx.stands[ac.standId] : undefined;
  if (!stand || stand.contact) {
    delete p.bus;
    delete p.busFailure;
    return;
  }
  if (stand.remoteBoarding === 'none') {
    delete p.bus;
    p.busFailure = 'disabled';
    p.gateId = null;
    return;
  }
  const priorGate = p.bus?.gateId ?? null;
  // 旅客を生成した後は、搭乗ゲートを固定する（1-07 / 1-11）。選び直さず、閉鎖中でも維持する（旅客はゲート工程で待ち、再開すれば搭乗する。
  // 締切までに再開しなければ facilityClosed で乗り遅れ）。固定は、今のスポットの設定を満たすゲートだけ。状態を持たない判定なので保存項目は増えない。
  const pinned = p.generated && !!priorGate && pinnedGateStillValid(sim, stand.id, priorGate);
  let gateId = p.boarding === 'notStarted' && !pinned ? null : priorGate;
  let selectionFailure: 'disabled' | 'unconfigured' | 'invalidGate' | undefined;
  if (p.boarding === 'notStarted' && !pinned) {
    const assignment = configuredBusGate(sim, f, stand.id, 'boarding');
    gateId = assignment.gateId;
    selectionFailure = assignment.failure;
  }
  if (!gateId) {
    const previousFailure = p.busFailure;
    delete p.bus;
    p.busFailure = selectionFailure ?? 'unconfigured';
    p.gateId = null;
    if (p.busFailure !== previousFailure) log(state, { t: state.now, kind: 'disruption', aircraftId: f.aircraftId, note: `リモートスポット ${stand.id} の搭乗バスゲートが利用できません（${p.busFailure}）` });
    return;
  }
  delete p.busFailure;
  p.bus = p.bus ?? { gateId, gateClosedAt: null, paxCarried: 0, waitPaxSec: 0 };
  p.bus.gateId = gateId;
  p.gateId = gateId;
}

/** 到着便: スポットがコンタクトでなければ降機口のあるバスゲートを決める（最初の 1 回だけ）。バス扱いでなければ undefined */
export function applyBusArrival(sim: Simulation, f: Flight, ac: Aircraft): string | null | undefined {
  const { ctx } = sim;
  const p = f.pax;
  const stand = ac.standId ? ctx.stands[ac.standId] : undefined;
  if (!stand || stand.contact) return undefined;
  if (stand.remoteBoarding === 'none') {
    const first = p.busFailure !== 'disabled';
    p.busFailure = 'disabled';
    p.gateId = null;
    if (first) log(sim.state, { t: sim.state.now, kind: 'disruption', aircraftId: f.aircraftId, note: `リモートスポット ${stand.id} はバス搭乗を使用しません` });
    return null;
  }
  if (!p.generated) {
    const configured = configuredBusGate(sim, f, stand.id, 'deplane');
    const gateId = configured.gateId;
    const previousFailure = p.busFailure;
    if (configured.failure || !gateId) {
      p.busFailure = configured.failure ?? 'unconfigured';
      p.gateId = null;
      if (previousFailure !== p.busFailure) log(sim.state, { t: sim.state.now, kind: 'disruption', aircraftId: f.aircraftId, note: `リモートスポット ${stand.id} の到着バスゲートが利用できません（${p.busFailure}）` });
      return null;
    }
    delete p.busFailure;
    p.bus ??= { gateId, gateClosedAt: null, paxCarried: 0, waitPaxSec: 0 };
    p.bus.gateId = gateId;
    p.gateId = gateId;
  }
  return p.bus?.gateId ?? null;
}

// ---------------------------------------------------------------- 出発便の搭乗（ゲートの締切・バス待ち）

/**
 * バス扱いの出発便の搭乗の進行（stepDepartureFlight の open の間）。
 * ゲートの締切 = ゲートより前のグループを乗り遅れにし、バス待ち・乗車中のグループは運ぶ。
 * バスが来ない（締切から BUS_GIVEUP_SEC）旅客は noBus で乗り遅れ。全員が終わったら搭乗を締める。
 */
export function stepBusBoarding(sim: Simulation, f: Flight, closeBoarding: (sim: Simulation, f: Flight, forced: null) => void): void {
  const { state } = sim;
  const p = f.pax;
  const b = p.bus!;
  const groups = groupsOfFlight(state, f.id);
  const allResolved = p.generated && groups.every((g) => PAX_FINAL_STATES.includes(g.state));
  if (allResolved) {
    closeBoarding(sim, f, null);
    return;
  }
  const gateId = p.gateId;
  if (b.gateClosedAt === null) {
    const gateDown = !!gateId && state.closures.gates.includes(gateId);
    const fac = gateId ? state.facilities[`gate:${gateId}`] : undefined;
    const gateBusy = gateId && !gateDown ? (fac?.queue.length ?? 0) + (fac?.inService.length ?? 0) > 0 : false;
    if (state.now < p.deadline! || gateBusy) return;
    if (!gateId) {
      closeBoarding(sim, f, null); // バスゲートが決まらなかった: 従来どおり noGate
      return;
    }
    const missed = missGroups(sim, f, null, (g) => g.state !== 'waitingBus' && g.state !== 'onBus');
    b.gateClosedAt = state.now;
    log(state, { t: state.now, kind: 'boardingClosed', aircraftId: f.aircraftId, note: `${f.number} 搭乗ゲート締切（バス待ち ${groups.filter((g) => g.state === 'waitingBus' || g.state === 'onBus').reduce((s, g) => s + g.count, 0)}人）` });
    if (missed > 0) log(state, { t: state.now, kind: 'paxMissed', aircraftId: f.aircraftId, note: `${f.number} ${missed}人` });
  }
  if (state.now >= b.gateClosedAt! + BUS_GIVEUP_SEC) {
    const missed = missGroups(sim, f, 'noBus', (g) => g.state === 'waitingBus' && !g.busTrip);
    if (missed > 0) log(state, { t: state.now, kind: 'paxMissed', aircraftId: f.aircraftId, note: `${f.number} ${missed}人（バスが来ず）` });
  }
  if (groupsOfFlight(state, f.id).every((g) => PAX_FINAL_STATES.includes(g.state))) closeBoarding(sim, f, null);
}

// ---------------------------------------------------------------- 配車・運行

const phaseActive = (t: BusTrip) => t.phase !== 'done' && t.phase !== 'cancelled';

export function stepApronBuses(sim: Simulation): void {
  const { state } = sim;
  const bus = state.bus!;
  for (const id of [...bus.active]) advance(sim, bus.trips[id]!);
  bus.active = bus.active.filter((id) => phaseActive(bus.trips[id]!));
  createRequests(sim);
  assign(sim);
  for (const u of Object.values(state.units)) if (u.kind === 'apronBus' && u.trip) u.busySec++;
}

function unitOf(sim: Simulation, t: BusTrip): GroundUnit | undefined {
  return t.busId ? sim.state.units[t.busId] : undefined;
}

function pickupPos(sim: Simulation, t: BusTrip): Pos {
  return t.dir === 'dep' ? gatePos(sim, t.gateId) : standPos(sim, t.standId);
}
function dropPos(sim: Simulation, t: BusTrip): Pos {
  return t.dir === 'dep' ? standPos(sim, t.standId) : gatePos(sim, t.gateId);
}

/** バスを運行から外して基地へ戻す（故障中はその場で修理待ち） */
function releaseBus(sim: Simulation, t: BusTrip): void {
  const u = unitOf(sim, t);
  if (u) {
    delete u.trip;
    if (u.status !== 'broken') sendUnit(sim.state, u, basePos(sim, u), 'returning');
  }
  t.busId = null;
}

function cancelTrip(sim: Simulation, t: BusTrip): void {
  const { state } = sim;
  for (const id of t.groups) {
    const g = state.paxGroups[id];
    if (g && g.busTrip === t.id) delete g.busTrip;
  }
  releaseBus(sim, t);
  t.phase = 'cancelled';
  t.phaseSince = state.now;
  t.phaseUntil = null;
}

/** 乗車中・乗車待ちのグループを乗車待ちに戻す（バスの故障） */
function requeueGroups(sim: Simulation, t: BusTrip): void {
  for (const id of t.groups) {
    const g = sim.state.paxGroups[id];
    if (g && g.busTrip === t.id) returnToBusQueue(sim, g, t.dir === 'dep' ? t.gateId : null);
  }
  t.groups = [];
  t.pax = 0;
}

function advance(sim: Simulation, t: BusTrip): void {
  const { state } = sim;
  const f = state.flights[t.flightId]!;
  // 欠航などで搭乗が締められた出発便の運行は取り消す（旅客は closeBoarding で処理済み）
  if (t.dir === 'dep' && f.pax.boarding === 'closed') {
    cancelTrip(sim, t);
    return;
  }
  const u = unitOf(sim, t);
  // バスの故障
  if (u && u.status === 'broken') {
    delete u.trip;
    t.busId = null;
    if (t.phase === 'toPickup' || t.phase === 'loading') {
      requeueGroups(sim, t);
      t.phase = 'waiting';
      t.phaseSince = state.now;
      t.phaseUntil = null;
    } else if (t.phase === 'driving' || t.phase === 'unloading') {
      t.resume = t.phase;
      t.stallAt = { x: u.x, y: u.y };
      t.phase = 'stalled';
      t.phaseSince = state.now;
      t.phaseUntil = null;
    } else if (t.phase === 'stalled') {
      t.phaseUntil = null; // 救援のバスも故障: 次の救援を待つ
    }
    return;
  }
  switch (t.phase) {
    case 'toPickup':
      if (u && state.now >= t.phaseUntil!) {
        t.phase = 'loading';
        t.phaseSince = state.now;
        t.phaseUntil = state.now + BUS_DOOR_SEC;
        u.status = 'working';
      }
      return;
    case 'loading':
      if (u) stepLoading(sim, t, f, u);
      return;
    case 'driving':
      if (u && state.now >= t.phaseUntil!) {
        t.phase = 'unloading';
        t.phaseSince = state.now;
        t.phaseUntil = state.now + Math.ceil(BUS_DOOR_SEC + BUS_UNLOAD_SEC_PER_PAX[t.dir] * t.pax);
        u.status = 'working';
      }
      return;
    case 'unloading':
      if (u && state.now >= t.phaseUntil!) completeTrip(sim, t);
      return;
    case 'stalled':
      // 救援のバスが合流して乗り換えを終えたら、元の段階を再開する
      if (u && t.phaseUntil !== null && state.now >= t.phaseUntil) {
        t.phaseSince = state.now;
        if (t.resume === 'unloading') {
          t.phase = 'unloading';
          t.phaseUntil = state.now + Math.ceil(BUS_DOOR_SEC + BUS_UNLOAD_SEC_PER_PAX[t.dir] * t.pax);
          u.status = 'working';
        } else {
          t.phase = 'driving';
          sendUnit(state, u, dropPos(sim, t), 'enroute');
          t.phaseUntil = u.moveEnd;
        }
        delete t.stallAt;
        delete t.resume;
      }
      return;
    default:
      return;
  }
}

function eligibleGroups(sim: Simulation, t: BusTrip): PaxGroup[] {
  return groupsOfFlight(sim.state, t.flightId).filter((g) => g.state === 'waitingBus' && !g.busTrip);
}

function expectMore(sim: Simulation, t: BusTrip, f: Flight): boolean {
  if (t.dir === 'arr') return f.pax.deplaneRemaining > 0;
  if (f.pax.bus!.gateClosedAt !== null) return false;
  return groupsOfFlight(sim.state, f.id).some((g) => !PAX_FINAL_STATES.includes(g.state) && g.state !== 'waitingBus' && g.state !== 'onBus');
}

function stepLoading(sim: Simulation, t: BusTrip, f: Flight, u: GroundUnit): void {
  const { state } = sim;
  let leftover = false;
  for (const g of eligibleGroups(sim, t)) {
    if (t.pax + g.count > APRON_BUS_CAPACITY) {
      leftover = true;
      continue;
    }
    g.busTrip = t.id;
    g.state = 'onBus';
    setGroupArea(state, g, null);
    t.groups.push(g.id);
    t.pax += g.count;
  }
  t.phaseUntil = t.phaseSince + BUS_DOOR_SEC + Math.ceil(t.pax * BUS_LOAD_SEC_PER_PAX);
  const more = expectMore(sim, t, f);
  if (t.pax === 0) {
    if (!more) cancelTrip(sim, t);
    return;
  }
  const full = t.pax >= APRON_BUS_CAPACITY || leftover;
  const timeUp = state.now - t.phaseSince >= BUS_MAX_LOAD_SEC;
  if (state.now < t.phaseUntil || !(full || !more || timeUp)) return;
  // 出発
  const b = f.pax.bus!;
  b.paxCarried += t.pax;
  b.waitPaxSec += (state.now - t.createdAt) * t.pax;
  sim.state.bus!.stats.waitSec += (state.now - t.createdAt) * t.pax;
  t.phase = 'driving';
  t.phaseSince = state.now;
  sendUnit(state, u, dropPos(sim, t), 'enroute');
  t.phaseUntil = u.moveEnd;
}

function completeTrip(sim: Simulation, t: BusTrip): void {
  const { state } = sim;
  for (const id of t.groups) {
    const g = state.paxGroups[id];
    if (!g || g.busTrip !== t.id) continue;
    if (t.dir === 'dep') finishBusBoarded(sim, g);
    else releaseBusArrival(sim, g, t.gateId);
  }
  const bus = state.bus!;
  bus.stats.trips++;
  bus.stats.pax += t.pax;
  // 5-21: ランプバス工程の実績（運行完了時点で運んだ人数。能力は算出しない）
  recordSimpleProcess(state, 'apronBus', t.pax, state.now, sim.ctx.terminal.areas[t.gateId]?.terminalId ?? '');
  onBusTrip(sim);
  t.phase = 'done';
  t.phaseSince = state.now;
  t.phaseUntil = null;
  releaseBus(sim, t);
}

/** 配車の要求（乗車待ちのグループがいて、受け付け中の運行がない便に新しい運行を作る） */
function createRequests(sim: Simulation): void {
  const { state } = sim;
  const bus = state.bus!;
  for (const f of Object.values(state.flights)) {
    const b = f.pax.bus;
    if (!b) continue;
    const dir = f.direction === 'departure' ? 'dep' : 'arr';
    const groups = groupsOfFlight(state, f.id);
    // バスが一台もない・全部故障・来ない到着旅客は、1 時間でスポットから動けないまま到達不能にする（従来のリモートスポットと同じ扱い）。
    // 配車の条件（ゲート・機体の駐機）より前に判定する（機体が出発したあとでも旅客を残さない）
    if (dir === 'arr') {
      for (const g of groups) {
        if (g.state === 'waitingBus' && !g.busTrip && state.now - g.appearAt >= 3600) {
          g.state = 'stranded';
          g.reason = 'unreachable';
          g.retryAt = Number.MAX_SAFE_INTEGER;
        }
      }
    }
    if (!b.gateId || !isBusGate(sim, b.gateId)) continue;
    if (dir === 'dep' && f.pax.boarding !== 'open') continue;
    const ac = state.aircraft[f.aircraftId];
    if (!ac?.standId) continue;
    if (!groups.some((g) => g.state === 'waitingBus' && !g.busTrip)) continue;
    const accepting = bus.active.some((id) => {
      const t = bus.trips[id]!;
      return t.flightId === f.id && t.dir === dir && (t.phase === 'waiting' || t.phase === 'toPickup' || t.phase === 'loading');
    });
    if (accepting) continue;
    const id = nextId(state, 'bt');
    bus.trips[id] = { id, dir, flightId: f.id, gateId: b.gateId, standId: ac.standId, busId: null, phase: 'waiting', phaseSince: state.now, phaseUntil: null, groups: [], pax: 0, createdAt: state.now };
    bus.active.push(id);
  }
}

/** 未配車の運行へ空きバスを割り当てる（救援を先に。出発の締切が早い順 → 到着順 → 運行 ID）。空きがなければ待たせる */
function assign(sim: Simulation): void {
  const { state } = sim;
  const bus = state.bus!;
  const need = bus.active
    .map((id) => bus.trips[id]!)
    .filter((t) => (t.phase === 'waiting' && !t.busId) || (t.phase === 'stalled' && !t.busId));
  if (need.length === 0) return;
  const key = (t: BusTrip) => {
    const f = state.flights[t.flightId]!;
    return t.phase === 'stalled' ? [0, 0] : t.dir === 'dep' ? [1, f.pax.deadline ?? f.estimated] : [2, f.block ?? f.estimated];
  };
  need.sort((a, b) => key(a)[0]! - key(b)[0]! || key(a)[1]! - key(b)[1]! || compareIds(a.id, b.id));
  const free = Object.values(state.units).filter((u) => u.kind === 'apronBus' && u.status !== 'broken' && !u.trip);
  let short = false;
  for (const t of need) {
    const target = t.phase === 'stalled' ? t.stallAt! : pickupPos(sim, t);
    free.sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y) || compareIds(a.id, b.id));
    const u = free.shift();
    if (!u) {
      short = true;
      continue;
    }
    u.trip = t.id;
    t.busId = u.id;
    sendUnit(state, u, target, 'enroute');
    if (t.phase === 'stalled') {
      t.phaseUntil = u.moveEnd + BUS_TRANSFER_SEC;
      bus.stats.rescues++;
      log(state, { t: state.now, kind: 'busRescue', note: `${u.id} → 運行 ${t.id}` });
    } else {
      t.phase = 'toPickup';
      t.phaseSince = state.now;
      t.phaseUntil = u.moveEnd;
    }
  }
  if (short) bus.stats.shortageSec++;
}

/** バス搭乗に使うゲートかどうか（運用中のバスゲート） */
export function isBusModeGate(sim: Simulation, gateId: string | null): boolean {
  return !!gateId && gateMode(sim.ctx.layout.facilities[gateId]!) === 'bus';
}
