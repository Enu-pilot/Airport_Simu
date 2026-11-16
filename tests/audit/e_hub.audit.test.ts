/**
 * 監査 e / PART 5: ハブ機能（乗継旅客・ターミナル間移動・ターミナル内の上下移動・波状の運航）。
 * 文書: docs/09_roadmap.md:155 / :171（乗継旅客は未実装）、docs/35_multi_terminal_passenger_flow.md:24,142（乗継需要の生成規則は別途仕様化）、
 *       docs/34_vertical_transport.md（スポット変更時のみターミナル間を歩く。上下移動設備は時間帯別能力で待機。到着・乗継への適用は未実装）。
 * 分類 D = 文書で未実装、E = 仕様なし。測定値は `[audit-e]` 行。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addSecondTerminal } from './b_helpers';
import { analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { createSandboxCompany } from '../../src/core/economy/company';
import { addTerminalTransitLink, deleteEntity, placeTerminalArea, updateEntity } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { reassignStand } from '../../src/core/sim/disruptions';
import { checkInvariants, checkPaxInvariants } from '../../src/core/sim/invariants';
import { SIM_START_SEC as T0 } from '../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { findTerminalTransferRoute } from '../../src/core/terminal/interTerminal';
import { terminalLinkCapacityPerHour } from '../../src/core/terminal/model';
import type { AirportLayout } from '../../src/core/model/types';
import { logE, manual, meanOf, H, r1 } from './e_helpers';
import { must } from '../unit/helpers';

/** スポット変更の時刻（出発 75 分前（着陸の 25 分前。着陸準備に入った機は割当済みのスポットが優先され変更が効かない: known-issues/e_reassignHome）: 出発旅客の大半がすでにターミナル B の中にいる）。それより前の変更は旅客が空港に着く前なので歩かない */
const SWITCH_REL = 5 * H - 75 * 60;
/** 変更できるのは着陸前の機だけ（reassignStand）。出発 5 時間後の便に対し、到着は出発 50 分前（折り返し 45 分 + 余裕）にしておく */
const ARRIVE_REL = 5 * H - 50 * 60;
const groupsOf = (sim: Simulation, flightId: string) => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);

function grep(dir: string, re: RegExp): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (re.test(l)) hits.push(`${p.replace(process.cwd() + '/', '')}:${i + 1}`); });
    }
  };
  walk(join(process.cwd(), dir));
  return hits;
}

describe('ID-e5 乗継旅客・乗継手荷物・最小乗継時間（D: 文書で未実装）', () => {
  it('静的: 乗継（connecting / MCT / minimumConnection）の語が sim・terminal・economy にない。transfer は「ターミナル間リンク」と「バス乗り継ぎ時間」だけ', () => {
    for (const re of [/connecting/i, /minimumConnection|minConnect|\bMCT\b/i, /乗継|乗り継ぎ/, /transferPax|transferBag|transferPassenger/i, /interline/i]) expect(grep('src/core/sim', re), String(re)).toEqual([]);
    for (const re of [/connecting/i, /minimumConnection|minConnect|\bMCT\b/i]) expect(grep('src/core/economy', re), String(re)).toEqual([]);
    const transfer = grep('src/core', /transfer/i).filter((h) => !/interTerminal|terminal\/model|layout\/operations|io\/|validation|apronBus|busRules|passengers|economy\/capacity|model\/types|layout\/|sim\/types|invariants|disruptions/.test(h));
    logE('e5-grep-transfer', { outsideTerminalLinkCode: transfer });
  });

  it('運航 3 時間（サンプル空港・自動計画）: すべての到着グループの手順は claim/exit のみで出口（landside）から退出する。すべての出発グループは保安検査・搭乗を含み、最初は空港外（toAirport）から始まる。到着旅客が出発便に紐づく例はない', () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'e5-nohub', settings: { flightsPerDay: 60 } });
    for (let i = 0; i < 4 * H; i++) {
      stepSimulation(sim);
      if (i % 300 === 0) expect(checkInvariants(sim)).toEqual([]);
    }
    const groups = Object.values(sim.state.paxGroups);
    const arr = groups.filter((g) => g.direction === 'arrival');
    const dep = groups.filter((g) => g.direction === 'departure');
    expect(arr.length).toBeGreaterThan(50);
    expect(dep.length).toBeGreaterThan(50);
    for (const g of arr) {
      expect(g.steps.every((s) => s === 'claim' || s === 'exit'), g.id).toBe(true);
      expect(g.steps.at(-1), g.id).toBe('exit');
      expect(sim.state.flights[g.flightId]!.direction, g.id).toBe('arrival');
    }
    for (const g of dep) {
      expect(g.steps, g.id).toContain('security');
      expect(g.steps.at(-1), g.id).toBe('gate');
      expect(sim.state.flights[g.flightId]!.direction, g.id).toBe('departure');
    }
    const exited = arr.filter((g) => g.state === 'exited').length;
    logE('e5-pax-flow', { arrivalGroups: arr.length, arrivalExited: exited, arrivalOther: arr.length - exited, departureGroups: dep.length, withTargetTerminal: groups.filter((g) => g.targetTerminalId).length });
    expect(groups.filter((g) => g.targetTerminalId).length).toBe(0); // スポット変更なし → ターミナル間移動は 0
  }, 300_000);
});

/** 2 ターミナル。std_1(fac_3) は B に接続、std_2(fac_4) は A。A↔B の出発区域に連絡通路（能力 cap 人/時）を引く（b_levelLinks と同形） */
function transferLayout(cap: number | undefined, kind: 'walkway' | 'movingWalkway' = 'walkway', travelSec = 120) {
  const tt = addSecondTerminal(createSampleAirport());
  let l = must(updateEntity(tt.layout, 'fac_3', { props: { ...tt.layout.facilities.fac_3!.props, connectedTo: tt.t2 } })).layout;
  const waiting = (t: string) => Object.values(l.terminalAreas).find((a) => a.terminalId === t && a.kind === 'waiting')!.id;
  const linked = must(addTerminalTransitLink(l, { kind, fromAreaId: waiting(tt.t2), toAreaId: waiting(tt.t1), distanceM: 250, travelSec, ...(cap !== undefined ? { capacityPerHour: cap } : {}), bidirectional: true, allowedZones: ['departure'] }));
  l = linked.layout;
  return { ...tt, layout: l, linkId: Object.keys(l.terminalLinks ?? {})[0]!, areaB: waiting(tt.t2), areaA: waiting(tt.t1) };
}

describe('ID-e5 ターミナル間連絡通路の能力: スポット変更で別ターミナルへ移る出発旅客の通過量（これが唯一のターミナル間移動）', () => {
  it('通路能力 cap = 20 / 60 / 200 / 1000 人/時: 170 人の便を出発の 75 分前（着陸前）にスポット変更（B→A）。通路の時間帯予約は cap を超えず、cap が小さいほど乗り遅れが増える（通路の能力が実運航の乗り遅れを決める）', () => {
    const rows: Record<string, unknown>[] = [];
    for (const cap of [20, 60, 200, 1000]) {
      const { layout, linkId } = transferLayout(cap);
      const sim = createSimulation(layout, { seed: 'e5-link', settings: manual });
      const ac = addTurnaround(sim, 'narrow180', T0 + ARRIVE_REL, { departureAt: T0 + 5 * H, plan: { contractId: 'e5', destinationId: 'north', arrPax: 100, depPax: 170, standId: 'std_1', seats: 180 } });
      const dep = sim.state.flights[ac.departureFlightId]!;
      let switched = false;
      let maxUsage = 0;
      const usedLink = new Set<string>();
      for (let i = 0; i < 6 * H; i++) {
        if (!switched && sim.state.now >= T0 + SWITCH_REL) { expect(reassignStand(sim, ac.id, 'std_2')).toEqual({ ok: true }); switched = true; }
        stepSimulation(sim);
        if (i % 30 === 0) for (const g of groupsOf(sim, dep.id)) if (g.terminalLinkId || g.terminalLinkWaitingId || g.targetTerminalId) usedLink.add(g.id);
        maxUsage = Math.max(maxUsage, sim.state.terminalTransit?.passengersByLink[linkId] ?? 0);
        if (i % 60 === 0) expect(checkInvariants(sim), `cap=${cap}`).toEqual([]);
      }
      const moved = usedLink.size;
      rows.push({ cap, booked: dep.pax.booked, boarded: dep.pax.boarded, missed: dep.pax.missed, maxHourlyReservation: maxUsage, groupsThatUsedLink: moved, depDelaySec: (dep.block ?? 0) - dep.scheduled });
      expect(maxUsage, `cap=${cap}`).toBeLessThanOrEqual(cap);
      expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
      expect(checkPaxInvariants(sim, true)).toEqual([]);
    }
    logE('e5-link-capacity', rows);
    expect(rows.every((r) => (r.groupsThatUsedLink as number) > 0)).toBe(true); // 通路が実際に使われた
    expect((rows[0]!.missed as number)).toBeGreaterThanOrEqual(rows[3]!.missed as number);
    expect((rows[0]!.missed as number)).toBeGreaterThan(rows[3]!.missed as number);
  }, 600_000);

  it('通路の種別と能力の既定値: 能力未指定は幅×200 人/時。動く歩道（travelSec 小）は歩道より速いが、能力は同じ規則。ダッシュボードの通路行は設定能力を出し、利用状況・使用率は「未算出」。findTerminalTransferRoute は能力を返す（計画 API）', () => {
    const walk = transferLayout(undefined, 'walkway', 120);
    const moving = transferLayout(undefined, 'movingWalkway', 60);
    const lw = Object.values(walk.layout.terminalLinks!)[0]!;
    const lm = Object.values(moving.layout.terminalLinks!)[0]!;
    expect(terminalLinkCapacityPerHour(lw)).toBe(terminalLinkCapacityPerHour(lm));
    const sim = createSimulation(moving.layout, { seed: 'e5-dash', settings: manual, company: createSandboxCompany('e5-dash') });
    const snap = analyzeAirportCapacity(sim.company!, sim.ctx);
    const row = snap.facilities.find((f) => f.id === lm.id)!;
    expect([row.unit, row.status, row.demand]).toEqual(['pax/h', 'uncomputed', null]);
    expect(row.capacity).toBe(lm.capacityPerHour ?? null); // [B] 能力未指定の通路: ダッシュボードは null（未設定）、運航は幅×200=1200 人/時を適用
    const rw = findTerminalTransferRoute(walk.layout, { fromAreaId: walk.areaB, toAreaId: walk.areaA, zone: 'departure' });
    const rm = findTerminalTransferRoute(moving.layout, { fromAreaId: moving.areaB, toAreaId: moving.areaA, zone: 'departure' });
    logE('e5-link-kinds', { defaultCapacityPerH: terminalLinkCapacityPerHour(lw), dashboardRowCapacity: row.capacity, routeWalkway: rw ? { sec: rw.travelSec, cap: (rw as unknown as { capacityPerHour?: number }).capacityPerHour ?? null } : null, routeMoving: rm ? { sec: rm.travelSec } : null });
    expect(rw).not.toBeNull();
    expect(rm!.travelSec).toBeLessThan(rw!.travelSec);
  });

  it('ターミナル間リンクが無い 2 ターミナルでスポットを B→A に変更: 出発旅客は移動できず乗り遅れる（連絡設備がないと別ターミナルへ行けない）。能力の問題ではなく設備なしの限界', () => {
    const tt = addSecondTerminal(createSampleAirport());
    const l = must(updateEntity(tt.layout, 'fac_3', { props: { ...tt.layout.facilities.fac_3!.props, connectedTo: tt.t2 } })).layout;
    const sim = createSimulation(l, { seed: 'e5-nolink', settings: manual });
    const ac = addTurnaround(sim, 'narrow180', T0 + ARRIVE_REL, { departureAt: T0 + 5 * H, plan: { contractId: 'e5', destinationId: 'north', arrPax: 100, depPax: 170, standId: 'std_1', seats: 180 } });
    const dep = sim.state.flights[ac.departureFlightId]!;
    let switched = false;
    for (let i = 0; i < 6 * H; i++) {
      if (!switched && sim.state.now >= T0 + SWITCH_REL) { expect(reassignStand(sim, ac.id, 'std_2')).toEqual({ ok: true }); switched = true; }
      stepSimulation(sim);
      if (i % 120 === 0) expect(checkInvariants(sim)).toEqual([]);
    }
    logE('e5-no-link', { booked: dep.pax.booked, boarded: dep.pax.boarded, missed: dep.pax.missed });
    expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
    expect(dep.pax.missed).toBeGreaterThan(0);
  }, 300_000);
});

describe('ID-e5 ターミナル内の上下移動（エスカレーター = ta_5）の能力: 保安検査・ゲートまでの流れと乗り遅れ', () => {
  /** 6 便（各 170 人）を同時刻に出発させる。出発旅客はすべて 1F の入口 → 上下移動設備 → 2F の手続きへ */
  function bunched(layout: AirportLayout, seed: string) {
    const sim = createSimulation(layout, { seed, settings: manual });
    const acs = Array.from({ length: 6 }, (_, i) => addTurnaround(sim, 'narrow180', T0 + 30 * 60 + i * 60, { departureAt: T0 + 4 * H, plan: { contractId: 'e5v', destinationId: 'north', arrPax: 100, depPax: 170, standId: `std_${i + 1}`, seats: 180 } }));
    for (let i = 0; i < 6 * H; i++) {
      stepSimulation(sim);
      if (i % 120 === 0) expect(checkInvariants(sim), seed).toEqual([]);
    }
    const flights = acs.map((a) => sim.state.flights[a.departureFlightId]!);
    const groups = flights.flatMap((f) => groupsOf(sim, f.id));
    const reasons: Record<string, number> = {};
    for (const g of groups) if (g.state === 'missed') reasons[g.reason ?? '?'] = (reasons[g.reason ?? '?'] ?? 0) + g.count;
    const stepFree = groups.filter((g) => g.stepFree);
    return {
      sim, booked: flights.reduce((s, f) => s + f.pax.booked, 0), boarded: flights.reduce((s, f) => s + f.pax.boarded, 0), missed: flights.reduce((s, f) => s + f.pax.missed, 0), reasons,
      meanWaitSec: Math.round(meanOf(groups.filter((g) => g.state === 'boarded').map((g) => g.waitSec))), meanWalkSec: Math.round(meanOf(groups.filter((g) => g.state === 'boarded').map((g) => g.walkSec))),
      stepFreeGroups: stepFree.length, stepFreeMissed: stepFree.filter((g) => g.state === 'missed').length, maxDelay: Math.max(...flights.map((f) => (f.block ?? 0) - f.scheduled)),
    };
  }
  const withEscalator = (cap: number) => must(updateEntity(createSampleAirport(), 'ta_5', { props: { ...createSampleAirport().terminalAreas.ta_5!.props, capacityPerHour: cap } })).layout;

  it('上下移動設備の能力 150 / 600 / 2400 人/時: 能力が小さいと待ち・乗り遅れが増える（A: 能力は実運航の律速になる）。保存則（搭乗+乗り遅れ=予約）と不変条件を維持', () => {
    const rows: Record<string, unknown>[] = [];
    for (const cap of [150, 600, 2400]) {
      const r = bunched(withEscalator(cap), 'e5-esc');
      rows.push({ capPerH: cap, booked: r.booked, boarded: r.boarded, missed: r.missed, missReasons: r.reasons, meanWaitSec: r.meanWaitSec, meanWalkSec: r.meanWalkSec, maxDepDelaySec: r.maxDelay });
      expect(r.boarded + r.missed).toBe(r.booked);
      expect(checkPaxInvariants(r.sim, true)).toEqual([]);
    }
    logE('e5-vertical-capacity', rows);
    expect((rows[0]!.missed as number)).toBeGreaterThan(rows[2]!.missed as number);
    expect((rows[0]!.meanWaitSec as number)).toBeGreaterThanOrEqual(rows[2]!.meanWaitSec as number);
  }, 600_000);

  it('段差なし必須のグループ（約 5%）: 階段を経路から除外する仕様（docs/34）。エスカレーターは段差なし扱いで到達できる。階段だけの空港では 2F へ行けず乗り遅れ、エレベーターを足すと到達できる', () => {
    const escalator = bunched(createSampleAirport(), 'e5-stepfree');
    let l = createSampleAirport();
    const t = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    l = must(deleteEntity(l, 'ta_5')).layout;
    const stairsOnly = must(placeTerminalArea(l, t.id, 0, 'stairs', { x: 86, y: 52 }, { w: 4, h: 2, name: '階段' })).layout;
    const withLift = must(placeTerminalArea(stairsOnly, t.id, 0, 'elevator', { x: 82, y: 52 }, { w: 2, h: 2, name: 'エレベーター' })).layout;
    const rs = bunched(stairsOnly, 'e5-stepfree');
    const rl = bunched(withLift, 'e5-stepfree');
    const pick = (r: ReturnType<typeof bunched>) => ({ stepFreeGroups: r.stepFreeGroups, stepFreeMissed: r.stepFreeMissed, missed: r.missed, reasons: r.reasons });
    logE('e5-step-free', { escalator: pick(escalator), stairsOnly: pick(rs), stairsPlusElevator: pick(rl) });
    expect(escalator.stepFreeGroups).toBeGreaterThan(0);
    expect(escalator.stepFreeMissed).toBe(0);
    expect(rs.stepFreeMissed).toBeGreaterThan(0);
    expect(rl.stepFreeMissed).toBeLessThan(rs.stepFreeMissed);
    expect(rl.boarded + rl.missed).toBe(rl.booked);
  }, 600_000);
});

describe('ID-e5 波状運航（バンク）: 30 分に 8 機到着 → 60 分後に 8 機出発（サンプル 1 ターミナル vs 2 ターミナル + 連絡通路）', () => {
  function bank(layout: AirportLayout, seed: string, homeSwitch = false) {
    const sim = createSimulation(layout, { seed, settings: manual });
    const acs = Array.from({ length: 8 }, (_, i) => {
      const arr = T0 + 30 * 60 + i * 225;
      return addTurnaround(sim, 'narrow180', arr, { departureAt: T0 + 30 * 60 + 1800 + 3600 + i * 225, plan: { contractId: 'e5b', destinationId: 'north', arrPax: 150, depPax: 150, standId: `std_${i + 1}`, seats: 180 } });
    });
    void homeSwitch;
    for (let i = 0; i < 6 * H; i++) {
      stepSimulation(sim);
      if (i % 120 === 0) {
        const v = checkInvariants(sim);
        if (v.length) throw new Error(`bank ${seed} t=${sim.state.now}: ${v.slice(0, 3).join(' / ')}`);
      }
    }
    const dep = acs.map((a) => sim.state.flights[a.departureFlightId]!);
    const arrF = acs.map((a) => sim.state.flights[a.arrivalFlightId]!);
    const biggestQueue = Object.entries(sim.state.facilities).map(([id, f]) => ({ id, kind: sim.ctx.terminal.areas[id]?.kind ?? id.slice(0, 4), maxQueue: f.maxQueue, meanWaitSec: f.served ? Math.round(f.waitTotal / f.served) : 0 })).sort((x, y) => y.maxQueue - x.maxQueue).slice(0, 4);
    return {
      sim,
      booked: dep.reduce((s, f) => s + f.pax.booked, 0), boarded: dep.reduce((s, f) => s + f.pax.boarded, 0), missed: dep.reduce((s, f) => s + f.pax.missed, 0),
      meanDepDelaySec: Math.round(meanOf(dep.map((f) => (f.block ?? 0) - f.scheduled))), maxDepDelaySec: Math.max(...dep.map((f) => (f.block ?? 0) - f.scheduled)),
      arrivalPaxExited: arrF.reduce((s, f) => s + f.pax.deplaned, 0), biggestQueue,
      landed: arrF.filter((f) => f.status !== 'scheduled').length, groundSec: Math.round(meanOf(acs.map((a) => (a.history.find((h) => h.state === 'takeoff')?.t ?? 0) - (a.history.find((h) => h.state === 'docking')?.t ?? 0)))),
    };
  }

  it('バンク運航の遅れ・乗り遅れ・律速施設（待ち行列の最大）を 3 seed で測る。単一ターミナルと、半分のスポットを別ターミナル（連絡通路 600 人/時）に置いた配置の比較。不変条件・保存則を維持', () => {
    const rows: Record<string, unknown>[] = [];
    for (const seed of ['e5-b1', 'e5-b2', 'e5-b3']) {
      const one = bank(createSampleAirport(), seed);
      const two = bank(transferLayout(600).layout, seed);
      for (const r of [one, two]) {
        expect(r.boarded + r.missed, seed).toBe(r.booked);
        expect(checkPaxInvariants(r.sim, true), seed).toEqual([]);
        expect(r.landed, seed).toBe(8);
      }
      rows.push({
        seed,
        single: { missed: one.missed, meanDepDelaySec: one.meanDepDelaySec, maxDepDelaySec: one.maxDepDelaySec, groundSec: one.groundSec, queues: one.biggestQueue },
        twoTerminals: { missed: two.missed, meanDepDelaySec: two.meanDepDelaySec, maxDepDelaySec: two.maxDepDelaySec, groundSec: two.groundSec, queues: two.biggestQueue },
      });
    }
    logE('e5-bank', rows);
    expect(rows.length).toBe(3);
  }, 900_000);
});

void r1;
