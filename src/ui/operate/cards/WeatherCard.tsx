import { REPAIR_COST } from '../../../core/sim/disruptions';
import { disruptionActions } from '../../../editor/simRunner';
import { DISRUPTION_KIND_LABEL, DISRUPTION_STATUS_LABEL, OPS_UI, WEATHER_LABEL, displayName, formatClock } from '../../../i18n/ja';
import { focusTarget } from '../focus';
import { useOps } from '../../OpsPanels';
import { Card, CardRow, useSecondly } from '../Card';
import { effectiveWx, forecastForDay } from '../../../core/sim/weather';
import { GAME_UI } from '../../../i18n/ja';
import { ForecastBlocks, LevelChip } from '../WxView';
import { DAY_SEC } from '../../../core/sim/rules';

/** 天候と発生中の障害、対応（修理）。詳細・発生の設定は「天候・障害」オーバーレイ */
export function WeatherCard() {
  useSecondly(() => 0); // 時間帯の表示を 1 秒ごとに更新する
  const o = useOps();
  if (!o) return null;
  const { state, ctx } = o.sim;
  const l = ctx.layout;
  const list = state.disruptions.filter((d) => d.status !== 'resolved').slice(-6).reverse();
  const closures = state.closures;
  const game = o.sim.company?.game;
  const levels = game?.weather === 'levels';
  const eff = levels && state.wx ? effectiveWx(state.wx) : null;
  const hour = Math.floor((state.now % DAY_SEC) / 3600);
  // 明日の予報（会社の暦の日 + 1。計画と同じ純関数から作る）
  const tomorrow = levels && game && o.sim.company ? forecastForDay(o.sim.company.seed, o.sim.company.day + 1, game) : null;
  return (
    <Card id="weather" title={OPS_UI.weatherTitle} open="disruptions" badge={WEATHER_LABEL[state.weather.kind]}>
      <CardRow label={OPS_UI.weatherNow}>
        <b data-testid="card-weather-now">{WEATHER_LABEL[state.weather.kind]}</b>
      </CardRow>
      {eff && (
        <div className="card-item" data-testid="weather-level-row">
          <span className="card-label">{GAME_UI.wxTitle}</span>
          <LevelChip level={eff.level} type={eff.type} testId="weather-level" />
          <div className="wx-hourly" data-testid="weather-hourly" title={GAME_UI.wxHourly}>
            {state.wx!.hours.map((h, i) => (
              <span key={i} className={`wx-l${h.level}${i === hour ? ' now' : ''}`} title={`${i}時 ${GAME_UI.wxType[h.type]} ${h.level}`} />
            ))}
          </div>
          <div className="muted small">{GAME_UI.wxEffectNote}</div>
        </div>
      )}
      {tomorrow && (
        <div className="card-item">
          <span className="card-label">{GAME_UI.wxForecast}</span>
          <ForecastBlocks f={tomorrow} testId="weather-forecast" />
        </div>
      )}
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
