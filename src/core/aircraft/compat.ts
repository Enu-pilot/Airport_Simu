import { apronBusesOf, gateMode } from '../model/gates';
import { explicitPbbForGate } from '../model/boardingBridge';
import { sortedValues } from '../model/ids';
import { sizeAtLeast, type AirportLayout, type Facility, type Runway, type Stand } from '../model/types';
import { canAircraftUse, type AirsideNetwork } from '../airside/network';
import { runwayLengthM, runwayMaxSize } from '../layout/runway';
import { takeoffDistanceM, type AircraftType } from '../sim/aircraftTypes';
import { TURNAROUND_TASKS, taskNeeds } from '../sim/tasks';
import type { UnitKind } from '../sim/types';

/**
 * 機種と空港施設の適合性（docs/17_compatibility.md）。ゲームで採用する簡略化した判定ルールで、
 * 実際の空港運用・航空安全基準への適合を保証するものではない。
 *
 * 運航計画（economy/planning.ts）、運航（sim/simulation.ts のスポット・滑走路の割り当てと経路）、
 * 分析（analytics）はすべてこのモジュールの判定を使う（判定を重複して実装しない）。
 *
 * 判定結果: ok = 使える / ng = 使えない（理由つき）/ unknown = 判定に必要な情報が足りない（要確認）
 */

export type CompatStatus = 'ok' | 'ng' | 'unknown';

export type CompatReason =
  | 'TYPE_UNRESOLVED' // 機種データがない（未解決の機種ID）
  | 'NOT_OPERATIONAL' // 施設が運用中でない（計画・建設中・閉鎖中）
  | 'RUNWAY_CLASS' // 滑走路の区分（長さ・幅）が機体の区分に足りない
  | 'RUNWAY_TAKEOFF_LENGTH' // 離陸に必要な長さ（ゲーム値）が足りない
  | 'RUNWAY_LANDING_LENGTH' // 着陸に必要な長さ（ゲーム値）が足りない
  | 'RUNWAY_CODE_F' // コード F の機体には幅 60 m の滑走路が必要
  | 'STAND_CLASS' // スポットの区分が足りない
  | 'STAND_CODE_F' // コード F 対応の指定がないスポット
  | 'STAND_NOT_CONNECTED' // スポットが誘導路につながっていない
  | 'TAXIWAY_CLASS' // 誘導路の幅の区分が足りない
  | 'TAXIWAY_CODE_F' // コード F 対応の指定がない誘導路
  | 'GATE_NO_STAND' // ゲートにスポットが紐付いていない（判定不能）
  | 'GATE_BUS' // バスゲート: スポットに固定せず、リモートスポットの便をランプバスで運ぶ（情報）
  | 'GATE_STAND_NG' // 紐付いたスポットが使えない
  | 'GATE_UPPER_DECK' // 2階建て機の上階への搭乗橋がない（情報。機能H: upper の PBB があれば付かない）
  | 'GSE_NONE' // 必要な車両・作業員が空港に1台もいない
  | 'GSE_FEWER' // 必要数より少ない（時間がかかる。使える）
  | 'NO_FUEL_FARM' // 燃料施設がない
  | 'NO_ROUTE'; // 使える滑走路とスポットを結ぶ経路がない

export interface Check {
  id: string;
  status: CompatStatus;
  reasons: CompatReason[];
  /** 理由の補足（例: 不足している車両の種類） */
  detail?: string[];
}

/** 判定に使う滑走路の必要長（ゲーム値）: 離陸 = 浮揚までの距離 + 100 m、着陸 = 必要減速距離 + 200 m */
export function requiredRunwayM(type: AircraftType): { takeoff: number; landing: number } {
  return { takeoff: Math.round(takeoffDistanceM(type) + 100), landing: Math.round(type.landingRollM + 200) };
}

const unresolved = (id: string): Check => ({ id, status: 'unknown', reasons: ['TYPE_UNRESOLVED'] });

export function checkRunway(type: AircraftType, r: Runway): Check {
  if (type.unresolved) return unresolved(r.id);
  const reasons: CompatReason[] = [];
  if (r.buildState !== 'operational') reasons.push('NOT_OPERATIONAL');
  const max = runwayMaxSize(r);
  if (!max || !sizeAtLeast(max, type.size)) reasons.push('RUNWAY_CLASS');
  const len = runwayLengthM(r);
  const need = requiredRunwayM(type);
  if (len < need.takeoff) reasons.push('RUNWAY_TAKEOFF_LENGTH');
  if (len < need.landing) reasons.push('RUNWAY_LANDING_LENGTH');
  if (type.codeF && r.surfaceWidthM < 60) reasons.push('RUNWAY_CODE_F');
  return { id: r.id, status: reasons.length ? 'ng' : 'ok', reasons };
}

export function checkStand(type: AircraftType, s: Stand, net?: AirsideNetwork): Check {
  if (type.unresolved) return unresolved(s.id);
  const reasons: CompatReason[] = [];
  if (s.buildState !== 'operational') reasons.push('NOT_OPERATIONAL');
  if (!sizeAtLeast(s.size, type.size)) reasons.push('STAND_CLASS');
  if (type.codeF && !(s.size === 'L' && s.codeF)) reasons.push('STAND_CODE_F');
  if (net && !net.standLinks[s.id]) reasons.push('STAND_NOT_CONNECTED');
  return { id: s.id, status: reasons.length ? 'ng' : 'ok', reasons };
}

export function checkTaxiway(type: AircraftType, e: AirportLayout['taxiways'][string]): Check {
  if (type.unresolved) return unresolved(e.id);
  const reasons: CompatReason[] = [];
  if (e.buildState !== 'operational') reasons.push('NOT_OPERATIONAL');
  if (!sizeAtLeast(e.widthClass, type.size)) reasons.push('TAXIWAY_CLASS');
  if (type.codeF && !(e.widthClass === 'L' && e.codeF)) reasons.push('TAXIWAY_CODE_F');
  return { id: e.id, status: reasons.length ? 'ng' : 'ok', reasons };
}

export function checkGate(type: AircraftType, gate: Facility, layout: AirportLayout, net?: AirsideNetwork): Check {
  if (type.unresolved) return unresolved(gate.id);
  // バスゲートはスポットを持たない（プール方式）。運用中なら適合、理由として情報を付ける
  if (gateMode(gate) === 'bus') {
    return gate.buildState === 'operational' ? { id: gate.id, status: 'ok', reasons: ['GATE_BUS'] } : { id: gate.id, status: 'ng', reasons: ['NOT_OPERATIONAL'] };
  }
  const standId = typeof gate.props.standId === 'string' ? gate.props.standId : null;
  const stand = standId ? layout.stands[standId] : undefined;
  if (!stand) return { id: gate.id, status: 'unknown', reasons: ['GATE_NO_STAND'] };
  const reasons: CompatReason[] = [];
  if (gate.buildState !== 'operational') reasons.push('NOT_OPERATIONAL');
  if (checkStand(type, stand, net).status !== 'ok') reasons.push('GATE_STAND_NG');
  const status: CompatStatus = reasons.length ? 'ng' : 'ok';
  // 情報（使用は可）: 上階への搭乗橋は扱わない。
  // 機能H: 明示の搭乗橋（PBB）があるゲートでは PBB 側の理由として読む —
  // upper デッキの橋があれば上階も扱えるので理由は付けず、無ければ従来どおり付ける。
  // 明示 PBB が無いゲート（互換合成）は従来の判定と完全一致させる
  if (status === 'ok' && type.doubleDeck) {
    const explicit = explicitPbbForGate(layout, gate.id);
    if (explicit.length > 0) {
      if (!explicit.some((u) => u.deck === 'upper')) reasons.push('GATE_UPPER_DECK');
    } else if (gate.props.jetBridge) {
      reasons.push('GATE_UPPER_DECK');
    }
  }
  return { id: gate.id, status, reasons };
}

/** 空港にある作業員・車両の数（運用中の GSE 基地・整備施設のプロパティ） */
export function airportUnits(layout: AirportLayout): Partial<Record<UnitKind, number>> {
  const n = (f: Facility, k: string) => Math.max(0, Number(f.props[k] ?? 0));
  const out: Partial<Record<UnitKind, number>> = {};
  const add = (k: UnitKind, v: number) => (out[k] = (out[k] ?? 0) + v);
  for (const f of Object.values(layout.facilities)) {
    if (f.buildState !== 'operational' || f.parentFacilityId) continue;
    if (f.kind === 'gseBase') {
      add('staff', n(f, 'staff'));
      add('tug', n(f, 'tugs'));
      add('beltLoader', n(f, 'beltLoaders'));
      add('baggageTractor', n(f, 'baggageTractors'));
      add('fuelTruck', n(f, 'fuelTrucks'));
      add('cateringTruck', n(f, 'cateringTrucks'));
      add('cleaningVan', n(f, 'cleaningVans'));
      if (apronBusesOf(f) > 0) add('apronBus', apronBusesOf(f));
    }
    if (f.kind === 'maintenance') add('engineer', n(f, 'engineers'));
  }
  return out;
}

/** 地上支援: 機種の作業に必要な作業員・車両が空港にあるか */
export function checkGround(type: AircraftType, layout: AirportLayout): Check {
  if (type.unresolved) return unresolved('ground');
  const units = airportUnits(layout);
  const reasons = new Set<CompatReason>();
  const detail = new Set<string>();
  for (const kind of [...TURNAROUND_TASKS, 'pushback' as const]) {
    for (const [u, need] of Object.entries(taskNeeds(type, kind)) as [UnitKind, number][]) {
      const have = units[u] ?? 0;
      if (have === 0) {
        reasons.add('GSE_NONE');
        detail.add(u);
      } else if (have < need) {
        reasons.add('GSE_FEWER');
        detail.add(u);
      }
    }
  }
  if (!Object.values(layout.facilities).some((f) => f.kind === 'fuelFarm' && f.buildState === 'operational' && !f.parentFacilityId)) reasons.add('NO_FUEL_FARM');
  const ng = reasons.has('GSE_NONE') || reasons.has('NO_FUEL_FARM');
  return { id: 'ground', status: ng ? 'ng' : 'ok', reasons: [...reasons], detail: [...detail].sort() };
}

export interface AirportCompat {
  typeId: string;
  status: CompatStatus;
  runways: Check[];
  stands: Check[];
  gates: Check[];
  /** 区分・コード F の条件を満たさない誘導路 */
  taxiwaysNg: Check[];
  ground: Check;
  /** 使える滑走路と使えるスポットが、機体が通れる誘導路でつながっているか */
  route: boolean;
  reasons: CompatReason[];
}

/** 機体が通れる誘導路で、使える滑走路のどれかから到達できるスポット */
export function reachableStands(type: AircraftType, net: AirsideNetwork, runwayIds: readonly string[]): Set<string> {
  const start = runwayIds.flatMap((id) => net.runwayNodes[id] ?? []);
  const seen = new Set(start);
  const queue = [...start];
  const stands = new Set<string>();
  while (queue.length > 0) {
    const n = queue.shift()!;
    for (const eid of [...(net.outgoing[n] ?? []), ...(net.incoming[n] ?? [])]) {
      const e = net.edges[eid]!;
      if (e.kind === 'runway') continue;
      if (!canAircraftUse(e, type.size, { operationalOnly: true, codeF: type.codeF })) continue;
      const next = e.from === n ? e.to : e.from;
      if (e.kind === 'standLink') {
        stands.add(e.sourceId);
        continue;
      }
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return stands;
}

/** 空港全体での判定: 使える滑走路・スポット・経路・地上支援がそろっていれば ok */
export function checkAirport(type: AircraftType, layout: AirportLayout, net: AirsideNetwork): AirportCompat {
  const runways = sortedValues(layout.runways).map((r) => checkRunway(type, r));
  const stands = sortedValues(layout.stands).map((s) => checkStand(type, s, net));
  const gates = sortedValues(layout.facilities)
    .filter((f) => f.kind === 'gate')
    .map((g) => checkGate(type, g, layout, net));
  const taxiwaysNg = sortedValues(layout.taxiways)
    .map((e) => checkTaxiway(type, e))
    .filter((c) => c.status === 'ng' && !(c.reasons.length === 1 && c.reasons[0] === 'NOT_OPERATIONAL'));
  const ground = checkGround(type, layout);
  if (type.unresolved) {
    return { typeId: type.id, status: 'unknown', runways, stands, gates, taxiwaysNg, ground, route: false, reasons: ['TYPE_UNRESOLVED'] };
  }
  const okRunways = runways.filter((c) => c.status === 'ok').map((c) => c.id);
  const okStands = new Set(stands.filter((c) => c.status === 'ok').map((c) => c.id));
  const reach = reachableStands(type, net, okRunways);
  const route = [...okStands].some((id) => reach.has(id));
  const reasons: CompatReason[] = [];
  if (okRunways.length === 0) reasons.push(...new Set(runways.flatMap((c) => c.reasons)));
  if (okStands.size === 0) reasons.push(...new Set(stands.flatMap((c) => c.reasons)));
  if (okRunways.length > 0 && okStands.size > 0 && !route) reasons.push('NO_ROUTE');
  if (ground.status === 'ng') reasons.push(...ground.reasons.filter((r) => r !== 'GSE_FEWER'));
  return { typeId: type.id, status: reasons.length === 0 ? 'ok' : 'ng', runways, stands, gates, taxiwaysNg, ground, route, reasons: [...new Set(reasons)] };
}

/** 地上支援の不足は「運航はできるが遅れる」ので、運航可否（滑走路・スポット・経路）だけを見る判定 */
export function canOperate(type: AircraftType, layout: AirportLayout, net: AirsideNetwork): boolean {
  if (type.unresolved) return false;
  const okRunways = sortedValues(layout.runways)
    .filter((r) => checkRunway(type, r).status === 'ok')
    .map((r) => r.id);
  if (okRunways.length === 0) return false;
  const reach = reachableStands(type, net, okRunways);
  return sortedValues(layout.stands).some((s) => reach.has(s.id) && checkStand(type, s, net).status === 'ok');
}
