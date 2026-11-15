import { TILE_M } from '../model/catalog';
import { sortedValues } from '../model/ids';
import { otherEnd } from '../airside/network';
import { resolveType } from './aircraftTypes';
import { checkStand } from '../aircraft/compat';
import { edgeIndexAt } from './routes';
import { MIN_GROUND_SEPARATION_M, TICK_SEC } from './rules';
import { APRON_BUS_CAPACITY } from './busRules';
import type { Simulation } from './simulation';
import { GROUND_MOVING_STATES, TERMINAL_STATES, type Aircraft, type AircraftState, type CrossingGrant, type SimState } from './types';

/** 横断中の機体の状態（経路上を地上走行している） */
const TAXIING_STATES: readonly AircraftState[] = ['vacating', 'taxiIn', 'docking', 'taxiOut', 'holdShort', 'lineUp'];

/** 機体が開いている横断の許可（crossing と heldCrossings）のうち、滑走路 rid を含むものを持つか */
function crossingHeld(ac: Aircraft, rid: string): boolean {
  if (!ac.route || !TAXIING_STATES.includes(ac.state)) return false;
  return openGrants(ac).some((c) => c.runwayId === rid || !!c.alsoRunwayIds?.includes(rid));
}

export function openGrants(ac: Aircraft): CrossingGrant[] {
  return [...(ac.heldCrossings ?? []), ...(ac.crossing ? [ac.crossing] : [])];
}

/**
 * 保存された運航状態の横断の占有の修復（復元時に checkInvariants の前に呼ぶ）。
 * 厳しくした R2 が拒否する占有（許可を持たない機体・地上走行でない機体の占有）を解放し、
 * 地上走行でない機体の許可を消す。整合した状態は何も変えない。戻り値は修復した項目の説明。
 */
export function repairCrossingState(state: SimState): string[] {
  const fixed: string[] = [];
  // 1. 許可の修復を先に行う（一部しか自機が占有していない許可を取り消すと、残りの占有が持ち主のない状態になるため、
  //    占有の解放はこのあとに行う）
  for (const ac of Object.values(state.aircraft)) {
    const taxiing = !!ac.route && TAXIING_STATES.includes(ac.state);
    if (!taxiing && (ac.crossing || ac.heldCrossings)) {
      fixed.push(`機体 ${ac.id} の横断の許可を取り消しました`);
      ac.crossing = null;
      delete ac.heldCrossings;
      continue;
    }
    // R2b: 許可に書かれた滑走路の占有が自機でなければ、その許可を取り消す
    const owns = (c: CrossingGrant): boolean => [c.runwayId, ...(c.alsoRunwayIds ?? [])].every((id) => state.runways[id]?.occupant?.aircraftId === ac.id);
    if (ac.heldCrossings) {
      const kept = ac.heldCrossings.filter(owns);
      if (kept.length < ac.heldCrossings.length) fixed.push(`機体 ${ac.id} の保留中の横断の許可を取り消しました`);
      if (kept.length === 0) delete ac.heldCrossings;
      else ac.heldCrossings = kept;
    }
    if (ac.crossing && !owns(ac.crossing)) {
      fixed.push(`機体 ${ac.id} の横断の許可を取り消しました`);
      ac.crossing = null;
    }
  }
  // 2. 許可のない横断の占有（R2）を解放する
  for (const [rid, rs] of Object.entries(state.runways)) {
    if (rs.occupant?.purpose !== 'crossing') continue;
    const ac = state.aircraft[rs.occupant.aircraftId];
    if (!ac || !crossingHeld(ac, rid)) {
      fixed.push(`滑走路 ${rid} の横断の占有（${rs.occupant.aircraftId}）を解放しました`);
      rs.occupant = null;
    }
  }
  return fixed;
}

/**
 * 状態と占有情報の整合性チェック。テストでは毎ティック実行し、違反があれば失敗させる。
 * 戻り値は違反内容の文字列（空なら整合）。
 */
export function checkInvariants(sim: Simulation): string[] {
  const { state, ctx } = sim;
  const out: string[] = [];
  const aircraft = sortedValues(state.aircraft);
  const active = (s: AircraftState) => !TERMINAL_STATES.includes(s) && s !== 'scheduled';

  // S: スポットは同時に1機まで。割り当てと機体側の参照が一致する
  const standOwners = new Map<string, string[]>();
  for (const ac of aircraft) {
    if (ac.standId) standOwners.set(ac.standId, [...(standOwners.get(ac.standId) ?? []), ac.id]);
  }
  for (const [stand, owners] of standOwners) {
    if (owners.length > 1) out.push(`S1 スポット ${stand} が複数機に割り当て: ${owners.join(',')}`);
    if (state.standAssignments[stand] !== owners[0]) out.push(`S4 ${owners[0]} のスポット ${stand} が割り当て表と不一致`);
  }
  for (const [stand, acId] of Object.entries(state.standAssignments)) {
    const ac = state.aircraft[acId];
    if (!ac || !active(ac.state) || ac.standId !== stand) out.push(`S4 割り当て表 ${stand}→${acId} が不正`);
    const info = ctx.stands[stand];
    const t = ac ? resolveType(ctx.types, ac.typeId) : null;
    if (ac && info && t && !t.unresolved && checkStand(t, ctx.layout.stands[stand]!).reasons.some((r) => r === 'STAND_CLASS' || r === 'STAND_CODE_F')) {
      out.push(`S3 ${acId} が適合しないスポット ${stand} に割り当て`);
    }
    // D1 閉鎖中のスポットに、着陸前の機体を新しく割り当てない
    if (ac && (ac.state === 'inbound' || ac.state === 'holding') && state.closures.stands.includes(stand)) {
      out.push(`D1 ${acId} が閉鎖中のスポット ${stand} に割り当て`);
    }
  }

  // R: 滑走路の占有は高々1機（構造上1つ）。占有機の状態と一致する
  for (const [rid, rs] of Object.entries(state.runways)) {
    if (rs.occupant) {
      const ac = state.aircraft[rs.occupant.aircraftId];
      const ok =
        ac &&
        ((rs.occupant.purpose === 'landing' && (ac.state === 'landing' || ac.state === 'vacating')) ||
          (rs.occupant.purpose === 'takeoff' && (ac.state === 'lineUp' || ac.state === 'takeoff')) ||
          (rs.occupant.purpose === 'crossing' && crossingHeld(ac, rid)));
      if (!ok) out.push(`R2 滑走路 ${rid} の占有 ${rs.occupant.aircraftId}(${rs.occupant.purpose}) と機体状態が不一致`);
    }
    if (rs.booking) {
      const ac = state.aircraft[rs.booking.aircraftId];
      if (!ac || ac.state !== 'approach') out.push(`R3 滑走路 ${rid} の進入予約 ${rs.booking.aircraftId} が進入中でない`);
    }
  }
  // R6: 交差する滑走路（従属運用）は、2 本が同時に離着陸で占有されない（自由形が関与する交差だけ。従来形だけなら空ループ）
  for (const c of ctx.crossings) {
    const oa = state.runways[c.a]?.occupant;
    const ob = state.runways[c.b]?.occupant;
    if (oa && ob && oa.purpose !== 'crossing' && ob.purpose !== 'crossing') {
      out.push(`R6 交差する滑走路 ${c.a} と ${c.b} が同時に使用中（${oa.aircraftId}, ${ob.aircraftId}）`);
    }
  }
  // R2b: 開いている横断の許可に書かれた滑走路は、すべてその機体が占有している
  for (const ac of aircraft) {
    for (const c of openGrants(ac)) {
      for (const id of [c.runwayId, ...(c.alsoRunwayIds ?? [])]) {
        const o = state.runways[id]?.occupant;
        if (o?.aircraftId !== ac.id || o.purpose !== 'crossing') out.push(`R2b 機体 ${ac.id} の横断の許可の滑走路 ${id} を自機が占有していない`);
      }
    }
  }
  for (const ac of aircraft) {
    const needs: Partial<Record<AircraftState, string>> = {
      landing: 'landing',
      lineUp: 'takeoff',
      takeoff: 'takeoff',
    };
    const purpose = needs[ac.state];
    if (purpose) {
      const rs = ac.runwayId ? state.runways[ac.runwayId] : undefined;
      if (rs?.occupant?.aircraftId !== ac.id) out.push(`R1 ${ac.id}(${ac.state}) が滑走路を占有していない`);
    }
    if (ac.state === 'approach') {
      const rs = ac.runwayId ? state.runways[ac.runwayId] : undefined;
      if (rs?.booking?.aircraftId !== ac.id) out.push(`R3 ${ac.id} が進入予約なしで進入中`);
    }
  }

  // T: 予約の保持者は有効な機体。走行中の機体は現在のエッジと次のノードを予約している
  for (const [k, acId] of [...Object.entries(state.nodeReservations), ...Object.entries(state.edgeReservations)]) {
    const ac = state.aircraft[acId];
    if (!ac || !active(ac.state)) out.push(`T0 ${k} の予約者 ${acId} が無効`);
  }
  for (const ac of aircraft) {
    const r = ac.route;
    if (!r) continue;
    // 経路の連続性: エッジは隣り合うノードを結ぶ
    for (let i = 0; i < r.edges.length; i++) {
      const e = ctx.network.edges[r.edges[i]!];
      if (!e || otherEnd(e, r.nodes[i]!) !== r.nodes[i + 1] || (e.from !== r.nodes[i] && e.to !== r.nodes[i])) {
        out.push(`T2 ${ac.id} の経路 ${i} 番目のエッジ ${r.edges[i]} が接続していない`);
      }
    }
    if (!['taxiIn', 'taxiOut', 'docking', 'vacating', 'holdShort', 'lineUp'].includes(ac.state)) continue;
    const i = edgeIndexAt(r, ac.dist);
    const e = ctx.network.edges[r.edges[i]!]!;
    if (e.kind === 'taxiway' && state.edgeReservations[e.id] !== ac.id) out.push(`T1 ${ac.id} が予約なしでエッジ ${e.id} を走行`);
    const next = r.nodes[i + 1]!;
    if (ctx.network.nodes[next]!.kind !== 'stand' && ac.dist > r.cum[i]! && state.nodeReservations[next] !== ac.id) {
      out.push(`T1 ${ac.id} が次のノード ${next} を予約していない`);
    }
  }

  // 地上の機体間距離
  const moving = aircraft.filter((a) => GROUND_MOVING_STATES.includes(a.state) && a.state !== 'takeoff');
  for (let i = 0; i < moving.length; i++) {
    for (let j = i + 1; j < moving.length; j++) {
      const d = Math.hypot(moving[i]!.x - moving[j]!.x, moving[i]!.y - moving[j]!.y) * TILE_M;
      if (d < MIN_GROUND_SEPARATION_M) out.push(`C1 ${moving[i]!.id} と ${moving[j]!.id} の距離 ${d.toFixed(1)}m`);
    }
  }

  // 瞬間移動の禁止: 地上での1ティックの移動量は最高速度以内
  for (const ac of aircraft) {
    // 状態が変わったティック（空中→接地など）は除く
    if (!GROUND_MOVING_STATES.includes(ac.state) || ac.stateSince >= state.now - TICK_SEC) continue;
    const moved = Math.hypot(ac.x - ac.px, ac.y - ac.py) * TILE_M;
    const vmax = ac.state === 'takeoff' || ac.state === 'landing' ? 100 : 20;
    if (moved > vmax * TICK_SEC + 1e-6) out.push(`M1 ${ac.id}(${ac.state}) が1ティックで ${moved.toFixed(1)}m 移動`);
  }
  out.push(...checkPaxInvariants(sim, false));
  out.push(...checkGroundInvariants(sim, false));
  if (state.bus) out.push(...checkBusInvariants(sim));
  return out;
}

/**
 * ランプバスの整合性（state.bus があるときだけ）。
 * BU1 乗車中（onBus）のグループは、ちょうど 1 つの未完了の運行の groups にいて busTrip が一致 /
 * BU2 運行の乗車人数 = グループの人数の合計 ≤ 定員 /
 * BU3 配車済みの運行のバスの trip が運行 ID と一致し、1 台が 2 つの運行を持たない /
 * BU4 バス待ち・乗車中のグループの便は p.bus を持ち、到着便の p.gateId はバスゲート
 * （故障したバスの運行の組み替えは次のティックの stepApronBuses が行うので、故障中のバスが運行を持つ一瞬は許す）
 */
export function checkBusInvariants(sim: Simulation): string[] {
  const { state, ctx } = sim;
  const bus = state.bus!;
  const out: string[] = [];
  const owner = new Map<string, string>();
  const busOwner = new Map<string, string>();
  for (const id of bus.active) {
    const t = bus.trips[id];
    if (!t) {
      out.push(`BU1 運行 ${id} が存在しない`);
      continue;
    }
    let sum = 0;
    for (const gid of t.groups) {
      const g = state.paxGroups[gid];
      if (!g) {
        out.push(`BU1 運行 ${t.id} のグループ ${gid} が存在しない`);
        continue;
      }
      sum += g.count;
      if (g.busTrip !== t.id) out.push(`BU1 ${gid} の busTrip（${g.busTrip ?? '-'}）が運行 ${t.id} と不一致`);
      if (g.state === 'onBus') {
        if (owner.has(gid)) out.push(`BU1 ${gid} が運行 ${owner.get(gid)} と ${t.id} に同時に乗車`);
        owner.set(gid, t.id);
      }
    }
    if (sum !== t.pax) out.push(`BU2 運行 ${t.id} の乗車人数 ${t.pax} ≠ グループ合計 ${sum}`);
    if (t.pax > APRON_BUS_CAPACITY) out.push(`BU2 運行 ${t.id} の乗車人数 ${t.pax} > 定員 ${APRON_BUS_CAPACITY}`);
    if (t.busId) {
      const u = state.units[t.busId];
      if (!u || u.trip !== t.id) out.push(`BU3 運行 ${t.id} のバス ${t.busId} の trip が不一致`);
      if (busOwner.has(t.busId)) out.push(`BU3 バス ${t.busId} が運行 ${busOwner.get(t.busId)} と ${t.id} を同時に担当`);
      busOwner.set(t.busId, t.id);
    } else if (t.phase === 'toPickup' || t.phase === 'loading' || t.phase === 'driving' || t.phase === 'unloading') {
      out.push(`BU3 運行 ${t.id}（${t.phase}）にバスが割り当てられていない`);
    }
  }
  for (const u of Object.values(state.units)) {
    if (u.kind === 'apronBus' && u.trip && !bus.active.includes(u.trip)) out.push(`BU3 バス ${u.id} が終了した運行 ${u.trip} を持っている`);
  }
  for (const gid of state.activePax) {
    const g = state.paxGroups[gid]!;
    if (g.state === 'onBus' && !owner.has(gid)) out.push(`BU1 ${gid} は乗車中だがどの運行にも含まれない`);
    if (g.state !== 'waitingBus' && g.state !== 'onBus') continue;
    const f = state.flights[g.flightId];
    if (!f?.pax.bus) out.push(`BU4 ${gid} はバス待ちだが便 ${g.flightId} が p.bus を持たない`);
    else if (g.direction === 'arrival' && !ctx.busGates.includes(f.pax.gateId ?? '')) out.push(`BU4 到着便 ${f.number} の p.gateId がバスゲートでない`);
  }
  return out;
}

/**
 * 地上支援・手荷物の整合性。
 * G1 作業員・車両は同時に1つの作業だけ / G2 作業中の作業は先行作業が完了している /
 * G3 出発準備完了以降の機体は全作業が完了している /
 * B1 手荷物は自便の機体にだけ1回積載 / B2 出発・到着の取り違えがない / B3 グループの手荷物数が一致
 */
export function checkGroundInvariants(sim: Simulation, full: boolean): string[] {
  const { state } = sim;
  const out: string[] = [];
  const owner = new Map<string, string>();
  for (const id of full ? Object.keys(state.tasks) : state.activeTasks) {
    const t = state.tasks[id]!;
    for (const u of t.units) {
      if (owner.has(u)) out.push(`G1 ${u} が ${owner.get(u)} と ${t.id} に同時に割り当て`);
      owner.set(u, t.id);
      if (state.units[u]?.taskId !== t.id) out.push(`G1 ${u} の割り当て先が ${t.id} と不一致`);
    }
    if ((t.state === 'inProgress' || t.state === 'dispatched') && !t.deps.every((k) => (state.aircraftTasks[t.aircraftId] ?? []).some((x) => state.tasks[x]!.kind === k && state.tasks[x]!.state === 'done'))) {
      out.push(`G2 ${t.id}(${t.kind}) が先行作業の完了前に開始`);
    }
  }
  for (const u of Object.values(state.units)) {
    if (u.taskId && !state.tasks[u.taskId]?.units.includes(u.id)) out.push(`G1 ${u.id} の作業 ${u.taskId} に自分が含まれない`);
    if (u.status === 'broken' && u.taskId) out.push(`G1 故障中の ${u.id} が作業 ${u.taskId} に割り当て`);
  }
  for (const ac of Object.values(state.aircraft)) {
    if (!['readyForPushback', 'pushback', 'taxiOut', 'holdShort', 'lineUp', 'takeoff', 'departed'].includes(ac.state)) continue;
    const tasks = (state.aircraftTasks[ac.id] ?? []).map((id) => state.tasks[id]!).filter((t) => t.kind !== 'pushback');
    if (tasks.length === 0 || tasks.some((t) => t.state !== 'done')) out.push(`G3 ${ac.id}(${ac.state}) の地上作業が未完了`);
  }
  const bagIds = full ? Object.keys(state.bags) : state.activeBags;
  for (const id of bagIds) {
    const b = state.bags[id]!;
    const f = state.flights[b.flightId];
    if (!f || (f.direction === 'departure') !== (b.direction === 'departure')) out.push(`B2 ${b.id} の便 ${b.flightId} と方向が不一致`);
    const depStates = ['checkedIn', 'sorting', 'madeUp', 'onCart', 'loaded', 'leftBehind', 'offloaded'];
    if (b.direction === 'arrival' && ['checkedIn', 'sorting', 'madeUp', 'loaded', 'leftBehind', 'offloaded'].includes(b.state)) out.push(`B2 到着手荷物 ${b.id} が出発の状態 ${b.state}`);
    if (b.direction === 'departure' && !depStates.includes(b.state)) out.push(`B2 出発手荷物 ${b.id} が到着の状態 ${b.state}`);
  }
  if (full) {
    for (const b of Object.values(state.bags)) {
      const f = state.flights[b.flightId]!;
      const loads = b.history.filter((h) => h.state === 'loaded').length;
      if (loads > 1) out.push(`B1 ${b.id} が ${loads} 回積載`);
      if (b.state === 'loaded' && b.loadedOn !== f.aircraftId) out.push(`B1 ${b.id} が別の機体 ${b.loadedOn} に積載`);
      if (b.state !== 'loaded' && b.loadedOn !== null) out.push(`B1 ${b.id} は積載済みでないのに機体を参照`);
    }
    for (const g of Object.values(state.paxGroups)) {
      const n = (state.groupBags[g.id] ?? []).length;
      if (n !== 0 && n !== g.bags) out.push(`B3 ${g.id} の手荷物 ${n} 個 ≠ ${g.bags} 個`);
    }
  }
  return out;
}

/**
 * 旅客の整合性。full = false のときは処理中の便・グループだけを見る（毎ティック用）。
 * P1 便の搭乗・乗り遅れ・退出人数 = グループの合計 / P2 搭乗済みは自便のゲートを通過している /
 * P3 待ち行列の所属と処理中グループ数 ≤ 窓口数 / P4 保安検査を通らずに出発区域にいない / P5 所在エリアが存在する
 */
export function checkPaxInvariants(sim: Simulation, full: boolean): string[] {
  const { state, ctx } = sim;
  const out: string[] = [];
  for (const f of Object.values(state.flights)) {
    const p = f.pax;
    if (!p.generated) continue;
    if (!full && ((f.direction === 'departure' && p.boarding === 'closed') || (f.direction === 'arrival' && p.exited === p.deplaned))) continue;
    const groups = (state.flightPax[f.id] ?? []).map((id) => state.paxGroups[id]!);
    const sum = (pred: (g: (typeof groups)[number]) => boolean) => groups.filter(pred).reduce((s, g) => s + g.count, 0);
    if (f.direction === 'departure') {
      if (sum(() => true) !== p.booked) out.push(`P1 ${f.number} 予約 ${p.booked} ≠ グループ合計 ${sum(() => true)}`);
      if (sum((g) => g.state === 'boarded') !== p.boarded) out.push(`P1 ${f.number} 搭乗 ${p.boarded} ≠ 搭乗済みグループ ${sum((g) => g.state === 'boarded')}`);
      if (sum((g) => g.state === 'missed') !== p.missed) out.push(`P1 ${f.number} 乗り遅れ ${p.missed} ≠ グループ ${sum((g) => g.state === 'missed')}`);
      for (const g of groups) {
        if (g.state === 'boarded' && (!p.gateId || g.boardedGate !== p.gateId)) out.push(`P2 ${g.id} が自便のゲートを通らずに搭乗済み`);
      }
    } else {
      if (sum(() => true) !== p.deplaned) out.push(`P1 ${f.number} 降機 ${p.deplaned} ≠ グループ合計 ${sum(() => true)}`);
      if (sum((g) => g.state === 'exited') !== p.exited) out.push(`P1 ${f.number} 退出 ${p.exited} ≠ グループ ${sum((g) => g.state === 'exited')}`);
    }
  }
  for (const [key, fac] of Object.entries(state.facilities)) {
    const area = ctx.layout.terminalAreas[key];
    const cap = key.startsWith('gate:') ? 1 : Number(area?.props.counters ?? area?.props.lanes ?? area?.props.fixtures ?? area?.props.capacity ?? 0);
    if (fac.inService.length > cap) out.push(`P3 ${key} の処理中 ${fac.inService.length} > 窓口数 ${cap}`);
    for (const id of fac.queue) if (state.paxGroups[id]?.facility !== key) out.push(`P3 ${id} が ${key} の待ち行列にいるが所属が不一致`);
    for (const id of fac.inService) if (state.paxGroups[id]?.state !== 'inService') out.push(`P3 ${id} が ${key} で処理中だが状態が不一致`);
  }
  const ids = full ? Object.keys(state.paxGroups) : state.activePax;
  for (const id of ids) {
    const g = state.paxGroups[id]!;
    if (g.terminalLinkPaxAccumulated !== undefined &&
      (!Number.isInteger(g.terminalLinkPaxAccumulated) ||
        g.terminalLinkPaxAccumulated <= 0 ||
        g.terminalLinkPaxAccumulated >= g.count ||
        g.state !== 'waitingTransport' ||
        !g.terminalLinkWaitingId)) {
      out.push(`P7 ${g.id} の連絡設備能力予約が不正`);
    }
    if (g.area && !ctx.terminal.areas[g.area]) out.push(`P5 ${g.id} の所在エリア ${g.area} が存在しない`);
    const a = g.area ? ctx.terminal.areas[g.area] : undefined;
    if (g.terminalId && a && a.terminalId !== g.terminalId && g.targetTerminalId !== a.terminalId) {
      out.push(`P6 ${g.id} がターミナル ${g.terminalId} から別ターミナル ${a.terminalId} のエリア ${a.id} に入っている`);
    }
    if (g.terminalId && g.route.some((areaId) => {
      const terminalId = ctx.terminal.areas[areaId]?.terminalId;
      return terminalId !== g.terminalId && terminalId !== g.targetTerminalId;
    })) {
      out.push(`P6 ${g.id} の経路が割当て先ターミナル外へ出ている`);
    }
    if (g.facility?.startsWith('gate:')) {
      const gateId = g.facility.slice('gate:'.length);
      const gateTerminal = ctx.terminal.gates[gateId]?.terminalId;
      if (g.terminalId && gateTerminal && gateTerminal !== g.terminalId) out.push(`P6 ${g.id} が割当てターミナル外の搭乗口 ${gateId} を利用している`);
    } else if (g.facility && ctx.terminal.areas[g.facility]?.terminalId !== g.terminalId) {
      out.push(`P6 ${g.id} が割当てターミナル外の施設 ${g.facility} を利用している`);
    }
    const flight = state.flights[g.flightId];
    const gateId = flight?.direction === 'departure' ? flight.pax.gateId : null;
    const gateTerminal = gateId ? ctx.terminal.gates[gateId]?.terminalId : null;
    if (g.terminalId && gateTerminal && gateTerminal !== g.terminalId && gateTerminal !== g.targetTerminalId) {
      out.push(`P6 ${g.id} のターミナル ${g.terminalId} と便ゲート ${gateId} のターミナル ${gateTerminal} が不一致`);
    }
    if (g.direction === 'departure' && a && a.zone === 'departure' && a.kind !== 'security' && !g.securityCleared) {
      out.push(`P4 ${g.id} が保安検査を通らずに出発区域 ${a.id} にいる`);
    }
    if ((g.state === 'queuing' || g.state === 'boardingQueue') && !state.facilities[g.facility ?? '']?.queue.includes(g.id)) {
      out.push(`P3 ${g.id} は待ち状態だが待ち行列にいない`);
    }
  }
  return out;
}

