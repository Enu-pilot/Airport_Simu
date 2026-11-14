import { CATALOG } from '../aircraft/catalog';
import { resolveType, type TypeTable } from '../sim/aircraftTypes';
import type { Simulation } from '../sim/simulation';
import type { BlockReason, TaskKind, UnitKind } from '../sim/types';
import { ON_TIME_SEC } from '../economy/balance';
import { evaluateDelayPair } from '../economy/delayEvaluation';
import type { FlightRecord } from './records';

/**
 * 運営分析の集計（docs/18_analytics.md に式・単位・対象・期間を記載）。
 * 値はすべて運航の記録（records.ts）と状態から計算した実績値。機種の属性からの推定は含めない
 * （航空会社の運航費だけは「推定」として区別する）。
 */

/** これより少ない便数の集計は「データ不足」として扱い、優劣の判断に使わない */
export const MIN_SAMPLE = 5;

export type GroupKey = 'manufacturer' | 'family' | 'model' | 'airline' | 'flight' | 'runway' | 'stand' | 'gate';

export interface GroupMetrics {
  key: string;
  /** 対象の便（機体の運航）数・完了数 */
  n: number;
  completed: number;
  completionRate: number | null;
  /** 座席数（定員）・搭乗者・座席利用率 */
  seats: number;
  paxBoarded: number;
  loadFactor: number | null;
  /** 平均（分）: 折り返し（ブロックイン → 準備完了）、スポット占有（ブロックイン → ブロックアウト）、出発遅延、到着・出発の地上走行 */
  avgTurnMin: number | null;
  avgStandMin: number | null;
  /** 出発遅延の評価対象値（外部要因と折返し猶予を控除）、分 */
  avgDepDelayMin: number | null;
  /** 実績時刻と予定時刻の差（控除前）、分 */
  avgActualDepDelayMin: number | null;
  avgTaxiInMin: number | null;
  avgTaxiOutMin: number | null;
  /** 定時運航率（出発、ブロックアウトが予定から15分以内） */
  otp: number | null;
  /** 地上作業ごとの平均所要時間（分） */
  taskMin: Partial<Record<TaskKind, number>>;
  /** 空港の収入（この便に帰属する分、cr） */
  revenue: number;
  /** 航空会社の運航費（推定: 機種のゲーム値 × ブロック時間 1.5h） */
  estOpCost: number;
  /** 運航できなかった便（ダイバート・欠航）と、障害の影響を受けた便 */
  failed: number;
  disrupted: number;
  /** サンプル数が少ない（MIN_SAMPLE 未満） */
  lowSample: boolean;
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const r1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

export function keyOf(r: FlightRecord, key: GroupKey): string | null {
  const m = CATALOG[r.typeId];
  switch (key) {
    case 'manufacturer':
      return m?.manufacturer ?? '不明';
    case 'family':
      return m?.family ?? '不明';
    case 'model':
      return r.typeId;
    case 'airline':
      return r.airlineId ?? '（契約なし）';
    case 'flight':
      return r.depNumber;
    case 'runway':
      return r.depRunway ?? r.arrRunway;
    case 'stand':
      return r.standId;
    case 'gate':
      return r.gateId;
  }
}

export function metricsOf(key: string, rs: FlightRecord[], types: TypeTable): GroupMetrics {
  const done = rs.filter((r) => r.result === 'completed');
  const seats = done.reduce((s, r) => s + r.seats, 0);
  const pax = done.reduce((s, r) => s + r.paxBoarded, 0);
  const taskMin: GroupMetrics['taskMin'] = {};
  for (const k of ['unload', 'fuel', 'clean', 'cater', 'inspect', 'load'] as TaskKind[]) {
    const v = avg(done.filter((r) => r.taskSec[k] !== undefined).map((r) => r.taskSec[k]! / 60));
    if (v !== null) taskMin[k] = r1(v)!;
  }
  const dep = done.filter((r) => r.blockOut !== null);
  const delayPairs = dep.map((r) => evaluateDelayPair({
    arrScheduled: r.arrScheduled,
    arrActual: r.landedAt,
    depScheduled: r.depScheduled,
    depBlockOut: r.blockOut,
    turnaroundSec: resolveType(types, r.typeId).turnaroundSec,
    arrivalExternalDelaySec: r.arrivalExternalDelaySec,
  }));
  return {
    key,
    n: rs.length,
    completed: done.length,
    completionRate: rs.length ? done.length / rs.length : null,
    seats,
    paxBoarded: pax,
    loadFactor: seats ? pax / seats : null,
    avgTurnMin: r1(avg(done.filter((r) => r.readyAt !== null && r.blockIn !== null).map((r) => (r.readyAt! - r.blockIn!) / 60))),
    avgStandMin: r1(avg(dep.filter((r) => r.blockIn !== null).map((r) => (r.blockOut! - r.blockIn!) / 60))),
    avgDepDelayMin: r1(avg(delayPairs.map((p) => p.departureSec / 60))),
    avgActualDepDelayMin: r1(avg(delayPairs.map((p) => p.actualDepartureSec / 60))),
    avgTaxiInMin: r1(avg(done.map((r) => r.taxiInSec / 60))),
    avgTaxiOutMin: r1(avg(done.map((r) => r.taxiOutSec / 60))),
    otp: rs.length ? dep.filter((_r, i) => delayPairs[i]!.departureSec <= ON_TIME_SEC).length / rs.length : null,
    taskMin,
    revenue: rs.reduce((s, r) => s + r.revenue, 0),
    estOpCost: Math.round(done.reduce((s, r) => s + resolveType(types, r.typeId).costPerBlockHour * 1.5, 0)),
    failed: rs.length - done.length,
    disrupted: rs.filter((r) => r.disruptions.length > 0).length,
    lowSample: rs.length < MIN_SAMPLE,
  };
}

/** 記録を切り口ごとに集計する（便数の多い順） */
export function aggregate(records: FlightRecord[], key: GroupKey, types: TypeTable): GroupMetrics[] {
  const groups = new Map<string, FlightRecord[]>();
  for (const r of records) {
    const k = keyOf(r, key);
    if (k === null) continue;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].map(([k, rs]) => metricsOf(k, rs, types)).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------- 空港全体の指標

export interface AirportKpis {
  /** 集計期間（秒） */
  elapsedSec: number;
  arrivals: number;
  departures: number;
  cancelled: number;
  /** 欠航・ダイバートの原因（便数） */
  failCauses: Record<string, number>;
  runways: { id: string; util: number; ops: number; avgWaitMin: number | null }[];
  stands: { id: string; util: number; turns: number }[];
  /** 地上で止まった時間の多いノード（上位） */
  hotspots: { node: string; waitMin: number }[];
  /** 時間帯（日内の時）ごとの出発・到着旅客 */
  hourlyPax: { hour: number; dep: number; arr: number }[];
  /** 処理施設（チェックイン・保安検査・ゲート）ごとの処理人数・平均待ち・最大待ち人数 */
  facilities: { id: string; kind: string; served: number; avgWaitMin: number | null; maxQueue: number }[];
  missedPax: number;
  /** 手荷物: 預け入れ → 積載の平均時間（分）、積み残し */
  bagProcessMin: number | null;
  bagsLeft: number;
  /** 作業員・車両の稼働率（作業に割り当てられていた時間 ÷ 台数 × 経過時間） */
  unitUtil: Partial<Record<UnitKind, number>>;
  /** 地上作業の停止時間（理由ごと、分） */
  blockedMin: Partial<Record<BlockReason, number>>;
  avgTaxiInMin: number | null;
  avgTaxiOutMin: number | null;
  avgGroundDistM: number | null;
  avgAirborneHoldMin: number | null;
  /** ランプバス（バスゲートがある運航だけ。従来の運航にはキーがない） */
  apronBus?: { trips: number; pax: number; avgWaitMin: number | null; shortageMin: number; rescues: number };
}

export function airportKpis(sim: Simulation): AirportKpis {
  const { state, ctx } = sim;
  const a = state.analytics;
  const elapsed = Math.max(1, state.now - a.since);
  const recs = a.records;
  const failCauses: Record<string, number> = {};
  for (const r of recs) {
    if (r.result === 'completed') continue;
    const c = r.causes.find((x) => x.startsWith('hold:')) ?? r.causes[0] ?? '不明';
    failCauses[c] = (failCauses[c] ?? 0) + 1;
  }
  const hourly = new Map<number, { dep: number; arr: number }>();
  for (const r of recs) {
    if (r.takeoffAt !== null) {
      const h = Math.floor((r.takeoffAt % 86400) / 3600);
      hourly.set(h, { dep: (hourly.get(h)?.dep ?? 0) + r.paxBoarded, arr: hourly.get(h)?.arr ?? 0 });
    }
    if (r.blockIn !== null) {
      const h = Math.floor((r.blockIn % 86400) / 3600);
      hourly.set(h, { dep: hourly.get(h)?.dep ?? 0, arr: (hourly.get(h)?.arr ?? 0) + r.paxArrived });
    }
  }
  const facilities = Object.entries(state.facilities)
    .map(([id, f]) => {
      const kind = id.startsWith('gate:') ? 'gate' : (ctx.terminal.areas[id]?.kind ?? 'area');
      return { id, kind, served: f.served, avgWaitMin: f.served ? r1(f.waitTotal / f.served / 60) : null, maxQueue: f.maxQueue };
    })
    .filter((f) => f.kind === 'checkIn' || f.kind === 'security' || f.kind === 'gate')
    .sort((x, y) => (y.avgWaitMin ?? 0) - (x.avgWaitMin ?? 0));
  const bagTimes: number[] = [];
  let bagsLeft = 0;
  for (const b of Object.values(state.bags)) {
    if (b.direction !== 'departure') continue;
    if (b.state === 'leftBehind') bagsLeft++;
    const start = b.history.find((h) => h.state === 'checkedIn')?.t;
    const end = b.history.find((h) => h.state === 'loaded')?.t;
    if (start !== undefined && end !== undefined) bagTimes.push((end - start) / 60);
  }
  const units = Object.values(state.units);
  const unitUtil: AirportKpis['unitUtil'] = {};
  for (const k of [...new Set(units.map((u) => u.kind))]) {
    const us = units.filter((u) => u.kind === k);
    unitUtil[k] = us.reduce((s, u) => s + u.busySec, 0) / (us.length * Math.max(1, state.now - a.since));
  }
  const blockedMin: AirportKpis['blockedMin'] = {};
  for (const [k, v] of Object.entries(state.groundStats.blockedSec)) blockedMin[k as BlockReason] = Math.round((v ?? 0) / 60);
  const done = recs.filter((r) => r.result === 'completed');
  return {
    elapsedSec: elapsed,
    arrivals: recs.filter((r) => r.landedAt !== null).length,
    departures: recs.filter((r) => r.takeoffAt !== null).length,
    cancelled: recs.filter((r) => r.result !== 'completed').length,
    failCauses,
    runways: Object.entries(a.runways).map(([id, r]) => ({ id, util: r.busySec / elapsed, ops: r.ops, avgWaitMin: r.ops ? r1(r.waitSec / r.ops / 60) : null })),
    stands: Object.keys(ctx.stands).map((id) => ({ id, util: (a.stands[id]?.busySec ?? 0) / elapsed, turns: a.stands[id]?.turns ?? 0 })),
    hotspots: Object.entries(a.nodes)
      .map(([node, sec]) => ({ node, waitMin: Math.round(sec / 6) / 10 }))
      .sort((x, y) => y.waitMin - x.waitMin)
      .slice(0, 8),
    hourlyPax: [...hourly.entries()].sort((x, y) => x[0] - y[0]).map(([hour, v]) => ({ hour, ...v })),
    facilities,
    missedPax: state.paxStats.missed,
    bagProcessMin: r1(avg(bagTimes)),
    bagsLeft,
    unitUtil,
    blockedMin,
    avgTaxiInMin: r1(avg(done.map((r) => r.taxiInSec / 60))),
    avgTaxiOutMin: r1(avg(done.map((r) => r.taxiOutSec / 60))),
    avgGroundDistM: r1(avg(done.map((r) => r.groundDistM))),
    avgAirborneHoldMin: r1(avg(recs.map((r) => r.airborneHoldSec / 60))),
    ...(state.bus
      ? {
          apronBus: {
            trips: state.bus.stats.trips,
            pax: state.bus.stats.pax,
            avgWaitMin: state.bus.stats.pax > 0 ? r1(state.bus.stats.waitSec / state.bus.stats.pax / 60) : null,
            shortageMin: Math.round(state.bus.stats.shortageSec / 60),
            rescues: state.bus.stats.rescues,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------- ボトルネック

export interface Bottleneck {
  /** 対象（施設ID・ノードID・ユニットの種類など） */
  target: string;
  area: 'runway' | 'taxiway' | 'stand' | 'checkIn' | 'security' | 'gate' | 'ground' | 'baggage';
  /** 深刻度（0〜1、根拠の指標から計算） */
  score: number;
  /** 判断に使った指標（名前 → 値と単位） */
  evidence: { label: string; value: string }[];
  /** 判断の規則 */
  rule: string;
}

/**
 * ボトルネックの推定。使用率の高さだけでなく、待ち時間・処理能力・停止時間・遅延への寄与を合わせて判断する。
 * 規則（ゲーム内の分析の簡易ルール）:
 *   滑走路   = 1便あたりの平均待ち ≥ 2分、または「滑走路待ち」を遅延理由に持つ便が 20% 以上
 *   スポット = 使用率 ≥ 70% かつ「スポット不足」を遅延理由に持つ便がある
 *   誘導路   = ノードでの停止の合計 ≥ 10分
 *   窓口     = 平均待ち ≥ 10分、または最大待ち人数 ≥ 30人
 *   地上支援 = 作業員・車両の不足による停止の合計 ≥ 30分（稼働率を併記）
 *   手荷物   = 積み残しがある、または預け入れ → 積載が平均 60分以上
 */
export function bottlenecks(sim: Simulation): Bottleneck[] {
  const k = airportKpis(sim);
  const recs = sim.state.analytics.records;
  const n = Math.max(1, recs.length);
  const share = (cause: string) => recs.filter((r) => r.causes.includes(cause)).length / n;
  const out: Bottleneck[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  for (const r of k.runways) {
    const q = share('runwayQueue');
    if ((r.avgWaitMin ?? 0) >= 2 || q >= 0.2) {
      out.push({
        target: r.id,
        area: 'runway',
        score: Math.min(1, (r.avgWaitMin ?? 0) / 10 + q),
        evidence: [
          { label: '1便あたりの平均待ち', value: `${r.avgWaitMin ?? 0}分` },
          { label: '滑走路待ちで遅れた便の割合', value: pct(q) },
          { label: '占有率', value: pct(r.util) },
          { label: '離着陸回数', value: `${r.ops}回` },
        ],
        rule: '平均待ち ≥ 2分、または滑走路待ちで遅れた便 ≥ 20%',
      });
    }
  }
  const noStand = share('noStand');
  for (const s of k.stands) {
    if (s.util >= 0.7 && noStand > 0) {
      out.push({
        target: s.id,
        area: 'stand',
        score: Math.min(1, s.util * 0.5 + noStand),
        evidence: [
          { label: '使用率', value: pct(s.util) },
          { label: 'スポット不足で遅れた便の割合（空港全体）', value: pct(noStand) },
          { label: '使用回数', value: `${s.turns}回` },
        ],
        rule: '使用率 ≥ 70% かつスポット不足で遅れた便がある',
      });
    }
  }
  for (const h of k.hotspots) {
    if (h.waitMin >= 10) {
      out.push({
        target: h.node,
        area: 'taxiway',
        score: Math.min(1, h.waitMin / 60),
        evidence: [
          { label: 'ノード付近での停止の合計', value: `${h.waitMin}分` },
          { label: '誘導路混雑で遅れた便の割合', value: pct(share('taxiCongestion')) },
        ],
        rule: '停止の合計 ≥ 10分',
      });
    }
  }
  for (const f of k.facilities) {
    if (f.kind === 'gate') continue;
    if ((f.avgWaitMin ?? 0) >= 10 || f.maxQueue >= 30) {
      out.push({
        target: f.id,
        area: f.kind === 'security' ? 'security' : 'checkIn',
        score: Math.min(1, (f.avgWaitMin ?? 0) / 30 + f.maxQueue / 200),
        evidence: [
          { label: '平均待ち', value: `${f.avgWaitMin ?? 0}分` },
          { label: '最大待ち人数', value: `${f.maxQueue}人` },
          { label: '処理人数', value: `${f.served}人` },
          { label: '乗り遅れ（空港全体）', value: `${k.missedPax}人` },
        ],
        rule: '平均待ち ≥ 10分、または最大待ち人数 ≥ 30人',
      });
    }
  }
  const shortage = (k.blockedMin.noStaff ?? 0) + (k.blockedMin.noVehicle ?? 0) + (k.blockedMin.noEngineer ?? 0);
  if (shortage >= 30) {
    out.push({
      target: 'ground',
      area: 'ground',
      score: Math.min(1, shortage / 600),
      evidence: [
        { label: '作業員不足による停止', value: `${k.blockedMin.noStaff ?? 0}分` },
        { label: '車両不足による停止', value: `${k.blockedMin.noVehicle ?? 0}分` },
        { label: '整備士不足による停止', value: `${k.blockedMin.noEngineer ?? 0}分` },
        ...Object.entries(k.unitUtil).map(([u, v]) => ({ label: `${u} の稼働率`, value: pct(v ?? 0) })),
        { label: '地上作業で遅れた便の割合', value: pct(share('groundHandling')) },
      ],
      rule: '作業員・車両の不足による停止の合計 ≥ 30分',
    });
  }
  if (k.bagsLeft > 0 || (k.bagProcessMin ?? 0) >= 60) {
    out.push({
      target: 'baggage',
      area: 'baggage',
      score: Math.min(1, k.bagsLeft / 50 + (k.bagProcessMin ?? 0) / 240),
      evidence: [
        { label: '積み残し', value: `${k.bagsLeft}個` },
        { label: '預け入れ → 積載の平均', value: `${k.bagProcessMin ?? '—'}分` },
        { label: '仕分け設備の停止', value: `${k.blockedMin.sorterDown ?? 0}分` },
      ],
      rule: '積み残しがある、または預け入れ → 積載が平均 60分以上',
    });
  }
  return out.sort((x, y) => y.score - x.score);
}
