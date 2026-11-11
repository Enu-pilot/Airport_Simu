import type { Simulation } from '../sim/simulation';
import { resolveType } from '../sim/aircraftTypes';
import { TURNAROUND_TASKS } from '../sim/tasks';
import { GROUND_MOVING_STATES, TERMINAL_STATES, type Aircraft, type TaskKind } from '../sim/types';

/**
 * 運営分析のための記録（docs/18_analytics.md）。シミュレーションの実際の状態から集める（推定値は含めない）。
 *
 * - 便ごとの記録（FlightRecord）: 機体が運航を終えた（出発完了・ダイバート・欠航）時点で1回だけ作る。
 * - 施設ごとの時間の記録: 毎ティック、滑走路の占有・スポットの割り当て・地上での停止を秒で数える。
 * 機種は機種ID（typeId）で記録するので、Boeing 777-300 と 777-300ER のような派生型を別々に集計できる。
 */

export interface FlightRecord {
  aircraftId: string;
  arrNumber: string;
  depNumber: string;
  airlineId: string | null;
  contractId: string | null;
  typeId: string;
  result: 'completed' | 'diverted' | 'cancelled';
  /** 運航不能・遅延の原因（待機理由・遅延理由） */
  causes: string[];
  arrRunway: string | null;
  depRunway: string | null;
  standId: string | null;
  gateId: string | null;
  arrScheduled: number;
  landedAt: number | null;
  blockIn: number | null;
  readyAt: number | null;
  blockOut: number | null;
  depScheduled: number;
  takeoffAt: number | null;
  /** 空中待機・地上走行（到着・出発）の時間（秒）と地上の移動距離（m）、地上での停止時間（秒） */
  airborneHoldSec: number;
  taxiInSec: number;
  taxiOutSec: number;
  groundDistM: number;
  groundStopSec: number;
  seats: number;
  paxBooked: number;
  paxBoarded: number;
  paxMissed: number;
  paxArrived: number;
  bagsLoaded: number;
  bagsLeft: number;
  /** 地上作業ごとの所要時間（開始〜完了、秒）と停止の合計（秒） */
  taskSec: Partial<Record<TaskKind, number>>;
  taskBlockedSec: number;
  /** 空港の収入のうちこの便に帰属するもの（着陸料・駐機料・使用料・地上支援料、cr）。会社なしの運航は 0 */
  revenue: number;
  /** 影響した障害（ID） */
  disruptions: string[];
}

export interface AnalyticsState {
  version: 1;
  records: FlightRecord[];
  /** 記録済みの機体 */
  recorded: Record<string, true>;
  /** 滑走路ごとの占有時間（秒）・離着陸回数・その滑走路を待った時間（秒） */
  runways: Record<string, { busySec: number; ops: number; waitSec: number }>;
  /** スポットごとの割り当て時間（秒）と回数 */
  stands: Record<string, { busySec: number; turns: number }>;
  /** 誘導路ノードごとの、地上で止まって待った時間（秒、機体・秒） */
  nodes: Record<string, number>;
  /** 機体ごとの途中経過（記録を作るまで） */
  live: Record<string, { airborneHoldSec: number; groundDistM: number; groundStopSec: number; revenue: number; disruptions: string[] }>;
  /** 集計の開始時刻 */
  since: number;
}

export function createAnalytics(now: number): AnalyticsState {
  return { version: 1, records: [], recorded: {}, runways: {}, stands: {}, nodes: {}, live: {}, since: now };
}

const liveOf = (a: AnalyticsState, id: string) => (a.live[id] ??= { airborneHoldSec: 0, groundDistM: 0, groundStopSec: 0, revenue: 0, disruptions: [] });

/** 収入を便に帰属させる（economy/ops.ts から呼ぶ） */
export function attributeRevenue(sim: Simulation, aircraftId: string, amount: number): void {
  liveOf(sim.state.analytics, aircraftId).revenue += amount;
}

/** 毎ティックの記録（シミュレーションの状態を読むだけで、変更しない） */
export function stepAnalytics(sim: Simulation): void {
  const { state, ctx } = sim;
  const a = state.analytics;
  for (const [rid, rs] of Object.entries(state.runways)) {
    const r = (a.runways[rid] ??= { busySec: 0, ops: 0, waitSec: 0 });
    if (rs.occupant) r.busySec++;
  }
  for (const sid of Object.keys(state.standAssignments)) (a.stands[sid] ??= { busySec: 0, turns: 0 }).busySec++;
  for (const ac of Object.values(state.aircraft)) {
    if (TERMINAL_STATES.includes(ac.state)) continue;
    if (ac.state === 'scheduled') continue;
    const live = liveOf(a, ac.id);
    if (ac.state === 'holding') {
      live.airborneHoldSec++;
      if (ac.runwayId) (a.runways[ac.runwayId] ??= { busySec: 0, ops: 0, waitSec: 0 }).waitSec++;
    }
    if (GROUND_MOVING_STATES.includes(ac.state) && ac.state !== 'takeoff' && ac.state !== 'landing') {
      live.groundDistM += ac.speed;
      if (ac.speed === 0 && ac.route) {
        live.groundStopSec++;
        if (ac.state === 'holdShort' && ac.runwayId) (a.runways[ac.runwayId] ??= { busySec: 0, ops: 0, waitSec: 0 }).waitSec++;
        // 停止位置に最も近い経路上のノード
        const r = ac.route;
        let k = 0;
        while (k + 1 < r.cum.length && r.cum[k + 1]! <= ac.dist) k++;
        const node = r.nodes[Math.min(r.nodes.length - 1, k + 1)]!;
        if (ctx.network.nodes[node]) a.nodes[node] = (a.nodes[node] ?? 0) + 1;
      }
    }
  }
  for (const ac of Object.values(state.aircraft)) {
    if (!TERMINAL_STATES.includes(ac.state) || a.recorded[ac.id]) continue;
    a.recorded[ac.id] = true;
    a.records.push(buildRecord(sim, ac));
  }
}

function buildRecord(sim: Simulation, ac: Aircraft): FlightRecord {
  const { state, ctx } = sim;
  const a = state.analytics;
  const arr = state.flights[ac.arrivalFlightId]!;
  const dep = state.flights[ac.departureFlightId]!;
  const live = liveOf(a, ac.id);
  const tasks = (state.aircraftTasks[ac.id] ?? []).map((id) => state.tasks[id]!);
  const taskSec: FlightRecord['taskSec'] = {};
  for (const t of tasks) {
    if (t.state === 'done' && t.startedAt !== null && t.doneAt !== null && TURNAROUND_TASKS.includes(t.kind)) taskSec[t.kind] = t.doneAt - t.startedAt;
  }
  const bags = (state.flightBags[dep.id] ?? []).map((id) => state.bags[id]!);
  const standId = arr.standId ?? dep.standId;
  if (standId && arr.block !== null) (a.stands[standId] ??= { busySec: 0, turns: 0 }).turns++;
  for (const rid of [arr.actual !== null ? arr.runwayId : null, dep.actual !== null ? dep.runwayId : null]) {
    if (rid) (a.runways[rid] ??= { busySec: 0, ops: 0, waitSec: 0 }).ops++;
  }
  const result: FlightRecord['result'] = ac.state === 'departed' ? 'completed' : ac.state === 'diverted' ? 'diverted' : 'cancelled';
  const causes = [...new Set([...arr.delayCauses, ...dep.delayCauses, ...(ac.holdReason && result !== 'completed' ? [`hold:${ac.holdReason}`] : [])])];
  const rec: FlightRecord = {
    aircraftId: ac.id,
    arrNumber: arr.number,
    depNumber: dep.number,
    airlineId: dep.airlineId,
    contractId: dep.contractId,
    typeId: ac.typeId,
    result,
    causes,
    arrRunway: arr.actual !== null ? arr.runwayId : null,
    depRunway: dep.actual !== null ? dep.runwayId : null,
    standId,
    gateId: dep.pax.gateId ?? (standId ? (ctx.standGate[standId] ?? null) : null),
    arrScheduled: arr.scheduled,
    landedAt: arr.actual,
    blockIn: arr.block,
    readyAt: dep.readyAt,
    blockOut: dep.block,
    depScheduled: dep.scheduled,
    takeoffAt: dep.actual,
    airborneHoldSec: live.airborneHoldSec,
    taxiInSec: arr.actual !== null && arr.block !== null ? arr.block - arr.actual : 0,
    taxiOutSec: dep.block !== null && dep.actual !== null ? dep.actual - dep.block : 0,
    groundDistM: Math.round(live.groundDistM),
    groundStopSec: live.groundStopSec,
    seats: dep.seats ?? resolveType(ctx.types, ac.typeId).seats,
    paxBooked: dep.pax.booked,
    paxBoarded: dep.pax.boarded,
    paxMissed: dep.pax.missed,
    paxArrived: arr.pax.deplaned,
    bagsLoaded: bags.filter((b) => b.state === 'loaded').length,
    bagsLeft: bags.filter((b) => b.state === 'leftBehind').length,
    taskSec,
    taskBlockedSec: tasks.reduce((s, t) => s + t.blockedTotal, 0),
    revenue: Math.round(live.revenue),
    disruptions: live.disruptions,
  };
  delete a.live[ac.id];
  return rec;
}

/** 障害が機体に影響したことを記録する（sim/disruptions.ts から呼ぶ） */
export function noteDisruption(sim: Simulation, aircraftId: string, disruptionId: string): void {
  const live = liveOf(sim.state.analytics, aircraftId);
  if (!live.disruptions.includes(disruptionId)) live.disruptions.push(disruptionId);
}
