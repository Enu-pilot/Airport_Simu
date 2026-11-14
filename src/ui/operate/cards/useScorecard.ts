import { airlineScorecard, type AirlineScore } from '../../../core/economy/airlineScore';
import { analyzeDayPlan, planDayWithDemand } from '../../../core/economy/planning';
import { useSecondly } from '../Card';

/** 航空会社の評価（読み取り専用の導出）。運航計画の分析を含むので 1 秒に 1 回だけ作り直す */
export function useScorecard(): AirlineScore[] | null {
  return useSecondly((o) => {
    const { sim } = o;
    const company = sim.company;
    if (!company) return null;
    const plan = planDayWithDemand(company, company.day, sim.state.access?.factor ?? 1, sim.ctx.types);
    const analysis = analyzeDayPlan(plan, sim.ctx, sim.state.closures.gates);
    return airlineScorecard({ company, ctx: sim.ctx, records: sim.state.analytics.records, plan, analysis });
  });
}
