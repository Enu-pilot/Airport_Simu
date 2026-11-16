/**
 * 回帰（計画 1-16 / E-1）: バス・鉄道は時間あたり定員（docs/15 §3）を超えて受け入れない。
 * 旧: 6 時間先で諦め、その時間帯へ定員を無視して加算した。
 * 修正: 先読みは 24 時間。空きがなければ（定員 0・1 グループが定員超過も含む）満車の駐車場と同じ方式で送迎・タクシー・徒歩へ切り替え、transitFull に数える。
 */
import { describe, expect, it } from 'vitest';
import { accessDeparture } from '../../../src/core/access/runtime';
import { BALANCE } from '../../../src/core/economy/balance';
import type { AccessMode } from '../../../src/core/access/model';
import type { Simulation } from '../../../src/core/sim/simulation';
import type { PaxGroup } from '../../../src/core/sim/types';
import { accessLayout, mkSim } from '../../audit/e_helpers';

let gid = 0;
const fakeGroup = (count: number): PaxGroup => ({ id: `rg_${++gid}`, count, walkSec: 0, waitSec: 0, state: 'toAirport' } as unknown as PaxGroup);
const M = BALANCE.accessModel;

function forceMode(sim: Simulation, mode: AccessMode): void {
  const acc = sim.state.access!;
  for (const m of Object.keys(acc.shares) as AccessMode[]) acc.shares[m] = m === mode ? 1 : 0;
  acc.available = [mode];
}

const peakOf = (sim: Simulation, mode: 'bus' | 'rail'): number => Math.max(0, ...Object.entries(sim.state.access!.hourly).filter(([k]) => k.startsWith(`${mode}:`)).map(([, v]) => v));

describe('1-16 バス・鉄道の定員', () => {
  it('1 便/時のバス（定員 50人/時）に 500 人分（10 時間分）が着いても、どの時間帯も 50 人を超えない', () => {
    const sim = mkSim(accessLayout({ bus: { busBays: 1, busesPerHour: 1 } }), 'e-repro-overbook');
    forceMode(sim, 'bus');
    sim.state.now = 10 * 3600;
    for (let i = 0; i < 100; i++) accessDeparture(sim, fakeGroup(5));
    expect(peakOf(sim, 'bus')).toBeLessThanOrEqual(M.busSeats);
  });

  it('24 時間分（1200 人）を超える需要は手段を切り替え（徒歩）、transitFull に数え、人数が保存される', () => {
    const sim = mkSim(accessLayout({ bus: { busBays: 1, busesPerHour: 1 } }), 's-overbook-24');
    forceMode(sim, 'bus');
    const acc = sim.state.access!;
    sim.state.now = 2 * 3600;
    const n = 300; // 5 人 × 300 = 1500 人 > 24 × 50
    for (let i = 0; i < n; i++) accessDeparture(sim, fakeGroup(5));
    expect(peakOf(sim, 'bus')).toBeLessThanOrEqual(M.busSeats);
    const onBus = Object.entries(acc.hourly).filter(([k]) => k.startsWith('bus:')).reduce((s, [, v]) => s + v, 0);
    expect(onBus).toBe(24 * M.busSeats);
    expect(acc.stats.pax.walk).toBe(n * 5 - onBus); // 乗れなかった分は徒歩へ（他の手段の分担率が 0 のとき）
    expect(acc.stats.pax.bus + acc.stats.pax.walk + acc.stats.pax.dropoff + acc.stats.pax.taxi).toBe(n * 5);
    expect(acc.stats.transitFull).toBeGreaterThan(0);
  });

  it('鉄道でも同じ（定員 trainSeats × 本数）', () => {
    const sim = mkSim(accessLayout({ rail: { trainsPerHour: 2 } }), 's-overbook-rail');
    forceMode(sim, 'rail');
    const cap = sim.state.access!.trainsPerHour * M.trainSeats;
    expect(cap).toBeGreaterThan(0);
    sim.state.now = 8 * 3600;
    const total = 40 * cap;
    for (let i = 0; i < total / 20; i++) accessDeparture(sim, fakeGroup(20));
    expect(peakOf(sim, 'rail')).toBeLessThanOrEqual(cap);
    expect(sim.state.access!.stats.transitFull).toBeGreaterThan(0);
  });

  it('定員 0（便数 0）では乗せず、切り替える（異常系）', () => {
    const sim = mkSim(accessLayout({ bus: { busBays: 1, busesPerHour: 1 } }), 's-overbook-zero');
    forceMode(sim, 'bus');
    sim.state.access!.busesPerHour = 0;
    sim.state.now = 9 * 3600;
    for (let i = 0; i < 5; i++) accessDeparture(sim, fakeGroup(3));
    expect(peakOf(sim, 'bus')).toBe(0);
    expect(sim.state.access!.stats.pax.bus).toBe(0);
    expect(sim.state.access!.stats.transitFull).toBe(5);
  });

  it('1 グループが定員を超える（境界）ときは乗せず切り替える。定員ちょうどは乗れる', () => {
    const sim = mkSim(accessLayout({ bus: { busBays: 1, busesPerHour: 1 } }), 's-overbook-big');
    forceMode(sim, 'bus');
    sim.state.now = 9 * 3600;
    accessDeparture(sim, fakeGroup(M.busSeats + 1));
    expect(peakOf(sim, 'bus')).toBe(0);
    accessDeparture(sim, fakeGroup(M.busSeats));
    expect(peakOf(sim, 'bus')).toBe(M.busSeats);
  });

  it('決定的: 同じシードなら同じ結果', () => {
    const run = () => {
      const sim = mkSim(accessLayout({ bus: { busBays: 1, busesPerHour: 1 } }), 's-overbook-det');
      const acc = sim.state.access!;
      sim.state.now = 7 * 3600;
      for (let i = 0; i < 80; i++) accessDeparture(sim, fakeGroup(7));
      return JSON.stringify([acc.hourly, acc.stats]);
    };
    expect(run()).toBe(run());
  });
});
