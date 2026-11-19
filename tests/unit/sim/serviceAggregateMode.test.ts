import { describe, expect, it } from 'vitest';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { serviceAggregateUsage } from '../../../src/core/sim/serviceAggregate';
import { layoutWithShops } from '../serviceFixture';
import { runUntil } from './helpers';

/**
 * 5-19 T12: 空港運営モードのカテゴリ集約方式。
 * 集約方式では店舗エリアへ個別に移動せず（グループの現在エリアが店舗になることがない）、
 * カテゴリ単位の利用実績が立ち、搭乗結果は詳細方式と同等に成立すること。
 * 既定（detailed）の挙動は従来どおり店舗へ実際に移動すること。
 */

const manual = { autoSchedule: false };

function runScenario(granularity: 'detailed' | 'aggregate'): { sim: Simulation } {
  const { layout } = layoutWithShops();
  const sim = createSimulation(layout, {
    seed: 'svc-mode', settings: manual, serviceGranularity: granularity,
  });
  const standId = Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;
  const t0 = sim.state.now;
  const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
    departureAt: t0 + 220 * 60,
    plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 },
  });
  runUntil(sim, () => ac.state === 'departed', 10 * 3600);
  return { sim };
}

describe('空港運営モードの店舗粒度（T12）', () => {
  it('集約方式: 店舗利用がカテゴリ実績として立ち、便は正常に完了する', () => {
    const { sim } = runScenario('aggregate');
    const usage = serviceAggregateUsage(sim);
    const totalUsers = [...usage.values()].reduce((s, u) => s + u.users, 0);
    expect(totalUsers).toBeGreaterThan(0);
    const totalRevenue = [...usage.values()].reduce((s, u) => s + u.revenue, 0);
    expect(totalRevenue).toBeGreaterThan(0);
    expect(sim.state.paxStats.boarded).toBeGreaterThan(0);
  });

  it('集約方式では旅客グループが店舗エリアに滞在しない（個別立寄りをしない）', () => {
    const { layout, shop, restaurant } = layoutWithShops();
    const sim = createSimulation(layout, { seed: 'svc-mode-2', settings: manual, serviceGranularity: 'aggregate' });
    const standId = Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;
    const t0 = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 220 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 },
    });
    const shopSet = new Set([shop, restaurant]);
    let ticks = 0;
    while (ac.state !== 'departed' && ticks < 10 * 3600) {
      stepSimulation(sim);
      ticks++;
      if (ticks % 30 === 0) {
        for (const g of Object.values(sim.state.paxGroups)) {
          expect(shopSet.has(g.area ?? '')).toBe(false);
          expect(g.facility !== null && shopSet.has(g.facility)).toBe(false);
        }
      }
    }
    expect(ac.state).toBe('departed');
  });

  it('詳細方式（既定）では従来どおり店舗エリアを使うグループがいる', () => {
    const { layout, shop, restaurant } = layoutWithShops();
    const sim = createSimulation(layout, { seed: 'svc-mode-3', settings: manual });
    expect(sim.serviceGranularity).toBe('detailed');
    const standId = Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;
    const t0 = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 220 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 },
    });
    const shopSet = new Set([shop, restaurant]);
    let seenAtShop = false;
    let ticks = 0;
    while (ac.state !== 'departed' && ticks < 10 * 3600) {
      stepSimulation(sim);
      ticks++;
      for (const g of Object.values(sim.state.paxGroups)) {
        if ((g.area && shopSet.has(g.area)) || (g.facility && shopSet.has(g.facility))) seenAtShop = true;
      }
    }
    expect(ac.state).toBe('departed');
    expect(seenAtShop).toBe(true);
  });

  it('集約方式は同一 seed で再現する', () => {
    const a = runScenario('aggregate');
    const b = runScenario('aggregate');
    const sum = (s: Simulation) => [...serviceAggregateUsage(s).values()].reduce((x, u) => x + u.users * 1000 + u.revenue, 0);
    expect(sum(b.sim)).toBe(sum(a.sim));
    expect(b.sim.state.paxStats.boarded).toBe(a.sim.state.paxStats.boarded);
  });
});
