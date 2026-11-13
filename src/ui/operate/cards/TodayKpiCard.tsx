import { computeKpi } from '../../../core/economy/ops';
import { COST_CATEGORIES, REVENUE_CATEGORIES } from '../../../core/economy/company';
import { formatCr } from '../../../editor/store';
import { OPS_UI } from '../../../i18n/ja';
import { Card, CardRow, useSecondly } from '../Card';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 1000) / 10}%`);

/** 本日の KPI（暫定値）: 発着・定時率・遅延・旅客・収支。1 秒に 1 回、computeKpi（読み取りのみ）で集計する */
export function TodayKpiCard() {
  const data = useSecondly((o) => {
    const c = o.sim.company;
    if (!c || !o.sim.state.economy) return null;
    const { kpi } = computeKpi(o.sim, c);
    const today = c.today;
    const revenue = REVENUE_CATEGORIES.reduce((s, k) => s + (today[k] ?? 0), 0);
    const cost = COST_CATEGORIES.reduce((s, k) => s - (today[k] ?? 0), 0);
    return { kpi, revenue, cost, day: c.day };
  });
  return (
    <Card id="kpi" title={OPS_UI.kpiTitle} open="finance" badge={data ? `${data.day + 1}${OPS_UI.dayUnit}` : undefined}>
      {data ? (
        <>
          <CardRow label={OPS_UI.kpiMovements}>
            <b data-testid="today-kpi-flights">{data.kpi.flights}</b>
          </CardRow>
          <CardRow label={OPS_UI.kpiOtp} tone={data.kpi.otp !== null && data.kpi.otp < 0.7 ? 'bad' : data.kpi.otp !== null && data.kpi.otp < 0.85 ? 'warn' : undefined}>
            <b data-testid="today-kpi-otp">{pct(data.kpi.otp)}</b>
          </CardRow>
          <CardRow label={OPS_UI.kpiDelay}>
            <b data-testid="today-kpi-delay">{data.kpi.avgDelayMin}分</b>
          </CardRow>
          <CardRow label={OPS_UI.kpiPax}>
            <b data-testid="today-kpi-pax">{data.kpi.paxDeparted + data.kpi.paxArrived}</b>
          </CardRow>
          <CardRow label={OPS_UI.kpiMissed} tone={data.kpi.missedPax > 0 ? 'warn' : undefined}>
            {data.kpi.missedPax}
          </CardRow>
          <CardRow label={OPS_UI.kpiRevenue}>
            <b data-testid="today-kpi-revenue">{formatCr(data.revenue)}</b>
          </CardRow>
          <CardRow label={OPS_UI.kpiCost}>
            <b data-testid="today-kpi-cost">{formatCr(data.cost)}</b>
          </CardRow>
          <CardRow label={OPS_UI.kpiProfit} tone={data.revenue - data.cost < 0 ? 'bad' : 'ok'}>
            <b data-testid="today-kpi-profit">{formatCr(data.revenue - data.cost)}</b>
          </CardRow>
          <div className="card-sub">{OPS_UI.kpiNote}</div>
        </>
      ) : (
        <div className="card-sub">{OPS_UI.kpiNone}</div>
      )}
    </Card>
  );
}
