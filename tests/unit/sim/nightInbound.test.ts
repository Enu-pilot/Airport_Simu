import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { defaultCityNightOps, isCityNightMovement, type CityNightOps } from '../../../src/core/economy/city';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { addTurnaround, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { cityCompany, citySim, DAY_SEC, H, hms, linearLayout } from '../../audit/d_helpers';
import { asBlock, phase2 } from './blockHelpers';

const SEEDS = ['n2-s1', 'n2-s2', 'n2-s3'];

function sim(seed: string, stands: number, ops: Partial<CityNightOps>, startTime: number, block = false): Simulation {
  const c = cityCompany(seed, 'core');
  c.city!.nightOps = { ...defaultCityNightOps(), ...ops };
  const l = linearLayout({ stands });
  return citySim(block ? asBlock(l) : l, c, { seed, startTime });
}

describe('2-13 nightInbound: 夜間にかかる到着は出発地で待機し、上空の夜間待機には上限がある', () => {
  for (const block of [false, true]) {
    for (const seed of SEEDS) {
      it(`${block ? 'block' : 'full'} seed=${seed}: 到着の遅れを大きくした 3 日。上空の夜間待機 ≤ airborneHoldMaxMin・夜間の着陸・離陸 0・出発地待機の便は朝に現れる`, { timeout: 200_000 }, () => {
        const s = sim(seed, 8, {}, 12 * H, block);
        const rng = new Rng(`${seed}:in`);
        const capSec = s.company!.city!.nightOps!.airborneHoldMaxMin * 60;
        for (let d = 0; d < 3; d++) {
          for (let i = 0; i < 10; i++) {
            const arr = d * DAY_SEC + 18 * H + rng.int(0, 5 * 3600);
            addTurnaround(s, i % 3 === 0 ? 'regional70' : 'narrow180', arr, { inboundDelaySec: rng.int(0, 150) * 60, departureAt: arr + (50 + rng.int(0, 30)) * 60 });
          }
        }
        let maxAirborneNight = 0;
        const run = new Map<string, number>();
        let nightLandings = 0;
        let nightTakeoffs = 0;
        for (let i = 0; i < 3 * DAY_SEC - 12 * H + 14 * H; i++) {
          stepSimulation(s);
          for (const a of Object.values(s.state.aircraft)) {
            if (['inbound', 'holding'].includes(a.state) && a.holdReason === 'noiseCurfew') {
              const n = (run.get(a.id) ?? 0) + 1;
              run.set(a.id, n);
              maxAirborneNight = Math.max(maxAirborneNight, n);
            } else run.delete(a.id);
            if (a.state === 'landing' && a.stateSince === s.state.now - 1 && isCityNightMovement(s.state.now)) nightLandings++;
            if (a.state === 'takeoff' && a.stateSince === s.state.now - 1 && isCityNightMovement(s.state.now)) nightTakeoffs++;
          }
          if (i % 900 === 0) expect(checkInvariants(s), hms(s.state.now)).toEqual([]);
        }
        expect(maxAirborneNight, '上空の夜間待機（秒）').toBeLessThanOrEqual(capSec + 2);
        expect(nightLandings).toBe(0);
        expect(nightTakeoffs).toBe(0);
        const flights = Object.values(s.state.flights);
        const origin = flights.filter((f) => f.nightHold?.kind === 'origin');
        const airborne = flights.filter((f) => f.nightHold?.kind === 'airborne');
        const diverted = flights.filter((f) => f.status === 'diverted');
        for (const f of origin) {
          expect(f.actual, `${f.id} は出発地待機の後に朝（06:00 以降）に着陸`).not.toBeNull();
          expect(isCityNightMovement(f.actual!), `${f.id} ${hms(f.actual!)}`).toBe(false);
          expect(f.actual!, f.id).toBeGreaterThanOrEqual(f.nightHold!.releaseAt);
          expect(f.delayCauses).toContain('noiseRestriction');
        }
        // 結果の記録との一致: 上空の夜間待機でダイバートした便は nightHold.kind 'airborne'、ダイバート数 = stats.diverted
        expect(diverted.length).toBe(s.state.stats.diverted);
        for (const f of airborne) expect(f.status === 'diverted' || f.actual !== null, f.id).toBe(true);
        for (const a of Object.values(s.state.aircraft)) expect(['departed', 'diverted', 'cannotOperate'], `${a.id} ${a.state}`).toContain(a.state);
        phase2('2-13-inbound', { block, seed, originHeld: origin.length, airborneNightHeld: airborne.length, diverted: diverted.length, maxAirborneNightSec: maxAirborneNight, capSec });
      });
    }
  }

  it('上空の夜間待機の上限: スポット不足で上空待機中に夜間にかかった到着は、上限（既定 30 分 / 設定 10 分 / 120 分）でダイバート', { timeout: 120_000 }, () => {
    const out: Record<string, number> = {};
    for (const cap of [10, 30, 120]) {
      const s = sim('cap', 1, { airborneHoldMaxMin: cap }, 20 * H);
      // 1 スポットを夜通し占有する機体と、そのスポットを待つ到着
      addTurnaround(s, 'narrow180', 20 * H + 10 * 60, { departureAt: 22 * H + 30 * 60 });
      const b = addTurnaround(s, 'narrow180', 21 * H + 40 * 60, { departureAt: 23 * H });
      const arr = s.state.flights[b.arrivalFlightId]!;
      let divertedAt = -1;
      let nightHoldStart = -1;
      for (let i = 0; i < 6 * H && divertedAt < 0; i++) {
        stepSimulation(s);
        if (arr.nightHold && nightHoldStart < 0) nightHoldStart = arr.nightHold.decidedAt;
        if (b.state === 'diverted') divertedAt = s.state.now;
      }
      expect(arr.nightHold?.kind, `cap=${cap}`).toBe('airborne');
      expect(divertedAt, `cap=${cap}`).toBeGreaterThan(0);
      expect(divertedAt - nightHoldStart, `cap=${cap}`).toBeGreaterThanOrEqual(cap * 60);
      expect(divertedAt - nightHoldStart, `cap=${cap}`).toBeLessThanOrEqual(cap * 60 + 5);
      expect(s.state.stats.diverted).toBe(1);
      out[String(cap)] = divertedAt - nightHoldStart;
    }
    phase2('2-13-cap', { holdSecByCap: out });
  });

  it('夜間にかかる到着の出発地待機: 到着予定 22:30 の便は現れず、朝 06:00 に着陸する（k 番目は SEPARATION_SEC[L][L] ずつずれる）', { timeout: 120_000 }, () => {
    const s = sim('origin', 4, {}, 21 * H);
    const acs = [0, 1, 2].map((i) => addTurnaround(s, 'narrow180', 22 * H + 30 * 60 + i * 60, { departureAt: DAY_SEC + 8 * H + i * 600 }));
    let appearedAt = -1;
    for (let i = 0; i < 12 * H; i++) {
      stepSimulation(s);
      if (appearedAt < 0 && acs[0]!.state !== 'scheduled') appearedAt = s.state.now;
    }
    const arrs = acs.map((a) => s.state.flights[a.arrivalFlightId]!);
    expect(appearedAt).toBeGreaterThanOrEqual(DAY_SEC + 6 * H - 15 * 60 - 1);
    for (const [k, f] of arrs.entries()) {
      expect(f.nightHold?.kind).toBe('origin');
      expect(f.nightHold!.releaseAt).toBe(DAY_SEC + 6 * H + k * 90);
      expect(f.actual!).toBeGreaterThanOrEqual(DAY_SEC + 6 * H);
    }
    expect(s.state.stats.diverted).toBe(0);
    phase2('2-13-origin', { landed: arrs.map((f) => hms(f.actual!)) });
  });
});
