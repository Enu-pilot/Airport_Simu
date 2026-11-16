/**
 * 監査 e / PART 2: 空側の運航能力（滑走路・誘導路・スポット → 回/時）。
 * 仕様: docs/33_capacity_dashboard.md、src/core/economy/capacity.ts（滑走路 = 本数×30 回/時、誘導路は「未算出」、スポットは運用中かつ接続済みの数）、
 *       src/core/economy/planning.ts RUNWAY_HOURLY_CAPACITY、src/core/sim/rules.ts SEPARATION_SEC。
 * 方針: 計画値（ダッシュボード）と、運航が飽和したときの実測（離着陸の 60 分窓の最大回数・離着陸間隔）を比べる。測定値は `[audit-e]` 行に出す。
 * GSE は豊富（RICH_GSE）にして、地上支援を律速から外す。折り返しの律速は PART 3。
 */
import { describe, expect, it } from 'vitest';
import { createStressLayout } from '../golden/layouts';
import { analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { RUNWAY_HOURLY_CAPACITY } from '../../src/core/economy/planning';
import { createSandboxCompany } from '../../src/core/economy/company';
import { updateEntity } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { resolveType, AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';
import { setManualResourceClosure } from '../../src/core/sim/disruptions';
import { SEPARATION_SEC } from '../../src/core/sim/rules';
import { addTurnaround, createSimulation, setRunwayConfig, type Simulation } from '../../src/core/sim/simulation';
import type { AirportLayout } from '../../src/core/model/types';
import { crossingFreeAirport, parallelFreeAirport } from '../unit/sim/crossingLayouts';
import { linearLayout, manual, takeoffTimes, traceRun } from './d_helpers';
import { logE, meanOf, RICH_GSE, saturate, topHolds, withGse } from './e_helpers';
import { createContext } from '../../src/core/sim/context';
import { must } from '../unit/helpers';

const TYPE = 'ATR42-600'; // 小型ターボプロップ（スポット M 級・折り返し 25 分）
const sizeM = resolveType(AIRCRAFT_TYPES, TYPE).size;
const SEP = SEPARATION_SEC[sizeM][sizeM];
const gapsOf = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);
const rich = (l: AirportLayout) => withGse(l, RICH_GSE);

/** n 機を 30 秒刻みで着陸させ（出発は 8 時間後）、着陸間隔を測る（到着だけの滑走路能力） */
function arrivalGaps(l: AirportLayout, n: number, seed: string, setup?: (s: Simulation) => void) {
  const sim = createSimulation(l, { seed, settings: manual });
  setup?.(sim);
  const t0 = sim.state.now + 600;
  const acs = Array.from({ length: n }, (_, i) => addTurnaround(sim, TYPE, t0 + i * 30, { departureAt: t0 + 8 * 3600 }));
  const tr = traceRun(sim, 2 * 3600, { every: 120 });
  const ld = acs.map((a) => a.history.find((h) => h.state === 'landing')?.t).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  return { gaps: gapsOf(ld), landed: ld.length, tr, sim };
}

/** n 機が同時刻に出発できる状態にして、離陸間隔を測る（出発だけの滑走路能力） */
function departureGaps(l: AirportLayout, n: number, seed: string, setup?: (s: Simulation) => void) {
  const sim = createSimulation(l, { seed, settings: manual });
  setup?.(sim);
  const t0 = sim.state.now + 600;
  const acs = Array.from({ length: n }, (_, i) => addTurnaround(sim, TYPE, t0 + i * 60, { departureAt: t0 + 3600 }));
  const tr = traceRun(sim, 4 * 3600, { every: 120 });
  const tk = takeoffTimes(acs).map((x) => x.t);
  // 間隔の最小値は滑走路ごとの規則（別の滑走路は独立）。滑走路別の間隔も返す
  const perRunway: Record<string, number[]> = {};
  for (const x of takeoffTimes(acs)) (perRunway[sim.state.aircraft[x.id]!.runwayId ?? '?'] ??= []).push(x.t);
  const perRunwayGaps = Object.values(perRunway).map(gapsOf);
  return { gaps: gapsOf(tk), perRunwayGaps, n: tk.length, tr, sim };
}

const ratePerHour = (gaps: number[]): number => (gaps.length ? Math.round((3600 / meanOf(gaps)) * 10) / 10 : 0);

describe('ID-e2 滑走路: 到着だけ・出発だけの実測能力（計画値 30 回/時 = 本数 × 30 との比較）', () => {
  const SEED = 'e2-gap';
  it('到着だけ（9 機を 30 秒刻みで着陸要求）: 着陸間隔は最小間隔(SEPARATION) を下回らず、平均は計画の 120 秒/機（30 回/時）より大幅に長い。出口が多いと短い', () => {
    const rows: Record<string, unknown>[] = [];
    const mean: Record<string, number> = {};
    for (const [name, l] of Object.entries({ 'linear-1exit': linearLayout({ stands: 12 }), 'linear-4exits': linearLayout({ stands: 12, multiExit: true }), sample: createSampleAirport(), 'stress-2parallel': createStressLayout() })) {
      const r = arrivalGaps(rich(l), 9, SEED);
      expect(r.tr.violations, name).toEqual([]);
      expect(r.landed, name).toBe(9);
      for (const g of r.gaps) expect(g, `${name} 最小間隔`).toBeGreaterThanOrEqual(SEP);
      mean[name] = meanOf(r.gaps);
      rows.push({ layout: name, runways: Object.keys(r.sim.ctx.runways).length, gapsSec: r.gaps, meanGapSec: Math.round(mean[name]!), arrivalsPerHour: ratePerHour(r.gaps), separationBoundPerHour: Math.round(3600 / SEP), dashboardMixedPerRunway: RUNWAY_HOURLY_CAPACITY });
    }
    logE('e2-arrival-only', rows);
    expect(mean['linear-4exits']!).toBeLessThan(mean['linear-1exit']!); // 出口が増えると滑走路占有・誘導が短縮
    expect(mean['linear-1exit']!).toBeGreaterThan(3600 / RUNWAY_HOURLY_CAPACITY); // 計画の 1 機あたり 120 秒より長い
  });

  it('出発だけ（8 機が同時に出発準備）: 離陸間隔 ≥ 最小間隔。平行 2 本のレイアウトは 1 本より短い間隔で離陸できる。サンプル空港（進入ノード 4 か所）は最小間隔に近い', () => {
    const rows: Record<string, unknown>[] = [];
    const mean: Record<string, number> = {};
    for (const [name, l] of Object.entries({ 'linear-pair(1 entry)': linearLayout({ stands: 12, oneWayPair: true }), 'linear-pair-dual(2 entries)': linearLayout({ stands: 12, oneWayPair: true, dual: true }), sample: createSampleAirport(), 'stress-2parallel': createStressLayout() })) {
      const r = departureGaps(rich(l), 8, SEED);
      expect(r.tr.violations, name).toEqual([]);
      expect(r.n, name).toBe(8);
      for (const gs of r.perRunwayGaps) for (const g of gs) expect(g, `${name} 最小間隔（滑走路ごと）`).toBeGreaterThanOrEqual(SEP);
      mean[name] = meanOf(r.gaps);
      rows.push({ layout: name, gapsSec: r.gaps, meanGapSec: Math.round(mean[name]!), departuresPerHour: ratePerHour(r.gaps), separationBoundPerHour: Math.round(3600 / SEP) });
    }
    logE('e2-departure-only', rows);
    expect(mean['stress-2parallel']!).toBeLessThan(mean['linear-pair(1 entry)']!);
    expect(mean.sample!).toBeLessThan(mean['linear-pair(1 entry)']!);
  });

  it('2 本平行（stress）の到着・出発の分離運用（N=到着専用 / S=出発専用）と混合の比較。分離運用は到着・出発の設定どおりに使われる', () => {
    const mixed = departureGaps(rich(createStressLayout()), 8, SEED);
    const seg = departureGaps(rich(createStressLayout()), 8, SEED, (s) => {
      const ids = Object.keys(s.state.runwayConfig).sort();
      setRunwayConfig(s, ids[0]!, { mode: 'arrivals' });
      setRunwayConfig(s, ids[1]!, { mode: 'departures' });
    });
    expect(seg.tr.violations).toEqual([]);
    expect(seg.n).toBe(8);
    const ids = Object.keys(seg.sim.state.runwayConfig).sort();
    const used = new Set(Object.values(seg.sim.state.aircraft).map((a) => a.runwayId).filter(Boolean));
    logE('e2-segregated-departures', { mixedMeanGap: Math.round(meanOf(mixed.gaps)), segregatedMeanGap: Math.round(meanOf(seg.gaps)), runwaysUsedBySegregated: [...used], departuresRunway: ids[1] });
    // 出発専用の滑走路だけが使われる（到着専用に指定した滑走路から離陸しない）
    for (const a of Object.values(seg.sim.state.aircraft)) if (a.runwayId) expect(a.runwayId).toBe(ids[1]);
  });
});

describe('ID-e2 滑走路・スポット・誘導路をまとめた飽和（1.5 時間の過負荷）: 実測ピーク ÷ ダッシュボード容量', () => {
  const SEED = 'e2-sat';
  const mk = (): [string, AirportLayout, ((s: Simulation) => void)?][] => [
    ['linear 16stands pair+4exits (1 rwy)', linearLayout({ stands: 16, multiExit: true, oneWayPair: true })],
    ['linear 16stands common spur (1 rwy)', linearLayout({ stands: 16, multiExit: true })],
    ['sample 9stands (1 rwy, 4 connectors)', createSampleAirport()],
    ['stress 12stands (2 parallel, mixed)', createStressLayout()],
    ['stress 12stands (2 parallel, N=arr / S=dep)', createStressLayout(), (s) => { const ids = Object.keys(s.state.runwayConfig).sort(); setRunwayConfig(s, ids[0]!, { mode: 'arrivals' }); setRunwayConfig(s, ids[1]!, { mode: 'departures' }); }],
  ];
  it('オファー 30 折り返し/時（60 離着陸/時）を 1.5 時間: 実測ピークは計画の滑走路容量（本数×30）を下回り、律速は滑走路ではなく「経路の一括予約（routeBusy）」とスポット占有（noStand）。不変条件違反・競合なし', () => {
    const rows: Record<string, unknown>[] = [];
    for (const [name, l, setup] of mk()) {
      const r = saturate(rich(l), { seed: SEED, n: 45, spacingSec: 120, typeId: TYPE, turnSec: 1700, simSeconds: 4 * 3600, ...(setup ? { setup } : {}) });
      expect(r.violations, name).toEqual([]);
      expect(r.conflicts, name).toBe(0);
      const runways = Object.keys(r.sim.ctx.runways).length;
      const dash = runways * RUNWAY_HOURLY_CAPACITY;
      rows.push({ layout: name, offeredTurnsPerH: 30, landed: r.landed, departed: r.departed, diverted: r.diverted, peak60Movements: r.peak60, dashboardRunwayCapacityPerH: dash, ratioPeakToDashboard: Math.round((r.peak60 / dash) * 100) / 100, meanDepDelaySec: r.meanDepDelaySec, meanGroundSec: r.meanGroundSec, topHoldSec: topHolds(r.holdSec) });
      expect(r.peak60, name).toBeLessThan(dash); // 過負荷でも計画容量には届かない
      expect(r.diverted, name).toBeGreaterThan(0); // 過負荷は待機超過（HOLD_DIVERT）でダイバート
      expect(r.landed + r.diverted, name).toBe(45); // 便は消えない
    }
    logE('e2-saturation', rows);
  }, 300_000);

  it('オファー 10/15/20 折り返し/時（同一レイアウト）: 低負荷では全便処理・遅れ小、負荷が上がると遅れとダイバートが増える（単調）', () => {
    const rows: { rate: number; landed: number; diverted: number; peak60: number; meanDepDelaySec: number }[] = [];
    for (const rate of [10, 15, 20]) {
      const r = saturate(rich(linearLayout({ stands: 16, multiExit: true, oneWayPair: true })), { seed: SEED, n: Math.round(rate * 1.5), spacingSec: 3600 / rate, typeId: TYPE, turnSec: 1700, simSeconds: 4 * 3600 });
      expect(r.violations, `rate ${rate}`).toEqual([]);
      rows.push({ rate, landed: r.landed, diverted: r.diverted, peak60: r.peak60, meanDepDelaySec: r.meanDepDelaySec });
    }
    logE('e2-load-sweep', rows);
    expect(rows[0]!.diverted).toBe(0);
    expect(rows[2]!.meanDepDelaySec).toBeGreaterThan(rows[0]!.meanDepDelaySec);
    expect(rows[2]!.diverted).toBeGreaterThanOrEqual(rows[0]!.diverted);
  }, 300_000);

  it('スポット数の効果（オファー 20 折り返し/時）: 4 → 8 → 16 でさばける便が増える（スポットが律速になる範囲）', () => {
    const rows: { stands: number; landed: number; diverted: number; peak60: number; noStandHoldSec: number }[] = [];
    for (const stands of [4, 8, 16]) {
      const r = saturate(rich(linearLayout({ stands, multiExit: true, oneWayPair: true })), { seed: SEED, n: 30, spacingSec: 180, typeId: TYPE, turnSec: 1700, simSeconds: 4 * 3600 });
      expect(r.violations, `stands ${stands}`).toEqual([]);
      const noStand = Object.entries(r.holdSec).filter(([k]) => k.endsWith('/noStand')).reduce((s, [, v]) => s + v, 0);
      rows.push({ stands, landed: r.landed, diverted: r.diverted, peak60: r.peak60, noStandHoldSec: noStand });
    }
    logE('e2-stand-sweep', rows);
    expect(rows[1]!.landed).toBeGreaterThan(rows[0]!.landed);
    expect(rows[2]!.landed).toBeGreaterThanOrEqual(rows[1]!.landed);
    expect(rows[0]!.noStandHoldSec).toBeGreaterThan(rows[2]!.noStandHoldSec);
  }, 300_000);

  it('交差 2 本（45°）と平行 2 本（750 m）: スポット 4 で同じ負荷（12 折り返し/時）。実測ピークと遅れを比較（特性化）。交差でも不変条件・競合なし', () => {
    const rows: Record<string, unknown>[] = [];
    for (const [name, l] of Object.entries({ 'crossing-45deg': crossingFreeAirport(), 'parallel-750m': parallelFreeAirport() })) {
      const r = saturate(rich(l), { seed: SEED, n: 16, spacingSec: 300, typeId: TYPE, turnSec: 1700, simSeconds: 4 * 3600 });
      expect(r.violations, name).toEqual([]);
      expect(r.conflicts, name).toBe(0);
      rows.push({ layout: name, landed: r.landed, diverted: r.diverted, peak60: r.peak60, dashboard: 2 * RUNWAY_HOURLY_CAPACITY, meanDepDelaySec: r.meanDepDelaySec, topHoldSec: topHolds(r.holdSec, 3) });
    }
    logE('e2-crossing-vs-parallel', rows);
  }, 300_000);
});

describe('ID-e2 ダッシュボードの空側の指標（docs/33）', () => {
  const snapOf = (l: AirportLayout) => {
    const sim = createSimulation(l, { seed: 'e2-dash', settings: manual, company: createSandboxCompany('e2-dash') });
    return { sim, snap: analyzeAirportCapacity(sim.company!, sim.ctx) };
  };

  it('誘導路の処理能力は「未算出」: summary は capacity/demand が null・status uncomputed、各誘導路の行も null。どのレイアウトでも数値にならない（滑走路数・スポット数・誘導路数を変えても）', () => {
    for (const l of [createSampleAirport(), createStressLayout(), linearLayout({ stands: 16, dual: true }), parallelFreeAirport()]) {
      const { snap } = snapOf(l);
      const t = snap.summary.find((m) => m.name === '誘導路')!;
      expect([t.capacity, t.demand, t.utilization, t.spare, t.status]).toEqual([null, null, null, null, 'uncomputed']);
      expect(snap.analysis.capacity.taxiwayMovementsPerHour).toBeNull();
      const rows = snap.facilities.filter((f) => f.kind === '誘導路');
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect([r.capacity, r.demand, r.status]).toEqual([null, null, 'uncomputed']);
      for (const name of ['プッシュバック', '搭乗バス']) expect(snap.summary.find((m) => m.name === name)!.capacity).toBeNull();
      expect(snap.analysis.capacity.simultaneousPushbacks).toBeNull();
      expect(snap.analysis.capacity.dailyMovements).toBeNull();
    }
  });

  it('滑走路: 容量 = 運用中の本数 × 30 回/時（形状・長さ・間隔・交差に依存しない固定値）。交差 2 本・平行 2 本・1 本で 60/60/30。1 日総処理は運用時間 × 同容量', () => {
    const out: Record<string, unknown> = {};
    for (const [name, l] of Object.entries({ single: createSampleAirport(), crossing: crossingFreeAirport(), parallel: parallelFreeAirport(), stress: createStressLayout() })) {
      const { snap, sim } = snapOf(l);
      const n = Object.keys(sim.ctx.runways).length;
      const m = snap.summary.find((x) => x.name === '滑走路')!;
      expect(m.capacity).toBe(n * RUNWAY_HOURLY_CAPACITY);
      const day = snap.summary.find((x) => x.name.startsWith('1日総処理'))!;
      expect(day.capacity).toBe(n * RUNWAY_HOURLY_CAPACITY * snap.operatingHours);
      out[name] = { runways: n, capacityPerH: m.capacity };
    }
    logE('e2-dashboard-runway', out);
  });

  it('スポット容量 = 運用中かつ誘導路に接続済みのスポット数。未接続・建設中（一時閉鎖を含む）は除外される。接続されていない 1 箇所を足しても増えない', () => {
    const base = createSampleAirport();
    const count = (l: AirportLayout) => {
      const { snap } = snapOf(l);
      const m = snap.summary.find((x) => x.name === 'スポット同時駐機')!;
      const ctx = createContext(l);
      const expected = Object.values(ctx.stands).filter((s) => s.operational && s.entry).length;
      expect(m.capacity).toBe(expected);
      return { cap: m.capacity!, rows: snap.facilities.filter((f) => f.kind.endsWith('スポット')) };
    };
    const b = count(base);
    expect(b.cap).toBe(9);
    // 建設中（一時閉鎖と同じ表現: buildState = underConstruction）
    const uc = must(updateEntity(base, 'std_1', { buildState: 'underConstruction' })).layout;
    const u = count(uc);
    expect(u.cap).toBe(8);
    expect(u.rows.find((r) => r.id === 'std_1')!.capacity).toBe(0);
    expect(u.rows.find((r) => r.id === 'std_1')!.state).toBe('construction');
    // 誘導路から切り離された（どの誘導路にも届かない）スポットを追加 → 容量は増えない
    const ctxBase = createContext(base);
    const lone = structuredClone(base);
    lone.stands['std_90'] = { id: 'std_90', name: '孤立', origin: { x: 150, y: 90 }, size: 'M', rotation: 180, buildState: 'operational' };
    const l = count(lone);
    expect(ctxBase.stands.std_1!.entry).not.toBeNull();
    expect(l.cap).toBe(9);
    expect(l.rows.find((r) => r.id === 'std_90')!.capacity).toBe(0);
    logE('e2-dashboard-stands', { base: b.cap, underConstruction: u.cap, disconnectedAdded: l.cap });
  });

  it('[観測 B] 運航中の手動閉鎖（setManualResourceClosure）はダッシュボード容量に反映されない（ダッシュボードは layout のみから算出し、運航状態を見ない）。docs/33 に記述なし (E)', () => {
    const l = createSampleAirport();
    const sim = createSimulation(l, { seed: 'e2-closure', settings: manual, company: createSandboxCompany('e2-closure') });
    const before = analyzeAirportCapacity(sim.company!, sim.ctx).summary.find((x) => x.name === 'スポット同時駐機')!.capacity;
    expect(setManualResourceClosure(sim, 'stand', 'std_1', true).ok).toBe(true);
    expect(sim.state.closures.stands).toContain('std_1');
    const after = analyzeAirportCapacity(sim.company!, sim.ctx).summary.find((x) => x.name === 'スポット同時駐機')!.capacity;
    logE('e2-closure-vs-dashboard', { before, after, closedAtRuntime: sim.state.closures.stands });
    expect(after).toBe(before);
  });
});
