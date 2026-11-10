import { TILE_M } from '../model/catalog';
import { sortedValues } from '../model/ids';
import { otherEnd } from '../airside/network';
import { resolveType } from './aircraftTypes';
import { checkStand } from '../aircraft/compat';
import { edgeIndexAt } from './routes';
import { MIN_GROUND_SEPARATION_M, TICK_SEC } from './rules';
import type { Simulation } from './simulation';
import { GROUND_MOVING_STATES, TERMINAL_STATES, type AircraftState } from './types';

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
          (rs.occupant.purpose === 'crossing' && ac.crossing?.runwayId === rid));
      if (!ok) out.push(`R2 滑走路 ${rid} の占有 ${rs.occupant.aircraftId}(${rs.occupant.purpose}) と機体状態が不一致`);
    }
    if (rs.booking) {
      const ac = state.aircraft[rs.booking.aircraftId];
      if (!ac || ac.state !== 'approach') out.push(`R3 滑走路 ${rid} の進入予約 ${rs.booking.aircraftId} が進入中でない`);
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
    if (g.area && !ctx.terminal.areas[g.area]) out.push(`P5 ${g.id} の所在エリア ${g.area} が存在しない`);
    const a = g.area ? ctx.terminal.areas[g.area] : undefined;
    if (g.direction === 'departure' && a && a.zone === 'departure' && a.kind !== 'security' && !g.securityCleared) {
      out.push(`P4 ${g.id} が保安検査を通らずに出発区域 ${a.id} にいる`);
    }
    if ((g.state === 'queuing' || g.state === 'boardingQueue') && !state.facilities[g.facility ?? '']?.queue.includes(g.id)) {
      out.push(`P3 ${g.id} は待ち状態だが待ち行列にいない`);
    }
  }
  return out;
}

