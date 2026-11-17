import { ops } from '../editor/simRunner';
import { formatCr, useEditor } from '../editor/store';
import { airlineDef } from '../core/economy/registry';
import type { DayReview, ReviewFlight, ReviewMetric } from '../core/analytics/review';
import type { ScoreComponent, ScoreKey } from '../core/economy/airlineScore';
import { COST_CATEGORIES, REVENUE_CATEGORIES } from '../core/economy/company';
import { GAME_UI, AIRCRAFT_STATE_LABEL, COST_LABEL, DAY_LOOP, DELAY_CAUSE_LABEL, DISRUPTION_KIND_LABEL, HOLD_REASON_LABEL, PLAN_ISSUE_LABEL, REVENUE_LABEL, REVIEW_METRIC_LABEL, SCORE_LABEL, SCORE_LEVEL_LABEL, TASK_LABEL } from '../i18n/ja';
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
const duration = (sec: number | null | undefined) => {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '記録なし';
  const n = Math.max(0, Math.round(sec));
  const min = Math.floor(n / 60);
  return min > 0 ? `${min}分${String(n % 60).padStart(2, '0')}秒` : `${n}秒`;
};

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
        <Row label="評価対象の平均遅延" value={`${num(k.avgDelayMin)} 分`} />
        {k.actualAvgDelayMin !== undefined && <Row label="実績の平均遅延" value={`${k.actualAvgDelayMin.toFixed(1)} 分`} />}
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

      <Section id="review-flights" title="便別の問題・時系列">
        {!review.flights ? (
          <div className="card-sub">この保存済み振り返りには便別の原因記録がありません。過去の記録から時刻や原因を補完していません。</div>
        ) : review.flights.length === 0 ? (
          <div className="card-sub">記録された便に個別の遅延・運航不能・旅客影響はありません。</div>
        ) : (
          <>
            <div className="muted small">実績時刻・原因・待ち時間は便記録とシミュレーション履歴から表示します。記録のない事象の時刻は補っていません。</div>
            <div className="review-flight-list">
              {review.flights.map((flight) => (
                <ReviewFlightDetail key={flight.aircraftId} flight={flight} review={review} />
              ))}
            </div>
          </>
        )}
      </Section>

      <Section id="review-pax" title={DAY_LOOP.paxTitle}>
        <Row label={DAY_LOOP.pax} value={`${(k.paxDeparted + k.paxArrived).toLocaleString('ja-JP')} 人`} />
        <Row label={DAY_LOOP.missed} value={`${k.missedPax} 人`} tone={k.missedPax > 0 ? 'warn' : undefined} />
        <Row label={DAY_LOOP.bags} value={`${k.leftBags} 個`} tone={k.leftBags > 0 ? 'warn' : undefined} />
        <Row label={DAY_LOOP.paxSat} value={num(k.paxSatisfaction)} />
        <Row label={DAY_LOOP.airSat} value={num(k.airlineSatisfaction)} />
        <Row label={DAY_LOOP.rating} value={num(k.rating)} />
      </Section>

      <Section id="review-airport-causes" title="空港全体の評価要因と改善提案">
        <Row label="空港評価（締め時点）" value={prev ? `${num(prev.kpi.rating)} → ${num(k.rating)}` : `${num(k.rating)}（前日記録なし）`} tone={prev && k.rating < prev.kpi.rating ? 'warn' : undefined} />
        <Row label="当日の評価入力" value={`旅客満足度 ${num(k.paxSatisfaction)} · 航空会社満足度 ${num(k.airlineSatisfaction)} · 定時率 ${pct(k.otp)}`} />
        <div className="muted small">便があった日の空港評価は、当日値（旅客40%・航空会社40%・定時率20%）を前日評価と 7:3 で平滑化します。ここでは記録された入力と運航上の制約を示し、個々の寄与を根拠なく配賦しません。</div>
        {review.bottlenecks.length === 0 ? (
          <div className="card-sub" data-testid="review-bottlenecks">運航記録から特定できる共通原因はありません。原因を特定できる記録なし。</div>
        ) : (
          <div className="card-sub" data-testid="review-bottlenecks">
            <b>実運航ログから特定した共通原因</b>
            {review.bottlenecks.slice(0, 6).map((b) => (
              <div key={b.cause} className="review-bottleneck">
                <Row label={causeLabel(b.cause)} value={`${b.flights}便`} />
                <div className="muted small">{b.evidence}。記録便の時刻範囲: {hhmm(b.firstRecordAt)}〜{hhmm(b.lastRecordAt)}。影響便: {b.flightNumbers.slice(0, 8).join('、')}{b.flightNumbers.length > 8 ? ` ほか${b.flightNumbers.length - 8}便` : ''}</div>
                <div className="small">改善案: {b.recommendation}</div>
              </div>
            ))}
            <div className="muted small">時間帯は便記録の運航時刻です。原因の個別発生時刻や不足資源数が記録されていない場合、推測していません。</div>
          </div>
        )}
      </Section>

      {r.city && (
        <Section id="review-city" title="都市・旅客需要">
          <Row label="都市規模" value={GAME_UI.cityType[r.city.type]} />
          <Row label="人口" value={`${r.city.populationStart.toLocaleString('ja-JP')} → ${r.city.populationEnd.toLocaleString('ja-JP')} 人`} />
          <Row label="需要上限" value={`${r.city.demandCeiling.toLocaleString('ja-JP')} 人/日`} />
          <Row label="計画需要 / 実績" value={`${r.city.expectedPax.toLocaleString('ja-JP')} / ${r.city.actualPax.toLocaleString('ja-JP')} 人`} />
          <Row label="都市係数" value={`×${r.city.cityFactor.toFixed(2)}`} />
          <Row label="道路 / 鉄道品質" value={`${r.city.roadQuality} / ${r.city.railQuality}`} />
          {r.city.noiseMovements !== undefined && <Row label="航空機の騒音ポイント" value={`${r.city.noisePoints ?? 0}（${r.city.noiseMovements} 動作）`} />}
          {r.city.nightMovements !== undefined && <Row label="夜間運航（22:00〜06:00）" value={`${r.city.nightMovements} 回`} tone={r.city.nightMovements > 0 ? 'warn' : undefined} />}
          {r.city.residentsStart !== undefined && r.city.residentsEnd !== undefined && <Row label="住民満足度" value={`${r.city.residentsStart.toFixed(1)} → ${r.city.residentsEnd.toFixed(1)}（${(r.city.residentDelta ?? 0) >= 0 ? '+' : ''}${(r.city.residentDelta ?? 0).toFixed(2)}）`} tone={(r.city.residentDelta ?? 0) < 0 ? 'warn' : undefined} />}
          {(r.city.events?.length ?? 0) > 0 && <Row label="開催イベント" value={r.city.events!.map((event) => `${({ festival: '祭り', sports: 'スポーツ大会', conference: '会議・展示会' } as const)[event.kind]}（規模${event.scale}・${event.location === 'cityCenter' ? '市街地' : '空港周辺'}）`).join('、')} />}
          {(r.city.eventDemandMultiplier ?? 1) > 1 && <Row label="イベント需要係数" value={`×${r.city.eventDemandMultiplier!.toFixed(2)} / 道路混雑 ×${(r.city.eventTrafficMultiplier ?? 1).toFixed(2)}`} />}
          {r.night && (
            <>
              <Row label="最後の出発の離陸の遅れ" value={r.night.lastDepartureDelayMin === null ? '—' : `${r.night.lastDepartureDelayMin} 分`} tone={(r.night.lastDepartureDelayMin ?? 0) >= 60 ? 'warn' : undefined} />
              <Row label="夜間の保留（スポット待機 / 出発地待機）" value={`${r.night.standHeld} / ${r.night.originHeld} 便`} />
              <Row label="翌朝への持ち越し / ダイバート / 欠航" value={`${r.night.carriedOver} / ${r.night.diverted} / ${r.night.cancelled} 便`} tone={r.night.carriedOver > 0 ? 'warn' : undefined} />
            </>
          )}
          <div className="muted small">騒音ポイントは機種サイズ・エンジン数を使ったゲーム内指標で、実測dBではありません。都市設定時は夜間の着陸・離陸を06:00まで待機させます。</div>
        </Section>
      )}

      <Section id="review-disruptions" title={DAY_LOOP.disruptionsTitle}>
        {(review.weather?.changes.length ?? 0) > 0 && (
          <div data-testid="review-weather">
            <Row label={DAY_LOOP.weatherTitle} value={DAY_LOOP.weatherMax(review.weather!.maxLevel)} tone={review.weather!.maxLevel >= 4 ? 'warn' : undefined} />
            {review.weather!.changes.map((c) => (
              <Row key={c.t} label={`${hhmm(c.t)} ${DAY_LOOP.weatherChange}`} value={`段階 ${c.level}`} />
            ))}
          </div>
        )}
        {review.disruptions.length === 0 ? (
          (review.weather?.changes.length ?? 0) > 0 ? null : <div className="card-sub">{DAY_LOOP.noDisruptions}</div>
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
              {a.emaBefore && a.emaAfter && (
                <div className="card-sub muted small">
                  <b>当日締めの評価移動平均（EMA）</b>
                  {(Object.keys(a.emaAfter) as ScoreKey[]).map((key) => `${SCORE_LABEL[key]} ${a.emaBefore?.[key] === undefined ? '60.0（初回の中立値）' : a.emaBefore[key]!.toFixed(1)} → ${a.emaAfter?.[key]?.toFixed(1) ?? '記録なし'}`).join(' · ')}
                  <div>満足度 {a.before.toFixed(1)} → {a.after.toFixed(1)}。不満 {a.complaintsBefore?.length ?? 0} → {a.complaintsAfter?.length ?? 0} 件。</div>
                </div>
              )}
              {a.components ? (
                <div className="review-score-reasons">
                  {a.components.filter((component) => component.level === 'bad' || component.level === 'warn').map((component) => {
                    const numbers = component.facts.flightNumbers ?? [];
                    const flights = (review.flights ?? []).filter((f) => numbers.includes(f.arrNumber) || numbers.includes(f.depNumber));
                    const operating = component.key === 'fees' || component.key === 'aircraft' || (component.key === 'slots' && numbers.length === 0);
                    return (
                      <div key={component.key} className="review-score-reason">
                        <b>{SCORE_LABEL[component.key]} · {SCORE_LEVEL_LABEL[component.level]}{component.score === null ? '' : ` (${component.score}点)`}</b>
                        <div>理由: {scoreReason(component.key, component.facts)}</div>
                        <div>根拠便: {flights.length ? flights.map((f) => `${f.arrNumber}/${f.depNumber}`).join('、') : operating ? '運営上の問題（特定便に帰属しません）' : numbers.length ? `${numbers.join('、')}（便の詳細記録なし）` : '原因を特定できる便記録なし'}</div>
                        <div>影響: {scoreImpact(component.key, flights)}</div>
                        <div>改善案: {scoreRecommendation(component.key)}</div>
                      </div>
                    );
                  })}
                  {a.components.every((component) => component.level !== 'bad' && component.level !== 'warn') && <div className="muted small">当日記録の評価項目に注意・不足はありません。</div>}
                </div>
              ) : (
                <div className="card-sub muted small">当日の評価要素は保存されていません。現行の計画から原因を再計算せず、原因を特定できる記録なしとして表示します。</div>
              )}
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

function ReviewFlightDetail({ flight: f, review }: { flight: ReviewFlight; review: DayReview }) {
  const runway = (id: string | null, name: string | null) => id ? `${name || id} (${id})` : '記録なし';
  const stand = f.standId ? `${f.standName || f.standId} (${f.standId})` : '記録なし';
  const gate = f.gateId ? `${f.gateName || f.gateId} (${f.gateId})` : '記録なし';
  const arrivalCauses = f.arrivalCauses === null ? null : f.arrivalCauses;
  const departureCauses = f.departureCauses === null ? null : f.departureCauses;
  const flightDisruptions = f.disruptionIds.map((id) => ({ id, disruption: review.disruptions.find((d) => d.id === id) }));
  const history = f.timeline;
  return (
    <details className="review-flight" data-testid={`review-flight-${f.aircraftId}`}>
      <summary>
        <b>{f.arrNumber} → {f.depNumber}</b>
        <span>{f.result === 'completed' ? '完了' : f.result === 'diverted' ? 'ダイバート' : '欠航'}</span>
        <span>{f.airlineId ? airlineDef(f.airlineId).name : '航空会社記録なし'} · {f.typeName}</span>
        <span>実遅延 {duration(Math.max(f.actualArrivalDelaySec ?? 0, f.actualDepartureDelaySec ?? 0))}</span>
        {(f.paxMissed > 0 || f.bagsLeft > 0) && <span className="ng-text">乗り遅れ {f.paxMissed}人・積み残し {f.bagsLeft}個</span>}
      </summary>
      <div className="review-flight-detail">
        <div className="review-cols">
          <div>
            <Row label="到着便 / 出発便" value={`${f.arrNumber} / ${f.depNumber}`} />
            <Row label="滑走路（到着 / 出発）" value={`${runway(f.arrRunway, f.arrRunwayName)} / ${runway(f.depRunway, f.depRunwayName)}`} />
            <Row label="スポット / ゲート" value={`${stand} / ${gate}`} />
            <Row label="到着予定 / 着陸実績" value={`${hhmm(f.arrScheduled)} / ${f.landedAt === null ? '実績なし' : hhmm(f.landedAt)}`} />
            <Row label="到着遅延（実績 / 評価対象）" value={`${duration(f.actualArrivalDelaySec)} / ${duration(f.evaluatedArrivalDelaySec)}`} />
            <Row label="出発予定 / ブロックアウト / 離陸" value={`${hhmm(f.depScheduled)} / ${f.blockOut === null ? '実績なし' : hhmm(f.blockOut)} / ${f.takeoffAt === null ? '実績なし' : hhmm(f.takeoffAt)}`} />
            <Row label="出発遅延（実績 / 評価対象）" value={`${duration(f.actualDepartureDelaySec)} / ${duration(f.evaluatedDepartureDelaySec)}`} />
            {f.takeoffDelaySec !== undefined && <Row label="離陸の遅れ（出発の実遅延とは別・夜間の待機を含む）" value={duration(f.takeoffDelaySec)} />}
            {f.departureGraceSec !== null && <Row label="折返し出発猶予" value={duration(f.departureGraceSec)} />}
          </div>
          <div>
            <Row label="地上走行（到着 / 出発）" value={`${duration(f.taxiInSec)} / ${duration(f.taxiOutSec)}`} />
            <Row label="空中待機 / 地上停止" value={`${duration(f.airborneHoldSec)} / ${duration(f.groundStopSec)}`} />
            <Row label="作業待ち / バス待ち" value={`${duration(f.taskBlockedSec)} / ${duration(f.busWaitSec)}`} />
            <Row label="旅客（予約 / 搭乗 / 乗り遅れ / 到着）" value={`${f.paxBooked} / ${f.paxBoarded} / ${f.paxMissed} / ${f.paxArrived}`} />
            <Row label="手荷物（積載 / 積み残し）" value={`${f.bagsLoaded} / ${f.bagsLeft}`} />
            <Row label="到着の原因" value={arrivalCauses === null ? '脚別記録なし' : arrivalCauses.length ? arrivalCauses.map(causeLabel).join('、') : '記録された原因なし'} />
            <Row label="出発の原因" value={departureCauses === null ? '脚別記録なし' : departureCauses.length ? departureCauses.map(causeLabel).join('、') : '記録された原因なし'} />
            {arrivalCauses === null && departureCauses === null && <Row label="便全体の原因（脚別記録なし）" value={f.causes.length ? f.causes.map(causeLabel).join('、') : '記録された原因なし'} />}
            <Row label="外部要因遅延（原因 / 秒数）" value={Object.entries(f.arrivalExternalDelaySec).length ? Object.entries(f.arrivalExternalDelaySec).map(([cause, sec]) => `${causeLabel(cause)} ${duration(sec)}`).join('、') : '記録なし'} />
            <Row label="影響した評価項目" value={f.impactKeys.length ? f.impactKeys.map((key) => SCORE_LABEL[key]).join('、') : '評価根拠への直接ひも付けなし'} />
          </div>
        </div>
        <div className="review-flight-timeline">
          <b>運航時系列</b>
          {history.length === 0 ? <div className="muted small">機体状態の時系列記録なし</div> : history.map((entry, index) => {
            const next = history[index + 1];
            const phaseDuration = next ? Math.max(0, next.t - entry.t) : null;
            return <div key={`${entry.t}:${entry.state}:${index}`} className="review-timeline-row"><time>{hhmm(entry.t)}</time><b>{AIRCRAFT_STATE_LABEL[entry.state]}</b>{phaseDuration !== null && <span>{duration(phaseDuration)}</span>}{entry.note && <span>{causeLabel(entry.note)}</span>}</div>;
          })}
          {f.taskRecords.length > 0 && <div className="review-task-timeline">
            <b>地上作業</b>
            {f.taskRecords.map((task, index) => <div key={`${task.kind}:${index}`} className="review-timeline-row"><time>{task.startedAt === null ? `依頼 ${hhmm(task.createdAt)} · 開始時刻記録なし` : `${hhmm(task.startedAt)}〜${task.doneAt === null ? '進行中' : hhmm(task.doneAt)}`}</time><b>{TASK_LABEL[task.kind]}</b><span>実作業 {task.startedAt !== null && task.doneAt !== null ? duration(task.doneAt - task.startedAt) : '記録なし'} · 停止 {duration(task.blockedSec)}</span>{task.note && <span>{task.note}</span>}</div>)}
          </div>}
          {f.events.length > 0 && <div className="review-task-timeline">
            <b>関連事象</b>
            {f.events.map((event, index) => <div key={`${event.t}:${event.kind}:${index}`} className="review-timeline-row"><time>{hhmm(event.t)}</time><b>{eventLabel(event.kind)}</b><span>{event.reason ? causeLabel(event.reason) : event.note ? causeLabel(event.note) : ''}</span></div>)}
          </div>}
          {flightDisruptions.length > 0 && <div className="review-task-timeline"><b>関連障害</b>{flightDisruptions.map(({ id, disruption }) => <div key={id} className="review-timeline-row"><time>{disruption ? hhmm(disruption.start) : '時刻記録なし'}</time><b>{disruption ? DISRUPTION_KIND_LABEL[disruption.kind] : '障害記録が見つかりません'}</b><span>{id}{disruption?.target ? ` · ${disruption.target}` : ''}</span><span>{disruption?.resolvedBy === 'player' ? DAY_LOOP.resolvedByPlayer : disruption?.resolvedBy === 'time' ? DAY_LOOP.resolvedByTime : DAY_LOOP.unresolved}</span></div>)}</div>}
        </div>
      </div>
    </details>
  );
}

function eventLabel(kind: string): string {
  const labels: Record<string, string> = { hold: '待機', goAround: '着陸復行', diverted: 'ダイバート', cannotOperate: '運航不能', taskBlocked: '地上作業停止', taskDone: '地上作業完了', boardingOpen: '搭乗開始', boardingClosed: '搭乗締切', boardingOpened: '搭乗開始', flightLanded: '着陸', blockIn: '駐機開始', bagsReady: '手荷物受取開始', groundReady: '地上作業完了', blockOut: 'プッシュバック', takeoff: '離陸', paxMissed: '乗り遅れ', busRescue: 'バス救援', standAssigned: 'スポット割当', disruption: '障害' };
  return labels[kind] ?? kind;
}

function scoreReason(key: string, facts: ScoreComponent['facts']): string {
  const value = Number(facts.value ?? 0);
  const target = Number(facts.target ?? 0);
  const n = Number(facts.n ?? 0);
  switch (key) {
    case 'otp': return `定時率 ${pct(value)}、要求 ${pct(target)}${facts.names ? `。記録上の主因 ${String((facts.names as string[])[0])}` : ''}`;
    case 'turnaround': return `標準より平均 ${value} 分、標準 ${target} 分`;
    case 'stand': return `当日評価でスポット競合 ${value}便、ゲート不足 ${target}便、スポット待ち ${n}便`;
    case 'fees': return `料金倍率 ${value.toFixed(2)}、割引後 ${target.toFixed(2)}`;
    case 'slots': return `当日計画で時間枠の問題 ${value}便、契約時間外 ${n}件`;
    case 'aircraft': return `運航条件に合わない契約機材 ${value}種、保有機材 ${target}種`;
    case 'pax': return `乗り遅れ率 ${pct(value)}、手荷物積み残し率 ${pct(target)}`;
    default: return '保存された評価事実を確認してください';
  }
}

function scoreImpact(key: string, flights: ReviewFlight[]): string {
  if (!flights.length) return '便への影響を記録から特定できません';
  if (key === 'otp') return `${flights.map((f) => `${f.arrNumber}/${f.depNumber}`).join('、')} の評価対象遅延が定時性に反映`;
  if (key === 'turnaround') return `${flights.map((f) => `${f.arrNumber}/${f.depNumber}`).join('、')} のブロックインから準備完了までを集計`;
  if (key === 'pax') return `乗り遅れ ${flights.reduce((n, f) => n + f.paxMissed, 0)}人、積み残し ${flights.reduce((n, f) => n + f.bagsLeft, 0)}個`;
  return `${flights.map((f) => `${f.arrNumber}/${f.depNumber}`).join('、')}`;
}

function scoreRecommendation(key: string): string {
  const recommendations: Record<string, string> = {
    otp: '外部遅延と空港内遅延を分けて確認し、地上走行・作業・搭乗のうち記録された原因から対策してください。',
    turnaround: '長時間の作業・停止が記録された便と作業工程を確認し、人員・車両または折返し時間を調整してください。',
    stand: '当日記録で競合・ゲート不足が出た時間帯のスポット割当と搭乗方式を見直してください。',
    fees: '契約割引を含む当日の料金倍率を確認し、料金設定または契約条件を調整してください。',
    slots: '当日評価に保存された契約時間帯・運航枠の問題を確認し、契約便の時刻または運用時間を調整してください。',
    aircraft: '対応できない機材の記録を確認し、施設適合性または契約機材を見直してください。',
    pax: '乗り遅れ・積み残しが記録された便の旅客動線、搭乗時間、手荷物作業を確認してください。',
  };
  return recommendations[key] ?? '記録された根拠に合わせて運用を見直してください。';
}
