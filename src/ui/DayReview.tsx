import { ops } from '../editor/simRunner';
import { formatCr, useEditor } from '../editor/store';
import { airlineDef } from '../core/economy/registry';
import type { DayReview, ReviewMetric } from '../core/analytics/review';
import { COST_CATEGORIES, REVENUE_CATEGORIES } from '../core/economy/company';
import { GAME_UI, COST_LABEL, DAY_LOOP, DELAY_CAUSE_LABEL, DISRUPTION_KIND_LABEL, HOLD_REASON_LABEL, PLAN_ISSUE_LABEL, REVENUE_LABEL, REVIEW_METRIC_LABEL, SCORE_LABEL } from '../i18n/ja';
import type { DelayCause, HoldReason } from '../core/sim/types';
import { DAY_SEC } from '../core/sim/rules';
import { dayFlowActions } from '../editor/dayFlowActions';
import { ForecastBlocks } from './operate/WxView';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, d = 1) => (v === null ? '—' : v.toFixed(d));
const hhmm = (t: number) => {
  const m = Math.floor((((t % DAY_SEC) + DAY_SEC) % DAY_SEC) / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const causeLabel = (c: string) => DELAY_CAUSE_LABEL[c as DelayCause] ?? HOLD_REASON_LABEL[c as HoldReason] ?? c;

const fmtMetric = (m: ReviewMetric, v: number | null): string => {
  if (v === null) return '—';
  if (m === 'otp') return pct(v);
  if (m === 'totalRevenue' || m === 'totalCost' || m === 'operatingProfit') return formatCr(v);
  if (m === 'avgDelayMin' || m === 'paxSatisfaction' || m === 'airlineSatisfaction' || m === 'rating') return v.toFixed(1);
  return String(Math.round(v));
};

/** 振り返りの画面（上部バーを残した全画面）。運航の締めの直後・「前日の振り返り」・履歴からの読み取り専用で使う */
export function DayReviewOverlay() {
  const df = useEditor((s) => s.dayFlow);
  const mode = useEditor((s) => s.mode);
  const live = mode === 'operate' && df.phase === 'review';
  const review = live ? df.review : df.viewing;
  if (!review) return null;
  return (
    <div className="day-review" data-testid="day-review" role="dialog" aria-label={DAY_LOOP.reviewTitle(review.day)}>
      <div className="day-review-head">
        <h2 data-testid="review-title">{DAY_LOOP.reviewTitle(review.day)}</h2>
        <span className="muted">{live ? DAY_LOOP.reviewSub : DAY_LOOP.reviewArchive}</span>
      </div>
      <div className="day-review-body">
        <ReviewBody review={review} />
      </div>
      <div className="day-review-foot">
        {live ? (
          <>
            <button className="primary" onClick={() => ops.nextDay()} data-testid="review-next">
              {DAY_LOOP.reviewNext}
            </button>
            <button onClick={() => ops.stop()} data-testid="review-build">
              {DAY_LOOP.reviewBuild}
            </button>
            <button onClick={() => dayFlowActions.openHistory(true)} data-testid="review-history">
              {DAY_LOOP.reviewHistory}
            </button>
          </>
        ) : (
          <button className="primary" onClick={() => ops.viewReview(null)} data-testid="review-close">
            {DAY_LOOP.reviewClose}
          </button>
        )}
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="review-sec" data-testid={id}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`card-row ${tone ?? ''}`}>
      <span className="card-label">{label}</span>
      <span className="card-value">{value}</span>
    </div>
  );
}

export function ReviewBody({ review }: { review: DayReview }) {
  const { report: r, prev } = review;
  const k = r.kpi;
  const layout = useEditor((s) => s.history.present);
  const nameOf = (id: string): string => {
    const f = layout.facilities[id];
    return f?.name || id;
  };
  const revenue = REVENUE_CATEGORIES.filter((c) => r.revenue[c]);
  const cost = COST_CATEGORIES.filter((c) => r.cost[c]);
  return (
    <div className="review-grid">
      <Section id="review-revenue" title={DAY_LOOP.money}>
        <div className="review-cols">
          <div>
            <h4>
              {DAY_LOOP.revenue} <b data-testid="review-revenue-total">{formatCr(r.totalRevenue)}</b>
            </h4>
            {revenue.map((c) => (
              <Row key={c} label={REVENUE_LABEL[c]} value={formatCr(r.revenue[c]!)} />
            ))}
          </div>
          <div data-testid="review-cost">
            <h4>
              {DAY_LOOP.cost} <b data-testid="review-cost-total">{formatCr(r.totalCost)}</b>
            </h4>
            {cost.map((c) => (
              <Row key={c} label={COST_LABEL[c]} value={formatCr(r.cost[c]!)} />
            ))}
            {r.construction !== 0 && <Row label={DAY_LOOP.construction} value={formatCr(r.construction)} />}
          </div>
        </div>
        <Row label={DAY_LOOP.profit} value={<b>{formatCr(r.operatingProfit)}</b>} tone={r.operatingProfit >= 0 ? 'ok' : 'bad'} />
        <Row label={DAY_LOOP.cashEnd} value={formatCr(r.cashEnd)} tone={r.cashEnd < 0 ? 'bad' : undefined} />
      </Section>

      <Section id="review-otp" title={DAY_LOOP.punctuality}>
        <Row label={DAY_LOOP.otp} value={<b data-testid="review-otp-value">{pct(k.otp)}</b>} tone={k.otp === null ? undefined : k.otp >= 0.85 ? 'ok' : k.otp >= 0.6 ? 'warn' : 'bad'} />
        <Row label={DAY_LOOP.avgDelay} value={`${num(k.avgDelayMin)} 分`} />
        <Row label={DAY_LOOP.flights} value={`${k.flights}`} />
        <div className="card-sub" data-testid="review-causes">
          <b>{DAY_LOOP.causes}</b>
          {review.delayCauses.length === 0 ? (
            <div>{DAY_LOOP.noCauses}</div>
          ) : (
            review.delayCauses.slice(0, 6).map((c) => <Row key={c.cause} label={causeLabel(c.cause)} value={DAY_LOOP.flightsN(c.flights)} />)
          )}
        </div>
      </Section>

      <Section id="review-pax" title={DAY_LOOP.paxTitle}>
        <Row label={DAY_LOOP.pax} value={`${(k.paxDeparted + k.paxArrived).toLocaleString('ja-JP')} 人`} />
        <Row label={DAY_LOOP.missed} value={`${k.missedPax} 人`} tone={k.missedPax > 0 ? 'warn' : undefined} />
        <Row label={DAY_LOOP.bags} value={`${k.leftBags} 個`} tone={k.leftBags > 0 ? 'warn' : undefined} />
        <Row label={DAY_LOOP.paxSat} value={num(k.paxSatisfaction)} />
        <Row label={DAY_LOOP.airSat} value={num(k.airlineSatisfaction)} />
        <Row label={DAY_LOOP.rating} value={num(k.rating)} />
      </Section>

      <Section id="review-disruptions" title={DAY_LOOP.disruptionsTitle}>
        {review.disruptions.length === 0 ? (
          <div className="card-sub">{DAY_LOOP.noDisruptions}</div>
        ) : (
          review.disruptions.map((d) => (
            <Row
              key={d.id}
              label={`${hhmm(d.start)} ${DISRUPTION_KIND_LABEL[d.kind]}${d.target ? `（${nameOf(d.target)}）` : ''}`}
              value={d.resolvedBy === 'player' ? DAY_LOOP.resolvedByPlayer : d.resolvedBy === 'time' ? DAY_LOOP.resolvedByTime : DAY_LOOP.unresolved}
            />
          ))
        )}
        <div className="card-sub" data-testid="review-responses">
          {DAY_LOOP.responses(review.responses)}
        </div>
      </Section>

      <Section id="review-compare" title={DAY_LOOP.compareTitle}>
        {!prev ? (
          <div className="card-sub">{DAY_LOOP.noPrev}</div>
        ) : (
          <table className="board">
            <tbody>
              {review.compare.map((c) => (
                <tr key={c.metric} data-testid={`review-compare-${c.metric}`} className={`verdict-${c.verdict}`}>
                  <td>{REVIEW_METRIC_LABEL[c.metric]}</td>
                  <td className="num">{fmtMetric(c.metric, c.a)}</td>
                  <td className="num">→ {fmtMetric(c.metric, c.b)}</td>
                  <td className={`verdict v-${c.verdict}`}>{c.verdict === 'improved' ? `▲ ${DAY_LOOP.improved}` : c.verdict === 'worse' ? `▼ ${DAY_LOOP.worse}` : c.verdict === 'same' ? `＝ ${DAY_LOOP.same}` : DAY_LOOP.na}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section id="review-airlines" title={DAY_LOOP.airlinesTitle}>
        {review.airlines.length === 0 ? (
          <div className="card-sub">{DAY_LOOP.noAirlines}</div>
        ) : (
          review.airlines.map((a) => (
            <div key={a.id} data-testid={`review-airline-${a.id}`}>
              <Row
                label={airlineDef(a.id).name}
                value={
                  <>
                    {a.before.toFixed(1)} → <b>{a.after.toFixed(1)}</b>{' '}
                    <span className={a.delta > 0 ? 'ok-text' : a.delta < 0 ? 'ng-text' : 'muted'}>({a.delta > 0 ? '+' : ''}{a.delta.toFixed(1)})</span>
                  </>
                }
              />
              {a.worst.length > 0 && <div className="card-sub warn-text">{DAY_LOOP.lacking}: {a.worst.map((w) => SCORE_LABEL[w]).join('・')}</div>}
              {a.newComplaints?.map((k) => (
                <div key={k} className="card-sub ng-text" data-testid={`review-complaint-${a.id}`}>{GAME_UI.newComplaint(airlineDef(a.id).name, SCORE_LABEL[k])}</div>
              ))}
              {a.fulfilled && a.fulfilled.length > 0 && <div className="card-sub ok-text" data-testid={`review-fulfilled-${a.id}`}>{GAME_UI.fulfilled}: {a.fulfilled.length}</div>}
            </div>
          ))
        )}
      </Section>

      {review.goals && (
        <Section id="review-goals" title={GAME_UI.reviewGoals}>
          {review.goals.completed.length === 0 ? (
            <div className="card-sub">{GAME_UI.reviewNoGoals}</div>
          ) : (
            review.goals.completed.map((g) => <Row key={g.id} label={GAME_UI.goal[g.id]?.title ?? g.id} value={g.cash > 0 ? formatCr(g.cash) : GAME_UI.goal[g.id]?.reward} />)
          )}
          <Row label={GAME_UI.tierLabel(GAME_UI.tier[review.goals.tier]!)} value={review.goals.tierUp ? GAME_UI.tierUp(GAME_UI.tier[review.goals.tier]!) : ''} />
        </Section>
      )}

      <Section id="review-tomorrow" title={DAY_LOOP.tomorrowTitle}>
        <div data-testid="review-tomorrow-flights">{DAY_LOOP.tomorrowFlights(review.tomorrow.flights)}</div>
        <div className="card-sub">
          <b>{DAY_LOOP.tomorrowIssues}</b>
          {review.tomorrow.issues.length === 0 ? (
            <div>{DAY_LOOP.noIssues}</div>
          ) : (
            review.tomorrow.issues.slice(0, 5).map((i, n) => (
              <div key={n} className={i.severity === 'error' ? 'ng-text' : i.severity === 'info' ? 'muted' : 'warn-text'}>
                {PLAN_ISSUE_LABEL[i.code]}
                {i.detail ? `（${i.detail}）` : ''}
              </div>
            ))
          )}
        </div>
        <div className="card-sub">
          <b>{DAY_LOOP.completing}</b>
          {review.tomorrow.completing.length === 0 ? (
            <div>{DAY_LOOP.noCompleting}</div>
          ) : (
            review.tomorrow.completing.map((p) => (
              <div key={p.id}>
                {DAY_LOOP.projectKind[p.kind] ?? p.kind}: {nameOf(p.id)}
              </div>
            ))
          )}
        </div>
        <div className="card-sub">
          <b>{DAY_LOOP.weather}</b>
          {review.tomorrow.weather ? <ForecastBlocks f={review.tomorrow.weather} testId="review-forecast" /> : <div>{DAY_LOOP.weatherNone}</div>}
        </div>
      </Section>
    </div>
  );
}
