import type { Simulation } from './simulation';
import { onBagLeftBehind } from '../economy/ops';
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

/**
 * グループの手荷物の「ベルトに出た/回収された」回数（PERF4-4）。
 * waitingBaggage で眠るグループの起床署名に使う。実行時状態（保存しない）。
 */
const bagWakeStore = new WeakMap<SimState, Map<string, number>>();

export function bagGroupVersion(state: SimState, groupId: string): number {
  return bagWakeStore.get(state)?.get(groupId) ?? 0;
}

export function moveBag(state: SimState, bag: Bag, to: BagState, location: string): void {
  const from = bag.state;
  const fromLocation = bag.location;
  bag.state = to;
  bag.location = location;
  bag.since = state.now;
  bag.history.push({ t: state.now, state: to, location });
  if (to === 'onBelt' || to === 'collected') {
    // 受取待ちグループの起床トリガー（passengers の睡眠署名が参照する）
    let m = bagWakeStore.get(state);
    if (!m) {
      m = new Map();
      bagWakeStore.set(state, m);
    }
    m.set(bag.paxGroupId, (m.get(bag.paxGroupId) ?? 0) + 1);
  }
  if (bagEventMode) bagTransitionHook(state, bag, from, fromLocation, to, location);
}

function addBag(state: SimState, g: PaxGroup, flightId: string, s: BagState, location: string, opts: { direction?: Bag['direction']; transferToFlightId?: string } = {}): Bag {
  const id = nextId(state, 'bg');
  const bag: Bag = {
    id,
    flightId,
    paxGroupId: g.id,
    direction: opts.direction ?? g.direction,
    state: s,
    location,
    since: state.now,
    loadedOn: null,
    history: [{ t: state.now, state: s, location }],
    ...(opts.transferToFlightId ? { transferToFlightId: opts.transferToFlightId } : {}),
  };
  state.bags[id] = bag;
  state.activeBags.push(id);
  (state.flightBags[flightId] ??= []).push(id);
  (state.groupBags[g.id] ??= []).push(id);
  if (bagEventMode && bag.state === 'checkedIn') {
    // コンベヤー待ちへ（出現順 = since の昇順に並ぶ。now は単調なため末尾追加でよい）
    bagRuntime(state).conveyor.push(id);
  }
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

/** 乗継グループの手荷物（フェーズ 4 §5.5）: 到着便の手荷物として作り、出発便への付け替え先を持たせる */
export function transferArrivalBags(sim: Simulation, g: PaxGroup, aircraftId: string, arrFlightId: string, depFlightId: string): void {
  for (let i = 0; i < g.bags; i++) {
    addBag(sim.state, g, arrFlightId, 'onAircraft', `aircraft:${aircraftId}`, { direction: 'arrival', transferToFlightId: depFlightId });
  }
}

/**
 * 乗継手荷物の付け替え（フェーズ 4 §5.5）: 搬送の完了時に受取所へ送らず、出発便の預け手荷物にする。
 * 付け替えは 1 回だけ（付け替え先が残っているものだけが対象）。便ごとの索引も付け替える。
 */
export function retagTransferBag(state: SimState, bag: Bag): void {
  if (!bag.transferToFlightId || bag.transferFromFlightId) return;
  const from = bag.flightId;
  const to = bag.transferToFlightId;
  const list = state.flightBags[from];
  if (list) {
    const i = list.indexOf(bag.id);
    if (i >= 0) list.splice(i, 1);
  }
  (state.flightBags[to] ??= []).push(bag.id);
  bag.flightId = to;
  bag.transferFromFlightId = from;
  delete bag.transferToFlightId;
  bag.direction = 'departure';
  moveBag(state, bag, 'checkedIn', `transfer:${from}`);
}

export function bagsOf(state: SimState, flightId: string, states?: readonly BagState[]): Bag[] {
  const list = (state.flightBags[flightId] ?? []).map((id) => state.bags[id]!);
  return states ? list.filter((b) => states.includes(b.state)) : list;
}

export function groupBagsOf(state: SimState, groupId: string): Bag[] {
  return (state.groupBags[groupId] ?? []).map((id) => state.bags[id]!);
}

// ---------------------------------------------------------------- イベント駆動化（性能改善 第4弾 PERF4-5）

/**
 * 手荷物のイベント駆動化（perf4-design.md §3.8）。
 * stepBaggage の毎 tick 全走査（コンベヤー・仕分け・ベルト・終端除去）を、
 * 状態ごとの索引で置き換える:
 * - コンベヤー: checkedIn はタイマー（since + CONVEYOR_SEC）。due 順キューから処理する
 * - 仕分け: 仕分け設備ごとの ID 順キュー。アキュムレータの計算は従来どおり毎 tick 行い、
 *   「ID 順に、1 秒以上経過したものを n 個まで」という従来の選択規則をそのまま再現する
 * - ベルト: 受取所ごとの atClaim キュー＋ベルト使用中の便の数。処理が要るのは
 *   到着・回収（便の枠が空く）・ベルト故障切替のあった受取所だけ
 * - 終端除去: 終端化した個数だけ数え、変わった tick の終わりにだけ従来の filter を行う
 * 索引は実行時状態（保存しない）。復元後は最初の stepBaggage で activeBags から再構築する。
 * キュー内の古い id は使用時に状態を検証して捨てる（遅延削除）。
 */
let bagEventMode = true;

/** テスト用: 手荷物のイベント経路の有効/無効（false で従来の全走査経路） */
export function setBagEventModeForTest(v: boolean): void {
  bagEventMode = v;
}
export function isBagEventMode(): boolean {
  return bagEventMode;
}

interface BagRuntime {
  /** checkedIn の bag id（due = since + CONVEYOR_SEC の昇順） */
  conveyor: string[];
  /** 仕分け設備 id → sorting 中の bag id（ID 順） */
  sorting: Map<string, string[]>;
  /** 受取所エリア id → atClaim の bag id（ID 順） */
  claimQueue: Map<string, string[]>;
  /** 受取所エリア id → (便 id → onBelt 中の個数) */
  beltFlights: Map<string, Map<string, number>>;
  /** ベルト再評価が必要な受取所エリア */
  beltDirty: Set<string>;
  /** 終端化したが activeBags に残っている個数 */
  finalsPending: number;
  initialized: boolean;
}

const bagRuntimeStore = new WeakMap<SimState, BagRuntime>();

const bagNum = (id: string): number => Number(id.slice(3));

function bagRuntime(state: SimState): BagRuntime {
  let rt = bagRuntimeStore.get(state);
  if (!rt) {
    rt = {
      conveyor: [],
      sorting: new Map(),
      claimQueue: new Map(),
      beltFlights: new Map(),
      beltDirty: new Set(),
      finalsPending: 0,
      initialized: false,
    };
    bagRuntimeStore.set(state, rt);
  }
  return rt;
}

/** ID 順を保って挿入する */
function insertBagId(list: string[], id: string): void {
  const n = bagNum(id);
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bagNum(list[mid]!) < n) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, id);
}

/** 復元直後など、索引が無い状態からの初期構築（activeBags の1回走査） */
function initBagRuntime(state: SimState): BagRuntime {
  const rt = bagRuntime(state);
  if (rt.initialized) return rt;
  rt.initialized = true;
  const conveyor: Bag[] = [];
  for (const id of state.activeBags) {
    const b = state.bags[id];
    if (!b) continue;
    if (BAG_FINAL_STATES.includes(b.state)) {
      rt.finalsPending++;
    } else if (b.state === 'checkedIn') {
      conveyor.push(b);
    } else if (b.state === 'sorting') {
      const sid = b.location.slice('sorter:'.length);
      (rt.sorting.get(sid) ?? rt.sorting.set(sid, []).get(sid)!).push(id);
    } else if (b.state === 'atClaim') {
      const area = b.location.slice('claim:'.length);
      (rt.claimQueue.get(area) ?? rt.claimQueue.set(area, []).get(area)!).push(id);
      rt.beltDirty.add(area);
    } else if (b.state === 'onBelt') {
      const area = b.location.slice('belt:'.length);
      const m = rt.beltFlights.get(area) ?? rt.beltFlights.set(area, new Map()).get(area)!;
      m.set(b.flightId, (m.get(b.flightId) ?? 0) + 1);
    }
  }
  conveyor.sort((a, b) => a.since - b.since || bagNum(a.id) - bagNum(b.id));
  rt.conveyor = conveyor.map((b) => b.id);
  return rt;
}

/** moveBag の遷移通知: 索引への追加・ベルト占有・終端数だけを維持する（除去は遅延） */
function bagTransitionHook(state: SimState, bag: Bag, from: BagState, fromLocation: string, to: BagState, location: string): void {
  const rt = bagRuntime(state);
  if (!rt.initialized) initBagRuntime(state);
  if (from === 'onBelt') {
    const area = fromLocation.slice('belt:'.length);
    const m = rt.beltFlights.get(area);
    if (m) {
      const left = (m.get(bag.flightId) ?? 0) - 1;
      if (left <= 0) {
        m.delete(bag.flightId);
        rt.beltDirty.add(area); // 便の枠が空いた → 待ち手荷物を流せる可能性がある
      } else {
        m.set(bag.flightId, left);
      }
    }
  }
  if (to === 'onBelt') {
    const area = location.slice('belt:'.length);
    const m = rt.beltFlights.get(area) ?? rt.beltFlights.set(area, new Map()).get(area)!;
    m.set(bag.flightId, (m.get(bag.flightId) ?? 0) + 1);
  } else if (to === 'checkedIn') {
    rt.conveyor.push(bag.id); // since = now（最大）なので末尾追加で due 順を保つ
  } else if (to === 'atClaim') {
    const area = location.slice('claim:'.length);
    insertBagId(rt.claimQueue.get(area) ?? rt.claimQueue.set(area, []).get(area)!, bag.id);
    rt.beltDirty.add(area);
  }
  if (BAG_FINAL_STATES.includes(to) && !BAG_FINAL_STATES.includes(from)) rt.finalsPending++;
}

/** ベルト設備の故障・復旧は、その受取所の再評価トリガーになる */
function noteBeltEquipment(state: SimState, key: string): void {
  if (!bagEventMode || !key.startsWith('belt:')) return;
  bagRuntime(state).beltDirty.add(key.slice('belt:'.length));
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
  noteBeltEquipment(state, key);
}

// ---------------------------------------------------------------- 1ティック

export function stepBaggage(sim: Simulation): void {
  if (bagEventMode) {
    stepBaggageEvent(sim);
    return;
  }
  stepBaggageLegacy(sim);
}

/** イベント経路（PERF4-5）。設備タイマーと仕分けアキュムレータは毎 tick、他は索引で処理する */
function stepBaggageEvent(sim: Simulation): void {
  const { state, ctx } = sim;
  const rt = initBagRuntime(state);
  for (const [key, e] of Object.entries(state.equipment)) {
    if (e.broken) {
      e.downSec++;
      if (e.repairUntil !== null && state.now >= e.repairUntil) setEquipmentBroken(sim, key, false);
    }
  }
  const sorter = ctx.sorters[0];
  // コンベヤー → 仕分け設備（due 順キューの先頭から。due でないものが先頭なら後ろも due でない）
  const conv = rt.conveyor;
  let cut = 0;
  while (cut < conv.length) {
    const b = state.bags[conv[cut]!];
    if (!b) {
      cut++;
      continue;
    }
    // 既に checkedIn でないものは二度と戻らない（戻る場合は付け替えで新規に追加される）ため捨てる
    if (b.state !== 'checkedIn') {
      cut++;
      continue;
    }
    if (state.now - b.since < CONVEYOR_SEC) break;
    cut++;
    if (sorter) {
      moveBag(state, b, 'sorting', `sorter:${sorter.id}`);
      insertBagId(rt.sorting.get(sorter.id) ?? rt.sorting.set(sorter.id, []).get(sorter.id)!, b.id);
    } else if (b.location !== 'conveyor:noSorter') {
      b.location = 'conveyor:noSorter';
      b.history.push({ t: state.now, state: b.state, location: b.location });
    }
  }
  if (cut > 0) rt.conveyor = conv.slice(cut);
  // 仕分け: アキュムレータは従来どおり毎 tick 更新し、設備ごとの ID 順キューから選ぶ
  for (const s of ctx.sorters) {
    if (isDown(state, s.id)) continue;
    const acc = (state.sorterAcc[s.id] ?? 0) + s.capacityPerMin / 60;
    let n = Math.floor(acc);
    state.sorterAcc[s.id] = acc - n;
    const q = rt.sorting.get(s.id);
    if (q && q.length > 0) {
      const loc = `sorter:${s.id}`;
      const survivors: string[] = [];
      let i = 0;
      for (; i < q.length; i++) {
        if (n <= 0) break; // 従来も n が尽きた時点で走査をやめる
        const id = q[i]!;
        const b = state.bags[id];
        if (!b || b.state !== 'sorting' || b.location !== loc) continue; // 遅延削除
        if (state.now - b.since < 1) {
          survivors.push(id);
          continue;
        }
        moveBag(state, b, 'madeUp', `makeup:${s.id}`);
        n--;
      }
      for (; i < q.length; i++) survivors.push(q[i]!);
      rt.sorting.set(s.id, survivors);
    }
    if (n === 0 && acc >= 1) state.sorterAcc[s.id] = Math.min(state.sorterAcc[s.id]!, 1);
  }
  // 受取所: 再評価が必要な受取所だけ、待ち手荷物を ID 順（受取所横断）に流す
  if (rt.beltDirty.size > 0) {
    const areas = [...rt.beltDirty];
    rt.beltDirty.clear();
    const areaSet = new Set(areas);
    const beltsByArea = new Map<string, number>();
    for (const area of areas) {
      beltsByArea.set(
        area,
        isDown(state, `belt:${area}`) ? 0 : Math.max(0, Number(ctx.layout.terminalAreas[area]?.props.belts ?? 0)),
      );
    }
    const cand: string[] = [];
    for (const area of areas) {
      const q = rt.claimQueue.get(area);
      if (q) cand.push(...q);
    }
    cand.sort((a, b) => bagNum(a) - bagNum(b));
    for (const id of cand) {
      const b = state.bags[id];
      if (!b || b.state !== 'atClaim') continue;
      const area = b.location.slice('claim:'.length);
      if (!areaSet.has(area)) continue;
      const flights = rt.beltFlights.get(area) ?? rt.beltFlights.set(area, new Map()).get(area)!;
      if ((flights.get(b.flightId) ?? 0) > 0 || flights.size < beltsByArea.get(area)!) {
        moveBag(state, b, 'onBelt', `belt:${area}`);
        const f = state.flights[b.flightId]!;
        f.pax.bagsReadyAt ??= state.now;
      }
    }
    for (const area of areas) {
      const q = rt.claimQueue.get(area);
      if (q) {
        rt.claimQueue.set(
          area,
          q.filter((id) => {
            const b = state.bags[id];
            return b !== undefined && b.state === 'atClaim' && b.location === `claim:${area}`;
          }),
        );
      }
    }
  }
  // 終端除去は、終端化が起きた tick の終わりにだけ従来の filter を行う
  if (rt.finalsPending > 0) {
    state.activeBags = state.activeBags.filter((id) => !BAG_FINAL_STATES.includes(state.bags[id]!.state));
    rt.finalsPending = 0;
  }
}

function stepBaggageLegacy(sim: Simulation): void {
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
    } else if ((paxGone || finalCutoff) && (['checkedIn', 'sorting', 'madeUp'].includes(b.state) || (g.state === 'cancelled' && b.state === 'onCart'))) {
      // 欠航では積み込み作業が走らないので、搬送中（onCart）の手荷物も終端にする
      moveBag(state, b, 'leftBehind', b.location);
      // 欠航（旅客グループが cancelled）の手荷物は終端状態にするだけで、積み残しの集計・罰金には数えない（欠航の補償は別。1-09 / B-1）。
      // 乗り遅れ（missed）は従来どおり数える。
      if (g.state !== 'cancelled') {
        state.groundStats.bagsLeftBehind++;
        left++;
      }
      if (!paxGone) onBagLeftBehind(sim);
    }
  }
  return left;
}
