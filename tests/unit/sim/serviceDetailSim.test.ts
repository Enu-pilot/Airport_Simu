import { describe, expect, it } from 'vitest';
import { runServiceDetailSim } from '../../../src/core/terminal/serviceDetailSim';
import { layoutWithShops } from '../serviceFixture';

/**
 * 5-19 T12: ターミナル詳細モード（独立 TerminalSimulation）。
 * 個別店舗 ID への立寄り・店舗別実績・集約整合・決定性・AirportDay への無干渉を固定する。
 */

describe('ターミナル詳細モード（店舗個別立寄り）', () => {
  it('入口→工程→店舗→待合→搭乗口まで流れ、店舗別実績と集約が一致する', () => {
    const { layout, terminal, shop, restaurant } = layoutWithShops();
    const r = runServiceDetailSim(layout, {
      terminalId: terminal, seed: 'detail-1', durationSec: 3 * 3600, groupsPerHour: 60, visitProb: 1,
    });
    expect(r.spawnedPax).toBeGreaterThan(0);
    expect(r.failed).toBe(0);
    expect(r.boarded + r.boardedLate).toBeGreaterThan(0);
    // 人数保存: 生成 = 到達 + 失敗 + 未完了
    expect(r.boarded + r.boardedLate + r.failed + r.unfinished).toBe(r.spawnedPax);
    // 店舗別実績: どちらかの店舗に利用がある
    const shopUsers = (r.records[shop]?.users ?? 0) + (r.records[restaurant]?.users ?? 0);
    expect(shopUsers).toBeGreaterThan(0);
    // 店舗別合計 = カテゴリ集約の合計（空港全体）
    const airportUsers = r.aggregated.airport
      .filter((c) => c.category === 'retail' || c.category === 'dining')
      .reduce((s, c) => s + c.users, 0);
    expect(airportUsers).toBe(shopUsers);
    const airportRevenue = r.aggregated.airport.reduce((s, c) => s + c.revenue, 0);
    const recordRevenue = Object.values(r.records).reduce((s, x) => s + x.revenue, 0);
    expect(airportRevenue).toBe(recordRevenue);
    expect(airportRevenue).toBeGreaterThan(0);
    // 経路キャッシュが効いている
    expect(r.routeStats.cacheHits).toBeGreaterThan(0);
  });

  it('立寄り希望がなければ店舗実績はゼロで、搭乗は成立する', () => {
    const { layout, terminal } = layoutWithShops();
    const r = runServiceDetailSim(layout, {
      terminalId: terminal, seed: 'detail-2', durationSec: 2 * 3600, groupsPerHour: 40, visitProb: 0,
    });
    const commercial = r.aggregated.airport.filter((c) => c.category === 'retail' || c.category === 'dining');
    expect(commercial.every((c) => c.users === 0 && c.revenue === 0)).toBe(true);
    expect(r.boarded + r.boardedLate).toBeGreaterThan(0);
    // 待合の滞留実績は立つ
    const waiting = r.aggregated.airport.find((c) => c.category === 'waiting')!;
    expect(waiting.users).toBeGreaterThan(0);
  });

  it('同一 seed で完全に再現する（決定性）', () => {
    const { layout, terminal } = layoutWithShops();
    const opts = { terminalId: terminal, seed: 'detail-3', durationSec: 2 * 3600, groupsPerHour: 50, visitProb: 0.7 };
    const a = runServiceDetailSim(layout, opts);
    const b = runServiceDetailSim(layout, opts);
    expect(b.spawnedPax).toBe(a.spawnedPax);
    expect(b.boarded).toBe(a.boarded);
    expect(b.records).toEqual(a.records);
    expect(b.routeStats).toEqual(a.routeStats);
  });

  it('Step-free 旅客だけでも階段なし経路で搭乗できる', () => {
    const { layout, terminal } = layoutWithShops();
    const r = runServiceDetailSim(layout, {
      terminalId: terminal, seed: 'detail-4', durationSec: 2 * 3600, groupsPerHour: 30, visitProb: 0.5, stepFreeRatio: 1,
    });
    expect(r.failed).toBe(0);
    expect(r.boarded + r.boardedLate).toBeGreaterThan(0);
  });

  it('layout を変更しない（AirportDay への副作用なし）', () => {
    const { layout, terminal } = layoutWithShops();
    const before = JSON.stringify(layout);
    runServiceDetailSim(layout, { terminalId: terminal, seed: 'detail-5', durationSec: 3600, groupsPerHour: 30 });
    expect(JSON.stringify(layout)).toBe(before);
  });
});
