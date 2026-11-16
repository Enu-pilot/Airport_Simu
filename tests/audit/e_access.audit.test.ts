/**
 * 監査 e / PART 1: ランドサイドのアクセス能力（道路・鉄道・駐車場・バス・タクシー → 空港に着ける人数）。
 * 仕様: docs/15_access_rules.md §2–§4・§7、docs/31 §需要上限、docs/34（道路 capacityPerHour は車両容量に使わない）。
 * 実装: src/core/access/{model,runtime,landside,rail}.ts、src/core/economy/capacity.ts。
 * 分類 A 実装・有効 / B 実装済みだが計画値と運航が不一致・検証不足 / C 仕様矛盾 / D 未実装と明記 / E 仕様・モデルなし。
 * 測定値は `[audit-e]` 行に出す（ゲーム値）。
 */
import { describe, expect, it } from 'vitest';
import { accessFactor, analyzeAccess } from '../../src/core/access/model';
import { accessArrival, accessDeparture, congestionDelayMin, stepAccess } from '../../src/core/access/runtime';
import { findPedestrianRoute } from '../../src/core/access/verticalWalk';
import { BALANCE } from '../../src/core/economy/balance';
import { analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { cityDemandCeiling, defaultCity, type CityType } from '../../src/core/economy/city';
import { createSandboxCompany } from '../../src/core/economy/company';
import { planDayWithDemand } from '../../src/core/economy/planning';
import { addRoadPath, connectRoadLevels, placeFacility } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation, type Simulation } from '../../src/core/sim/simulation';
import type { AccessMode } from '../../src/core/access/model';
import type { PaxGroup } from '../../src/core/sim/types';
import { must } from '../unit/helpers';
import { accessLayout, logE, mkSim, r1, r3, runE, scaledCompany, H } from './e_helpers';

const M = BALANCE.accessModel;

let gid = 0;
const fakeGroup = (count: number): PaxGroup => ({ id: `fg_${++gid}`, count, walkSec: 0, waitSec: 0, state: 'toAirport' } as unknown as PaxGroup);

/** 運航の乱数・分担率の抽選は本物のまま。分担率だけを手段 1 つに固定して、その手段の容量の効き方を単独で見る */
function forceMode(sim: Simulation, mode: AccessMode): void {
  const acc = sim.state.access!;
  for (const m of Object.keys(acc.shares) as AccessMode[]) acc.shares[m] = m === mode ? 1 : 0;
  acc.available = [mode];
}

function newSim(layout = accessLayout(), seed = 'e1-drv'): Simulation {
  const sim = mkSim(layout, seed);
  expect(sim.state.access, 'access runtime exists with company + terminal').not.toBeNull();
  return sim;
}

/** n グループ（size 人）を 1 時間（hour 時台）に均等に着かせる */
function driveDepartures(sim: Simulation, n: number, size: number, hour: number): { delays: number[] } {
  const delays: number[] = [];
  for (let i = 0; i < n; i++) {
    sim.state.now = hour * H + Math.floor((i * H) / n);
    delays.push(accessDeparture(sim, fakeGroup(size)));
  }
  return { delays };
}

describe('ID-e1 ダッシュボードのアクセス能力値（E: 単一の「人/時」は無い）', () => {
  it('capacity.ts の summary にアクセス全体の処理人数（人/時・人/日）の行はない。アクセス関連は「駅からターミナルへの連絡通路」(pax/h) だけで、駅は trains/h、道路は設定値のみ', () => {
    const sim = mkSim(accessLayout({ bus: {}, taxi: {}, rail: {} }), 'e1-dash');
    const snap = analyzeAirportCapacity(sim.company!, sim.ctx);
    const names = snap.summary.map((m) => m.name);
    const accessRows = names.filter((n) => /アクセス|道路|駐車|バス乗り場|タクシー|車寄せ|鉄道|駅/.test(n));
    expect(accessRows).toEqual(['駅からターミナルへの連絡通路']);
    // 駅行は列車本数（trains/h）であり、旅客人数ではない
    const station = snap.facilities.find((f) => f.kind === '鉄道駅')!;
    expect(station.unit).toBe('trains/h');
    expect(station.capacity).toBe(4);
    expect(station.status).toBe('uncomputed');
    // 駐車場・バス・タクシー乗り場・出入口の容量はダッシュボードの施設行にも出ない
    const kinds = new Set(snap.facilities.map((f) => f.kind));
    for (const k of ['駐車場', 'バス乗り場', 'タクシー乗り場', '出入口']) expect(kinds.has(k), k).toBe(false);
    const a = analyzeAccess(sim.ctx.layout, {});
    logE('e1-dash', { summaryNames: names, accessModelOnly: { roadPerH: a.roadCapacityPerHour, curbPerH: a.curbCapacityPerHour, parking: a.parkingSpaces, busPerH: a.busesPerHour, trainsPerH: a.trainsPerHour, taxiBerths: a.taxiBerths, modePaxPerH: Object.fromEntries(Object.values(a.modes).map((m) => [m.mode, m.capacityPerHour])) } });
  });

  it('analyzeAccess の容量値 = 運航ランタイムが使う値（出入口×900・車寄せ×40・駐車台数・便数・本数・乗車枠）', () => {
    const sim = mkSim(accessLayout({ bus: { busBays: 2, busesPerHour: 8 }, taxi: { berths: 5 }, rail: { trainsPerHour: 6 }, secondEntrance: true }), 'e1-parity');
    const a = analyzeAccess(sim.ctx.layout, {});
    const acc = sim.state.access!;
    expect(a.entrances).toBe(2);
    expect(acc.roadCapacity).toBe(2 * M.roadPerEntrance);
    expect(acc.curbCapacity).toBe(a.curbCapacityPerHour);
    expect(acc.parkingSpaces).toBe(a.parkingSpaces);
    expect(acc.busesPerHour).toBe(Math.min(8, 2 * M.busesPerBay));
    expect(acc.trainsPerHour).toBe(6);
    expect(acc.taxiBerths).toBe(5);
    expect(a.modes.bus.capacityPerHour).toBe(acc.busesPerHour * M.busSeats);
    expect(a.modes.rail.capacityPerHour).toBe(6 * M.trainSeats);
    expect(a.modes.taxi.capacityPerHour).toBe(5 * M.taxiPaxPerBerth);
  });
});

describe('ID-e1 道路・車寄せ: 容量は「硬い上限」ではなく BPR 型の遅れとして効く（A、docs/15 §3-4）', () => {
  it('合成グループを 1 時間に流し込む掃引: 平均の道路遅れは交通量/容量で単調増加し、v=容量で 外部時間×0.15≒5.25 分、上限 90 分。到着が遅れる分だけ入口到着が遅れる', () => {
    const rows: { groups: number; vehicles: number; vOverC: number; meanDelayMin: number; maxDelayMin: number }[] = [];
    let prev = -1;
    for (const n of [50, 150, 300, 450, 600, 900, 1200]) {
      const sim = newSim(accessLayout(), 'e1-road');
      const { delays } = driveDepartures(sim, n, 3, 10);
      const acc = sim.state.access!;
      const v = acc.hourly['road:10'] ?? 0;
      const mean = acc.stats.roadDelayN ? acc.stats.roadDelaySum / acc.stats.roadDelayN : 0;
      rows.push({ groups: n, vehicles: v, vOverC: r3(v / acc.roadCapacity), meanDelayMin: r3(mean), maxDelayMin: r1(Math.max(...delays) / 60) });
      expect(mean + 1e-9, `n=${n}`).toBeGreaterThanOrEqual(prev);
      prev = mean;
      expect(Math.max(...delays) / 60, 'cap 90 + curb + walk').toBeLessThanOrEqual(M.congestionMaxMin + 90 + 60);
    }
    logE('e1-road-sweep-1entrance', { roadCapacityPerH: 900, rows });
    // 解析式との一致: v = 容量 のとき 35×0.15 = 5.25 分、v = 2×容量 で 84 分、v = 3×容量 は上限 90 分
    expect(congestionDelayMin(M.externalMin.car, 900, 900)).toBeCloseTo(5.25, 9);
    expect(congestionDelayMin(M.externalMin.car, 1800, 900)).toBeCloseTo(84, 9);
    expect(congestionDelayMin(M.externalMin.car, 2700, 900)).toBe(M.congestionMaxMin);
    // 飽和点（平均遅れが 5 分を超える最初の行）
    const knee = rows.find((r) => r.meanDelayMin >= 5);
    logE('e1-road-knee', { firstRowMeanDelayGE5min: knee ?? null, note: 'knee near vOverC≈1 (BPR)' });
    // 容量内（v/c < 0.5）では遅れは 1 分未満＝能力は需要を制限しない
    expect(rows[0]!.meanDelayMin).toBeLessThan(1);
  });

  it('2 本目の出入口を足すと道路容量が 900→1800 に倍増し、同じ交通量での遅れが減る（上限が動く）。車寄せ容量（接する一般道路タイル×40）は出入口数と独立', () => {
    const one = newSim(accessLayout(), 'e1-ent');
    const two = newSim(accessLayout({ secondEntrance: true }), 'e1-ent');
    expect(analyzeAccess(one.ctx.layout, {}).roadCapacityPerHour).toBe(900);
    expect(analyzeAccess(two.ctx.layout, {}).roadCapacityPerHour).toBe(1800);
    driveDepartures(one, 600, 3, 10);
    driveDepartures(two, 600, 3, 10);
    const d = (s: Simulation) => s.state.access!.stats.roadDelaySum / s.state.access!.stats.roadDelayN;
    logE('e1-entrance-moves-limit', { meanDelayMin: { oneEntrance: r3(d(one)), twoEntrances: r3(d(two)) }, vehicles: one.state.access!.hourly['road:10'] });
    expect(d(two)).toBeLessThan(d(one));
    expect(analyzeAccess(one.ctx.layout, {}).curbCapacityPerHour).toBe(analyzeAccess(two.ctx.layout, {}).curbCapacityPerHour);
  });

  it('車寄せ（降車）側: 送迎が車寄せ容量を超えると curbDelay が増える（容量 = タイル×40/時）', () => {
    const sim = newSim(accessLayout(), 'e1-curb');
    forceMode(sim, 'dropoff');
    const cap = sim.state.access!.curbCapacity;
    sim.state.now = 10 * H;
    for (let i = 0; i < cap * 2; i++) accessDeparture(sim, fakeGroup(2));
    const s = sim.state.access!.stats;
    logE('e1-curb', { curbCapacityPerH: cap, groups: cap * 2, meanCurbDelayMin: r3(s.curbDelaySum / s.curbDelayN), maxDelayMin: M.congestionMaxMin });
    expect(s.curbDelaySum / s.curbDelayN).toBeGreaterThan(0.5);
  });

  it('[観測] 到着旅客の車・送迎は道路交通量を消費するが、遅れの対象外（出発側のみ遅れる）。docs/15 §3 到着は「そのまま退出」= 仕様どおり (A)', () => {
    const sim = newSim(accessLayout(), 'e1-arr');
    forceMode(sim, 'car');
    sim.state.now = 11 * H;
    const g = fakeGroup(3);
    expect(accessArrival(sim, g)).toBe(false); // 待ち行列に入らず即退出
    expect(sim.state.access!.hourly['road:11']).toBe(1);
    expect(sim.state.access!.stats.roadDelayN).toBe(0);
  });
});

describe('ID-e1 駐車場: 台数が上限として効く（A）', () => {
  it('満車で停められない車が出て「満車」に数えられ、探索 10 分の遅れ＋別手段へ切替。駐車台数は台数を超えない', () => {
    const rows: Record<string, unknown>[] = [];
    for (const spaces of [10, 40, 400]) {
      const sim = newSim(accessLayout({ parkingSpaces: spaces }), 'e1-park');
      forceMode(sim, 'car');
      // 切替先に送迎を許す（満車後の再抽選）。分担率 car=1 のままだと再抽選は dropoff 不可 → 'walk' へ落ちる
      const acc = sim.state.access!;
      acc.available = ['car', 'dropoff'];
      acc.shares.dropoff = 1; // 再抽選は ['dropoff','taxi','bus','rail','walk'] から
      acc.shares.car = 1;
      sim.state.now = 9 * H;
      const n = 100;
      let parked = 0;
      for (let i = 0; i < n; i++) {
        sim.state.now = 9 * H + i * 10;
        const g = fakeGroup(2);
        const d = accessDeparture(sim, g);
        if (g.mode === 'car') parked++;
        if (d >= M.parkingSearchMin * 60) expect(d).toBeGreaterThanOrEqual(M.parkingSearchMin * 60);
        expect(acc.parked.length).toBeLessThanOrEqual(spaces);
      }
      rows.push({ spaces, carGroups: acc.stats.carGroups, parkingFull: acc.stats.parkingFull, parkedCars: parked, peakParked: acc.stats.peakParked });
      expect(acc.stats.parkingFull).toBe(Math.max(0, acc.stats.carGroups - spaces));
    }
    logE('e1-parking', rows);
  });

  it('駐車台数 0 の駐車場だけでは自家用車が使えない（noCapacity）。駐車場なしなら noFacility', () => {
    const l = accessLayout({ parkingSpaces: 0 });
    const a = analyzeAccess(l, {});
    expect(a.modes.car.available).toBe(false);
    expect(a.modes.car.reason).toBe('noCapacity');
  });
});

describe('ID-e1 バス・鉄道・タクシー: 時間あたりの定員が上限として効く（A）。ただし 6 時間先で諦める挙動は known-issues', () => {
  it('バス（便数×50人/時）: 超過した出発グループは次の時間帯へ繰り延べ、transitFull と遅れが出る。便数を増やすと上限が動く', () => {
    const rows: Record<string, unknown>[] = [];
    for (const busesPerHour of [2, 4, 12]) {
      const sim = newSim(accessLayout({ bus: { busBays: 2, busesPerHour } }), 'e1-bus');
      forceMode(sim, 'bus');
      const acc = sim.state.access!;
      const cap = acc.busesPerHour * M.busSeats;
      sim.state.now = 10 * H;
      let maxDelay = 0;
      for (let i = 0; i < 100; i++) {
        sim.state.now = 10 * H + i * 30;
        maxDelay = Math.max(maxDelay, accessDeparture(sim, fakeGroup(3)));
      }
      const perHour = Object.entries(acc.hourly).filter(([k]) => k.startsWith('bus:')).map(([k, v]) => [k, v] as const);
      for (const [, v] of perHour) expect(v).toBeLessThanOrEqual(cap);
      rows.push({ busesPerHour: acc.busesPerHour, capPaxPerH: cap, paxIn100Groups: 300, transitFull: acc.stats.transitFull, maxDelayMin: r1(maxDelay / 60), hoursUsed: perHour.length });
    }
    logE('e1-bus-capacity', rows);
    expect((rows[0]!.transitFull as number)).toBeGreaterThan(rows[2]!.transitFull as number);
  });

  it('鉄道（本数×200人/時）: 同様に定員超過は次の時間帯へ。本数・列車種別（快速/特急）で運賃と所要は変わるが定員は本数×200 のまま', () => {
    const a = analyzeAccess(accessLayout({ rail: { trainsPerHour: 4, railService: 'express' } }), {});
    const b = analyzeAccess(accessLayout({ rail: { trainsPerHour: 4, railService: 'local' } }), {});
    expect(a.modes.rail.capacityPerHour).toBe(800);
    expect(b.modes.rail.capacityPerHour).toBe(800);
    expect(a.modes.rail.fare).toBeGreaterThan(b.modes.rail.fare); // 特急は運賃加算
    const sim = newSim(accessLayout({ rail: { trainsPerHour: 2 } }), 'e1-rail');
    forceMode(sim, 'rail');
    sim.state.now = 10 * H;
    for (let i = 0; i < 200; i++) { sim.state.now = 10 * H + i * 15; accessDeparture(sim, fakeGroup(3)); }
    const acc = sim.state.access!;
    for (const [k, v] of Object.entries(acc.hourly)) if (k.startsWith('rail:')) expect(v, k).toBeLessThanOrEqual(400);
    logE('e1-rail-capacity', { trainsPerH: 2, capPaxPerH: 400, transitFull: acc.stats.transitFull, hours: Object.keys(acc.hourly).filter((k) => k.startsWith('rail:')).length });
    expect(acc.stats.transitFull).toBeGreaterThan(0);
  });

  it('到着旅客の乗り場（待ち行列）の処理能力: タクシー=乗車枠×30人/時、バス=便数ごとに50人、列車=本数ごとに200人。実測処理量は analyzeAccess の capacityPerHour と一致', () => {
    const rows: Record<string, unknown>[] = [];
    for (const mode of ['taxi', 'bus', 'rail'] as const) {
      const sim = newSim(accessLayout({ bus: { busBays: 2, busesPerHour: 4 }, taxi: { berths: 4 }, rail: { trainsPerHour: 4 } }), `e1-q-${mode}`);
      forceMode(sim, mode);
      const model = analyzeAccess(sim.ctx.layout, {}).modes[mode].capacityPerHour!;
      const acc = sim.state.access!;
      sim.state.now = 12 * H;
      // 十分な待ち行列を作る（グループ 1 人ずつ、モデル容量の 3 倍）
      const total = model * 3;
      for (let i = 0; i < total; i++) {
        const g = fakeGroup(1);
        sim.state.paxGroups[g.id] = g;
        expect(accessArrival(sim, g)).toBe(true);
      }
      let served = 0;
      for (let t = 0; t < H; t++) {
        sim.state.now = 12 * H + t;
        served += stepAccess(sim).reduce((s, g) => s + g.count, 0);
      }
      rows.push({ mode, modelCapacityPerH: model, servedIn1h: served, queueLeft: acc.queues[mode].length });
      expect(Math.abs(served - model) / model, mode).toBeLessThan(0.25);
    }
    logE('e1-queue-throughput', rows);
  });

  it('[観測 C 疑い] 繰り延べは最大 6 時間先で諦め、その時間帯の定員を超えて受け入れる（docs/15 §3「空きのある次の時間帯まで待つ」）— tests/audit/known-issues/e_transitOverbook.repro.test.ts', () => {
    const sim = newSim(accessLayout({ bus: { busBays: 1, busesPerHour: 1 } }), 'e1-overbook');
    forceMode(sim, 'bus');
    sim.state.now = 10 * H;
    for (let i = 0; i < 40; i++) accessDeparture(sim, fakeGroup(5)); // 200 人 = 4 時間分
    const peak = Math.max(...Object.entries(sim.state.access!.hourly).filter(([k]) => k.startsWith('bus:')).map(([, v]) => v));
    logE('e1-overbook-probe', { capPaxPerH: M.busSeats, peakHourPax: peak });
    expect(peak).toBeLessThanOrEqual(M.busSeats); // 4 時間分は 6 時間窓に収まる（まだ超過しない）
  });
});

describe('ID-e1 RoadEdge.capacityPerHour（docs/34）: 車両のアクセス容量には使わない。歩行路の経路能力だけ使う', () => {
  it('一般道路の capacityPerHour を 1 / 99999 に変えても analyzeAccess（手段・分担率・容量）と運航ランタイムの値は不変。ダッシュボードの道路行は設定値を出すが「未算出」', () => {
    const res = [undefined, 1, 99999].map((cap) => {
      const l = accessLayout(cap === undefined ? {} : { roadCapacityPerHour: cap });
      const a = analyzeAccess(l, {});
      const sim = mkSim(l, 'e1-edgecap');
      const acc = sim.state.access!;
      return { modes: a.modes, road: a.roadCapacityPerHour, curb: a.curbCapacityPerHour, factor: a.factor, accRoad: acc.roadCapacity, shares: acc.shares, snap: analyzeAirportCapacity(sim.company!, sim.ctx) };
    });
    for (const r of res.slice(1)) {
      expect(r.modes).toEqual(res[0]!.modes);
      expect([r.road, r.curb, r.factor, r.accRoad]).toEqual([res[0]!.road, res[0]!.curb, res[0]!.factor, res[0]!.accRoad]);
      expect(r.shares).toEqual(res[0]!.shares);
    }
    const row = res[1]!.snap.facilities.find((f) => f.kind === '一般道路' && f.capacity === 1)!;
    expect(row.status).toBe('uncomputed');
    expect(row.demand).toBeNull();
    logE('e1-edgecap', { road: res[0]!.road, curb: res[0]!.curb, factor: r3(res[0]!.factor), unchangedFor: [1, 99999] });
  });

  it('同じ運航日の結果も、一般道路の capacityPerHour（1 / 99999）で一致する（旅客・手段・満車・遅れ）', () => {
    const runDay = (cap: number | undefined) => {
      const sim = createSimulation(accessLayout(cap === undefined ? {} : { roadCapacityPerHour: cap }), { seed: 'e1-edgeday', company: scaledCompany('e1-edgeday', 1) });
      runE(sim, 14 * H, 600, 'edgeday');
      return JSON.stringify({ s: sim.state.access!.stats, p: sim.state.paxStats });
    };
    expect(runDay(1)).toBe(runDay(undefined));
    expect(runDay(99999)).toBe(runDay(undefined));
  }, 120_000);

  function undergroundStation(walkCap: number) {
    let l = createSampleAirport();
    l = must(placeFacility(l, 'railStation', { x: 46, y: 58 }, { name: '地下駅', props: { level: -1, trainsPerHour: 4 } })).layout;
    l = must(addRoadPath(l, [{ x: 48, y: 61 }, { x: 48, y: 105 }], { roadClass: 'rail', level: -1 })).layout;
    l = must(addRoadPath(l, [{ x: 48, y: 55 }, { x: 48, y: 58 }], { roadClass: 'walkway', level: 0, capacityPerHour: walkCap })).layout;
    l = must(addRoadPath(l, [{ x: 48, y: 58 }, { x: 48, y: 60 }], { roadClass: 'walkway', level: -1, capacityPerHour: walkCap })).layout;
    const at = (level: number, y: number) => Object.values(l.roadNodes).find((n) => (n.level ?? 0) === level && n.pos.x === 48 && n.pos.y === y)!.id;
    const before = l;
    l = must(connectRoadLevels(l, at(0, 58), at(-1, 58), { roadClass: 'walkway', connectorKind: 'elevator', capacityPerHour: walkCap })).layout;
    return { before, l };
  }

  it('地下駅: 歩行コネクタがないと鉄道は使えず、あると使える。歩行路の最小能力 min(本数×200, 歩行路) がモデルの鉄道容量になる（docs/34）', () => {
    const rows: Record<string, unknown>[] = [];
    for (const walkCap of [100, 800, 5000]) {
      const { before, l } = undergroundStation(walkCap);
      expect(analyzeAccess(before, {}).modes.rail.available).toBe(false);
      const a = analyzeAccess(l, {});
      expect(a.modes.rail.available).toBe(true);
      expect(a.railWalkCapacityPerHour).toBe(walkCap);
      expect(a.modes.rail.capacityPerHour).toBe(Math.min(4 * M.trainSeats, walkCap));
      rows.push({ walkCap, modelRailCapacity: a.modes.rail.capacityPerHour, trainsPerHour: a.trainsPerHour });
    }
    logE('e1-underground-walkcap', rows);
  });

  it('[B] 歩行路能力が小さい地下駅: モデル(analyzeAccess)の鉄道容量は 100 人/時だが、運航ランタイムは本数×200=800 人/時で受け入れる（歩行路能力は運航に未接続）', () => {
    const { l } = undergroundStation(100);
    const model = analyzeAccess(l, {}).modes.rail.capacityPerHour!;
    const sim = mkSim(l, 'e1-walkcap');
    forceMode(sim, 'rail');
    const acc = sim.state.access!;
    sim.state.now = 10 * H;
    for (let i = 0; i < 80; i++) { sim.state.now = 10 * H + i * 40; accessDeparture(sim, fakeGroup(5)); }
    const hourly = Math.max(...Object.entries(acc.hourly).filter(([k]) => k.startsWith('rail:')).map(([, v]) => v));
    logE('e1-walkcap-vs-runtime', { modelRailCapacityPerH: model, runtimeRailCapacityPerH: acc.trainsPerHour * M.trainSeats, maxHourlyRailPax: hourly, classification: 'B' });
    expect(model).toBe(100);
    expect(hourly).toBeGreaterThan(model); // 運航は 100/時を超えて受け入れる
    expect(hourly).toBeLessThanOrEqual(acc.trainsPerHour * M.trainSeats);
  });
});

describe('ID-e1 鉄道の接続条件（docs/15 §1）', () => {
  it('線路が敷地外周まで届かないと駅は notConnected（鉄道は使えない）。届けば使える。駅→線路→外周以外の接続（道路との共有）は不可', () => {
    const short = analyzeAccess(accessLayout({ rail: { toEdge: false } }), {});
    expect(short.modes.rail.available).toBe(false);
    expect(short.modes.rail.reason).toBe('notConnected');
    const ok = analyzeAccess(accessLayout({ rail: {} }), {});
    expect(ok.modes.rail.available).toBe(true);
    // 駅だけで線路なし → notConnected
    let l = createSampleAirport();
    l = must(placeFacility(l, 'railStation', { x: 30, y: 58 }, { props: { trainsPerHour: 4 } })).layout;
    expect(analyzeAccess(l, {}).modes.rail.reason).toBe('notConnected');
    // 一般道路は鉄道とつながらない（種別ごとに別ネットワーク）: 駅を一般道路に接して置いても使えない
    let l2 = createSampleAirport();
    l2 = must(placeFacility(l2, 'railStation', { x: 50, y: 58 }, { props: { trainsPerHour: 4 } })).layout;
    expect(analyzeAccess(l2, {}).modes.rail.available).toBe(false);
  });

  it('地上駅（level 0）は歩行路なしでも「ターミナルから 16 タイル以内」で使える（旧ルール）。16 超は tooFar 相当で使えない。地上以外の階の駅は歩行路が必須', () => {
    expect(analyzeAccess(accessLayout({ rail: {} }), {}).modes.rail.available).toBe(true); // 距離 11 タイル
    // 遠い地上駅（x=4）: ターミナル(x=46)から 40 タイル
    let l = createSampleAirport();
    l = must(placeFacility(l, 'railStation', { x: 4, y: 58 }, { props: { trainsPerHour: 4 } })).layout;
    l = must(addRoadPath(l, [{ x: 6, y: 61 }, { x: 6, y: 105 }], { roadClass: 'rail' })).layout;
    const far = analyzeAccess(l, {});
    expect(far.modes.rail.available).toBe(false);
    // 地下駅で歩行路なし
    let u = createSampleAirport();
    u = must(placeFacility(u, 'railStation', { x: 46, y: 58 }, { props: { level: -1, trainsPerHour: 4 } })).layout;
    u = must(addRoadPath(u, [{ x: 48, y: 61 }, { x: 48, y: 105 }], { roadClass: 'rail', level: -1 })).layout;
    expect(analyzeAccess(u, {}).modes.rail.available).toBe(false);
    const st = Object.values(u.facilities).find((f) => f.kind === 'railStation')!;
    const term = Object.values(u.facilities).find((f) => f.kind === 'terminal')!;
    expect(findPedestrianRoute(u, st, term)).toBeNull();
  });

  it('鉄道を足すと分担率が割り振られ（car/dropoff が減る）、アクセス係数は増えるが 1.1 で飽和する。施設を足し続けても係数は 1.1 を超えない', () => {
    const base = analyzeAccess(accessLayout(), {});
    const rail = analyzeAccess(accessLayout({ rail: {} }), {});
    const all = analyzeAccess(accessLayout({ rail: {}, bus: {}, taxi: {} }), {});
    expect(rail.modes.rail.share).toBeGreaterThan(0);
    expect(rail.modes.car.share + rail.modes.dropoff.share).toBeLessThan(base.modes.car.share + base.modes.dropoff.share);
    expect(base.factor).toBeLessThan(rail.factor);
    expect(rail.factor).toBeLessThan(all.factor + 1e-9);
    expect(all.factor).toBeLessThanOrEqual(M.factor.max);
    expect(accessFactor(1e9)).toBeCloseTo(Math.min(M.factor.max, M.factor.floor + M.factor.span), 12);
    logE('e1-factor', { base: r3(base.factor), rail: r3(rail.factor), all: r3(all.factor), shares: { base: Object.fromEntries(Object.values(base.modes).map((m) => [m.mode, r3(m.share)])), all: Object.fromEntries(Object.values(all.modes).map((m) => [m.mode, r3(m.share)])) } });
  });
});

describe('ID-e1 都市モデル: アクセスと需要上限（docs/31）', () => {
  const company = (type: CityType, railQuality?: 0 | 1 | 2 | 3 | 4 | 5) => {
    const c = createSandboxCompany('e1-city');
    c.city = defaultCity(type);
    if (railQuality !== undefined) c.city.railQuality = railQuality;
    return c;
  };

  it('鉄道品質 0 の都市では駅があっても鉄道は利用不可（noService）。品質 1 で各停、2 で快速、3 で特急が使える', () => {
    const l = accessLayout({ rail: { railService: 'local' } });
    const q0 = analyzeAccess(l, { city: company('regional', 0).city });
    expect(q0.modes.rail.available).toBe(false);
    expect(q0.modes.rail.reason).toBe('noService');
    expect(analyzeAccess(l, { city: company('regional', 1).city }).modes.rail.available).toBe(true);
    const rapid = accessLayout({ rail: { railService: 'rapid' } });
    expect(analyzeAccess(rapid, { city: company('regional', 1).city }).modes.rail.available).toBe(false);
    expect(analyzeAccess(rapid, { city: company('regional', 2).city }).modes.rail.available).toBe(true);
    const exp = accessLayout({ rail: { railService: 'express' } });
    expect(analyzeAccess(exp, { city: company('regional', 2).city }).modes.rail.available).toBe(false);
    expect(analyzeAccess(exp, { city: company('regional', 3).city }).modes.rail.available).toBe(true);
  });

  it('需要上限: ceiling はアクセス係数で 0.7〜1.0 倍に変わる。上限が効く小都市では、アクセスが良いほど計画旅客が増える（ただし上限 ×1.0 まで）', () => {
    const city = defaultCity('regional');
    const lo = cityDemandCeiling(city, 0.3);
    const hi = cityDemandCeiling(city, 1.1);
    expect(hi / lo).toBeCloseTo(1 / 0.7, 9);
    const pax = (access: number) => {
      const c = company('regional');
      const plan = planDayWithDemand(c, 0, access);
      return plan.flights.reduce((s, f) => s + f.arrPax + f.depPax, 0);
    };
    const p03 = pax(0.3);
    const p10 = pax(1.0);
    const p11 = pax(1.1);
    logE('e1-city-demand', { ceilingLo: Math.round(lo), ceilingHi: Math.round(hi), plannedPax: { access03: p03, access10: p10, access11: p11 } });
    expect(p10).toBeGreaterThan(p03);
    expect(p11).toBeGreaterThanOrEqual(p10);
    // 都市なし: 計画旅客は搭乗率 × アクセス係数に比例（上限なし）
    const noCity = (access: number) => planDayWithDemand(createSandboxCompany('e1-city'), 0, access).flights.reduce((s, f) => s + f.arrPax + f.depPax, 0);
    expect(noCity(1.0)).toBeGreaterThan(noCity(0.3) * 2);
  });

  it('アクセスが需要を増やす経路: アクセス係数（道路なし 0.3 / サンプル ≈1.0 / 鉄道つき）→ planDay の旅客数。道路なしの空港では計画旅客が約 3 割', () => {
    const noRoad = createSampleAirport();
    for (const e of Object.values(noRoad.roads)) delete noRoad.roads[e.id];
    const fNo = analyzeAccess(noRoad, {}).factor;
    const fBase = analyzeAccess(accessLayout(), {}).factor;
    const fRail = analyzeAccess(accessLayout({ rail: {}, bus: {}, taxi: {} }), {}).factor;
    const total = (f: number) => planDayWithDemand(createSandboxCompany('e1-fac'), 0, f).flights.reduce((s, x) => s + x.depPax, 0);
    const t = [total(fNo), total(fBase), total(fRail)];
    logE('e1-access-to-demand', { factor: [r3(fNo), r3(fBase), r3(fRail)], plannedDepPax: t });
    expect(fNo).toBeCloseTo(M.factor.floor, 2); // 徒歩（遠方）だけが残る
    expect(t[0]).toBeLessThan(t[1]! * 0.45);
    expect(t[2]).toBeGreaterThanOrEqual(t[1]!);
  });
});

describe('ID-e1 通し運航（会社つき・1 日）: アクセス施設の容量が実際の遅れ・満車・乗り遅れに現れるか', () => {
  const SEEDS = ['e1-s1', 'e1-s2', 'e1-s3'];
  interface DayRes { missed: number; spawned: number; parkingFull: number; carGroups: number; roadDelayMin: number; transitFull: number; modePax: Record<string, number>; peakParked: number; wait: Record<string, number>; flights: number }
  function day(layout: ReturnType<typeof accessLayout>, seed: string, factor: number): DayRes {
    const sim = createSimulation(layout, { seed, company: scaledCompany(seed, factor) });
    // 06:00 開始、締め（24:00）の少し前まで。統計は日次締めでリセットされるため直前で読む
    runE(sim, 17 * H + 3000, 1200, `day ${seed}`);
    const s = sim.state.access!.stats;
    const wait: Record<string, number> = {};
    for (const m of ['taxi', 'bus', 'rail'] as const) wait[m] = s.waitPax[m] ? r1(s.waitSum[m] / s.waitPax[m] / 60) : 0;
    return { missed: sim.state.paxStats.missed, spawned: sim.state.paxStats.spawned, parkingFull: s.parkingFull, carGroups: s.carGroups, roadDelayMin: r3(s.roadDelayN ? s.roadDelaySum / s.roadDelayN : 0), transitFull: s.transitFull, modePax: s.pax, peakParked: s.peakParked, wait, flights: sim.state.stats.departures };
  }

  it('駐車場 400→20 台: 満車が発生し、鉄道・バス・タクシーを足すと自家用車の比率が下がり満車が減る（上限が動く）。3 seed', () => {
    const rows: Record<string, unknown>[] = [];
    for (const seed of SEEDS) {
      const base = day(accessLayout(), seed, 1);
      const small = day(accessLayout({ parkingSpaces: 20 }), seed, 1);
      const multi = day(accessLayout({ parkingSpaces: 20, rail: {}, bus: {}, taxi: {} }), seed, 1);
      rows.push({ seed, base, small, multi });
      expect(base.parkingFull, seed).toBe(0);
      expect(small.parkingFull, seed).toBeGreaterThan(0);
      expect(small.peakParked, seed).toBeLessThanOrEqual(20 + 0);
      expect(multi.modePax.rail! + multi.modePax.bus! + multi.modePax.taxi!, seed).toBeGreaterThan(0);
      expect(multi.carGroups, seed).toBeLessThan(small.carGroups);
    }
    logE('e1-day-parking-and-transit', rows);
  }, 300_000);

  it('バスだけが手段のとき（分担率を bus=1 に固定、同じ日の計画）: 便数 1/時（50人/時）では出発旅客が繰り延べで乗り遅れる。12/時に増やすと乗り遅れが消える（上限が動く）', () => {
    const run = (busesPerHour: number) => {
      const sim = createSimulation(accessLayout({ bus: { busBays: 2, busesPerHour } }), { seed: 'e1-busonly', company: scaledCompany('e1-busonly', 1) });
      forceMode(sim, 'bus');
      runE(sim, 17 * H + 3000, 1200, `busonly ${busesPerHour}`);
      const s = sim.state.access!.stats;
      return { busesPerHour, capPaxPerH: busesPerHour * M.busSeats, spawned: sim.state.paxStats.spawned, missed: sim.state.paxStats.missed, transitFull: s.transitFull, busWaitMin: s.waitPax.bus ? r1(s.waitSum.bus / s.waitPax.bus / 60) : 0 };
    };
    const low = run(1);
    const high = run(12);
    logE('e1-day-bus-only', { low, high });
    expect(low.transitFull).toBeGreaterThan(high.transitFull);
    expect(low.missed).toBeGreaterThan(high.missed);
  }, 300_000);

  it('需要 ×1 と ×2（同じ施設・同じ seed）: 道路の遅れ・満車・乗り遅れの増え方を測る。道路 900 台/時は 1 滑走路・9 スポットの空港では最大需要でも飽和しない（観測）', () => {
    const rows: Record<string, unknown>[] = [];
    for (const seed of SEEDS.slice(0, 2)) {
      const x1 = day(accessLayout(), seed, 1);
      const x2 = day(accessLayout(), seed, 2);
      rows.push({ seed, x1, x2 });
      expect(x2.spawned, seed).toBeGreaterThan(x1.spawned);
      expect(x2.roadDelayMin, seed).toBeGreaterThanOrEqual(x1.roadDelayMin - 1e-9);
    }
    logE('e1-day-demand-sweep', rows);
  }, 300_000);
});
