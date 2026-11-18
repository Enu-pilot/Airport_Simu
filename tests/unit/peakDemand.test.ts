import { describe, expect, it } from 'vitest';
import { CHECKIN_SHARE, PAX_PROCESS_LEAD_SEC, type DayPlan, type PlannedFlight } from '../../src/core/economy/planning';
import { peakProcessDemand, peakWindowPerHour } from '../../src/core/economy/peakDemand';

const H = 3600;
function flight(partial: Partial<PlannedFlight>): PlannedFlight {
  return {
    key: 'k', contractId: 'c', airlineId: 'NP', destinationId: 'TYO', typeId: 'narrow180',
    arrNumber: '1', depNumber: '2', arrivalAt: 0, departureAt: 0, arrPax: 0, depPax: 0,
    seats: 180, inboundDelaySec: 0, ...partial,
  };
}
const planOf = (flights: PlannedFlight[]): DayPlan => ({ flights }) as unknown as DayPlan;
/** 出発手続きの出現時刻（出発 − 90 分）にそろえた出発便 */
const depAt = (appearAt: number, depPax: number, key = `d${appearAt}`) =>
  flight({ key, departureAt: appearAt + PAX_PROCESS_LEAD_SEC, depPax });

describe('peakWindowPerHour（60分窓の最大）', () => {
  it('集中した便を最大の60分として拾う', () => {
    expect(peakWindowPerHour([{ at: 0, pax: 100 }, { at: 600, pax: 100 }, { at: 1200, pax: 100 }])).toBe(300);
  });
  it('ちょうど60分離れた便は同じ窓に入らない', () => {
    expect(peakWindowPerHour([{ at: 0, pax: 100 }, { at: H, pax: 100 }])).toBe(100);
    expect(peakWindowPerHour([{ at: 0, pax: 100 }, { at: H - 1, pax: 100 }])).toBe(200);
  });
  it('空なら 0', () => {
    expect(peakWindowPerHour([])).toBe(0);
  });
});

describe('peakProcessDemand（運行計画のピーク需要）', () => {
  it('出発ピークは最も集中する60分、チェックインは CHECKIN_SHARE を掛ける', () => {
    const plan = planOf([
      depAt(10 * H, 100, 'a'), depAt(10 * H + 900, 100, 'b'), depAt(10 * H + 1800, 100, 'c'),
      depAt(20 * H, 500, 'z'),
    ]);
    const peak = peakProcessDemand(plan);
    expect(peak.departurePaxPerHour).toBe(500);
    expect(peak.checkInPaxPerHour).toBe(Math.round(500 * CHECKIN_SHARE));
  });

  it('到着ピークは到着時刻（+到着遅延）で数える', () => {
    const plan = planOf([
      flight({ key: 'a', arrivalAt: 8 * H, arrPax: 120 }),
      flight({ key: 'b', arrivalAt: 8 * H + 1800, arrPax: 130, inboundDelaySec: 600 }),
      flight({ key: 'c', arrivalAt: 15 * H, arrPax: 90 }),
    ]);
    expect(peakProcessDemand(plan).arrivalPaxPerHour).toBe(250);
  });

  it('ターミナルで絞れる。未割当はターミナルが1つだけのときだけ fallback する', () => {
    const plan = planOf([depAt(10 * H, 100, 'a'), depAt(10 * H, 200, 'b')]);
    const of = (f: PlannedFlight) => (f.key === 'a' ? 't1' : null);
    expect(peakProcessDemand(plan, { terminalId: 't1', terminalIdOf: of }).departurePaxPerHour).toBe(100);
    expect(peakProcessDemand(plan, { terminalId: 't1', terminalIdOf: of, soleTerminalId: 't1' }).departurePaxPerHour).toBe(300);
    expect(peakProcessDemand(plan, { terminalId: 't2', terminalIdOf: of }).departurePaxPerHour).toBe(0);
  });

  it('計画便がなければすべて 0', () => {
    expect(peakProcessDemand(planOf([]))).toEqual({ departurePaxPerHour: 0, checkInPaxPerHour: 0, arrivalPaxPerHour: 0 });
  });
});
