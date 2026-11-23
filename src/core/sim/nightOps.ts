import { compareIds, sortedValues } from '../model/ids';
import { isCityNightMovement, nextCityMovementTime } from '../economy/city';
import { resolveType, takeoffRollSec, type AircraftType } from './aircraftTypes';
import { holdShortOnRoute, makeRoute, routeLength } from './routes';
import { ENGINE_START_SEC, LINEUP_ALIGN_SEC, LINEUP_SPEED, NIGHT_DEP_MARGIN_SEC, PUSHBACK_SPEED, SEPARATION_SEC } from './rules';
import { departurePath, type Simulation } from './simulation';
import { weatherEffects } from './disruptions';
import type { Aircraft, Flight, Route } from './types';

/**
 * 夜間の運用（フェーズ 2、K-3・docs/40 R8〜R15。docs/design/impl_phase2_plan.md §3）。
 * city.nightOps があるときだけ使う。乱数・実時間は使わない。走査は ID 順。
 */

/** 朝の解放: 最初の離陸の目標を 06:00 からこの秒数だけ後ろにする */
const NIGHT_RELEASE_SLACK_SEC = 30;

const typeOf = (sim: Simulation, ac: Aircraft): AircraftType => resolveType(sim.ctx.types, ac.typeId);

/** 整列以降（滑走路手前の停止位置から浮揚まで）の秒数。departureBlocked の夜間判定と共通（値は 1-13 のまま） */
export function lineUpToAirborneSec(sim: Simulation, ac: Aircraft): number {
  const lineUpSec = ac.route ? Math.max(0, routeLength(ac.route) - ac.dist) / LINEUP_SPEED : 0;
  return lineUpSec + LINEUP_ALIGN_SEC + takeoffRollSec(typeOf(sim, ac));
}

/** 経路 r（スポット → 滑走路の進入ノード）の、プッシュバック開始から浮揚までの標準の秒数 */
function outSecOnRoute(sim: Simulation, ac: Aircraft, r: Route): number {
  const type = typeOf(sim, ac);
  const last = r.nodes.length - 1;
  const holdAt = r.cum[last]! - holdShortOnRoute(sim.ctx, r, last, -1);
  const pushback = Math.ceil(r.cum[1]! / PUSHBACK_SPEED);
  const taxi = Math.max(0, holdAt - r.cum[1]!) / Math.max(0.1, type.taxiSpeed * weatherEffects(sim.state).taxi);
  const lineUp = (r.cum[last]! - holdAt) / LINEUP_SPEED;
  return pushback + ENGINE_START_SEC + Math.ceil(taxi) + Math.ceil(lineUp) + LINEUP_ALIGN_SEC + takeoffRollSec(type);
}

const nominalCache = new WeakMap<Simulation['ctx'], Map<string, number>>();

/**
 * 標準の離陸までの秒数（プッシュバック開始 → 浮揚）。経路を渡さないときは、スポット → 使える入口の混雑を無視した最短経路を探す。
 * 結果はキャッシュする（保存しない。キー: スポット・機種の大きさ・codeF・滑走路の運用方向とモード・閉鎖中の誘導路。復元後は同じ値で作り直す）。
 * 経路がない（スポットなし・入口なし）ときは null。
 */
export function nominalOutSec(sim: Simulation, ac: Aircraft, path?: { nodes: string[]; edges: string[] }): number | null {
  if (path) return outSecOnRoute(sim, ac, makeRoute(sim.ctx, 'pushback', path.nodes, path.edges));
  if (!ac.standId) return null;
  const type = typeOf(sim, ac);
  const key = `${ac.standId}|${type.id}|${type.size}|${type.codeF ? 1 : 0}|${Object.keys(sim.state.runwayConfig).sort(compareIds).map((id) => `${id}:${sim.state.runwayConfig[id]!.direction}:${sim.state.runwayConfig[id]!.mode}`).join(',')}|${sim.state.closures.taxiways.join(',')}`;
  let cache = nominalCache.get(sim.ctx);
  if (!cache) nominalCache.set(sim.ctx, (cache = new Map()));
  const hit = cache.get(key);
  if (hit !== undefined) return hit < 0 ? null : hit;
  const p = departurePath(sim, ac, false);
  const v = p ? outSecOnRoute(sim, ac, makeRoute(sim.ctx, 'pushback', p.path.nodes, p.path.edges)) : -1;
  cache.set(key, v);
  return v < 0 ? null : v;
}

/** 同じ滑走路の離陸待ちの列の見込み（秒） */
function queueSec(sim: Simulation, ac: Aircraft): number {
  const rid = ac.runwayId;
  // 件数だけを数える（順序に依存しない）ので、ID 順の並べ替え・配列の確保はしない（性能改善 第8弾。結果は同一）
  let n = 0;
  const aircraft = sim.state.aircraft;
  for (const id in aircraft) {
    const a = aircraft[id]!;
    if (a.id !== ac.id && (a.state === 'holdShort' || a.state === 'taxiOut' || a.state === 'lineUp') && (!rid || a.runwayId === rid)) n++;
  }
  return n * SEPARATION_SEC.M.M;
}

/**
 * 予測離陸時刻 = プッシュバック開始 + 標準の離陸までの秒数 + 列の見込み + 余裕（NIGHT_DEP_MARGIN_SEC）。経路がなければ null。
 * path を渡せば実際の経路で、渡さなければ標準の経路で見積もる。
 */
export function predictTakeoffAt(sim: Simulation, ac: Aircraft, startAt: number, path?: { nodes: string[]; edges: string[] }): number | null {
  const out = nominalOutSec(sim, ac, path);
  if (out === null) return null;
  return startAt + out + queueSec(sim, ac) + NIGHT_DEP_MARGIN_SEC;
}

export const nightOpsOf = (sim: Simulation) => sim.company?.city?.nightOps ?? null;

const depOf = (sim: Simulation, ac: Aircraft): Flight => sim.state.flights[ac.departureFlightId]!;

/**
 * 夜間のスポット待機の解放時刻（プッシュバック開始）。朝の最初の運航時刻から、同じ朝に待機する出発の離陸を SEPARATION_SEC の間隔で並べる
 * （先に止めた便が先。決定の順は止めた時刻・機体 ID 順）。
 */
export function standReleaseAt(sim: Simulation, ac: Aircraft): number {
  const now = sim.state.now;
  const morning = nextCityMovementTime(now);
  const mine = nominalOutSec(sim, ac) ?? 0;
  // 最初の離陸の目標は 06:00 の少し後（滑走路手前に着いたとき、夜間待機の判定が確実に解けているように。標準の所要の見積もりは加減速を省くので実際は遅めになる）
  let takeoff = morning + NIGHT_RELEASE_SLACK_SEC;
  let prev: Aircraft | null = null;
  let prevTakeoff = -Infinity;
  // 最大の (離陸見込み, 機体 ID) を選ぶだけで走査順に依存しないため、並べ替えずに走査する（性能改善 第8弾。結果は同一）
  for (const o of Object.values(sim.state.aircraft)) {
    if (o.id === ac.id || (o.state !== 'turnaround' && o.state !== 'readyForPushback')) continue;
    const f = depOf(sim, o);
    if (f.nightHold?.kind !== 'stand' || f.nightHold.releaseAt < morning - 3600 || f.nightHold.releaseAt > morning + 12 * 3600) continue;
    const t = f.nightHold.releaseAt + (nominalOutSec(sim, o) ?? 0);
    if (t > prevTakeoff || (t === prevTakeoff && prev && compareIds(o.id, prev.id) > 0)) {
      prev = o;
      prevTakeoff = t;
    }
  }
  if (prev) takeoff = Math.max(morning + NIGHT_RELEASE_SLACK_SEC, prevTakeoff + SEPARATION_SEC[typeOf(sim, prev).size][typeOf(sim, ac).size]);
  return Math.max(now + 1, takeoff - mine);
}

/** 未離陸の出発で、予測離陸が制限開始の warnLeadMin 分前を越える便（R11。警告用）。夜間待機を決めた便は除く */
export interface NightRisk {
  flightId: string;
  aircraftId: string;
  predictedAt: number;
  /** 制限開始（22:00）までの余裕（秒。負なら越えている） */
  marginSec: number;
}

export function nightRiskFlights(sim: Simulation): NightRisk[] {
  const n = nightOpsOf(sim);
  if (!n) return [];
  const out: NightRisk[] = [];
  for (const ac of sortedValues(sim.state.aircraft)) {
    if (!['turnaround', 'readyForPushback', 'pushback', 'taxiOut', 'holdShort'].includes(ac.state)) continue;
    const f = depOf(sim, ac);
    if (f.nightHold || f.status === 'cancelled') continue;
    const startAt = ac.state === 'turnaround' || ac.state === 'readyForPushback' ? Math.max(sim.state.now, f.estimated) : sim.state.now;
    const rem = ac.state === 'pushback' || ac.state === 'taxiOut' || ac.state === 'holdShort' ? lineUpToAirborneSec(sim, ac) + (ac.route ? Math.max(0, routeLength(ac.route) - ac.dist) / Math.max(1, typeOf(sim, ac).taxiSpeed) : 0) : 0;
    const predicted = ac.state === 'turnaround' || ac.state === 'readyForPushback' ? predictTakeoffAt(sim, ac, startAt) : startAt + rem + NIGHT_DEP_MARGIN_SEC;
    if (predicted === null) continue;
    const dayStart = Math.floor(startAt / 86400) * 86400;
    const limit = dayStart + 22 * 3600 - n.warnLeadMin * 60;
    // 同じ日の夜（制限開始の warnLeadMin 分前以降）に予測離陸が入る便
    if (predicted > limit && startAt < dayStart + 22 * 3600 + 3600) out.push({ flightId: f.id, aircraftId: ac.id, predictedAt: predicted, marginSec: dayStart + 22 * 3600 - predicted });
  }
  return out;
}

/** 離陸待ちの列で、持ち越しの危険がある機体か（prioritizeAtRisk。予測離陸が制限開始の warnLeadMin 分前を越える） */
export function atRiskForNight(sim: Simulation, ac: Aircraft): boolean {
  const n = nightOpsOf(sim);
  if (!n) return false;
  return isCityNightMovement(sim.state.now + lineUpToAirborneSec(sim, ac) + n.warnLeadMin * 60);
}
