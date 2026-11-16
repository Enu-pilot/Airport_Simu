/**
 * 既知の不具合の再現（監査 d / 夜間騒音規制）: 夜間に滑走路手前で待機した L 級機（wide300 / A350-900 / B777 / B787 など）は、06:00:00 ではなく 05:59:59 に離陸する（夜間移動として日報に数えられる）。
 *
 * 期待（docs/31_city_models.md「離陸も滑走路上の予測時刻が夜間なら滑走路手前で待機する」「夜間は22:00以上または06:00未満」「日次の夜間移動数 nightMovements は実際の着陸・離陸時刻から数える」）:
 *   規制中は夜間に離陸しない。日報の nightMovements は 0。
 * 実際: departureBlocked（simulation.ts:754-762）は離陸時刻を `now + 整列 + 15 秒 + sqrt(2·D/a)` と連続式で予測するが、離陸滑走の積分（:1017-1018）は
 *   `speed += a; dist += speed`（離散で 1 tick 先行）なので、L 級（a=1.8, 浮揚速度 80）では実際の浮揚が予測より 1 秒早い。予測が 06:00:00 になった最初の tick に許可を出すと 05:59:59 に浮揚する。
 *   M/S 級（narrow180 など）は同じ式でも 06:00:00 ちょうどになり、現れない（機種の数値依存）。評価は cityNoiseMetrics（ops.ts:493-508）が flight.actual で数えるので、夜間移動 1 件・住民満足度 −0.15。
 * 実行: AUDIT_KNOWN=1 npx vitest run -c vitest.audit.config.ts tests/audit/known-issues/d_curfewTakeoffEarly.repro.test.ts
 */
import { expect, it } from 'vitest';
import { addTurnaround, stepSimulation } from '../../../src/core/sim/simulation';
import { stepTicks } from '../../../src/core/sim/dayloop';
import { cityCompany, citySim, DAY_SEC, H, hms, isNight, linearLayout } from '../d_helpers';

it('夜間に滑走路手前で待機した A350-900（L 級）は、規制解除（06:00:00）より前に離陸しない。日報の nightMovements は 0。seed=d2-early', () => {
  const c = cityCompany('d2-early', 'core');
  const sim = citySim(linearLayout({ stands: 2, standSize: 'L', baseWidth: 'L', runwayWidthM: 60, runwayTiles: 150, multiExit: true }), c, { seed: 'd2-early', startTime: 20 * H + 30 * 60 });
  const a = addTurnaround(sim, 'A350-900', 20 * H + 55 * 60, { departureAt: 21 * H + 58 * 60 });
  const dep = sim.state.flights[a.departureFlightId]!;
  for (let i = 0; i < 12 * H && a.state !== 'departed'; i++) stepSimulation(sim);
  expect(a.state).toBe('departed');
  expect(dep.delayCauses).toContain('noiseRestriction'); // 夜間待機に入ったこと（前提）
  expect(isNight(dep.actual!), `takeoff at ${hms(dep.actual!)}`).toBe(false);
  expect(dep.actual!).toBeGreaterThanOrEqual(DAY_SEC + 6 * H);
  // 日報（翌日の締め）でも夜間移動 0
  stepTicks(sim, 2 * DAY_SEC, { stopAtDayClose: true });
  stepTicks(sim, 2 * DAY_SEC, { stopAtDayClose: true });
  const night = c.reports.map((r) => r.city?.nightMovements ?? 0).reduce((x, y) => x + y, 0);
  expect(night).toBe(0);
});
