/**
 * 監査 d 系（誘導路の部分進行・夜間規制）の共通ヘルパ。テスト専用。src/ は変更しない。
 */
import { addTaxiwayPath, placeFacility, placeRunway, placeStand, type OpResult } from '../../src/core/layout/operations';
import type { AirportLayout, SizeClass } from '../../src/core/model/types';
import { checkInvariants } from '../../src/core/sim/invariants';
import { reservableParts, routeLength } from '../../src/core/sim/routes';
import { createSimulation, stepSimulation, type CreateOptions, type Simulation } from '../../src/core/sim/simulation';
import { TERMINAL_STATES, type Aircraft } from '../../src/core/sim/types';
import { addContract, createSandboxCompany, type CompanyState, type TimeWindow } from '../../src/core/economy/company';
import { defaultCity, isCityNightMovement, type CityType } from '../../src/core/economy/city';
import { DAY_SEC } from '../../src/core/sim/rules';
import { emptyLayout, must } from '../unit/helpers';

export const manual = { autoSchedule: false, inboundDelayProb: 0 };

export interface LinearOpts {
  stands?: number;
  standSize?: SizeClass;
  /** 第 2 の経路（東側の誘導路 T2 と第 2 の滑走路進入ノード (95,30)）を足す */
  dual?: boolean;
  /** 共通誘導路（スポット ← → 平行誘導路 T）の幅区分 */
  spurWidth?: SizeClass;
  /** 共通誘導路を一方通行にする（from→to = 滑走路方向 = 北向き）か */
  spurOneWay?: boolean;
  /** 共通誘導路以外の誘導路の幅区分（既定 M） */
  baseWidth?: SizeClass;
  /** 平行誘導路 T への出口を (30,50,70,90) に複数設け、T を x=90 まで延ばす（到着の離脱選択の検査用。dual とは併用しない） */
  multiExit?: boolean;
  /** 滑走路の長さ（タイル。既定 100、dual は 170）。L 級機は離着陸距離のため 150 程度が必要 */
  runwayTiles?: number;
  /** 滑走路の路面幅（m。既定 45。L 級機は 60 が必要） */
  runwayWidthM?: 30 | 45 | 60;
  /** 入口・出口を別の一方通行誘導路（x=50: 北→南のみ / x=60: 南→北のみ）に分ける */
  oneWayPair?: boolean;
}

/**
 * 滑走路 1 本（y=30, x=10..110（dual は 10..180）, 東向き。離陸の進入ノードは (10,30) だけ（他のノードは残り距離が離陸滑走距離に足りない）。dual のみ (95,30) も候補）、平行誘導路 T（y=38, x=10..80。x=80 に離脱用の連絡路 X80）、滑走路端 (10,30) への連絡路 W、
 * T の東端（x=55）から南のエプロン（y=50）へ下りる単一の共通誘導路 SPUR（スポット側から滑走路端まで滑走路の横断なし）。
 * dual = true のときは、エプロン誘導路 B を東へ延ばし、SPUR とは交わらない第 2 の経路
 * （x=110 の南北路 → T2 (y=42, x=95..110) → 連絡路 (95,42)→(95,30)）で滑走路ノード (95,30) へ入れるようにする。
 */
export function linearLayout(o: LinearOpts = {}): AirportLayout {
  const n = o.stands ?? 4;
  let l = emptyLayout(200, 90);
  const step = (r: OpResult) => (l = must(r).layout);
  step(placeRunway(l, { x: 10, y: 30 }, 90, o.dual ? 170 : o.runwayTiles ?? 100, { surfaceWidthM: o.runwayWidthM ?? 45 }));
  const xx = o.multiExit ? 90 : o.dual ? 80 : 70;
  const bw = o.baseWidth ?? 'M';
  step(addTaxiwayPath(l, [{ x: 10, y: 38 }, { x: xx, y: 38 }], { name: 'T', widthClass: bw }));
  if (o.multiExit) for (const x of [30, 50, 70, 90]) step(addTaxiwayPath(l, [{ x, y: 30 }, { x, y: 38 }], { name: `EXIT${x}`, widthClass: bw }));
  else step(addTaxiwayPath(l, [{ x: xx, y: 30 }, { x: xx, y: 38 }], { name: 'EXIT', widthClass: bw }));
  step(addTaxiwayPath(l, [{ x: 10, y: 30 }, { x: 10, y: 38 }], { name: 'W', widthClass: bw }));
  if (o.oneWayPair) {
    step(addTaxiwayPath(l, [{ x: 50, y: 38 }, { x: 50, y: 50 }], { name: 'SPUR_IN', widthClass: o.spurWidth ?? bw, oneWay: true }));
    step(addTaxiwayPath(l, [{ x: 60, y: 50 }, { x: 60, y: 38 }], { name: 'SPUR_OUT', widthClass: o.spurWidth ?? bw, oneWay: true }));
  } else {
    step(addTaxiwayPath(l, [{ x: 55, y: 38 }, { x: 55, y: 50 }], { name: 'SPUR', widthClass: o.spurWidth ?? bw, oneWay: o.spurOneWay ?? false }));
  }
  const x0 = 55 - Math.floor((n * 5) / 2);
  step(addTaxiwayPath(l, [{ x: x0 - 2, y: 50 }, { x: o.dual ? 110 : x0 + n * 5 + 2, y: 50 }], { name: 'B', widthClass: bw }));
  step(placeFacility(l, 'apron', { x: x0 - 3, y: 51 }, { w: n * 5 + 6, h: 8 }));
  for (let i = 0; i < n; i++) step(placeStand(l, { x: x0 + i * 5, y: 51 }, o.standSize ?? 'M', 180, 'operational', `S${i + 1}`));
  step(placeFacility(l, 'gseBase', { x: x0 + n * 5 + 6, y: 55 }));
  step(placeFacility(l, 'fuelFarm', { x: x0 + n * 5 + 6, y: 60 }));
  step(placeFacility(l, 'maintenance', { x: x0 - 12, y: 55 }));
  if (o.dual) {
    step(addTaxiwayPath(l, [{ x: 110, y: 50 }, { x: 110, y: 42 }, { x: 95, y: 42 }, { x: 95, y: 30 }], { name: 'T2', widthClass: bw }));
  }
  return l;
}

export type Snap = { st: Aircraft['state']; hold: Aircraft['holdReason']; dist: number; speed: number };

export interface TaxiTrace {
  /** 機体 id → tick ごとのスナップ（now は起点からの経過ではなく絶対秒） */
  perTick: { now: number; ac: Record<string, Snap> }[];
  /** 機体が pushback に入った tick で、経路上の予約が「他機」に握られていたか（プッシュバック開始直前の予約表を使う） */
  pushbackStarts: { id: string; t: number; foreignOnRoute: string[] }[];
  /** 機体 id → `${state}/${holdReason}` ごとの待機秒数 */
  holdSec: Record<string, Record<string, number>>;
  /** pushback 開始時の経路の終点ノード座標（タイル）と全長（m） */
  routeEnds: Record<string, { x: number; y: number; lengthM: number }>;
  /** 機体 id → 経路の種別ごとの node 座標列（タイル。最初に見た経路） */
  routes: Record<string, Partial<Record<string, [number, number][]>>>;
  /** 同一滑走路向け taxiOut/holdShort/lineUp の同時機数の最大 */
  maxConcurrentTowardRunway: number;
  /** 機体ごとの状態遷移時刻 */
  firstAt: Record<string, Partial<Record<Aircraft['state'], number>>>;
  violations: string[];
  holdReasons: Set<string>;
  /** 'crossing' 待機中のスナップ（dist > 0 / speed 0 の確認用） */
  crossingHolds: { id: string; t: number; dist: number; speed: number }[];
  /** 滑走路上（takeoff/landing/lineUp 以外）に居る機体が、他機の離着陸中に存在した回数（横断中を除く判定用の生カウント） */
  onRunwayWhileOp: number;
  /** 横断許可を持たずに滑走路ノードの上で停止した機体の回数 */
  stoppedOnRunwayNoGrant: number;
}

const TOWARD = new Set<Aircraft['state']>(['taxiOut', 'holdShort', 'lineUp']);

/** seconds 秒進めながら、地上走行の部分進行に関する事実を採取する。checkInvariants を every ごとに実行 */
export function traceRun(sim: Simulation, seconds: number, opts: { every?: number; onTick?: (s: Simulation, i: number) => void; keepPerTick?: boolean } = {}): TaxiTrace {
  const every = opts.every ?? 5;
  const tr: TaxiTrace = {
    perTick: [], pushbackStarts: [], holdSec: {}, routeEnds: {}, routes: {}, maxConcurrentTowardRunway: 0, firstAt: {}, violations: [], holdReasons: new Set(),
    crossingHolds: [], onRunwayWhileOp: 0, stoppedOnRunwayNoGrant: 0,
  };
  const prevState = new Map<string, Aircraft['state']>();
  for (let i = 0; i < seconds; i++) {
    const nodeRes = { ...sim.state.nodeReservations };
    const edgeRes = { ...sim.state.edgeReservations };
    stepSimulation(sim);
    opts.onTick?.(sim, i);
    const snap: Record<string, Snap> = {};
    const toward = new Map<string, number>();
    for (const ac of Object.values(sim.state.aircraft)) {
      if (ac.state === 'scheduled') continue;
      if (opts.keepPerTick) snap[ac.id] = { st: ac.state, hold: ac.holdReason, dist: ac.dist, speed: ac.speed };
      const fa = (tr.firstAt[ac.id] ??= {});
      if (fa[ac.state] === undefined) fa[ac.state] = sim.state.now;
      if (ac.route) {
        const rr = (tr.routes[ac.id] ??= {});
        rr[ac.route.kind] ??= ac.route.nodes.map((n) => [sim.ctx.network.nodes[n]!.pos.x, sim.ctx.network.nodes[n]!.pos.y] as [number, number]);
      }
      if (ac.holdReason) {
        tr.holdReasons.add(ac.holdReason);
        const h = (tr.holdSec[ac.id] ??= {});
        h[`${ac.state}/${ac.holdReason}`] = (h[`${ac.state}/${ac.holdReason}`] ?? 0) + 1;
      }
      if (ac.holdReason === 'crossing') tr.crossingHolds.push({ id: ac.id, t: sim.state.now, dist: ac.dist, speed: ac.speed });
      if (TOWARD.has(ac.state) && ac.runwayId) toward.set(ac.runwayId, (toward.get(ac.runwayId) ?? 0) + 1);
      if (ac.state === 'pushback' && prevState.get(ac.id) !== 'pushback' && ac.route) {
        const parts = reservableParts(sim.ctx, ac.route, 0);
        // 直前の tick 開始時点で他機が握っていた区間のうち、tick 後も持ち主の経路の未解放部分に残っているもの（= 他機の区間を重ねて予約した）
        const owners = [
          ...parts.nodes.filter((n) => nodeRes[n] !== undefined && nodeRes[n] !== ac.id).map((n) => `${n}:${nodeRes[n]}`),
          ...parts.edges.filter((e) => edgeRes[e] !== undefined && edgeRes[e] !== ac.id).map((e) => `${e}:${edgeRes[e]}`),
        ];
        const foreign = owners.filter((o) => {
          const [key, ownerId] = o.split(':') as [string, string];
          const r = sim.state.aircraft[ownerId]!.route;
          if (!r || r.kind === 'takeoff') return false; // 離陸開始で全予約は解放済み（経路はランウェイ区間に差し替わる）
          // 持ち主が同じ tick のうちに通過して解放した分は正当。まだ経路の未解放部分に含むなら違反
          return r.nodes.slice(r.released).includes(key) || r.edges.slice(Math.max(0, r.released - 1)).includes(key);
        });
        const endPos = sim.ctx.network.nodes[ac.route.nodes[ac.route.nodes.length - 1]!]!.pos;
        tr.routeEnds[ac.id] = { x: endPos.x, y: endPos.y, lengthM: Math.round(routeLength(ac.route)) };
        tr.pushbackStarts.push({ id: ac.id, t: sim.state.now, foreignOnRoute: foreign });
      }
      prevState.set(ac.id, ac.state);
    }
    for (const n of toward.values()) tr.maxConcurrentTowardRunway = Math.max(tr.maxConcurrentTowardRunway, n);
    if (opts.keepPerTick) tr.perTick.push({ now: sim.state.now, ac: snap });
    if (i % every === 0) {
      const v = checkInvariants(sim);
      for (const m of v) if (tr.violations.length < 20) tr.violations.push(`t=${sim.state.now}: ${m}`);
    }
  }
  return tr;
}

export const allDone = (sim: Simulation): boolean =>
  Object.values(sim.state.aircraft).every((a) => a.state === 'scheduled' || TERMINAL_STATES.includes(a.state));

/** takeoff 開始時刻（history）の昇順 */
export function takeoffTimes(acs: Aircraft[]): { id: string; t: number }[] {
  return acs
    .map((a) => ({ id: a.id, t: a.history.find((h) => h.state === 'takeoff')?.t }))
    .filter((x): x is { id: string; t: number } => x.t !== undefined)
    .sort((p, q) => p.t - q.t);
}

export const logD = (tag: string, obj: unknown): void => {
  console.log(`[audit-d] ${tag} ${JSON.stringify(obj)}`);
};

const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/**
 * 離陸・着陸で滑走路を占有している機体（occupant）以外の地上機体が、その滑走路の路面（中心線 ± 半幅）の上にいる件。
 * 横断（purpose 'crossing'）中は他機が占有していないので対象外。空中（inbound/holding/approach）・終端状態は除く。
 */
export function runwayIntrusions(sim: Simulation): string[] {
  const out: string[] = [];
  for (const [rid, rs] of Object.entries(sim.state.runways)) {
    const occ = rs.occupant;
    if (!occ || occ.purpose === 'crossing') continue;
    const info = sim.ctx.runways[rid]!;
    const a = sim.ctx.network.nodes[info.nodes[0]!]!.pos;
    const b = sim.ctx.network.nodes[info.nodes[info.nodes.length - 1]!]!.pos;
    const half = (sim.ctx.layout.runways[rid]?.surfaceWidthM ?? 45) / 2 / 25;
    for (const ac of Object.values(sim.state.aircraft)) {
      if (ac.id === occ.aircraftId || ac.state === 'scheduled' || TERMINAL_STATES.includes(ac.state)) continue;
      if (['inbound', 'holding', 'approach'].includes(ac.state)) continue;
      if (distToSegment(ac.x, ac.y, a.x, a.y, b.x, b.y) < half) out.push(`t=${sim.state.now} ${ac.id}(${ac.state}/${ac.holdReason}) on ${rid} while ${occ.aircraftId} ${occ.purpose}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 夜間規制（都市設定あり）の補助


export const H = 3600;
export { isCityNightMovement, DAY_SEC };

/** 都市設定つきのサンドボックス会社（city を省略すると都市なし） */
export function cityCompany(seed: string, city: CityType | null): CompanyState {
  const c = createSandboxCompany(seed);
  if (city) c.city = defaultCity(city);
  return c;
}

/** 窓ごとの追加契約（morning / daytime / evening / any × 機種）。planning の時間帯検査用 */
export function addWindowContracts(c: CompanyState): void {
  const base = { feeDiscount: 0.1, startDay: 0, endDay: 9999, status: 'active' as const, offerExpiresDay: 0 };
  const list: [string, string, string, number, TimeWindow][] = [
    ['SK', 'TWN', 'B737-800W', 4, 'morning'],
    ['NP', 'YKH', 'A320neo', 4, 'evening'],
    ['RJ', 'KTA', 'regional70', 6, 'evening'],
    ['AQ', 'MSK', 'A320-200', 5, 'daytime'],
    ['SK', 'HSM', 'B777-300ER', 1, 'evening'],
  ];
  for (const [airlineId, destinationId, typeId, perDay, window] of list) addContract(c, { ...base, airlineId, destinationId, typeId, perDay, window });
}

/** 時刻（秒）→ "d{日} HH:MM:SS" */
export const hms = (t: number): string => {
  const d = Math.floor(t / DAY_SEC);
  const s = t - d * DAY_SEC;
  const p = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `d${d} ${p(s / 3600)}:${p((s % 3600) / 60)}:${p(s % 60)}`;
};

export function citySim(layout: AirportLayout, c: CompanyState, opts: CreateOptions = {}): Simulation {
  return createSimulation(layout, { company: c, settings: manual, ...opts });
}

/** now が time-of-day で夜間（22:00 以上 06:00 未満）か */
export const isNight = (t: number): boolean => isCityNightMovement(t);
