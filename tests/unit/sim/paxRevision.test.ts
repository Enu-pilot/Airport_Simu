import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { initialGoals } from '../../../src/core/economy/goals';
import { placeTerminalArea, type OpResult } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import {
  LOUNGE_DWELL_MIN_TABLE,
  PAX_ARRIVAL_MIN,
  PAX_ARRIVAL_MIN_INTL,
  PAX_ARRIVAL_TABLE,
  PAX_GENERATE_LEAD_SEC,
  PAX_GENERATE_LEAD_SEC_BY_STAGE,
  drawLoungeDwellSec,
  paxScaleStage,
  paxScaleStageOfTier,
  pendingPaxOf,
} from '../../../src/core/sim/passengers';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import type { PaxGroup } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { domTransferAirport } from '../transferLayout';
import { runUntil } from './helpers';

/**
 * 乗客生成の見直し（PAX-2〜PAX-4、設計書 design-PAX）の検証。
 * - PAX-2: 未出現グループの pending 分離（台帳 activePax には残り、毎 tick の走査からだけ外れる）
 * - PAX-3: 来港分布の規模連動（ステージ S/M/L）と生成リードの連動
 * - PAX-4: ラウンジ滞在の分布化（min(希望, slack)）と乗継グループの lounge ステップ
 * 運航結果の不変性そのものはゴールデン（PAX-2 段階で全件一致）で担保する。
 */

const manual = { autoSchedule: false };

function layoutWithLounge(seats = 40): { layout: AirportLayout; terminal: string; lounge: string } {
  let layout = createSampleAirport();
  const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  const r: OpResult = placeTerminalArea(layout, terminal, 1, 'lounge', { x: 82, y: 51 }, { w: 4, h: 2, name: 'ラウンジ', props: { seats } });
  const m = must(r);
  layout = m.layout;
  return { layout, terminal, lounge: m.created[0]! };
}

const standIdOf = (layout: AirportLayout): string =>
  Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;

const depGroupsOf = (sim: Simulation, flightId: string): PaxGroup[] =>
  (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);

describe('PAX-3: 規模ステージと分布表・生成リード', () => {
  it('格 → ステージは S(0〜2) / M(3〜4) / L(5〜7)', () => {
    expect([0, 1, 2].map(paxScaleStageOfTier)).toEqual(['S', 'S', 'S']);
    expect([3, 4].map(paxScaleStageOfTier)).toEqual(['M', 'M']);
    expect([5, 6, 7].map(paxScaleStageOfTier)).toEqual(['L', 'L', 'L']);
  });

  it('分布表: S は従来値と同一、M/L は設計書の表どおり', () => {
    expect(PAX_ARRIVAL_TABLE.S.domestic).toEqual(PAX_ARRIVAL_MIN);
    expect(PAX_ARRIVAL_TABLE.S.international).toEqual(PAX_ARRIVAL_MIN_INTL);
    expect(PAX_ARRIVAL_TABLE.M.domestic).toEqual({ earliest: 180, mode: 105, latest: 50 });
    expect(PAX_ARRIVAL_TABLE.M.international).toEqual({ earliest: 270, mode: 165, latest: 80 });
    expect(PAX_ARRIVAL_TABLE.L.domestic).toEqual({ earliest: 210, mode: 120, latest: 55 });
    expect(PAX_ARRIVAL_TABLE.L.international).toEqual({ earliest: 300, mode: 180, latest: 90 });
  });

  it('生成リード: S は従来どおり、M/L は国際 earliest + 30 分で左裾が潰れない', () => {
    expect(PAX_GENERATE_LEAD_SEC_BY_STAGE.S).toBe(PAX_GENERATE_LEAD_SEC);
    expect(PAX_GENERATE_LEAD_SEC_BY_STAGE.M).toBe((270 + 30) * 60);
    expect(PAX_GENERATE_LEAD_SEC_BY_STAGE.L).toBe((300 + 30) * 60);
    for (const stage of ['M', 'L'] as const) {
      // 生成時点で出現時刻が過去にならない（最早の出現でもリードより 30 分手前）
      expect(PAX_GENERATE_LEAD_SEC_BY_STAGE[stage] - PAX_ARRIVAL_TABLE[stage].international.earliest * 60).toBe(30 * 60);
    }
  });

  it('paxScaleStage: 会社のない運航は S、会社の格で決まる', () => {
    expect(paxScaleStage({ company: null } as unknown as Simulation)).toBe('S');
    expect(paxScaleStage({ company: { goals: { tier: 2 } } } as unknown as Simulation)).toBe('S');
    expect(paxScaleStage({ company: { goals: { tier: 4 } } } as unknown as Simulation)).toBe('M');
    expect(paxScaleStage({ company: { goals: { tier: 7 } } } as unknown as Simulation)).toBe('L');
    expect(paxScaleStage({ company: {} } as unknown as Simulation)).toBe('S');
  });

  it('ラウンジ滞在分布表: S/M は国内 [20,45,90]・国際 [30,60,120] 分、L 国際は [30,75,150] 分', () => {
    expect(LOUNGE_DWELL_MIN_TABLE.S.domestic).toEqual({ min: 20, mode: 45, max: 90 });
    expect(LOUNGE_DWELL_MIN_TABLE.S.international).toEqual({ min: 30, mode: 60, max: 120 });
    expect(LOUNGE_DWELL_MIN_TABLE.M).toEqual(LOUNGE_DWELL_MIN_TABLE.S);
    expect(LOUNGE_DWELL_MIN_TABLE.L.international).toEqual({ min: 30, mode: 75, max: 150 });
  });
});

describe('PAX-2: pending 分離', () => {
  it('生成直後の未出現グループは pending に入り、出現時刻を過ぎると外れる（台帳には残る）', { timeout: 300_000 }, () => {
    const layout = createSampleAirport();
    const sim = createSimulation(layout, { seed: 'pax-pending', settings: manual });
    const t0 = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 300 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 0, depPax: 120, standId: standIdOf(layout), seats: 180 },
    });
    const depF = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => depF.pax.generated, 4 * 3600);
    const groups = depGroupsOf(sim, depF.id);
    expect(groups.length).toBeGreaterThan(0);
    // S ステージの生成リードは従来どおり出発 180 分前
    expect(sim.state.now).toBeGreaterThanOrEqual(depF.scheduled - PAX_GENERATE_LEAD_SEC);
    // 全グループとも出現は生成時刻より未来 → 全員 pending、かつ台帳（activePax）にも残る
    const pending = pendingPaxOf(sim.state);
    expect(groups.every((g) => g.appearAt > sim.state.now)).toBe(true);
    expect(groups.map((g) => g.id).sort()).toEqual([...pending].sort());
    expect(groups.every((g) => sim.state.activePax.includes(g.id))).toBe(true);
    // 出発 40 分前（最遅の出現 = 45 分前も過ぎた）では pending は空になる
    runUntil(sim, () => sim.state.now >= depF.scheduled - 40 * 60, 4 * 3600);
    expect(pendingPaxOf(sim.state)).toEqual([]);
    expect(depGroupsOf(sim, depF.id).some((g) => g.state !== 'toAirport')).toBe(true);
  });
});

describe('PAX-3: 生成タイミングと出現分布の連動（実運航）', () => {
  it('S（会社なし）: 生成は出発 180 分前、出現は [45, 150] 分前の範囲', { timeout: 300_000 }, () => {
    const layout = createSampleAirport();
    const sim = createSimulation(layout, { seed: 'pax-stage-s', settings: manual });
    const t0 = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 300 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 0, depPax: 120, standId: standIdOf(layout), seats: 180 },
    });
    const depF = sim.state.flights[ac.departureFlightId]!;
    runUntil(sim, () => sim.state.now >= depF.scheduled - PAX_GENERATE_LEAD_SEC - 60, 4 * 3600);
    expect(depF.pax.generated).toBeFalsy();
    runUntil(sim, () => depF.pax.generated, 4 * 3600);
    for (const g of depGroupsOf(sim, depF.id)) {
      const before = depF.scheduled - g.appearAt;
      expect(before).toBeGreaterThanOrEqual(45 * 60);
      expect(before).toBeLessThanOrEqual(150 * 60);
    }
  });

  it('M（格 3）: 生成は出発 300 分前に早まり、出現は国内 [50, 180] 分前の範囲', { timeout: 300_000 }, () => {
    const layout = createSampleAirport();
    const company = createSandboxCompany('pax-stage-m');
    company.goals = { ...initialGoals(), tier: 3 };
    const sim = createSimulation(layout, { seed: 'pax-stage-m', settings: manual, company });
    const t0 = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 400 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 0, depPax: 120, standId: standIdOf(layout), seats: 180 },
    });
    const depF = sim.state.flights[ac.departureFlightId]!;
    // 従来リード（180 分前）より前に生成される
    runUntil(sim, () => depF.pax.generated, 6 * 3600);
    expect(sim.state.now).toBeLessThan(depF.scheduled - PAX_GENERATE_LEAD_SEC);
    expect(sim.state.now).toBeGreaterThanOrEqual(depF.scheduled - PAX_GENERATE_LEAD_SEC_BY_STAGE.M);
    for (const g of depGroupsOf(sim, depF.id)) {
      const before = depF.scheduled - g.appearAt;
      expect(before).toBeGreaterThanOrEqual(50 * 60);
      expect(before).toBeLessThanOrEqual(180 * 60);
    }
  });
});

describe('PAX-4: ラウンジ滞在の分布化', () => {
  it('滞在希望時間の引きは分布の範囲内に収まり、ばらつく', { timeout: 120_000 }, () => {
    const layout = createSampleAirport();
    const sim = createSimulation(layout, { seed: 'pax-dwell', settings: manual });
    const t0 = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 300 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 0, depPax: 10, standId: standIdOf(layout), seats: 180 },
    });
    const depF = sim.state.flights[ac.departureFlightId]!;
    const g = { flightId: depF.id } as PaxGroup;
    const domestic = Array.from({ length: 200 }, () => drawLoungeDwellSec(sim, g));
    expect(Math.min(...domestic)).toBeGreaterThanOrEqual(20 * 60);
    expect(Math.max(...domestic)).toBeLessThanOrEqual(90 * 60);
    expect(new Set(domestic).size).toBeGreaterThan(50);
    // 国際便扱いにすると国際の分布 [30, 120] 分になる
    depF.routeType = 'international';
    const intl = Array.from({ length: 200 }, () => drawLoungeDwellSec(sim, g));
    expect(Math.min(...intl)).toBeGreaterThanOrEqual(30 * 60);
    expect(Math.max(...intl)).toBeLessThanOrEqual(120 * 60);
  });

  it('集約方式: 滞在は min(希望, slack) で、希望 > slack の頭打ちが起きる', { timeout: 300_000 }, () => {
    const { layout } = layoutWithLounge(200);
    const sim = createSimulation(layout, { seed: 'lounge-ops', settings: manual, serviceGranularity: 'aggregate' });
    const t0 = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 220 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId: standIdOf(layout), seats: 180 },
    });
    const seen = new Map<string, { duration: number; planned: number }>();
    let ticks = 0;
    while (ac.state !== 'departed' && ticks < 10 * 3600) {
      stepSimulation(sim);
      ticks++;
      for (const g of Object.values(sim.state.paxGroups)) {
        if (g.aggService?.kind === 'lounge' && g.state === 'inService' && !seen.has(g.id)) {
          seen.set(g.id, { duration: (g.serviceUntil ?? sim.state.now) - sim.state.now, planned: g.plannedDwellSec! });
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const r of seen.values()) {
      expect(r.planned).toBeGreaterThanOrEqual(20 * 60);
      expect(r.planned).toBeLessThanOrEqual(90 * 60);
      expect(r.duration).toBeLessThanOrEqual(r.planned);
      expect(r.duration).toBeGreaterThan(0);
    }
    // 余裕が希望より短いグループでは頭打ち（duration < planned）が実際に起きる
    expect([...seen.values()].some((r) => r.duration < r.planned)).toBe(true);
  });

  it('詳細方式: 滞在時間は希望時間を超えず、下限 30 秒を下回らない', { timeout: 300_000 }, () => {
    const { layout, lounge } = layoutWithLounge(200);
    const sim = createSimulation(layout, { seed: 'lounge-ops', settings: manual, serviceGranularity: 'detailed' });
    const t0 = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 220 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId: standIdOf(layout), seats: 180 },
    });
    const seen = new Map<string, { duration: number; planned: number }>();
    let ticks = 0;
    while (ac.state !== 'departed' && ticks < 10 * 3600) {
      stepSimulation(sim);
      ticks++;
      for (const g of Object.values(sim.state.paxGroups)) {
        if (g.facility === lounge && g.state === 'inService' && !seen.has(g.id)) {
          seen.set(g.id, { duration: (g.serviceUntil ?? sim.state.now) - sim.state.now, planned: g.plannedDwellSec! });
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const r of seen.values()) {
      expect(r.planned).toBeGreaterThanOrEqual(20 * 60);
      expect(r.duration).toBeGreaterThanOrEqual(30);
      expect(r.duration).toBeLessThanOrEqual(Math.max(30, r.planned));
    }
  });
});

describe('PAX-4: 乗継グループの lounge ステップ', () => {
  it('DD 乗継: 一部のグループに lounge が shop/restroom の後・gate の前に入る', { timeout: 300_000 }, () => {
    let layout = domTransferAirport();
    const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
    const r: OpResult = placeTerminalArea(layout, terminal, 1, 'lounge', { x: 82, y: 51 }, { w: 4, h: 2, name: 'ラウンジ', props: { seats: 200 } });
    layout = must(r).layout;
    const sim = createSimulation(layout, { seed: 'xfer-lounge', settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'narrow180', t, {
      departureAt: t + 300 * 60,
      plan: { contractId: 'k-arr', destinationId: 'TYO', arrPax: 200, depPax: 0, standId: null },
    });
    const b = addTurnaround(sim, 'narrow180', t + 30 * 60, {
      departureAt: t + 170 * 60,
      plan: { contractId: 'k-dep', destinationId: 'OSA', arrPax: 0, depPax: 0, standId: null },
    });
    const arrF = sim.state.flights[a.arrivalFlightId]!;
    const depF = sim.state.flights[b.departureFlightId]!;
    arrF.transferPlan = [{ depFlightId: depF.id, pax: 160, kind: 'DD' }];
    depF.plannedTransferIn = 160;
    runUntil(sim, () => b.state === 'departed', 8 * 3600);
    const xg = depGroupsOf(sim, depF.id).filter((g) => g.transfer);
    expect(xg.length).toBeGreaterThan(3);
    const withLounge = xg.filter((g) => g.steps.includes('lounge'));
    expect(withLounge.length).toBeGreaterThan(0);
    for (const g of withLounge) {
      const li = g.steps.indexOf('lounge');
      expect(li).toBeLessThan(g.steps.indexOf('gate'));
      const shop = g.steps.indexOf('shop');
      const restroom = g.steps.indexOf('restroom');
      if (shop >= 0) expect(li).toBeGreaterThan(shop);
      if (restroom >= 0) expect(li).toBeGreaterThan(restroom);
    }
    // 乗継自体は従来どおり成立する
    expect(depF.pax.boarded).toBe(160);
  });
});
