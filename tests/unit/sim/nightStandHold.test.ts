import { describe, expect, it } from 'vitest';
import { defaultCityNightOps, isCityNightMovement } from '../../../src/core/economy/city';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { nightRiskFlights, nominalOutSec } from '../../../src/core/sim/nightOps';
import { SEPARATION_SEC } from '../../../src/core/sim/rules';
import { addTurnaround, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { PUSHBACK_DISPATCH_LEAD_SEC, tasksOf } from '../../../src/core/sim/ground';
import type { Aircraft } from '../../../src/core/sim/types';
import { cityCompany, citySim, DAY_SEC, H, hms, linearLayout } from '../../audit/d_helpers';
import { asBlock, phase2 } from './blockHelpers';

const SEEDS = ['n1-s1', 'n1-s2', 'n1-s3'];
const MODES = [['full', (l: ReturnType<typeof linearLayout>) => l], ['block', asBlock]] as const;

function nightSim(seed: string, layout: ReturnType<typeof linearLayout>, startTime = 19 * H): Simulation {
  const c = cityCompany(seed, 'core');
  c.city!.nightOps = defaultCityNightOps();
  return citySim(layout, c, { seed, startTime });
}

/** 夜 n（n 日目の夕方〜翌朝）の便: 夕方の出発（21:00〜22:00）、遅れて夜にかかる到着、翌朝の到着 */
function addNight(sim: Simulation, n: number): Aircraft[] {
  const base = n * DAY_SEC;
  const acs: Aircraft[] = [];
  for (let i = 0; i < 6; i++) acs.push(addTurnaround(sim, 'narrow180', base + 19 * H + 30 * 60 + i * 20 * 60, { departureAt: base + 21 * H + i * 12 * 60 }));
  for (let i = 0; i < 2; i++) acs.push(addTurnaround(sim, 'regional70', base + 21 * H + 10 * 60 + i * 600, { inboundDelaySec: 70 * 60, departureAt: base + 22 * H + 30 * 60 + i * 600 }));
  for (let i = 0; i < 4; i++) acs.push(addTurnaround(sim, 'narrow180', base + DAY_SEC + 6 * H + 30 * 60 + i * 10 * 60, { departureAt: base + DAY_SEC + 7 * H + 40 * 60 + i * 10 * 60 }));
  return acs;
}

describe('2-12 nightStandHold: 夜間にかかる出発はスポットで待機し翌朝に運航（full / block）', () => {
  for (const [mode, tf] of MODES) {
    for (const seed of SEEDS) {
      it(`${mode} seed=${seed}: 夜間に pushback/taxiOut/holdShort の機体 0・取りこぼし 0・朝 06:00 以降に全便が離陸し間隔 ≥ 最小間隔・待機中はスポットだけを持つ・朝の到着のダイバート 0`, { timeout: 180_000 }, () => {
        const sim = nightSim(seed, tf(linearLayout({ stands: 8 })));
        const acs = addNight(sim, 0);
        const bad: string[] = [];
        let nightMoving = 0;
        let nightTaxiing = 0;
        let stranded = 0;
        let heldTicks = 0;
        const heldIds = new Set<string>();
        const MOVING = ['pushback', 'taxiOut', 'holdShort', 'lineUp', 'takeoff'];
        for (let i = 0; i < DAY_SEC - 19 * H + 12 * H; i++) {
          stepSimulation(sim);
          const t = sim.state.now;
          const night = isCityNightMovement(t);
          for (const a of Object.values(sim.state.aircraft)) {
            // 夜間に止まっている機体（滑走路手前の待機・整列・離陸）。朝の解放は 06:00 の少し前（最大 2 分）に滑走路手前へ着くので、その 2 分だけは除く。
            // 誘導路を走るのは夜間でも可（数だけ記録）。離陸の時刻が夜間でないことは終わりに検査する
            const tod = t % DAY_SEC;
            const preDawn = tod >= 6 * H - 120 && tod < 6 * H;
            if (night && !preDawn && (a.state === 'holdShort' || a.state === 'lineUp' || a.state === 'takeoff' || (a.state === 'taxiOut' && a.speed < 0.01 && a.stateSince < t - 5))) nightMoving++;
            if (night && MOVING.includes(a.state)) nightTaxiing++;
            if (a.state === 'holdShort' && a.holdReason === 'noiseCurfew') stranded++;
            const dep = sim.state.flights[a.departureFlightId]!;
            if (dep.nightHold?.kind === 'stand' && t < dep.nightHold.releaseAt && ['turnaround', 'readyForPushback'].includes(a.state)) {
              heldTicks++;
              heldIds.add(a.id);
              // 待機中に持つのはスポットだけ: 経路・交差点・区間・トーイングカーを持たない（トーイングカーは朝の手配 = 解放の 10 分前まで）
              if (a.route !== null || a.standId === null) bad.push(`${a.id} route/stand ${hms(t)}`);
              if (Object.values(sim.state.nodeReservations).includes(a.id)) bad.push(`${a.id} node ${hms(t)}`);
              if (sim.state.taxiBlocks && Object.values(sim.state.taxiBlocks.occ).some((l) => l.includes(a.id))) bad.push(`${a.id} occ ${hms(t)}`);
              if (t < dep.nightHold.releaseAt - PUSHBACK_DISPATCH_LEAD_SEC - 5) for (const tk of tasksOf(sim.state, a.id)) if (tk.kind === 'pushback' && tk.units.length > 0) bad.push(`${a.id} tug ${hms(t)}`);
            }
          }
          if (i % 600 === 0) expect(checkInvariants(sim), hms(t)).toEqual([]);
        }
        expect(bad.slice(0, 5), '待機中の占有').toEqual([]);
        expect(nightMoving, '夜間に止まっている機体（holdShort・停止した taxiOut・lineUp・takeoff）').toBe(0);
        expect(stranded, '取りこぼし（滑走路手前の夜間待機）').toBe(0);
        if (sim.state.taxiBlocks) expect(sim.state.taxiBlocks.stats.nightStranded).toBe(0);
        expect(heldIds.size, '夜間のスポット待機が実際に起きた').toBeGreaterThanOrEqual(2);
        // 全便が終端。離陸が夜間にない。待機した便は翌朝 06:00:00 以降に離陸
        const takeoffs: number[] = [];
        for (const a of acs) {
          const dep = sim.state.flights[a.departureFlightId]!;
          expect(a.state, `${a.id}`).toBe('departed');
          expect(isCityNightMovement(dep.actual!), `${a.id} 離陸 ${hms(dep.actual!)}`).toBe(false);
          takeoffs.push(dep.actual!);
          if (dep.nightHold?.kind === 'stand') expect(dep.actual! % DAY_SEC, `${a.id} ${hms(dep.actual!)}`).toBeGreaterThanOrEqual(6 * H);
        }
        takeoffs.sort((x, y) => x - y);
        for (let i = 1; i < takeoffs.length; i++) expect(takeoffs[i]! - takeoffs[i - 1]!, `離陸間隔 ${hms(takeoffs[i - 1]!)} → ${hms(takeoffs[i]!)}`).toBeGreaterThanOrEqual(SEPARATION_SEC.S.S);
        expect(sim.state.stats.diverted, '朝の到着を含めダイバート 0').toBe(0);
        const held = acs.filter((a) => sim.state.flights[a.departureFlightId]!.nightHold?.kind === 'stand');
        phase2('2-12-standHold', { mode, seed, heldFlights: held.length, heldTicks, nightTaxiingTicks: nightTaxiing, firstMorningTakeoff: hms(Math.min(...held.map((a) => sim.state.flights[a.departureFlightId]!.actual!))), lastMorningTakeoff: hms(Math.max(...held.map((a) => sim.state.flights[a.departureFlightId]!.actual!))), stats: sim.state.stats });
      });
    }
  }

  for (const [mode, tf] of MODES) {
    it(`${mode} 境界: 予測離陸がちょうど 21:59:59 なら出発し、22:00:00 なら翌朝まで待機する（予測 = 開始 + 標準の所要 + 列 + 余裕）`, { timeout: 180_000 }, () => {
      const results: Record<string, { held: boolean; actual: number }> = {};
      for (const delta of [-2, -1, 0, 1]) {
        const sim = nightSim('edge', tf(linearLayout({ stands: 4 })), 19 * H + 30 * 60);
        const a = addTurnaround(sim, 'narrow180', 20 * H, { departureAt: 21 * H });
        // スポットが決まるまで進めて、標準の所要を得る
        for (let i = 0; i < 40 * 60 && !a.standId; i++) stepSimulation(sim);
        const out = nominalOutSec(sim, a)!;
        expect(out).toBeGreaterThan(0);
        const dep = sim.state.flights[a.departureFlightId]!;
        // 出発の開始（プッシュバック）を T にすると、予測離陸 = T + out + 600（列なし）。これが 22:00:00 + delta になるように T を置く
        const T = 22 * H + delta - 600 - out;
        dep.scheduled = T;
        dep.estimated = T;
        let held = false;
        for (let i = 0; i < 16 * H && a.state !== 'departed'; i++) {
          stepSimulation(sim);
          if (dep.nightHold?.kind === 'stand') held = true;
          if (i % 900 === 0) expect(checkInvariants(sim)).toEqual([]);
        }
        expect(a.state).toBe('departed');
        results[String(delta)] = { held, actual: dep.actual! };
      }
      phase2('2-12-boundary', { mode, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { held: v.held, actual: hms(v.actual) }])) });
      expect(results['-2']!.held).toBe(false);
      expect(results['-1']!.held).toBe(false);
      expect(results['0']!.held).toBe(true);
      expect(results['1']!.held).toBe(true);
      for (const k of ['-2', '-1']) expect(results[k]!.actual).toBeLessThan(22 * H);
      for (const k of ['0', '1']) expect(results[k]!.actual).toBeGreaterThanOrEqual(DAY_SEC + 6 * H);
    });
  }

  it('nightOps がない都市設定・都市なしは従来どおり（スポット待機をしない。nightHold を作らない）', { timeout: 120_000 }, () => {
    const c = cityCompany('legacy', 'core');
    const sim = citySim(linearLayout({ stands: 4 }), c, { seed: 'legacy', startTime: 20 * H });
    const a = addTurnaround(sim, 'narrow180', 20 * H + 20 * 60, { departureAt: 21 * H + 50 * 60 });
    for (let i = 0; i < 14 * H && a.state !== 'departed'; i++) stepSimulation(sim);
    expect(a.state).toBe('departed');
    for (const f of Object.values(sim.state.flights)) expect(f.nightHold).toBeUndefined();
    expect(nightRiskFlights(sim)).toEqual([]);
  });
});
