import { describe, expect, it } from 'vitest';
import { addWindowContracts, cityCompany } from '../audit/d_helpers';
import { analyzeDayPlan, planDayWithDemand } from '../../src/core/economy/planning';
import { createContext } from '../../src/core/sim/context';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import {
  CITY_NIGHT_CURFEW,
  CITY_TYPES,
  cityOperatingHours,
  clampNightOps,
  defaultCity,
  defaultCityNightOps,
  departureCutoffIssue,
  departureCutoffMin,
  type CityType,
} from '../../src/core/economy/city';
import type { CompanyState } from '../../src/core/economy/company';

/** 2-11: 出発時刻の制限（最終出発時刻）の計画側（docs/40 R1〜R7、plan §3.6）。 */
const withNight = (seed: string, type: CityType, cutoffMin?: number): CompanyState => {
  const c = cityCompany(seed, type);
  addWindowContracts(c);
  c.city!.nightOps = { ...defaultCityNightOps(), ...(cutoffMin !== undefined ? { departureCutoffMin: cutoffMin } : {}) };
  return c;
};
const without = (seed: string, type: CityType): CompanyState => {
  const c = cityCompany(seed, type);
  addWindowContracts(c);
  return c;
};

describe('2-11 cityOperatingHours / 最終出発時刻', () => {
  const hours = { openMin: 360, closeMin: 1320, peaks: [] };
  it('nightOps なし（第 2 引数なし・都市のみ）は従来と同じ値', () => {
    expect(cityOperatingHours(hours)).toEqual({ ...hours, openMin: 360, closeMin: 1320 });
    expect(cityOperatingHours(hours, defaultCity('core'))).toEqual(cityOperatingHours(hours));
  });
  it('nightOps ありは closeMin を最終出発時刻でも切る（範囲の両端）', () => {
    const c = defaultCity('core');
    for (const m of [1200, 1275, 1305]) {
      c.nightOps = { ...defaultCityNightOps(), departureCutoffMin: m };
      expect(cityOperatingHours(hours, c).closeMin).toBe(m);
    }
    c.nightOps = { ...defaultCityNightOps(), departureCutoffMin: 1305 };
    expect(cityOperatingHours({ ...hours, closeMin: 1000 }, c).closeMin).toBe(1000); // 運用時間の閉店のほうが早ければそちら
    expect(CITY_NIGHT_CURFEW.fromMin).toBe(1320);
  });
  it('既定値は 21:15（制限開始の 45 分前）で、範囲に丸める', () => {
    expect(defaultCityNightOps().departureCutoffMin).toBe(1275);
    expect(clampNightOps({ ...defaultCityNightOps(), departureCutoffMin: 5000, airborneHoldMaxMin: -3, warnLeadMin: 999 })).toMatchObject({ departureCutoffMin: 1305, airborneHoldMaxMin: 0, warnLeadMin: 120 });
  });
  it('手動の便の警告（R7）: 境界は最終出発時刻ちょうどが可・1 分後から警告。nightOps なしは null。日をまたぐ秒でも日内で判定', () => {
    const c = defaultCity('core');
    expect(departureCutoffIssue(c, 23 * 3600)).toBeNull();
    c.nightOps = defaultCityNightOps();
    expect(departureCutoffMin(c)).toBe(1275);
    expect(departureCutoffIssue(c, 1275 * 60)).toBeNull();
    expect(departureCutoffIssue(c, 1275 * 60 + 59)).toBeNull(); // 21:15:59 は同じ分
    expect(departureCutoffIssue(c, 1276 * 60)).toMatch(/最終出発時刻 21:15/);
    expect(departureCutoffIssue(c, 86_400 * 3 + 1276 * 60)).toMatch(/21:15/);
    expect(departureCutoffIssue(c, 86_400 * 3 + 10 * 3600)).toBeNull();
    expect(departureCutoffIssue(undefined, 23 * 3600)).toBeNull();
  });
});

describe('2-11 計画: 出発予定 ≤ 最終出発時刻（3 種類の都市 × 3 シード × 数日）', () => {
  for (const type of CITY_TYPES) {
    for (const seed of ['cut-a', 'cut-b', 'cut-c']) {
      it(`${type} / ${seed}: 全便の出発 ≤ 最終出発時刻、到着は 06:00 以降`, () => {
        for (const cutoff of [1200, 1275, 1305]) {
          const c = withNight(seed, type, cutoff);
          for (let day = 0; day < 4; day++) {
            const plan = planDayWithDemand(c, day);
            expect(plan.flights.length).toBeGreaterThan(0);
            for (const f of plan.flights) {
              expect(f.departureAt).toBeLessThanOrEqual(cutoff * 60);
              expect(f.arrivalAt).toBeGreaterThanOrEqual(CITY_NIGHT_CURFEW.toMin * 60);
            }
          }
        }
      });
    }
  }

  it('nightOps なしの計画は、nightOps を足す前と完全に一致する（key を持たない）', () => {
    for (const type of CITY_TYPES) {
      const a = planDayWithDemand(without('same', type), 1);
      const b = planDayWithDemand(without('same', type), 1);
      expect(a).toEqual(b);
      expect('departureCutoffMin' in a).toBe(false);
    }
  });

  it('収まらない契約は dropped になり、OUTSIDE_HOURS の detail に最終出発時刻が入る。nightOps なしは同じ契約が計画に入り detail なし', () => {
    const ctx = createContext(createSampleAirport());
    const setLate = (c: CompanyState) => { c.hours = { ...c.hours, openMin: 1150 }; }; // 19:10 開場: 20:00 の最終出発には折り返しが収まらない
    const c = withNight('drop', 'core', 1200);
    setLate(c);
    const plan = planDayWithDemand(c, 0);
    expect(plan.dropped.length).toBeGreaterThan(0);
    expect(plan.flights.every((f) => f.departureAt <= 1200 * 60)).toBe(true);
    expect(plan.departureCutoffMin).toBe(1200);
    const issues = analyzeDayPlan(plan, ctx).issues.filter((x) => x.code === 'OUTSIDE_HOURS');
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) expect(i.detail).toBe('最終出発時刻 20:00');
    const base = without('drop', 'core');
    setLate(base);
    const basePlan = planDayWithDemand(base, 0);
    expect(basePlan.dropped.length).toBeLessThan(plan.dropped.length);
    for (const i of analyzeDayPlan(basePlan, ctx).issues.filter((x) => x.code === 'OUTSIDE_HOURS')) expect(i.detail).toBeUndefined();
  });

  it('最終出発時刻を遅くすると、収まらない契約は増えない', () => {
    for (const type of CITY_TYPES) {
      const mk = (m: number) => { const c = withNight('mono', type, m); c.hours = { ...c.hours, openMin: 1150 }; return planDayWithDemand(c, 0).dropped.length; };
      expect(mk(1200)).toBeGreaterThanOrEqual(mk(1275));
      expect(mk(1275)).toBeGreaterThanOrEqual(mk(1305));
    }
  });
});
