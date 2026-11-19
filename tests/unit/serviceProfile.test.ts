import { describe, expect, it } from 'vitest';
import { placeTerminalArea } from '../../src/core/layout/operations';
import { BALANCE } from '../../src/core/economy/balance';
import {
  aggregateServiceRecords,
  buildServiceProfiles,
  categoryProfile,
  serviceProfilesFor,
  type ServiceFacilityRecord,
} from '../../src/core/terminal/serviceProfile';
import { must } from './helpers';
import { layoutWithShops } from './serviceFixture';

/**
 * 5-19 T11: 個別施設データからカテゴリ×ターミナル集約 profile を導出する adapter。
 * 台帳は個別エリアが唯一の元データで、集約値はそこから一意に生成されること。
 */

describe('サービス集約 profile（T11）', () => {
  it('個別エリアからカテゴリ別に施設数・合計能力・根拠値を導出する', () => {
    const { layout, terminal } = layoutWithShops();
    const profiles = buildServiceProfiles(layout);
    const retail = categoryProfile(profiles, terminal, 'retail')!;
    expect(retail.status).toBe('available');
    expect(retail.facilityCount).toBe(1);
    expect(retail.totalCapacity).toBe(8);
    expect(retail.dwellSec).toBe(BALANCE.retail.shopSec);
    expect(retail.spendPerPax).toBe(BALANCE.retail.shopPerPax);
    expect(retail.byZone).toEqual([{ zone: 'departure', facilityCount: 1, totalCapacity: 8 }]);

    const dining = categoryProfile(profiles, terminal, 'dining')!;
    expect(dining.totalCapacity).toBe(10);
    expect(dining.dwellSec).toBe(BALANCE.retail.restaurantSec);
    expect(dining.spendPerPax).toBe(BALANCE.retail.restaurantPerPax);
  });

  it('待合は購買値を持たず、ラウンジは未設置、価格・品質は常に未算出', () => {
    const { layout, terminal } = layoutWithShops();
    const profiles = buildServiceProfiles(layout);
    const waiting = categoryProfile(profiles, terminal, 'waiting')!;
    expect(waiting.facilityCount).toBe(1);
    expect(waiting.totalAreaCapacity).toBe(10 * 2 * 40);
    expect(waiting.dwellSec).toBeNull();
    expect(waiting.spendPerPax).toBeNull();
    const lounge = categoryProfile(profiles, terminal, 'lounge')!;
    expect(lounge.status).toBe('notConfigured');
    expect(lounge.facilityCount).toBe(0);
    for (const p of profiles.byTerminalCategory.values()) expect(p.priceQuality).toBeNull();
  });

  it('施設の増減が集約結果へそのまま反映される（存在を無視しない）', () => {
    const base = layoutWithShops();
    const before = categoryProfile(buildServiceProfiles(base.layout), base.terminal, 'retail')!;
    let layout = base.layout;
    const m = must(placeTerminalArea(layout, base.terminal, 1, 'shop', { x: 50, y: 51 }, { w: 4, h: 2, name: '売店2', props: { capacity: 5 } }));
    layout = m.layout;
    const after = categoryProfile(buildServiceProfiles(layout), base.terminal, 'retail')!;
    expect(after.facilityCount).toBe(before.facilityCount + 1);
    expect(after.totalCapacity).toBe(before.totalCapacity + 5);
  });

  it('layout 単位でキャッシュされ、同一オブジェクトでは再生成しない', () => {
    const { layout } = layoutWithShops();
    expect(serviceProfilesFor(layout)).toBe(serviceProfilesFor(layout));
    const rebuilt = buildServiceProfiles(layout);
    expect(rebuilt).not.toBe(serviceProfilesFor(layout));
    expect(rebuilt.facilities).toEqual(serviceProfilesFor(layout).facilities);
  });

  it('店舗別実績 → カテゴリ → ターミナル → 空港全体の集約が一致する', () => {
    const { layout, terminal, shop, restaurant, waiting } = layoutWithShops();
    const profiles = buildServiceProfiles(layout);
    const rec = (areaId: string, users: number, revenue: number): ServiceFacilityRecord => ({
      areaId, users, groups: 1, waitPaxSec: users * 60, dwellPaxSec: users * 300, revenue, busyServerSec: 300, turnedAway: 0,
    });
    const records = new Map([
      [shop, rec(shop, 10, 150)],
      [restaurant, rec(restaurant, 4, 88)],
      [waiting, rec(waiting, 30, 0)],
    ]);
    const agg = aggregateServiceRecords(profiles, records);
    const retail = agg.byCategory.get(`${terminal}|retail`)!;
    expect(retail.users).toBe(10);
    expect(retail.avgWaitSec).toBe(60);
    expect(retail.avgDwellSec).toBe(300);
    const airportRetail = agg.airport.find((r) => r.category === 'retail')!;
    expect(airportRetail.users).toBe(10);
    expect(airportRetail.revenue).toBe(150);
    const airportWaiting = agg.airport.find((r) => r.category === 'waiting')!;
    expect(airportWaiting.users).toBe(30);
    // 利用者ゼロのカテゴリは平均が未算出になる
    const lounge = agg.airport.find((r) => r.category === 'lounge')!;
    expect(lounge.avgWaitSec).toBeNull();
    expect(lounge.avgDwellSec).toBeNull();
  });
});
