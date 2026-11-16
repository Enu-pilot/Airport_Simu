/**
 * 監査 e / PART 3: 折り返し能力（作業員・車両・燃料・整備士 → 同時に処理できる便数・地上時間・出発遅れ）。
 * 仕様: docs/13_ground_handling_rules.md §1–2、docs/33_capacity_dashboard.md（地上支援・折り返し = 既存 turnaroundCapacity）、docs/34（燃料管ハイドラント = 給油車不要・作業 0.6 倍）。
 * 実装: src/core/economy/planning.ts turnaroundCapacity（staff/4・beltLoader・baggageTractor・fuelTruck×2・cleaningVan×2・cateringTruck×2 の最小値。tug・整備士・燃料施設は含まない）、
 *       src/core/sim/ground.ts / tasks.ts。
 * 構成: linearLayout（旅客なし・スポット 6）に 6 機を 90 秒刻みで到着させ、資源 1 種類だけを変える（他は豊富）。
 */
import { describe, expect, it } from 'vitest';
import { analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { turnaroundCapacity } from '../../src/core/economy/planning';
import { addRoadPath, deleteEntity, placeFacility, updateEntity } from '../../src/core/layout/operations';
import { standTiles } from '../../src/core/layout/footprint';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext } from '../../src/core/sim/context';
import { addTurnaround, createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import type { AirportLayout } from '../../src/core/model/types';
import { createSandboxCompany } from '../../src/core/economy/company';
import { linearLayout, manual } from './d_helpers';
import { logE, meanOf, RICH_GSE, scaledCompany, turnRun, withGse, H, r1 } from './e_helpers';
import { must } from '../unit/helpers';

const N = 6;
const SPACING = 90;
const base = (): AirportLayout => linearLayout({ stands: N, multiExit: true, oneWayPair: true });
const rich = (extra: Partial<Record<keyof typeof RICH_GSE, number>> = {}) => withGse(base(), { ...RICH_GSE, ...extra });
const withEngineers = (l: AirportLayout, n: number): AirportLayout => {
  const m = Object.values(l.facilities).find((f) => f.kind === 'maintenance')!;
  return must(updateEntity(l, m.id, { props: { ...m.props, engineers: n } })).layout;
};
const run = (l: AirportLayout, seed = 'e3-sw') => turnRun(l, { seed, n: N, spacingSec: SPACING, typeId: 'narrow180', simSeconds: 5 * H });
const cap = (l: AirportLayout) => turnaroundCapacity(createContext(l));

type Res = keyof typeof RICH_GSE;
const SWEEPS: { res: Res; values: number[] }[] = [
  { res: 'staff', values: [4, 8, 12, 16, 24, 200] },
  { res: 'tugs', values: [1, 30] },
  { res: 'fuelTrucks', values: [1, 2, 30] },
  { res: 'cateringTrucks', values: [1, 2, 30] },
  { res: 'cleaningVans', values: [1, 2, 30] },
];

describe('ID-e3 資源の掃引: 少ない→豊富で、地上時間・出発遅れ・同時折り返し数がどう変わるか（seed e3-sw）', () => {
  const results: Record<string, { v: number; cap: number; departed: number; meanDelay: number; maxDelay: number; ground: number; onStand: number }[]> = {};
  const baseline = run(rich());
  it('基準（全資源が豊富）: 6 機すべて出発し、遅れは小さい。dashboard の折り返し能力（資源の最小値）は 6 以上', () => {
    logE('e3-baseline', { departed: baseline.departed, meanDepDelaySec: baseline.meanDepDelaySec, meanGroundSec: baseline.meanGroundSec, maxOnStand: baseline.maxOnStand, dashboardTurnCapacity: cap(rich()) });
    expect(baseline.departed).toBe(N);
    expect(cap(rich())).toBeGreaterThanOrEqual(N);
    expect(baseline.maxOnStand).toBe(N);
  });

  for (const { res, values } of SWEEPS) {
    it(`${res}: ${values.join(' / ')} — 資源が増えて悪化しない（単調、許容 = 平均遅れの 10% + 120 秒）。能力値 = 資源の最小値の計算どおり`, () => {
      const rows: (typeof results)[string] = [];
      for (const v of values) {
        const l = rich({ [res]: v });
        const r = run(l);
        rows.push({ v, cap: cap(l), departed: r.departed, meanDelay: r.meanDepDelaySec, maxDelay: r.maxDepDelaySec, ground: r.meanGroundSec, onStand: r.maxOnStand });
      }
      results[res] = rows;
      logE(`e3-sweep-${res}`, rows);
      // 出発できた数は資源が増えて減らない
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.departed, `${res} departed`).toBeGreaterThanOrEqual(rows[i - 1]!.departed);
      // 出発できた便の平均遅れ: 悪化しない（許容つき。出発できない便は遅れに含まれないので、departed が同数のときだけ比較）
      for (let i = 1; i < rows.length; i++) {
        if (rows[i]!.departed === rows[i - 1]!.departed) expect(rows[i]!.meanDelay, `${res}@${rows[i]!.v}`).toBeLessThanOrEqual(rows[i - 1]!.meanDelay * 1.1 + 120);
      }
      // 能力値は資源に単調（非減少）
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.cap).toBeGreaterThanOrEqual(rows[i - 1]!.cap);
      // 豊富な値では基準と同等
      expect(rows.at(-1)!.departed).toBe(N);
      expect(rows.at(-1)!.meanDelay).toBeLessThanOrEqual(baseline.meanDepDelaySec * 1.1 + 120);
    }, 300_000);
  }

  it('整備士（点検の必要資源。整備施設の「整備士」）: 0 だと点検が終わらず出発できない。1 以上で出発する。dashboard の折り返し能力は整備士を含まない', () => {
    const rows = [0, 1, 3, 10].map((e) => {
      const l = withEngineers(rich(), e);
      const r = run(l);
      return { engineers: e, cap: cap(l), departed: r.departed, meanDelay: r.meanDepDelaySec, blocked: { noEngineer: r.blockReasons.noEngineer ?? 0 } };
    });
    logE('e3-sweep-engineers', rows);
    expect(rows[0]!.departed).toBe(0);
    expect(rows[0]!.blocked.noEngineer).toBeGreaterThan(0);
    expect(rows[1]!.departed).toBe(N);
    expect(new Set(rows.map((r) => r.cap)).size).toBe(1); // 能力値は整備士の有無で不変
    for (let i = 2; i < rows.length; i++) expect(rows[i]!.meanDelay).toBeLessThanOrEqual(rows[i - 1]!.meanDelay * 1.1 + 120);
  }, 300_000);

  it('ダッシュボードの能力値が「膝」を予測するか: 同時 6 機の負荷で、能力値 < 6 の設定は遅れが基準より大きく、能力値 ≥ 6 の設定は基準に近いか（資源ごとに判定。特性化）', () => {
    const verdicts: Record<string, unknown>[] = [];
    for (const { res, values } of SWEEPS) {
      const rows = results[res];
      if (!rows) continue; // 個別実行時
      const knee = rows.find((r) => r.meanDelay <= baseline.meanDepDelaySec * 1.2 + 120 && r.departed === N);
      const predicted = rows.find((r) => r.cap >= N);
      verdicts.push({ res, values, measuredKneeAt: knee?.v ?? null, dashboardKneeAt: predicted?.v ?? null, dashboardConservative: !!knee && !!predicted ? predicted.v > knee.v : null, rows: rows.map((r) => ({ v: r.v, cap: r.cap, delay: r.meanDelay })) });
    }
    logE('e3-knee-vs-dashboard', verdicts);
    expect(verdicts.length).toBeGreaterThan(0);
  });
});

describe('ID-e3 能力値（turnaroundCapacity）の定義: 含まれる資源と含まれない資源（B）', () => {
  it('= min(staff/4, ベルトローダー, 手荷物牽引車, 給油車×2, 清掃車×2, ケータリング車×2)。トーイングカー・整備士・燃料施設の有無・燃料管は含まれない（docs/33 は「人員・車両制約」とのみ記述）', () => {
    const l = rich();
    const g = (props: Record<string, number>) => cap(withGse(l, props));
    expect(g({ staff: 20, beltLoaders: 3, baggageTractors: 3, fuelTrucks: 2, cateringTrucks: 2, cleaningVans: 2 })).toBe(3);
    expect(g({ staff: 11 })).toBe(2);
    expect(g({ beltLoaders: 1 })).toBe(1);
    expect(g({ fuelTrucks: 1 })).toBe(2);
    expect(g({ tugs: 0 })).toBe(cap(l)); // トーイングカー 0 でも能力は変わらない（が、実際はプッシュバック不能）
    expect(cap(withEngineers(l, 0))).toBe(cap(l));
    // 燃料施設を撤去しても能力値は不変（実際には給油ができず出発不能）
    const farm = Object.values(l.facilities).find((f) => f.kind === 'fuelFarm')!;
    const noFarm = must(deleteEntity(l, farm.id)).layout;
    expect(cap(noFarm)).toBe(cap(l));
    const snap = (x: AirportLayout) => { const s = createSimulation(x, { seed: 'e3-cap', settings: manual, company: createSandboxCompany('e3-cap') }); return analyzeAirportCapacity(s.company!, s.ctx).summary.find((m) => m.name === '地上支援・折り返し')!; };
    expect(snap(noFarm).capacity).toBe(snap(l).capacity);
    logE('e3-capacity-def', { rich: cap(l), tugs0: g({ tugs: 0 }), noFuelFarm: cap(noFarm), engineers0: cap(withEngineers(l, 0)) });
  });

  it('トーイングカー 0: 到着・折り返し作業は終わるがプッシュバックができず出発できない（能力値はこれを反映しない）', () => {
    const r = run(rich({ tugs: 0 }));
    logE('e3-tugs0', { departed: r.departed, blocked: r.blockReasons, dashboardCap: cap(rich({ tugs: 0 })) });
    expect(r.departed).toBe(0);
    expect(r.blockReasons.noVehicle ?? 0).toBeGreaterThan(0);
  }, 120_000);
});

describe('ID-e3 手荷物系の車両（ターミナルあり = サンプル空港）: ベルトローダー・手荷物牽引車', () => {
  const sampleRun = (props: Record<string, number>) => turnRun(withGse(createSampleAirport(), { ...RICH_GSE, ...props }), { seed: 'e3-bag', n: 5, spacingSec: 120, typeId: 'narrow180', simSeconds: 4 * H });
  it('ベルトローダー 1 / 牽引車 1（旅客・手荷物あり）: 豊富な場合より悪化することはあっても改善しない。線形レイアウト（旅客なし）では差が出なかった資源が、手荷物のある運航で効くかを測る', () => {
    const rows = [
      { res: 'baseline(rich)', r: sampleRun({}) },
      { res: 'beltLoaders=1', r: sampleRun({ beltLoaders: 1 }) },
      { res: 'baggageTractors=1', r: sampleRun({ baggageTractors: 1 }) },
    ].map(({ res, r }) => ({ res, departed: r.departed, meanDelay: r.meanDepDelaySec, maxDelay: r.maxDepDelaySec, ground: r.meanGroundSec, blocked: r.blockReasons }));
    logE('e3-bag-vehicles', rows);
    for (const r of rows.slice(1)) {
      expect(r.departed, r.res).toBe(rows[0]!.departed);
      expect(r.meanDelay, r.res).toBeGreaterThanOrEqual(rows[0]!.meanDelay - 120); // 資源を減らして改善しない（許容 120 秒）
    }
  }, 300_000);
});

describe('ID-e3 燃料: 燃料施設なし・ハイドラント（燃料管）', () => {
  it('燃料施設なし: 給油作業が noFuelFarm で止まり続け、出発準備が完了しない（出発 0 便）。validation は NO_FUEL_FARM 警告のみ', () => {
    const l = base();
    const farm = Object.values(l.facilities).find((f) => f.kind === 'fuelFarm')!;
    const noFarm = withGse(must(deleteEntity(l, farm.id)).layout, RICH_GSE);
    const r = run(noFarm);
    logE('e3-no-fuelfarm', { departed: r.departed, blockedSec: r.blockReasons });
    expect(r.departed).toBe(0);
    expect(r.blockReasons.noFuelFarm ?? 0).toBeGreaterThan(0);
  }, 120_000);

  /** 燃料施設から std_1 まで燃料管をつなぐ（ノードが燃料施設・スポットの 1 タイル以内であること） */
  function hydrantLayout(fuelTrucks: number, pipe: boolean): AirportLayout {
    let l = withGse(linearLayout({ stands: 4, multiExit: true, oneWayPair: true }), { ...RICH_GSE, fuelTrucks });
    if (!pipe) return l;
    const farm = Object.values(l.facilities).find((f) => f.kind === 'fuelFarm')!;
    const s1 = Object.values(l.stands)[0]!;
    const tl = standTiles(s1);
    const minX = Math.min(...tl.map((t) => t.x));
    const maxY = Math.max(...tl.map((t) => t.y));
    l = must(addRoadPath(l, [{ x: farm.origin.x - 1, y: farm.origin.y + 1 }, { x: minX, y: farm.origin.y + 1 }, { x: minX, y: maxY + 1 }], { roadClass: 'fuel', name: '燃料管' })).layout;
    return l;
  }
  /** std_1 だけを使わせて 1 機の折り返し作業（給油）を読む */
  function fuelTaskAt(l: AirportLayout, seed: string) {
    const sim = createSimulation(l, { seed, settings: manual });
    for (const id of Object.keys(sim.ctx.stands)) if (id !== 'std_1') sim.state.closures.stands.push(id);
    const a = addTurnaround(sim, 'narrow180', sim.state.now + 600);
    for (let i = 0; i < 6000 && !(sim.state.aircraftTasks[a.id] ?? []).length; i++) stepSimulation(sim);
    const t = (sim.state.aircraftTasks[a.id] ?? []).map((id) => sim.state.tasks[id]!).find((x) => x.kind === 'fuel')!;
    return { standId: a.standId, hydrant: sim.ctx.hydrantStands.has(a.standId ?? ''), workSec: t.workSec, needsFuelTruck: t.needs.fuelTruck ?? 0 };
  }

  it('ハイドラント接続スポット: 給油は給油車不要・作業時間 0.6 倍（docs/34）。給油車 0 台でも接続スポットの機体は出発でき、非接続では出発できない。ダッシュボードの折り返し能力は給油車 0 で 0 のまま（B）', () => {
    expect([...createContext(hydrantLayout(2, true)).hydrantStands]).toEqual(['std_1']);
    const plain = fuelTaskAt(hydrantLayout(2, false), 'e3-hyd');
    const hyd = fuelTaskAt(hydrantLayout(2, true), 'e3-hyd');
    logE('e3-hydrant-time', { plain, hyd });
    expect(plain.standId).toBe('std_1');
    expect(hyd.hydrant).toBe(true);
    expect(plain.needsFuelTruck).toBe(1);
    expect(hyd.needsFuelTruck).toBe(0);
    expect(hyd.workSec).toBe(Math.round(plain.workSec * 0.6));
    // 給油車 0 台での出発可否（std_1 以外は閉鎖して 1 機）
    const fly = (l: AirportLayout) => turnRun(l, { seed: 'e3-hyd', n: 1, spacingSec: 60, simSeconds: 3 * H, setup: (s) => { for (const id of Object.keys(s.ctx.stands)) if (id !== 'std_1') s.state.closures.stands.push(id); } });
    const withPipe = fly(hydrantLayout(0, true));
    const noPipe = fly(hydrantLayout(0, false));
    logE('e3-hydrant-no-trucks', { withPipe: { departed: withPipe.departed, delay: withPipe.meanDepDelaySec }, noPipe: { departed: noPipe.departed, blocked: noPipe.blockReasons }, dashboardCapacity: { withPipe: cap(hydrantLayout(0, true)), noPipe: cap(hydrantLayout(0, false)) } });
    expect(withPipe.departed).toBe(1);
    expect(noPipe.departed).toBe(0);
    expect(cap(hydrantLayout(0, true))).toBe(0);
  }, 300_000);
});

describe('ID-e3 GSE 基地の位置・複数基地（ユニットは基地からスポットへ 8 m/s + 準備 30 秒で移動）', () => {
  it('基地が遠い（x=160、約 100 タイル）と出発準備完了が遅くなる（地上時間・出発遅れは出発予定に隠れて変わらない）。能力値（資源数だけ）は不変。資源を 2 基地に分けても合計が同じなら能力値は同じ', () => {
    const near = rich();
    const gse = Object.values(near.facilities).find((f) => f.kind === 'gseBase')!;
    const far = must(placeFacility(must(deleteEntity(near, gse.id)).layout, 'gseBase', { x: 160, y: gse.origin.y }, { props: { ...gse.props } })).layout;
    const rn = run(near);
    const rf = run(far);
    // 2 基地（近い方と遠い方に半分ずつ）
    const half = Object.fromEntries(Object.entries(RICH_GSE).map(([k, v]) => [k, Math.ceil(v / 2)]));
    const split = must(placeFacility(withGse(near, half), 'gseBase', { x: 160, y: gse.origin.y }, { props: { ...gse.props, ...half } })).layout;
    const rs = run(split);
    logE('e3-gse-distance', { near: { readyAfterDock: rn.meanReadyAfterDockSec, ground: rn.meanGroundSec, delay: rn.meanDepDelaySec, departed: rn.departed }, far: { readyAfterDock: rf.meanReadyAfterDockSec, ground: rf.meanGroundSec, delay: rf.meanDepDelaySec, departed: rf.departed }, splitHalfNearHalfFar: { readyAfterDock: rs.meanReadyAfterDockSec, ground: rs.meanGroundSec, delay: rs.meanDepDelaySec, departed: rs.departed }, dashboardCap: [cap(near), cap(far), cap(split)], note: 'ground/delay are bounded by the scheduled departure; readyAfterDock shows the vehicle travel effect' });
    expect(rf.departed).toBe(N);
    expect(rf.meanReadyAfterDockSec).toBeGreaterThan(rn.meanReadyAfterDockSec);
    expect(cap(far)).toBe(cap(near));
    expect(rs.departed).toBe(N);
  }, 300_000);
});

describe('ID-e3 通し 1 日（サンプル空港・サンドボックス契約）: ダッシュボードの「折り返し能力 / 需要」判定はどれだけ保守的か（3 seed）', () => {
  const SEEDS = ['e3-d1', 'e3-d2', 'e3-d3'];
  const DOUBLE = { staff: 40, tugs: 4, beltLoaders: 6, baggageTractors: 6, fuelTrucks: 4, cateringTrucks: 4, cleaningVans: 4 };
  function dayRun(seed: string, factor: number, gse: Record<string, number> | null) {
    let l = createSampleAirport();
    if (gse) l = withGse(l, gse);
    const sim = createSimulation(l, { seed, company: scaledCompany(seed, factor) });
    const snap = analyzeAirportCapacity(sim.company!, sim.ctx);
    const m = snap.summary.find((x) => x.name === '地上支援・折り返し')!;
    let maxOn = 0;
    for (let i = 0; i < 18 * H - 60; i++) {
      stepSimulation(sim);
      if (i % 60 === 0) {
        let c = 0;
        for (const a of Object.values(sim.state.aircraft)) if (['docking', 'parked', 'turnaround', 'readyForPushback'].includes(a.state) && a.standId) c++;
        maxOn = Math.max(maxOn, c);
      }
    }
    const delays = Object.values(sim.state.flights).filter((f) => f.direction === 'departure' && f.block !== null).map((f) => (f.block! - f.scheduled) / 60);
    return { seed, factor, dashCapacity: m.capacity, dashDemand: m.demand, status: m.status, simMaxOnStand: maxOn, flights: delays.length, otp: Math.round((delays.filter((d) => d <= 15).length / Math.max(1, delays.length)) * 100) / 100, meanDepDelayMin: r1(meanOf(delays)), lateReadySec: sim.state.groundStats.lateReadySec, noVehicleSec: sim.state.groundStats.blockedSec.noVehicle ?? 0, noStaffSec: sim.state.groundStats.blockedSec.noStaff ?? 0 };
  }

  it('既定 GSE（能力 3）と 2 倍 GSE（能力 6）、契約 ×1 と ×2: 同じ seed で、判定（adequate/warning/shortage）と実際の定時性・遅れ・同時折り返し最大を比較', () => {
    const rows: Record<string, unknown>[] = [];
    for (const seed of SEEDS) {
      const d1 = dayRun(seed, 1, null);
      const d2 = dayRun(seed, 2, null);
      const b2 = dayRun(seed, 2, DOUBLE);
      rows.push({ seed, 'default x1': d1, 'default x2': d2, 'double x2': b2 });
      expect(d1.dashCapacity, seed).toBe(3);
      expect(b2.dashCapacity, seed).toBe(6);
      expect(d2.dashDemand!, seed).toBeGreaterThanOrEqual(d1.dashDemand!);
      expect(d2.flights, seed).toBeGreaterThan(d1.flights);
      // GSE を 2 倍にして悪化しない（許容: 平均遅れ +2 分）
      expect(b2.meanDepDelayMin, seed).toBeLessThanOrEqual(d2.meanDepDelayMin + 2);
      expect(d1.simMaxOnStand, seed).toBeLessThanOrEqual(9);
    }
    logE('e3-day-conservatism', rows);
  }, 900_000);
});
