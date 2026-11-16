/**
 * 再現: 燃料施設（または整備士）がない空港で、計画・運航可否が「運航できない」を示さず、便が計画されたまま出発できずに詰まる。
 * 期待（docs/17_compatibility.md §ルール「地上支援: 必要な車両・作業員が空港に 1 台以上 → GSE_NONE（ng）」「燃料施設がある → NO_FUEL_FARM」、
 *   §運航への反映「運航計画の分析は、その空港で運航できない機種の便をエラーとして示す」「判定を重複して実装しない」）:
 *   燃料施設のない空港では、計画分析（analyzeDayPlan）が運航不能のエラーを返す、または operableTypes から機種が除かれる。
 * 実際: src/core/aircraft/compat.ts:220-229 の canOperate は地上支援を見ない（コメントは「地上支援の不足は運航できるが遅れる」）。
 *   しかし燃料施設なし／整備士 0 は「遅れ」ではなく無期限の停止になる（src/core/sim/ground.ts:380 noFuelFarm、ground.ts:465 noEngineer。
 *   給油・点検が完了せず出発準備が整わない）。計画は便を作り続け、到着機がスポットに居座る。
 * 実行: AUDIT_KNOWN=1 npx vitest run -c vitest.audit.config.ts tests/audit/known-issues/e_noFuelFarmPlan
 */
import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { analyzeDayPlan, planDay } from '../../../src/core/economy/planning';
import { deleteEntity } from '../../../src/core/layout/operations';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { operableTypes } from '../../../src/core/sim/context';
import { createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import { must } from '../../unit/helpers';

describe('e-repro 燃料施設なしでも計画は運航可能として便を作る', () => {
  it('燃料施設を撤去したサンプル空港: 計画分析にエラーが出る（期待）。実際は 0 件で、運航すると出発 0 便', () => {
    let l = createSampleAirport();
    for (const f of Object.values(l.facilities)) if (f.kind === 'fuelFarm') l = must(deleteEntity(l, f.id)).layout;
    const company = createSandboxCompany('e-repro-fuel');
    const sim = createSimulation(l, { seed: 'e-repro-fuel', company });
    const plan = planDay(company, 0, 1, sim.ctx.types);
    const analysis = analyzeDayPlan(plan, sim.ctx);
    for (let i = 0; i < 3 * 3600; i++) stepSimulation(sim);
    const errors = analysis.issues.filter((x) => x.severity === 'error');
    console.log(`[audit-e] repro-nofuel ${JSON.stringify({ plannedFlights: plan.flights.length, planErrors: errors.length, operableTypes: operableTypes(sim.ctx).length, departuresAfter3h: sim.state.stats.departures, noFuelFarmSec: sim.state.groundStats.blockedSec.noFuelFarm ?? 0 })}`);
    expect(plan.flights.length).toBeGreaterThan(0);
    expect(errors.length, '計画分析が運航不能をエラーとして示す').toBeGreaterThan(0);
  }, 120_000);
});
