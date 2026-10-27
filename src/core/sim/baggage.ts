import type { Simulation } from './simulation';
import { EVENT_LOG_LIMIT, type Bag, type BagState, type EquipmentState, type PaxGroup, type SimState } from './types';

/**
 * 手荷物（docs/13_ground_handling_rules.md）。
 *
 * 手荷物は1個ずつのエンティティで、状態・所在・履歴を持つ。所属する便は生成時に決まり、変わらない
 * （出発手荷物は出発便、到着手荷物は到着便）。積載は自便の機体に1回だけ行う。
 *
 * 出発: checkedIn（チェックイン）→ コンベヤー → sorting（仕分け設備）→ madeUp（便ごとに仕分け済み）
 *        → onCart（牽引車で機体へ）→ loaded / leftBehind（積み残し）/ offloaded（乗り遅れ旅客の分を取り下ろし）
 * 到着: onAircraft → onCart（荷下ろし・受取所へ搬送）→ atClaim（ベルト待ち）→ onBelt → collected
 */

/** チェックインカウンターから仕分け場までのコンベヤーの所要時間 */
export const CONVEYOR_SEC = 120;
/** 積み下ろし（ベルトローダー1台・作業員2人）の1個あたりの時間 */
export const HANDLE_SEC_PER_BAG = 6;
/** 搭乗締切からこの時間を過ぎても機体へ届いていない手荷物は積み残し */
export const BAG_CUTOFF_AFTER_BOARDING_SEC = 10 * 60;
/** 車両の走行速度（m/s）と、作業位置での準備時間 */
export const VEHICLE_SPEED = 8;
export const VEHICLE_SETUP_SEC = 30;

export const BAG_FINAL_STATES: readonly BagState[] = ['loaded', 'leftBehind', 'offloaded', 'collected'];

function log(state: SimState, e: SimState['events'][number]): void {
  state.events.push(e);
  if (state.events.length > EVENT_LOG_LIMIT) state.events.splice(0, state.events.length - EVENT_LOG_LIMIT);
}

function nextId(state: SimState, prefix: string): string {
  const n = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = n;
  return `${prefix}_${n}`;
}

export function moveBag(state: SimState, bag: Bag, to: BagState, location: string): void {
  bag.state = to;
  bag.location = location;
  bag.since = state.now;
  bag.history.push({ t: state.now, state: to, location });
}

function addBag(state: SimState, g: PaxGroup, flightId: string, s: BagState, location: string): Bag {
  const id = nextId(state, 'bg');
  const bag: Bag = {
    id,
    flightId,
    paxGroupId: g.id,
    direction: g.direction,
    state: s,
    location,
    since: state.now,
    loadedOn: null,
    history: [{ t: state.now, state: s, location }],
  };
  state.bags[id] = bag;
  state.activeBags.push(id);
  (state.flightBags[flightId] ??= []).push(id);
  (state.groupBags[g.id] ??= []).push(id);
  return bag;
}

/** チェックインの完了時に、グループの預け手荷物を生成する */
export function checkInBags(sim: Simulation, g: PaxGroup, counterArea: string): void {
  if ((sim.state.groupBags[g.id] ?? []).length > 0) return; // 二重の預け入れはしない
  for (let i = 0; i < g.bags; i++) addBag(sim.state, g, g.flightId, 'checkedIn', `counter:${counterArea}`);
}

/** 到着グループの手荷物（到着機の貨物室にある） */
export function arrivalBags(sim: Simulation, g: PaxGroup, aircraftId: string): void {
  for (let i = 0; i < g.bags; i++) addBag(sim.state, g, g.flightId, 'onAircraft', `aircraft:${aircraftId}`);
}

export function bagsOf(state: SimState, flightId: string, states?: readonly BagState[]): Bag[] {
  const list = (state.flightBags[flightId] ?? []).map((id) => state.bags[id]!);
  return states ? list.filter((b) => states.includes(b.state)) : list;
}

export function groupBagsOf(state: SimState, groupId: string): Bag[] {
  return (state.groupBags[groupId] ?? []).map((id) => state.bags[id]!);
}

// ---------------------------------------------------------------- 設備の故障

export function equipment(state: SimState, key: string): EquipmentState {
  return (state.equipment[key] ??= { broken: false, repairUntil: null, downSec: 0 });
}

export const isDown = (state: SimState, key: string): boolean => state.equipment[key]?.broken ?? false;

/** 設備・車両を停止（故障）/ 復旧させる。repairSec を指定すると自動で復旧する */
export function setEquipmentBroken(sim: Simulation, key: string, broken: boolean, repairSec?: number): void {
  const { state } = sim;
  const e = equipment(state, key);
  if (e.broken === broken) return;
  e.broken = broken;
  e.repairUntil = broken && repairSec ? state.now + repairSec : null;
  log(state, { t: state.now, kind: broken ? 'equipmentDown' : 'equipmentUp', note: key });
}

// ---------------------------------------------------------------- 1ティック

export function stepBaggage(sim: Simulation): void {
  const { state, ctx } = sim;
  for (const [key, e] of Object.entries(state.equipment)) {
    if (e.broken) {
      e.downSec++;
      if (e.repairUntil !== null && state.now >= e.repairUntil) setEquipmentBroken(sim, key, false);
    }
  }
  const sorter = ctx.sorters[0];
  // コンベヤー → 仕分け設備
  for (const id of state.activeBags) {
    const b = state.bags[id]!;
    if (b.state === 'checkedIn' && state.now - b.since >= CONVEYOR_SEC) {
      if (sorter) moveBag(state, b, 'sorting', `sorter:${sorter.id}`);
      else if (b.location !== 'conveyor:noSorter') {
        b.location = 'conveyor:noSorter';
        b.history.push({ t: state.now, state: b.state, location: b.location });
      }
    }
  }
  // 仕分け: 設備ごとの処理能力（個/分）。停止中は進まない
  for (const s of ctx.sorters) {
    if (isDown(state, s.id)) continue;
    const acc = (state.sorterAcc[s.id] ?? 0) + s.capacityPerMin / 60;
    let n = Math.floor(acc);
    state.sorterAcc[s.id] = acc - n;
    for (const id of state.activeBags) {
      if (n <= 0) break;
      const b = state.bags[id]!;
      if (b.state !== 'sorting' || b.location !== `sorter:${s.id}` || state.now - b.since < 1) continue;
      moveBag(state, b, 'madeUp', `makeup:${s.id}`);
      n--;
    }
    if (n === 0 && acc >= 1) state.sorterAcc[s.id] = Math.min(state.sorterAcc[s.id]!, 1);
  }
  // 受取所: ベルト（受取所ごとのベルト数、故障中は 0）に空きがあれば便ごとに流す
  const claimFlights = new Map<string, Set<string>>();
  for (const id of state.activeBags) {
    const b = state.bags[id]!;
    if (b.state === 'onBelt') {
      const area = b.location.slice('belt:'.length);
      (claimFlights.get(area) ?? claimFlights.set(area, new Set()).get(area)!).add(b.flightId);
    }
  }
  for (const id of state.activeBags) {
    const b = state.bags[id]!;
    if (b.state !== 'atClaim') continue;
    const area = b.location.slice('claim:'.length);
    const onBelt = claimFlights.get(area) ?? claimFlights.set(area, new Set()).get(area)!;
    const belts = isDown(state, `belt:${area}`) ? 0 : Math.max(0, Number(ctx.layout.terminalAreas[area]?.props.belts ?? 0));
    if (onBelt.has(b.flightId) || onBelt.size < belts) {
      onBelt.add(b.flightId);
      moveBag(state, b, 'onBelt', `belt:${area}`);
      const f = state.flights[b.flightId]!;
      f.pax.bagsReadyAt ??= state.now;
    }
  }
  state.activeBags = state.activeBags.filter((id) => !BAG_FINAL_STATES.includes(state.bags[id]!.state));
}

/** グループの手荷物がすべてベルトに出ているか（到着旅客の受け取り条件） */
export function groupBagsOnBelt(state: SimState, groupId: string): boolean {
  const bags = groupBagsOf(state, groupId);
  return bags.length > 0 && bags.every((b) => b.state === 'onBelt' || b.state === 'collected');
}

export function collectBags(sim: Simulation, groupId: string): void {
  const { state } = sim;
  for (const b of groupBagsOf(state, groupId)) {
    if (b.state === 'onBelt') {
      moveBag(state, b, 'collected', `pax:${groupId}`);
      state.groundStats.bagsCollected++;
    }
  }
}

/**
 * 出発便の締め処理: 乗り遅れた旅客の手荷物は積まない（積載済みなら取り下ろす）。
 * finalCutoff = true のとき、まだ機体に届いていない手荷物を積み残しにする。
 */
export function reconcileDepartureBags(sim: Simulation, flightId: string, finalCutoff: boolean): number {
  const { state } = sim;
  let left = 0;
  for (const b of bagsOf(state, flightId)) {
    const g = state.paxGroups[b.paxGroupId]!;
    const paxGone = g.state === 'missed' || g.state === 'cancelled';
    if (paxGone && b.state === 'loaded') {
      b.loadedOn = null;
      moveBag(state, b, 'offloaded', `makeup:offload`);
      state.groundStats.bagsOffloaded++;
    } else if ((paxGone || finalCutoff) && ['checkedIn', 'sorting', 'madeUp'].includes(b.state)) {
      moveBag(state, b, 'leftBehind', b.location);
      state.groundStats.bagsLeftBehind++;
      left++;
    }
  }
  return left;
}
