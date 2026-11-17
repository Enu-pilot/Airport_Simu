import { describe, expect, it } from 'vitest';
import { defaultCityNightOps } from '../../../src/core/economy/city';
import { takeoffRollSec, resolveType } from '../../../src/core/sim/aircraftTypes';
import { lineUpToAirborneSec, nightRiskFlights, nominalOutSec } from '../../../src/core/sim/nightOps';
import { addTurnaround, departureQueue, stepSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { cityCompany, citySim, H, linearLayout } from '../../audit/d_helpers';
import { phase2 } from './blockHelpers';

function mk(ops: Partial<ReturnType<typeof defaultCityNightOps>> | null, stands = 4, dual = false): Simulation {
  const c = cityCompany('warn', 'core');
  if (ops) c.city!.nightOps = { ...defaultCityNightOps(), ...ops };
  return citySim(linearLayout({ stands, dual }), c, { seed: 'warn', startTime: 19 * H });
}

describe('2-15 nightWarning: 早めの警告（R11）と優先の方針（R12）のコア', () => {
  it('警告の発生条件: 予測離陸が制限開始の warnLeadMin（既定 20 分）前を越えたとき。境界はちょうど 21:40:00（以下は警告なし・1 秒超で警告）', () => {
    const out: Record<string, boolean> = {};
    for (const delta of [-1, 0, 1]) {
      const sim = mk({});
      const a = addTurnaround(sim, 'narrow180', 19 * H + 30 * 60, { departureAt: 21 * H });
      for (let i = 0; i < 2 * H && a.state !== 'turnaround'; i++) stepSimulation(sim);
      const dep = sim.state.flights[a.departureFlightId]!;
      const out0 = nominalOutSec(sim, a)!;
      // 予測離陸 = 開始 + 標準の所要 + 600（列なし）を 21:40:00 + delta にする
      const T = 21 * H + 40 * 60 + delta - 600 - out0;
      dep.scheduled = T;
      dep.estimated = T;
      const risks = nightRiskFlights(sim);
      out[String(delta)] = risks.some((r) => r.aircraftId === a.id);
      if (risks.length > 0) expect(risks[0]!.predictedAt).toBe(21 * H + 40 * 60 + delta);
    }
    phase2('2-15-warn-boundary', out);
    expect(out['-1']).toBe(false);
    expect(out['0']).toBe(false);
    expect(out['1']).toBe(true);
  });

  it('警告の条件は warnLeadMin に従い、夜間待機を決めた便・nightOps なしでは出ない', () => {
    // warnLeadMin = 60: 21:00 以降の予測で警告
    const sim = mk({ warnLeadMin: 60 });
    const a = addTurnaround(sim, 'narrow180', 19 * H + 30 * 60, { departureAt: 21 * H + 30 * 60 });
    for (let i = 0; i < 2 * H && a.state !== 'turnaround'; i++) stepSimulation(sim);
    expect(nightRiskFlights(sim).map((r) => r.aircraftId)).toEqual([a.id]);
    const early = mk({ warnLeadMin: 5 });
    const b = addTurnaround(early, 'narrow180', 19 * H + 30 * 60, { departureAt: 21 * H + 30 * 60 });
    for (let i = 0; i < 2 * H && b.state !== 'turnaround'; i++) stepSimulation(early);
    expect(nightRiskFlights(early)).toEqual([]);
    const none = mk(null);
    const c = addTurnaround(none, 'narrow180', 19 * H + 30 * 60, { departureAt: 21 * H + 50 * 60 });
    for (let i = 0; i < 2 * H && c.state !== 'turnaround'; i++) stepSimulation(none);
    expect(nightRiskFlights(none)).toEqual([]);
    // 夜間待機を決めた便は警告ではなく待機の対象
    const held = mk({});
    const d = addTurnaround(held, 'narrow180', 19 * H + 30 * 60, { departureAt: 21 * H + 55 * 60 });
    for (let i = 0; i < 3 * H && !held.state.flights[d.departureFlightId]!.nightHold; i++) stepSimulation(held);
    expect(held.state.flights[d.departureFlightId]!.nightHold?.kind).toBe('stand');
    expect(nightRiskFlights(held)).toEqual([]);
  });

  it('優先の方針 prioritizeAtRisk: false（既定）では離陸待ちの順序が従来と一致し、true のときだけ危険な機体が先になる', () => {
    const t1 = resolveType(mk({}).ctx.types, 'regional70');
    const t2 = resolveType(mk({}).ctx.types, 'narrow180');
    expect(takeoffRollSec(t2)).toBeGreaterThan(takeoffRollSec(t1));
    const order = (flag: boolean | null): string[] => {
      const sim = mk(flag === null ? null : { prioritizeAtRisk: flag, warnLeadMin: 20 }, 4, true);
      const a = addTurnaround(sim, 'regional70', 19 * H + 30 * 60, { departureAt: 20 * H });
      const b = addTurnaround(sim, 'narrow180', 19 * H + 31 * 60, { departureAt: 20 * H });
      for (let i = 0; i < 90 * 60; i++) stepSimulation(sim);
      const rid = Object.keys(sim.ctx.runways)[0]!;
      // 離陸待ちの列を作る: a（短い滑走）が先に待ち、b（長い滑走）が後。時刻を 22:00 − warnLead の直前に置くと、b だけが「予測離陸が危険」になる
      for (const [k, x] of [[100, a], [50, b]] as const) {
        x.state = 'holdShort';
        x.runwayId = rid;
        x.route = null;
        x.queuedSince = 21 * H - k;
      }
      const base = lineUpToAirborneSec(sim, a);
      const mid = Math.floor((takeoffRollSec(t1) + takeoffRollSec(t2)) / 2);
      sim.state.now = 22 * H - 20 * 60 - (base - takeoffRollSec(t1)) - mid; // a: 予測 22:00 より前 / b: 22:00 以降
      return departureQueue(sim, rid).map((x) => x.id);
    };
    const legacy = order(null);
    expect(legacy).toEqual(['ac_1', 'ac_2']);
    expect(order(false)).toEqual(legacy);
    expect(order(true)).toEqual(['ac_2', 'ac_1']);
    phase2('2-15-priority', { legacy, off: order(false), on: order(true) });
  });
});
