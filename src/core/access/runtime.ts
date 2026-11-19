import { Rng } from '../rng';
import { BALANCE } from '../economy/balance';
import { post, type CompanyState } from '../economy/company';
import type { Simulation } from '../sim/simulation';
import type { PaxGroup, SimState } from '../sim/types';
import { ACCESS_MODES, analyzeAccess, type AccessAnalysis, type AccessMode, type AccessSegments, type SegmentPath, type TransitMode } from './model';
import { cargoPlannedTruckTripsByHour, cargoPlannedTruckTripsPerDay } from '../economy/cargo';
import { recordSimpleProcess } from '../sim/processStats';
import { featureOn } from '../economy/unlocks';

/**
 * 運航中の空港アクセス（docs/15_access_rules.md §4）。
 *
 * - 出発旅客グループは、空港に着く時点で手段を選ぶ（分担率による抽選）。手段ごとに次の制約を受ける:
 *   自家用車 = 駐車場の空き（満車なら探し回って送迎・タクシーなどに切り替え）、
 *   送迎・自家用車・タクシー = 道路と車寄せの混雑（BPR 型の遅れ）、バス・鉄道 = 1時間あたりの定員（超えると次の便）。
 *   交通施設からターミナルまでの徒歩も到着時刻と歩行時間に加わる。
 * - 到着旅客グループは出口で手段を選び、タクシー・バス・鉄道は乗り場の待ち行列に並ぶ（乗れるまで退出しない）。
 * - 使用料（駐車料金・交通事業者の使用料）は会社の収入として記録する。
 * 会社なしの運航（テスト）ではアクセスを扱わない（state.access = null）。
 */

export interface AccessRuntime {
  /** 運航開始時の分析（分担率・徒歩・容量） */
  shares: Record<AccessMode, number>;
  walkMin: Record<AccessMode, number>;
  available: AccessMode[];
  roadCapacity: number;
  curbCapacity: number;
  parkingSpaces: number;
  taxiBerths: number;
  busesPerHour: number;
  /** 貨物トラックの背景交通（台/時、1日の計画台数を24時間へ均等配分。CARGO-05。旧セーブでは欠落しうるため任意） */
  cargoTrucksPerHour?: number;
  /** 貨物トラックの時間帯配分（台/時 ×24、CARGO-08 格 6）。ある場合は均等配分より優先する */
  cargoTruckProfile?: number[];
  trainsPerHour: number;
  factor: number;
  /** 駐車中の車の出庫時刻（昇順） */
  parked: number[];
  /** 時間帯ごとの交通量（`road:時` / `curb:時` = 台、`bus:時` / `rail:時` = 出発旅客の人数） */
  hourly: Record<string, number>;
  /** 到着旅客の乗り場の待ち行列（グループID、到着順） */
  queues: Record<TransitMode, string[]>;
  taxiAcc: number;
  stats: AccessStats;
  /** 区間能力モデル（フェーズ 4 §6）の解析。ない場合は集約モデル */
  segments?: AccessSegments;
  /** 区間モデルのときの鉄道の受け入れ上限（人/時）= min(本数 × 定員, 連絡通路の能力)（4-12） */
  railCapPerHour?: number;
}

export interface AccessStats {
  pax: Record<AccessMode, number>;
  /** 自家用車で来たグループと、満車で停められなかったグループ */
  carGroups: number;
  parkingFull: number;
  /** 道路・車寄せの遅れ（分）の合計と件数 */
  roadDelaySum: number;
  roadDelayN: number;
  curbDelaySum: number;
  curbDelayN: number;
  /** バス・鉄道の満員で次の便に回された出発グループ */
  transitFull: number;
  /** 到着旅客の乗り場での待ち（人・秒） */
  waitSum: Record<TransitMode, number>;
  waitPax: Record<TransitMode, number>;
  peakParked: number;
}

const M = BALANCE.accessModel;
const DAY = 86400;

export function emptyAccessStats(): AccessStats {
  const z = () => ({ taxi: 0, bus: 0, rail: 0 });
  return {
    pax: { car: 0, dropoff: 0, taxi: 0, bus: 0, rail: 0, walk: 0 },
    carGroups: 0,
    parkingFull: 0,
    roadDelaySum: 0,
    roadDelayN: 0,
    curbDelaySum: 0,
    curbDelayN: 0,
    transitFull: 0,
    waitSum: z(),
    waitPax: z(),
    peakParked: 0,
  };
}

/** 貨物トラックの背景交通（台/時）。貨物が有効で当日計画の運搬がある場合だけ発生する（CARGO-05） */
function cargoTrucksPerHourFor(c: CompanyState): number {
  return featureOn(c, 'cargo') ? cargoPlannedTruckTripsPerDay(c, c.day) / 24 : 0;
}

/** 時間帯プロファイル（格 6）。貨物が無効な会社では null */
function cargoTruckProfileFor(c: CompanyState): number[] | undefined {
  if (!featureOn(c, 'cargo')) return undefined;
  return cargoPlannedTruckTripsByHour(c, c.day) ?? undefined;
}

/** その時間帯の貨物トラック背景交通（台/時）。プロファイルがあればそれを、なければ均等配分を使う */
export function cargoTrucksAtHour(acc: AccessRuntime, hour: number): number {
  if (acc.cargoTruckProfile) return acc.cargoTruckProfile[hour] ?? 0;
  return acc.cargoTrucksPerHour ?? 0;
}

export function createAccessRuntime(sim: Simulation, c: CompanyState): AccessRuntime | null {
  if (!sim.ctx.paxTerminal) return null;
  const a: AccessAnalysis = analyzeAccess(sim.ctx.layout, { fees: c.fees, feedback: c.accessFeedback, city: c.city, day: c.day });
  const dayStart = Math.floor(sim.state.now / DAY) * DAY;
  const shares = {} as Record<AccessMode, number>;
  const walkMin = {} as Record<AccessMode, number>;
  for (const m of ACCESS_MODES) {
    shares[m] = a.modes[m].share;
    walkMin[m] = a.modes[m].walkMin;
  }
  return {
    shares,
    walkMin,
    available: ACCESS_MODES.filter((m) => a.modes[m].available),
    roadCapacity: a.roadCapacityPerHour,
    curbCapacity: a.curbCapacityPerHour,
    parkingSpaces: a.parkingSpaces,
    taxiBerths: a.taxiBerths,
    busesPerHour: a.busesPerHour,
    // 貨物 OFF ではフィールド自体を持たない（フィンガープリントの不変条件。CARGO-05）
    ...(cargoTrucksPerHourFor(c) > 0 ? { cargoTrucksPerHour: cargoTrucksPerHourFor(c) } : {}),
    // 時間帯プロファイルも同じ不変条件で、格 6 以上かつ台数がある場合だけ持つ（CARGO-08 格 6）
    ...(cargoTruckProfileFor(c) && cargoTrucksPerHourFor(c) > 0 ? { cargoTruckProfile: cargoTruckProfileFor(c) } : {}),
    trainsPerHour: a.trainsPerHour,
    factor: a.factor,
    // 前日から駐車している車（駐車場が減っていれば、収まる分だけ）
    parked: c.parkedCars.map((t) => dayStart + t).filter((t) => t > sim.state.now).sort((x, y) => x - y).slice(0, a.parkingSpaces),
    hourly: {},
    queues: { taxi: [], bus: [], rail: [] },
    taxiAcc: 0,
    stats: emptyAccessStats(),
    ...(a.segments ? { segments: a.segments } : {}),
    ...(a.segments && a.railWalkCapacityPerHour !== null ? { railCapPerHour: Math.min(a.trainsPerHour * M.trainSeats, a.railWalkCapacityPerHour) } : {}),
  };
}

/** 日が変わったとき: 前日の混雑（feedback）と料金を反映して分担率・アクセス係数を更新する。返り値 = アクセス係数 */
export function refreshAccess(sim: Simulation, c: CompanyState): number {
  const a = analyzeAccess(sim.ctx.layout, { fees: c.fees, feedback: c.accessFeedback, city: c.city, day: c.day });
  const acc = sim.state.access;
  if (acc) {
    for (const m of ACCESS_MODES) acc.shares[m] = a.modes[m].share;
    acc.factor = a.factor;
    const trucks = cargoTrucksPerHourFor(c);
    acc.cargoTrucksPerHour = trucks > 0 ? trucks : undefined;
    acc.cargoTruckProfile = trucks > 0 ? cargoTruckProfileFor(c) : undefined;
    acc.segments = a.segments;
    acc.railCapPerHour = a.segments && a.railWalkCapacityPerHour !== null ? Math.min(a.trainsPerHour * M.trainSeats, a.railWalkCapacityPerHour) : undefined;
  }
  return a.factor;
}

function withRng<T>(state: SimState, fn: (rng: Rng) => T): T {
  const rng = new Rng(state.rng);
  const v = fn(rng);
  state.rng = rng.state();
  return v;
}

function choose(acc: AccessRuntime, u: number, allowed: readonly AccessMode[]): AccessMode {
  const list = acc.available.filter((m) => allowed.includes(m));
  const total = list.reduce((s, m) => s + acc.shares[m], 0);
  let x = u * total;
  for (const m of list) {
    x -= acc.shares[m];
    if (x < 0) return m;
  }
  return list[list.length - 1] ?? 'walk';
}

/** BPR 型の遅れ（分）= 基本時間 × 0.15 × (交通量/容量)^4（上限あり） */
export function congestionDelayMin(baseMin: number, volume: number, capacity: number): number {
  if (capacity <= 0) return M.congestionMaxMin;
  return Math.min(M.congestionMaxMin, baseMin * 0.15 * (volume / capacity) ** 4);
}

/** バス・鉄道の定員の空きを探す先読み時間（時間）。これを超えて空きがなければ別の手段に切り替える */
const TRANSIT_LOOKAHEAD_H = 24;

const add = (acc: AccessRuntime, key: string, v: number) => (acc.hourly[key] = (acc.hourly[key] ?? 0) + v);

/**
 * 区間モデル: その時間帯の volume / capacity が最小の出入口の経路を選ぶ（決定的、乱数なし）。
 * 選んだ経路の各辺に台数を足し、BPR 型の遅れ（分）を返す。到着側は台数だけ足す（countOnly）。
 */
function segmentTraverse(acc: AccessRuntime, paths: Record<string, SegmentPath>, vehicles: number, hour: number, externalMin: number, countOnly: boolean): number {
  const segs = acc.segments!;
  // 貨物トラックの背景交通（CARGO-05）: 集約モデルと同じ往復 ×2 を、貨物経路の辺にだけ重ねる。
  // 保存はせず読み取り時に加えるので、旅客側の区間交通量の記録は汚さない。
  const truckBg = cargoTrucksAtHour(acc, hour) * 2;
  const cargoEdges = new Set<string>();
  if (truckBg > 0) for (const p of Object.values(segs.cargoPaths)) for (const e of p.edges) cargoEdges.add(e);
  const bg = (e: string): number => (cargoEdges.has(e) ? truckBg : 0);
  let best: SegmentPath | null = null;
  let bestRatio = Infinity;
  for (const key of Object.keys(paths).sort()) {
    const p = paths[key]!;
    let r = 0;
    for (const e of p.edges) {
      const info = segs.edges[e];
      if (!info || info.capacity <= 0) continue;
      r = Math.max(r, ((acc.hourly[`seg:${e}:${hour}`] ?? 0) + bg(e)) / info.capacity);
    }
    if (r < bestRatio) {
      bestRatio = r;
      best = p;
    }
  }
  if (!best) return 0;
  let total = 0;
  for (const e of best.edges) {
    const info = segs.edges[e];
    if (!info || info.capacity <= 0) continue;
    const v = add(acc, `seg:${e}:${hour}`, vehicles) + bg(e);
    if (!countOnly) {
      const t0 = info.t0Min + (e === best.edges[0] ? externalMin : 0);
      total += Math.min(M.congestionMaxMin, t0 * 0.15 * (v / info.capacity) ** 4);
    }
  }
  return Math.min(M.congestionMaxMin, total);
}

function release(acc: AccessRuntime, now: number): void {
  let i = 0;
  while (i < acc.parked.length && acc.parked[i]! <= now) i++;
  if (i > 0) acc.parked.splice(0, i);
}

function park(acc: AccessRuntime, until: number): void {
  let i = acc.parked.length;
  while (i > 0 && acc.parked[i - 1]! > until) i--;
  acc.parked.splice(i, 0, until);
  acc.stats.peakParked = Math.max(acc.stats.peakParked, acc.parked.length);
}

function fee(c: CompanyState | null | undefined, m: AccessMode, count: number): void {
  if (!c) return;
  if (m === 'taxi' || m === 'bus' || m === 'rail') post(c, 'transit', count * BALANCE.accessFees[m] * c.fees[m]);
}

/**
 * 出発グループが空港に着く時点の処理。返り値 = 追加の遅れ（秒）。0 ならそのまま入口に入る。
 */
export function accessDeparture(sim: Simulation, g: PaxGroup): number {
  const acc = sim.state.access;
  g.accessDone = true;
  // 5-21: アクセス工程の実績（出発旅客のアクセス処理時点。既存のアクセス統計 stats.pax と
  // 同じ時点で数える。能力は空港全体の共有値のため算出しない）
  recordSimpleProcess(sim.state, 'access', g.count, sim.state.now, g.terminalId ?? '');
  if (!acc) return 0;
  const { state } = sim;
  const now = state.now;
  const hour = Math.floor(now / 3600);
  let mode = withRng(state, (rng) => choose(acc, rng.next(), ACCESS_MODES));
  let delayMin = 0;

  if (mode === 'car') {
    acc.stats.carGroups++;
    release(acc, now);
    if (acc.parked.length >= acc.parkingSpaces) {
      // 満車: 探し回った末に送迎・タクシーなどに切り替える
      acc.stats.parkingFull++;
      delayMin += M.parkingSearchMin;
      mode = withRng(state, (rng) => choose(acc, rng.next(), ['dropoff', 'taxi', 'bus', 'rail', 'walk']));
    } else {
      park(acc, now + BALANCE.carPark.stayDays * DAY);
      if (sim.company) post(sim.company, 'carPark', BALANCE.carPark.feePerCar * sim.company.fees.carPark);
    }
  }
  if (mode === 'bus' || mode === 'rail') {
    // 1時間あたりの定員を超えたら次の便（時間帯）へ。24 時間先まで探して空きがなければ、定員を超えて受け入れず別の手段に切り替える（1-16 / E-1）
    const cap = mode === 'bus' ? acc.busesPerHour * M.busSeats : (acc.railCapPerHour ?? acc.trainsPerHour * M.trainSeats);
    let h = hour;
    const lastHour = hour + TRANSIT_LOOKAHEAD_H - 1;
    if (cap > 0 && g.count <= cap) while (h <= lastHour && (acc.hourly[`${mode}:${h}`] ?? 0) + g.count > cap) h++;
    if (cap <= 0 || g.count > cap || h > lastHour) {
      // 満車の駐車場と同じ方式: 送迎・タクシー・徒歩へ切り替える（定員を超えて加算する経路はない）
      acc.stats.transitFull++;
      mode = withRng(state, (rng) => choose(acc, rng.next(), ['dropoff', 'taxi', 'walk']));
    } else {
      if (h > hour) {
        acc.stats.transitFull++;
        delayMin += (h * 3600 - now) / 60;
      }
      add(acc, `${mode}:${h}`, g.count);
    }
  }
  if (mode === 'car' || mode === 'dropoff' || mode === 'taxi') {
    // 道路: 自家用車 1台、送迎・タクシー 2台（往復）。バスの定期便と貨物トラックを背景交通として常に含む
    const vehicles = mode === 'car' ? 1 : 2;
    if (acc.segments) {
      // 区間モデル（フェーズ 4 §6.3）: 出入口の経路ごとに台数を数え、辺ごとの BPR 遅れを合計する
      const paths = mode === 'car' ? acc.segments.parkingPaths : acc.segments.paths;
      const d = segmentTraverse(acc, paths, vehicles, hour, M.externalMin[mode], false);
      acc.stats.roadDelaySum += d;
      acc.stats.roadDelayN++;
      delayMin += d;
    } else {
      // 背景交通: バスの定期便と貨物トラック（どちらも往復 ×2）。容量の消費はこの式だけにし、
      // アクセス係数側では差し引かない（二重計上にしない。CARGO-05）
      const v = add(acc, `road:${hour}`, vehicles) + acc.busesPerHour * 2 + cargoTrucksAtHour(acc, hour) * 2;
      const d = congestionDelayMin(M.externalMin[mode], v, acc.roadCapacity);
      acc.stats.roadDelaySum += d;
      acc.stats.roadDelayN++;
      delayMin += d;
      if (mode !== 'car') {
        const cv = add(acc, `curb:${hour}`, 1);
        const cd = congestionDelayMin(10, cv, acc.curbCapacity);
        acc.stats.curbDelaySum += cd;
        acc.stats.curbDelayN++;
        delayMin += cd;
      }
    }
  }
  fee(sim.company, mode, g.count);
  g.mode = mode;
  acc.stats.pax[mode] += g.count;
  const walk = acc.walkMin[mode] ?? 0;
  g.walkSec += Math.round(walk * 60);
  return Math.round((delayMin + walk) * 60);
}

/**
 * 到着グループが出口に着いた時点の処理。true = 乗り場で待つ（退出はまだ）。
 */
export function accessArrival(sim: Simulation, g: PaxGroup): boolean {
  const acc = sim.state.access;
  if (!acc) return false;
  const { state } = sim;
  const mode = withRng(state, (rng) => choose(acc, rng.next(), ACCESS_MODES));
  g.mode = mode;
  g.accessDone = true;
  acc.stats.pax[mode] += g.count;
  g.walkSec += Math.round((acc.walkMin[mode] ?? 0) * 60);
  const hour = Math.floor(state.now / 3600);
  if (acc.segments && (mode === 'dropoff' || mode === 'car' || mode === 'taxi')) {
    // 区間モデル: 到着側も同じ経路に台数だけ足す（遅れは発生しない）
    const paths = mode === 'car' ? acc.segments.parkingPaths : acc.segments.paths;
    segmentTraverse(acc, paths, mode === 'car' ? 1 : 2, hour, 0, true);
  } else if (mode === 'dropoff' || mode === 'car') {
    add(acc, `road:${hour}`, mode === 'car' ? 1 : 2);
    if (mode === 'dropoff') add(acc, `curb:${hour}`, 1);
  }
  if (mode === 'taxi' || mode === 'bus' || mode === 'rail') {
    if (mode === 'taxi' && !acc.segments) add(acc, `road:${hour}`, 2);
    acc.queues[mode].push(g.id);
    g.state = 'waitingTransport';
    return true;
  }
  return false;
}

/**
 * 乗り場の処理（毎ティック）。タクシーは乗車枠 × 30人/時の割合で、バス・鉄道は便ごとに定員まで乗せる。
 * 乗れたグループを返す（呼び出し側が退出を確定する）。
 */
export function stepAccess(sim: Simulation): PaxGroup[] {
  const acc = sim.state.access;
  if (!acc) return [];
  const { state } = sim;
  const out: PaxGroup[] = [];
  const serve = (mode: TransitMode, capacity: number) => {
    const q = acc.queues[mode];
    let left = capacity;
    while (q.length > 0) {
      const g = state.paxGroups[q[0]!]!;
      if (g.count > left) break;
      left -= g.count;
      q.shift();
      acc.stats.waitSum[mode] += g.waitSec * g.count;
      acc.stats.waitPax[mode] += g.count;
      fee(sim.company, mode, g.count);
      out.push(g);
    }
    return capacity - left;
  };
  if (acc.queues.taxi.length > 0) {
    acc.taxiAcc = Math.min(acc.taxiAcc + (acc.taxiBerths * M.taxiPaxPerBerth) / 3600, 10);
    acc.taxiAcc -= serve('taxi', Math.floor(acc.taxiAcc));
  }
  const every = (perHour: number) => perHour > 0 && state.now % Math.max(60, Math.round(3600 / perHour)) === 0;
  if (every(acc.busesPerHour)) serve('bus', M.busSeats);
  if (every(acc.trainsPerHour)) serve('rail', M.trainSeats);
  return out;
}

/** 締めのとき: 統計を返して次の期間へ。日をまたぐ駐車を翌日 0:00 からの秒で返す */
export function takeAccessStats(sim: Simulation): { stats: AccessStats; parkedCars: number[] } | null {
  const acc = sim.state.access;
  if (!acc) return null;
  // 次の日の始まり（0:00 の締めなら今、途中の締めなら次の 0:00）
  const nextMidnight = Math.ceil(sim.state.now / DAY) * DAY;
  const stats = acc.stats;
  acc.stats = emptyAccessStats();
  acc.stats.peakParked = acc.parked.length;
  // 翌日 0:00 より前に出庫する車（途中で締めた日の残り）は持ち越さない
  return { stats, parkedCars: acc.parked.filter((t) => t > nextMidnight).map((t) => t - nextMidnight) };
}
