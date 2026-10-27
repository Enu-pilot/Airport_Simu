import { TILE_M } from '../model/catalog';
import { sortedValues } from '../model/ids';
import { otherEnd } from '../airside/network';
import { AIRCRAFT_TYPES } from './aircraftTypes';
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
    if (ac && info && sizeRank(AIRCRAFT_TYPES[ac.typeId].size) > sizeRank(info.size)) {
      out.push(`S3 ${acId} がサイズの合わないスポット ${stand} に割り当て`);
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
  return out;
}

const sizeRank = (s: 'S' | 'M' | 'L'): number => ({ S: 1, M: 2, L: 3 })[s];
