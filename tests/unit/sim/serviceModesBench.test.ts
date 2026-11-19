import { describe, expect, it } from 'vitest';
import { addTurnaround, createSimulation } from '../../../src/core/sim/simulation';
import { buildServiceProfiles } from '../../../src/core/terminal/serviceProfile';
import { runServiceDetailSim } from '../../../src/core/terminal/serviceDetailSim';
import type { AirportLayout, TerminalArea } from '../../../src/core/model/types';
import { emptyLayout } from '../helpers';
import { layoutWithShops } from '../serviceFixture';
import { runUntil } from './helpers';

/**
 * 5-19 T13: 粒度分離の性能実測（ベースライン）。
 * - 運営モード: 同一レイアウト・同一 seed で詳細方式と集約方式の全運航時間を比較する。
 * - 集約 profile の生成時間は店舗数に対してのみ増え、運航 tick には混入しないことを確認する。
 * - 詳細モード: 合成ターミナルで店舗数 × 旅客数を段階的に増やし、実行時間・経路キャッシュ・
 *   tick p50/p95 を記録する。数値は console に出し、計画書へ転記する（合否は緩い上限で見る）。
 */

function syntheticLayout(shopCount: number): { layout: AirportLayout; terminalId: string } {
  const layout = emptyLayout(260, 90);
  const terminalId = 'fac_t';
  layout.facilities[terminalId] = {
    id: terminalId, kind: 'terminal', name: '合成ターミナル', origin: { x: 10, y: 10 }, w: 200, h: 15,
    rotation: 0, buildState: 'operational', props: { levels: 1 },
  };
  layout.facilities['fac_g'] = {
    id: 'fac_g', kind: 'gate', name: 'G1', origin: { x: 100, y: 9 }, w: 2, h: 1,
    rotation: 0, buildState: 'operational', props: { standId: 'std_1' },
  };
  const area = (id: string, kind: TerminalArea['kind'], x: number, y: number, w: number, h: number, zone: TerminalArea['zone'], props: Record<string, number> = {}): void => {
    layout.terminalAreas[id] = { id, terminalId, level: 0, kind, name: id, origin: { x, y }, w, h, zone, props };
  };
  area('ta_lobby', 'departureLobby', 10, 10, 200, 3, 'departure');
  // 店舗は 2 段（y13 / y17）に並べる。歩行距離が支配的にならないよう幅を抑えた合成形状
  const pitch = shopCount > 66 ? 3 : 6;
  for (let i = 0; i < shopCount; i++) {
    const row = i % 2;
    const idx = Math.floor(i / 2);
    area(`ta_shop_${i}`, i % 4 === 3 ? 'restaurant' : 'shop', 10 + idx * pitch, row === 0 ? 13 : 17, pitch - 1, 4, 'departure', { capacity: 8 });
  }
  area('ta_wait', 'waiting', 190, 13, 18, 8, 'departure');
  area('ta_sec', 'security', 10, 21, 20, 4, 'departure', { lanes: 8 });
  area('ta_ci', 'checkIn', 30, 21, 96, 4, 'landside', { counters: 32 });
  area('ta_ent', 'entrance', 126, 21, 20, 4, 'landside');
  return { layout, terminalId };
}

const bench = (label: string, fn: () => void): number => {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  console.log(`[bench] ${label}: ${ms.toFixed(1)} ms`);
  return ms;
};

describe('粒度分離ベンチマーク（T13）', () => {
  it('運営モード: 集約方式は詳細方式と同程度以下の時間で同じ運航を完了する', () => {
    const run = (granularity: 'detailed' | 'aggregate'): number => {
      const { layout } = layoutWithShops();
      const sim = createSimulation(layout, { seed: 'bench-ops', settings: { autoSchedule: false }, serviceGranularity: granularity });
      const standId = Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;
      const startAt = sim.state.now;
      const ac = addTurnaround(sim, 'narrow180', startAt + 20 * 60, {
        departureAt: startAt + 220 * 60,
        plan: { contractId: 'test', destinationId: 'north', arrPax: 180, depPax: 180, standId, seats: 180 },
      });
      const t0 = performance.now();
      runUntil(sim, () => ac.state === 'departed', 10 * 3600);
      return performance.now() - t0;
    };
    const detailed = run('detailed');
    const aggregate = run('aggregate');
    console.log(`[bench] ops detailed=${detailed.toFixed(1)}ms aggregate=${aggregate.toFixed(1)}ms`);
    expect(aggregate).toBeLessThan(detailed * 3 + 500);
  }, 120_000);

  it('集約 profile 生成は店舗数に対して緩やかに増える（運航 tick には混入しない）', () => {
    for (const n of [4, 16, 64, 256]) {
      const { layout } = syntheticLayout(n);
      const ms = bench(`profile build shops=${n}`, () => buildServiceProfiles(layout));
      expect(ms).toBeLessThan(1000);
    }
  }, 60_000);

  it('詳細モード: 店舗数・旅客数の段階負荷', () => {
    const cases: { shops: number; groupsPerHour: number; hours: number }[] = [
      { shops: 4, groupsPerHour: 60, hours: 4 },
      { shops: 16, groupsPerHour: 120, hours: 4 },
      { shops: 64, groupsPerHour: 240, hours: 4 },
      { shops: 128, groupsPerHour: 480, hours: 4 },
    ];
    for (const c of cases) {
      const { layout, terminalId } = syntheticLayout(c.shops);
      let summary = '';
      const ms = bench(`detail shops=${c.shops} gph=${c.groupsPerHour}`, () => {
        const r = runServiceDetailSim(layout, {
          terminalId, seed: 'bench-detail', durationSec: c.hours * 3600, groupsPerHour: c.groupsPerHour, visitProb: 0.6,
          budgetMinSec: 100 * 60, budgetMaxSec: 160 * 60,
          nowMs: () => performance.now(),
        });
        const hitRate = r.routeStats.calls > 0 ? r.routeStats.cacheHits / r.routeStats.calls : 0;
        summary = `pax=${r.spawnedPax} boarded=${r.boarded + r.boardedLate} failed=${r.failed} routeCalls=${r.routeStats.calls} hit=${(hitRate * 100).toFixed(1)}% tickP50=${r.tickMs.p50.toFixed(3)}ms tickP95=${r.tickMs.p95.toFixed(3)}ms`;
        expect(r.failed).toBe(0);
        expect(hitRate).toBeGreaterThan(0.5);
      });
      console.log(`[bench]   ${summary} total=${ms.toFixed(1)}ms`);
      expect(ms).toBeLessThan(120_000);
    }
  }, 300_000);
});
