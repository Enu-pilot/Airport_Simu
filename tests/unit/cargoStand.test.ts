import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../src/core/economy/company';
import type { AirportLayout } from '../../src/core/model/types';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addTurnaround, createSimulation, type Simulation } from '../../src/core/sim/simulation';
import { runUntil } from './sim/helpers';

/**
 * 貨物優先スポット（Stand.cargoPreferred）:
 * 貨物便は優先スポットを先に選ぶ。旅客便の割当はフラグで一切変わらない（使えもする）。
 */
const manual = { autoSchedule: false };

function mStands(layout: AirportLayout): string[] {
  return Object.values(layout.stands).filter((s) => s.size === 'M' && s.buildState === 'operational').map((s) => s.id);
}

function cargoArrival(sim: Simulation, at: number) {
  return addTurnaround(sim, 'narrow180', at, {
    airline: 'NH',
    plan: { contractId: 'cargo-test', destinationId: 'TWN', arrPax: 0, depPax: 0, standId: null, cargo: { volumeM3: 10 } },
  });
}

function assignedStand(sim: Simulation, ac: { standId: string | null; state: string }): string | null {
  runUntil(sim, () => ac.standId !== null || ac.state === 'holding', 3600);
  return ac.standId;
}

describe('貨物優先スポット', () => {
  it('貨物便は貨物優先スポットを、通常の優先順位より先に選ぶ', { timeout: 120_000 }, () => {
    // 基準: フラグなしで貨物便が選ぶスポット
    const baseLayout = createSampleAirport();
    const baseSim = createSimulation(baseLayout, { company: createSandboxCompany('cargo-stand-base'), settings: manual });
    const base = assignedStand(baseSim, cargoArrival(baseSim, baseSim.state.now + 20 * 60));
    expect(base).not.toBeNull();

    // 別の M スポットにフラグを立てると、貨物便はそちらへ行く
    const layout = createSampleAirport();
    const other = mStands(layout).find((id) => id !== base)!;
    layout.stands[other]!.cargoPreferred = true;
    const sim = createSimulation(layout, { company: createSandboxCompany('cargo-stand-pref'), settings: manual });
    const ac = cargoArrival(sim, sim.state.now + 20 * 60);
    expect(assignedStand(sim, ac)).toBe(other);
  });

  it('貨物優先スポットが埋まっていれば、貨物便は通常スポットへ割り当たる', { timeout: 120_000 }, () => {
    const layout = createSampleAirport();
    const target = mStands(layout)[0]!;
    layout.stands[target]!.cargoPreferred = true;
    const sim = createSimulation(layout, { company: createSandboxCompany('cargo-stand-fallback'), settings: manual });
    const first = cargoArrival(sim, sim.state.now + 20 * 60);
    expect(assignedStand(sim, first)).toBe(target);
    const second = cargoArrival(sim, sim.state.now + 25 * 60);
    const stand = assignedStand(sim, second);
    expect(stand).not.toBeNull();
    expect(stand).not.toBe(target);
  });

  it('旅客便の割当はフラグで変わらず、貨物優先スポットも使える', { timeout: 120_000 }, () => {
    // 基準: フラグなしで旅客便が選ぶスポット
    const baseSim = createSimulation(createSampleAirport(), { company: createSandboxCompany('cargo-stand-pax-base'), settings: manual });
    const baseAc = addTurnaround(baseSim, 'narrow180', baseSim.state.now + 20 * 60, { airline: 'NH' });
    const base = assignedStand(baseSim, baseAc);
    expect(base).not.toBeNull();

    // そのスポット自体にフラグを立てても、旅客便は従来どおりそこへ割り当たる
    const layout = createSampleAirport();
    layout.stands[base!]!.cargoPreferred = true;
    const sim = createSimulation(layout, { company: createSandboxCompany('cargo-stand-pax'), settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { airline: 'NH' });
    expect(assignedStand(sim, ac)).toBe(base);
  });
});
