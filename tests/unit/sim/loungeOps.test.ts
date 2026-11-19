import { describe, expect, it } from 'vitest';
import { placeTerminalArea, type OpResult } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { serviceAggregateUsage } from '../../../src/core/sim/serviceAggregate';
import { must } from '../helpers';
import { runUntil } from './helpers';

/**
 * 5-19 2A の残件: ラウンジの運営モード（AirportDay）接続。
 * - 詳細・集約の両方式で、出発旅客の一部が搭乗開始までラウンジに滞留し、
 *   利用実績（人数・滞在人秒）がカテゴリキー `${terminalId}|lounge` に立つこと。
 * - ラウンジのない空港では実績が立たず、従来どおり運航できること。
 * - 満席のときは待合へフォールバックし、搭乗自体は成立すること。
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

function runScenario(layout: AirportLayout, granularity: 'detailed' | 'aggregate', seed = 'lounge-ops'): Simulation {
  const sim = createSimulation(layout, { seed, settings: manual, serviceGranularity: granularity });
  const standId = Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;
  const t0 = sim.state.now;
  const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
    departureAt: t0 + 220 * 60,
    plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 },
  });
  runUntil(sim, () => ac.state === 'departed', 10 * 3600);
  return sim;
}

describe('ラウンジの運営モード接続（2A 残件）', () => {
  it.each(['detailed', 'aggregate'] as const)('%s 方式: ラウンジ利用実績が立ち、便は正常に完了する', (granularity) => {
    const { layout, terminal } = layoutWithLounge(40);
    const sim = runScenario(layout, granularity);
    const usage = serviceAggregateUsage(sim);
    const lounge = usage.get(`${terminal}|lounge`);
    expect(lounge).toBeDefined();
    expect(lounge!.users).toBeGreaterThan(0);
    expect(lounge!.groups).toBeGreaterThan(0);
    expect(lounge!.dwellPaxSec).toBeGreaterThan(0);
    // ラウンジは購買ではないため売上は持たない
    expect(lounge!.revenue).toBe(0);
    expect(sim.state.paxStats.boarded).toBeGreaterThan(0);
  });

  it('ラウンジのない空港ではラウンジ実績が立たない', () => {
    const layout = createSampleAirport();
    const sim = runScenario(layout, 'aggregate', 'lounge-ops-none');
    const usage = serviceAggregateUsage(sim);
    expect([...usage.keys()].some((k) => k.endsWith('|lounge'))).toBe(false);
    expect(sim.state.paxStats.boarded).toBeGreaterThan(0);
  });

  it('集約方式: 席数が極端に少ないと満席フォールバック（skipped）が発生し、搭乗は成立する', () => {
    const { layout, terminal } = layoutWithLounge(1);
    const sim = runScenario(layout, 'aggregate', 'lounge-ops-full');
    const lounge = serviceAggregateUsage(sim).get(`${terminal}|lounge`);
    expect(lounge).toBeDefined();
    expect(lounge!.skipped).toBeGreaterThan(0);
    expect(sim.state.paxStats.boarded).toBeGreaterThan(0);
  });

  it('詳細方式: 旅客グループが実際にラウンジエリアへ移動して滞留する', () => {
    const { layout, lounge } = layoutWithLounge(40);
    const sim = createSimulation(layout, { seed: 'lounge-ops-area', settings: manual, serviceGranularity: 'detailed' });
    const standId = Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;
    const t0 = sim.state.now;
    const ac = addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 220 * 60,
      plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 },
    });
    let sawLoungeStay = false;
    let ticks = 0;
    while (ac.state !== 'departed' && ticks < 10 * 3600) {
      stepSimulation(sim);
      ticks++;
      if (ticks % 30 === 0) {
        for (const g of Object.values(sim.state.paxGroups)) {
          if (g.facility === lounge || g.area === lounge) sawLoungeStay = true;
        }
      }
    }
    expect(sawLoungeStay).toBe(true);
  });
});
