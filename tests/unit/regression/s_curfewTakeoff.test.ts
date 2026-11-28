/**
 * 回帰（計画 1-13 / 監査 d / D-2）: 夜間規制中は、どの機種も 06:00:00 より前に離陸しない。
 * 旧: 離陸時刻の予測が連続式 sqrt(2D/a)、実際の積分は 1 tick 先行する離散式のため、L 級機が 05:59:59 に浮揚した。
 * 修正: 予測を takeoffRollSec（1 tick ずつの積分で浮揚距離に届く最小 tick 数）に置き換えた。
 */
import { describe, expect, it } from 'vitest';
import { addTurnaround, stepSimulation } from '../../../src/core/sim/simulation';
import { stepTicks } from '../../../src/core/sim/dayloop';
import { AIRCRAFT_TYPES, takeoffDistanceM, takeoffRollSec } from '../../../src/core/sim/aircraftTypes';
import { TICK_SEC } from '../../../src/core/sim/rules';
import { cityCompany, citySim, DAY_SEC, H, hms, isNight, linearLayout } from '../../audit/d_helpers';

const bigLayout = () => linearLayout({ stands: 2, standSize: 'L', baseWidth: 'L', runwayWidthM: 60, runwayTiles: 150, multiExit: true });

describe('1-13 離陸時刻の予測', () => {
  it('夜間に滑走路手前で待機した A350-900（L 級）は、06:00:00 より前に離陸しない。日報の nightMovements は 0。seed=d2-early', () => {
    const c = cityCompany('d2-early', 'core');
    const sim = citySim(bigLayout(), c, { seed: 'd2-early', startTime: 20 * H + 30 * 60 });
    const a = addTurnaround(sim, 'A350-900', 20 * H + 55 * 60, { departureAt: 21 * H + 58 * 60 });
    const dep = sim.state.flights[a.departureFlightId]!;
    for (let i = 0; i < 12 * H && a.state !== 'departed'; i++) stepSimulation(sim);
    expect(a.state).toBe('departed');
    expect(dep.delayCauses).toContain('noiseRestriction');
    expect(isNight(dep.actual!), `takeoff at ${hms(dep.actual!)}`).toBe(false);
    expect(dep.actual!).toBeGreaterThanOrEqual(DAY_SEC + 6 * H);
    stepTicks(sim, 2 * DAY_SEC, { stopAtDayClose: true });
    stepTicks(sim, 2 * DAY_SEC, { stopAtDayClose: true });
    const night = c.reports.map((r) => r.city?.nightMovements ?? 0).reduce((x, y) => x + y, 0);
    expect(night).toBe(0);
  }, 60_000);

  it('takeoffRollSec は連続式以上で、1 tick を超えて長くならず、実際の積分と一致する（全機種）', () => {
    for (const m of Object.values(AIRCRAFT_TYPES)) {
      const t = m;
      const cont = Math.sqrt((2 * takeoffDistanceM(t)) / t.takeoffAccel);
      const roll = takeoffRollSec(t);
      // 離散積分は連続式より最大 1 tick 前後する
      expect(Math.abs(roll - cont), m.id).toBeLessThan(TICK_SEC + 1e-9);
    }
  });

  it('カタログの全機種で、夜間待機後の実際の離陸時刻は 06:00:00 以降で、予測との差がない（機種ごと）', () => {
    const rows: string[] = [];
    const skipped: string[] = [];
    for (const m of Object.values(AIRCRAFT_TYPES)) {
      const c = cityCompany(`s-take-${m.id}`, 'core');
      const sim = citySim(bigLayout(), c, { seed: `s-take-${m.id}`, startTime: 20 * H + 30 * 60 });
      const a = addTurnaround(sim, m.id, 20 * H + 55 * 60, { departureAt: 21 * H + 58 * 60 });
      const dep = sim.state.flights[a.departureFlightId]!;
      let takeoffStart: number | null = null;
      for (let i = 0; i < 12 * H && a.state !== 'departed'; i++) {
        stepSimulation(sim);
        if (a.state === 'takeoff' && takeoffStart === null) takeoffStart = sim.state.now;
      }
      if (a.state !== 'departed') {
        skipped.push(`${m.id}:${a.state}`); // このレイアウトでは運航できない機種（例: 超大型機）
        continue;
      }
      rows.push(`${m.id}: actual=${hms(dep.actual!)} roll=${dep.actual! - takeoffStart!}`);
      expect(isNight(dep.actual!), `${m.id} takeoff at ${hms(dep.actual!)}`).toBe(false);
      // 離陸滑走の実時間は takeoffRollSec と一致する
      // 予測と実際が 1 tick も違わない: 規制明けの最初の許可で、離陸はちょうど 06:00:00
      expect(dep.actual!, m.id).toBe(DAY_SEC + 6 * H);
      // 観測した状態遷移（takeoff に入った tick）からの実時間は takeoffRollSec より 1 tick 短い（積分の最初の 1 tick が状態遷移と同じ tick に入るため）
      expect(takeoffRollSec(m) - (dep.actual! - takeoffStart!), m.id).toBe(TICK_SEC);
    }
    // このレイアウトで運航できないのはコード F（翼幅 65m 以上）の機種だけ。従来は A380 だけだったが、
    // 機材カタログ改修（2026-FLEET、PR #95）で同じコード F の B747-8・B747-8F が加わった
    expect(skipped.every((x) => AIRCRAFT_TYPES[x.split(':')[0]!]?.codeF === true), skipped.join(', ')).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(Object.keys(AIRCRAFT_TYPES).length - 3);
  }, 600_000);

  it('M・S 級（narrow180）の回帰: 夜間待機後の離陸は 06:00:00 から大きく遅れない', () => {
    const c = cityCompany('s-take-narrow', 'core');
    const sim = citySim(linearLayout({ stands: 2 }), c, { seed: 's-take-narrow', startTime: 20 * H + 30 * 60 });
    const a = addTurnaround(sim, 'narrow180', 20 * H + 55 * 60, { departureAt: 21 * H + 58 * 60 });
    const dep = sim.state.flights[a.departureFlightId]!;
    for (let i = 0; i < 12 * H && a.state !== 'departed'; i++) stepSimulation(sim);
    expect(dep.actual!).toBeGreaterThanOrEqual(DAY_SEC + 6 * H);
    expect(dep.actual!).toBeLessThan(DAY_SEC + 6 * H + 600);
  });
});
