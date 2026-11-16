/**
 * 監査 e 系（空港の「能力」: アクセス・空側・折り返し・基地機能・ハブ機能）の共通ヘルパ。テスト専用。src/ は変更しない。
 */
import { addRoadPath, placeFacility, updateEntity } from '../../src/core/layout/operations';
import type { AirportLayout, FacilityKind } from '../../src/core/model/types';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { checkInvariants } from '../../src/core/sim/invariants';
import { createSimulation, stepSimulation, type CreateOptions, type Simulation } from '../../src/core/sim/simulation';
import { createSandboxCompany, type CompanyState } from '../../src/core/economy/company';
import { must } from '../unit/helpers';

export const logE = (tag: string, obj: unknown): void => {
  console.log(`[audit-e] ${tag} ${JSON.stringify(obj)}`);
};

export const H = 3600;
export const manual = { autoSchedule: false, inboundDelayProb: 0 };

/** now を seconds 進める。不変条件を every ティックごとに確認し、違反は label 付きで例外にする */
export function runE(sim: Simulation, seconds: number, every = 120, label = ''): void {
  for (let i = 0; i < seconds; i++) {
    stepSimulation(sim);
    if (i % every === 0) {
      const v = checkInvariants(sim);
      if (v.length) throw new Error(`${label} t=${sim.state.now}: ${v.slice(0, 4).join(' / ')}`);
    }
  }
}

export const runToTime = (sim: Simulation, t: number, every = 120, label = ''): void => runE(sim, Math.max(0, t - sim.state.now), every, label);

export function mkSim(layout: AirportLayout, seed: string, opts: CreateOptions & { company?: CompanyState | null } = {}): Simulation {
  return createSimulation(layout, { seed, settings: manual, company: createSandboxCompany(seed), ...opts });
}

export const maxOf = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);
export const meanOf = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const r1 = (v: number): number => Math.round(v * 10) / 10;
export const r3 = (v: number): number => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- アクセス施設の追加（サンプル空港）
/**
 * サンプル空港（一般道路 y=57、出入口 1 か所、駐車場 400 台）にアクセス施設を足す。
 * busStop (36,58) / taxiStand (44,58) / railStation (30,58)+鉄道線 x=32 を南端（y=105 付近の敷地外周）へ。
 */
export interface AccessVariant {
  parkingSpaces?: number;
  bus?: { busBays?: number; busesPerHour?: number };
  taxi?: { berths?: number };
  rail?: { trainsPerHour?: number; railService?: 'local' | 'rapid' | 'express'; toEdge?: boolean };
  /** 第 2 の出入口（2 本目の一般道路を敷地外周まで延ばす） */
  secondEntrance?: boolean;
  /** 一般道路 1 区間の capacityPerHour を上書き（RoadEdge.capacityPerHour が車両容量に使われないことの検査用） */
  roadCapacityPerHour?: number;
}

export function accessLayout(v: AccessVariant = {}): AirportLayout {
  let l = createSampleAirport();
  const fac = (kind: FacilityKind, x: number, y: number, props?: Record<string, number | string | boolean>) => {
    const r = must(placeFacility(l, kind, { x, y }, props ? { props } : {}));
    l = r.layout;
    return r.created[0]!;
  };
  if (v.parkingSpaces !== undefined) {
    const p = Object.values(l.facilities).find((f) => f.kind === 'parking')!;
    l = must(updateEntity(l, p.id, { props: { ...p.props, spaces: v.parkingSpaces } })).layout;
  }
  if (v.bus) fac('busStop', 36, 58, { busBays: v.bus.busBays ?? 2, busesPerHour: v.bus.busesPerHour ?? 4 });
  if (v.taxi) fac('taxiStand', 44, 58, { berths: v.taxi.berths ?? 4 });
  if (v.rail) {
    fac('railStation', 30, 58, { trainsPerHour: v.rail.trainsPerHour ?? 4, ...(v.rail.railService ? { railService: v.rail.railService } : {}) });
    const toY = v.rail.toEdge === false ? 80 : 105;
    l = must(addRoadPath(l, [{ x: 32, y: 61 }, { x: 32, y: toY }], { roadClass: 'rail', name: '空港連絡線' })).layout;
  }
  if (v.secondEntrance) l = must(addRoadPath(l, [{ x: 30, y: 57 }, { x: 30, y: 0 }], { roadClass: 'public', name: '北口' })).layout;
  if (v.roadCapacityPerHour !== undefined) {
    const e = Object.values(l.roads).find((r) => r.roadClass === 'public')!;
    l.roads[e.id] = { ...e, capacityPerHour: v.roadCapacityPerHour };
  }
  return l;
}

// ---------------------------------------------------------------- 会社・契約の倍加
import { addContract } from '../../src/core/economy/company';

/** サンドボックス会社の契約を factor 倍にする（契約を複製して追加。1 = そのまま） */
export function scaledCompany(seed: string, factor: number): CompanyState {
  const c = createSandboxCompany(seed);
  const base = Object.values(c.contracts);
  for (let i = 1; i < factor; i++) {
    for (const k of base) {
      const { id: _id, numberBase: _nb, ...rest } = k;
      void _id; void _nb;
      addContract(c, rest);
    }
  }
  return c;
}

// ---------------------------------------------------------------- 空側・折り返し用
export const RICH_GSE = { staff: 200, tugs: 30, beltLoaders: 30, baggageTractors: 30, fuelTrucks: 30, cateringTrucks: 30, cleaningVans: 30 } as const;

/** gseBase 施設の props を上書きする（先頭の gseBase）。複数基地は addGseBase */
export function withGse(layout: AirportLayout, props: Partial<Record<keyof typeof RICH_GSE | 'apronBuses', number>>): AirportLayout {
  const f = Object.values(layout.facilities).find((x) => x.kind === 'gseBase')!;
  return must(updateEntity(layout, f.id, { props: { ...f.props, ...props } })).layout;
}

// ---------------------------------------------------------------- 空側の飽和測定
import { addTurnaround } from '../../src/core/sim/simulation';
import type { Aircraft } from '../../src/core/sim/types';
import type { AircraftTypeId } from '../../src/core/sim/aircraftTypes';
import { traceRun } from './d_helpers';

export interface SatOpts {
  seed: string;
  n: number;
  spacingSec: number;
  typeId?: AircraftTypeId | string;
  simSeconds: number;
  /** 出発を予定する折り返し時間（秒）。省略は機種の既定 */
  turnSec?: number;
  setup?: (sim: Simulation) => void;
}
export interface SatResult {
  offered: number;
  landed: number;
  departed: number;
  diverted: number;
  /** 任意の 60 分窓での離着陸の最大回数 */
  peak60: number;
  /** 最初の着陸〜最後の離陸の平均（回/時） */
  avgPerHour: number;
  firstLanding: number;
  lastTakeoff: number;
  /** 滞留理由（state/hold）ごとの合計秒（全機合計）上位 */
  holdSec: Record<string, number>;
  meanDepDelaySec: number;
  maxDepDelaySec: number;
  meanGroundSec: number;
  maxConcurrentTowardRunway: number;
  violations: string[];
  conflicts: number;
  acs: Aircraft[];
  sim: Simulation;
}

export function saturate(layout: AirportLayout, o: SatOpts): SatResult {
  const sim = createSimulation(layout, { seed: o.seed, settings: manual });
  o.setup?.(sim);
  const t0 = sim.state.now + 20 * 60;
  const acs: Aircraft[] = [];
  for (let i = 0; i < o.n; i++) {
    const at = t0 + i * o.spacingSec;
    acs.push(addTurnaround(sim, (o.typeId ?? 'regional70') as AircraftTypeId, at, o.turnSec ? { departureAt: at + o.turnSec } : {}));
  }
  const tr = traceRun(sim, o.simSeconds, { every: 120 });
  const hist = (a: Aircraft, st: string) => a.history.find((h) => h.state === st)?.t;
  const lds = acs.map((a) => hist(a, 'landing')).filter((x): x is number => x !== undefined);
  const tks = acs.map((a) => hist(a, 'takeoff')).filter((x): x is number => x !== undefined);
  const ev = [...lds, ...tks].sort((a, b) => a - b);
  let peak60 = 0;
  for (let i = 0, j = 0; i < ev.length; i++) {
    while (ev[i]! - ev[j]! >= 3600) j++;
    peak60 = Math.max(peak60, i - j + 1);
  }
  const holdSec: Record<string, number> = {};
  for (const h of Object.values(tr.holdSec)) for (const [k, v] of Object.entries(h)) holdSec[k] = (holdSec[k] ?? 0) + v;
  const delays = acs.filter((a) => a.state === 'departed').map((a) => (sim.state.flights[a.departureFlightId]!.block ?? 0) - sim.state.flights[a.departureFlightId]!.scheduled);
  const grounds = acs.filter((a) => hist(a, 'takeoff') !== undefined && hist(a, 'docking') !== undefined).map((a) => hist(a, 'takeoff')! - hist(a, 'docking')!);
  const first = Math.min(...lds, Infinity);
  const last = Math.max(...tks, -Infinity);
  return {
    offered: o.n, landed: lds.length, departed: tks.length, diverted: sim.state.stats.diverted, peak60,
    avgPerHour: lds.length + tks.length > 0 && last > first ? Math.round(((lds.length + tks.length) / ((last - first) / 3600)) * 10) / 10 : 0,
    firstLanding: first - t0, lastTakeoff: last - t0, holdSec, meanDepDelaySec: Math.round(meanOf(delays)), maxDepDelaySec: delays.length ? Math.max(...delays) : 0,
    meanGroundSec: Math.round(meanOf(grounds)), maxConcurrentTowardRunway: tr.maxConcurrentTowardRunway, violations: tr.violations, conflicts: sim.state.stats.conflicts, acs, sim,
  };
}

export const topHolds = (h: Record<string, number>, k = 4): Record<string, number> => Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, k));

// ---------------------------------------------------------------- 折り返し測定（軽量）
export interface TurnRun {
  offered: number;
  departed: number;
  /** 出発予定との差（block − scheduled）の平均・最大（秒）。出発できなかった便は含まない */
  meanDepDelaySec: number;
  maxDepDelaySec: number;
  /** ブロックイン（docking）〜離陸（takeoff）の平均（秒） */
  meanGroundSec: number;
  /** ブロックイン（docking）〜出発準備完了（flight.readyAt）の平均（秒）。地上支援の速さそのもの（出発予定に隠れない） */
  meanReadyAfterDockSec: number;
  /** スポット上（docked〜pushback 前）の機数の最大 */
  maxOnStand: number;
  blockReasons: Record<string, number>;
  sim: Simulation;
}

export function turnRun(layout: AirportLayout, o: { seed: string; n: number; spacingSec: number; typeId?: string; simSeconds: number; setup?: (s: Simulation) => void; company?: CompanyState | null }): TurnRun {
  const sim = createSimulation(layout, { seed: o.seed, settings: manual, ...(o.company !== undefined ? { company: o.company } : {}) });
  o.setup?.(sim);
  const t0 = sim.state.now + 20 * 60;
  const acs = Array.from({ length: o.n }, (_, i) => addTurnaround(sim, (o.typeId ?? 'narrow180') as AircraftTypeId, t0 + i * o.spacingSec));
  let maxOnStand = 0;
  for (let i = 0; i < o.simSeconds; i++) {
    stepSimulation(sim);
    if (i % 10 === 0) {
      let c = 0;
      for (const a of Object.values(sim.state.aircraft)) if (['docking', 'parked', 'turnaround', 'readyForPushback'].includes(a.state) && a.standId) c++;
      maxOnStand = Math.max(maxOnStand, c);
    }
    if (i % 300 === 0) {
      const v = checkInvariants(sim);
      if (v.length) throw new Error(`turnRun ${o.seed} t=${sim.state.now}: ${v.slice(0, 3).join(' / ')}`);
    }
  }
  const hist = (a: Aircraft, st: string) => a.history.find((h) => h.state === st)?.t;
  const dep = acs.filter((a) => a.state === 'departed');
  const delays = dep.map((a) => (sim.state.flights[a.departureFlightId]!.block ?? 0) - sim.state.flights[a.departureFlightId]!.scheduled);
  const grounds = dep.filter((a) => hist(a, 'docking') !== undefined && hist(a, 'takeoff') !== undefined).map((a) => hist(a, 'takeoff')! - hist(a, 'docking')!);
  const readies = dep.filter((a) => hist(a, 'docking') !== undefined && sim.state.flights[a.departureFlightId]!.readyAt !== null).map((a) => sim.state.flights[a.departureFlightId]!.readyAt! - hist(a, 'docking')!);
  const blockReasons: Record<string, number> = {};
  for (const [k, v] of Object.entries(sim.state.groundStats.blockedSec)) blockReasons[k] = v ?? 0;
  return { offered: o.n, departed: dep.length, meanDepDelaySec: Math.round(meanOf(delays)), maxDepDelaySec: delays.length ? Math.max(...delays) : 0, meanGroundSec: Math.round(meanOf(grounds)), meanReadyAfterDockSec: Math.round(meanOf(readies)), maxOnStand, blockReasons, sim };
}
