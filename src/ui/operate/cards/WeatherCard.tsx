import { REPAIR_COST } from '../../../core/sim/disruptions';
import { disruptionActions } from '../../../editor/simRunner';
import { DISRUPTION_KIND_LABEL, DISRUPTION_STATUS_LABEL, OPS_UI, WEATHER_LABEL, displayName, formatClock } from '../../../i18n/ja';
import { focusTarget } from '../focus';
import { useOps } from '../../OpsPanels';
import { Card, CardRow } from '../Card';

/** 天候と発生中の障害、対応（修理）。詳細・発生の設定は「天候・障害」オーバーレイ */
export function WeatherCard() {
  const o = useOps();
  if (!o) return null;
  const { state, ctx } = o.sim;
  const l = ctx.layout;
  const list = state.disruptions.filter((d) => d.status !== 'resolved').slice(-6).reverse();
  const closures = state.closures;
  return (
    <Card id="weather" title={OPS_UI.weatherTitle} open="disruptions" badge={WEATHER_LABEL[state.weather.kind]}>
      <CardRow label={OPS_UI.weatherNow}>
        <b data-testid="card-weather-now">{WEATHER_LABEL[state.weather.kind]}</b>
      </CardRow>
      <CardRow label={OPS_UI.closures} tone={closures.taxiways.length + closures.stands.length + closures.gates.length > 0 ? 'warn' : undefined}>
        {OPS_UI.closuresText(closures.taxiways.length, closures.stands.length, closures.gates.length)}
      </CardRow>
      {list.length === 0 && <div className="card-sub">{OPS_UI.noDisruption}</div>}
      {list.map((d) => (
        <div key={d.id} className="card-item" data-testid={`card-disruption-${d.id}`}>
          <button className="link" onClick={() => focusTarget(d.targetId)} title={OPS_UI.jump}>
            {DISRUPTION_KIND_LABEL[d.kind]}
            {d.weather ? `（${WEATHER_LABEL[d.weather]}）` : ''}
            {d.targetId ? ` ${displayName(l, d.targetId)}` : ''}
          </button>
          <span className={d.status === 'active' ? 'ng-text' : 'muted'}>
            {DISRUPTION_STATUS_LABEL[d.status]}
            {d.end !== null ? ` 〜${formatClock(d.end)}` : ''}
          </span>
          {!['weather', 'demandSurge', 'inboundDelay'].includes(d.kind) && (
            <button className="small" onClick={() => disruptionActions.resolve(d.id)} title={`費用 ${REPAIR_COST[d.kind].toLocaleString('ja-JP')} cr`} data-testid={`card-resolve-${d.id}`}>
              {OPS_UI.repair}
            </button>
          )}
        </div>
      ))}
    </Card>
  );
}
