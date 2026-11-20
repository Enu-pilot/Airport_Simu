import { useEffect, useRef } from 'react';
import { ops } from '../editor/simRunner';
import { goalText } from './operate/cards/GoalsCard';
import { formatCr, useEditor } from '../editor/store';
import { focusEntity } from '../editor/input';
import { useReviewUi } from './shell/reviewUi';
import type { MissBreakdownEntry } from '../core/sim/missBreakdown';
import { airlineDef, destinationDef } from '../core/economy/registry';
import { hubChoiceShare, type TransferOdEntry } from '../core/economy/hub';
import { CITY_NIGHT_CURFEW } from '../core/economy/city';
import { FOLLOWUP_UI, PHASE7B_UI, PROCESS_STEP_LABEL, REPORT_FOLLOWUP_UI } from '../i18n/ja';
import { PROCESS_STEPS } from '../core/sim/processStats';
import type { DayReview, ReviewFlight, ReviewMetric } from '../core/analytics/review';
import type { ScoreComponent, ScoreKey } from '../core/economy/airlineScore';
import { COST_CATEGORIES, REVENUE_CATEGORIES } from '../core/economy/company';
import { GAME_UI, AIRCRAFT_STATE_LABEL, AREA_KIND_LABEL, COST_LABEL, DAY_LOOP, DELAY_CAUSE_LABEL, DISRUPTION_KIND_LABEL, HOLD_REASON_LABEL, MISS_BOTTLENECK_LABEL, PLAN_ISSUE_LABEL, REVENUE_LABEL, REVIEW_METRIC_LABEL, SCORE_LABEL, SCORE_LEVEL_LABEL, TASK_LABEL, UNIT_KIND_LABEL, complaintDetailText, displayName, formatClock, formatMinute } from '../i18n/ja';
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

/** 乗継の接続成功率（日報 hub の既存フィールドからの表示専用の算出。発生 0 は null） */
export function hubConnectionRate(hub: { spawned: number; connected: number }): number | null {
  return hub.spawned > 0 ? hub.connected / hub.spawned : null;
}

/** 乗り遅れ内訳のうち乗継に起因する項目（乗継保安検査の待ち・乗継時間の不足）だけを取り出す */
export function transferMissedEntries(entries: readonly MissBreakdownEntry[] | undefined): MissBreakdownEntry[] {
  return (entries ?? []).filter((e) => e.category === 'transferSecurity' || e.category === 'transferLate');
}

const HUB_OD_KIND_LABEL: Record<TransferOdEntry['kind'], string> = {
  DD: '国内→国内',
  DI: '国内→国際',
  ID: '国際→国内',
  II: '国際→国際',
};

export interface HubOdRow {
  key: string;
  fromName: string;
  toName: string;
  kindLabel: string;
  pax: number;
  pairs: number;
  appeal: number;
  /** 直行競合の採用率（%）。appeal は適用前の値なので、同じ OD で表示側に hubChoiceShare を計算する */
  choiceSharePct: number;
  qualityPct: number;
  gapMin: number;
}

/**
 * 日報の hubOd（5A: その日の計画で配分された乗継の OD 集約記録）を表示行へ写す純関数。
 * HubPanel の接続ペア見込み（当日の計画をその場で再計算した便ペア単位）とは別物で、
 * こちらは締め時に記録された「計画配分」そのもの。並びは core の集計順（人数降順）を保つ。
 */
export function hubOdRows(entries: readonly TransferOdEntry[] | undefined): HubOdRow[] {
  return (entries ?? []).map((e) => ({
    key: `${e.from}|${e.to}|${e.kind}`,
    fromName: destinationDef(e.from).name,
    toName: destinationDef(e.to).name,
    kindLabel: HUB_OD_KIND_LABEL[e.kind] ?? e.kind,
    pax: e.pax,
    pairs: e.pairs,
    appeal: e.appeal,
    choiceSharePct: Math.round(hubChoiceShare(destinationDef(e.from), destinationDef(e.to)) * 100),
    qualityPct: Math.round(e.avgQuality * 100),
    gapMin: Math.round(e.avgGapMin),
  }));
}

const fmtM3 = (v: number): string => (Math.round(v * 10) / 10).toLocaleString('ja-JP', { maximumFractionDigits: 1 });

/**
 * 日報の積替貨物（CARGO-08 格 7・翌日便接続のみ）の表示文を返す純関数。
 * 積替が無い日（0 / 未定義。旧日報を含む）は null を返し、従来表示と同一に保つ。
 */
export function cargoTransshipmentText(cargo: { transshipmentM3?: number } | undefined): string | null {
  const v = cargo?.transshipmentM3;
  if (v === undefined || !(v > 0)) return null;
  return FOLLOWUP_UI.cargoTransshipmentValue(fmtM3(v));
}

export interface PortalUsageRow {
  portalId: string;
  facilityId: string;
  enter: number;
  exit: number;
  total: number;
}

/** 日報の portalUsage（B4: ポータル通過実績）を表示行へ写す純関数（合計の降順） */
export function portalUsageRows(entries: readonly { portalId: string; facilityId: string; enter: number; exit: number }[] | undefined): PortalUsageRow[] {
  return (entries ?? [])
    .map((u) => ({ portalId: u.portalId, facilityId: u.facilityId, enter: u.enter, exit: u.exit, total: u.enter + u.exit }))
    .sort((a, b) => b.total - a.total || (a.portalId < b.portalId ? -1 : 1));
}

/** 0 時からの分（0〜1439）を HH:MM 表記にする */
const minOfDayText = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * 工程ピークの開始表記（5-21 ローリング化への追随）:
 * peakStartMin（最も混んだ連続 60 分の開始分）があればそれを正とし、
 * 持たない旧日報では従来の「{peakHour} 時台」にフォールバックする。
 */
export function processPeakStartText(p: { peakHour: number; peakStartMin?: number }): string {
  return p.peakStartMin !== undefined ? REPORT_FOLLOWUP_UI.peakWindow(minOfDayText(p.peakStartMin)) : REPORT_FOLLOWUP_UI.peakHourBand(p.peakHour);
}

/** タイムライン連動のハイライト判定に使うピークの時（peakStartMin がある行は開始時刻の時で判定する） */
export function processPeakHourOf(p: { peakHour: number; peakStartMin?: number }): number {
  return p.peakStartMin !== undefined ? Math.floor(p.peakStartMin / 60) : p.peakHour;
}

export interface ProcessPeakLike {
  step: string;
  capacityPerHour: number;
  demandPerHour?: number;
  peakHour: number;
  peakStartMin?: number;
  peakProcessed: number;
  utilization: number | null;
  avgWaitSec: number;
}

/**
 * 工程ピーク行の値文字列。能力を算出しない工程（apronBus / access は capacityPerHour = 0）では
 * 「能力 0 人/時」と誤表示せず、能力・使用率を出さない（実績のみ）。需要は空港全体行だけが持つ。
 */
export function processPeakValue(p: ProcessPeakLike): string {
  const parts: string[] = [];
  if (p.capacityPerHour > 0) {
    parts.push(`能力 ${p.capacityPerHour} 人/時`);
    if (p.demandPerHour !== undefined) parts.push(`需要 ${p.demandPerHour} 人/時`);
  } else {
    parts.push(REPORT_FOLLOWUP_UI.noCapacity);
  }
  parts.push(`${processPeakStartText(p)} 実績 ${p.peakProcessed} 人`);
  if (p.capacityPerHour > 0 && p.utilization !== null) parts.push(`使用率 ${Math.round(p.utilization * 100)}%`);
  parts.push(`平均待ち ${Math.round((p.avgWaitSec / 60) * 10) / 10} 分`);
  return parts.join('・');
}

export interface StepWaitRow {
  step: string;
  label: string;
  p50Sec: number;
  p95Sec: number;
  pax: number;
}

/**
 * 日報 doorToDoor.stepWaits（5-23: 工程別の待ち時間の分位点）を表示行へ写す純関数。
 * 並びは工程の正規順（PROCESS_STEPS）。stepWaits を持たない旧日報では空（節ごと出さない）。
 */
export function stepWaitRows(stepWaits: Record<string, { p50Sec: number; p95Sec: number; pax: number }> | undefined): StepWaitRow[] {
  if (!stepWaits) return [];
  const order = new Map<string, number>(PROCESS_STEPS.map((s, i) => [s, i] as const));
  return Object.entries(stepWaits)
    .map(([step, w]) => ({ step, label: PROCESS_STEP_LABEL[step] ?? step, p50Sec: w.p50Sec, p95Sec: w.p95Sec, pax: w.pax }))
    .sort((a, b) => (order.get(a.step) ?? 99) - (order.get(b.step) ?? 99) || (a.step < b.step ? -1 : 1));
}

/**
 * 振り返りの画面（UIデザイン更新 第5段階で右ドロワーの中身になった）。
 * 運航の締めの直後・「前日の振り返り」・履歴からの読み取り専用で使う。
 * タイムラインで時間帯が指定されたら、工程ピークの節までスクロールする。
 */
export function DayReviewPanel() {
  const df = useEditor((s) => s.dayFlow);
  const mode = useEditor((s) => s.mode);
  const live = mode === 'operate' && df.phase === 'review';
  const review = live ? df.review : df.viewing;
  const focusNonce = useReviewUi((s) => s.focusNonce);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusNonce === 0) return;
    bodyRef.current?.querySelector('[data-testid="review-process-peak"]')?.scrollIntoView({ block: 'start' });
  }, [focusNonce]);
  if (!review) return null;
  return (
    <div className="day-review" data-testid="day-review" role="dialog" aria-label={DAY_LOOP.reviewTitle(review.day)}>
      <div className="day-review-head">
        <h2 data-testid="review-title">{DAY_LOOP.reviewTitle(review.day)}</h2>
        <span className="muted">{live ? DAY_LOOP.reviewSub : DAY_LOOP.reviewArchive}</span>
      </div>
      <div className="day-review-body" ref={bodyRef}>
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

function Row({
  label,
  value,
  tone,
  onFocus,
  highlighted,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
  /** 指定すると行クリックで地図の該当箇所へフォーカスする（第5段階の地図連携） */
  onFocus?: () => void;
  /** タイムラインから指定された時間帯に一致する行の強調 */
  highlighted?: boolean;
}) {
  return (
    <div
      className={`card-row ${tone ?? ''}${onFocus ? ' focusable' : ''}${highlighted ? ' row-highlight' : ''}`}
      onClick={onFocus}
      title={onFocus ? '地図で該当箇所を表示' : undefined}
    >
      <span className="card-label">{label}</span>
      <span className="card-value">{value}</span>
    </div>
  );
}

export function ReviewBody({ review }: { review: DayReview }) {
  const { report: r, prev } = review;
  const k = r.kpi;
  const layout = useEditor((s) => s.history.present);
  const focusHour = useReviewUi((s) => s.focusHour);
  const nameOf = (id: string): string => {
    const f = layout.facilities[id];
    return f?.name || id;
  };
  // 第5段階の地図連携: 行クリックで該当箇所へフォーカスする（要対応リストと同じ focusEntity を再利用し、
  // カメラ移動＋選択ハイライトで示す）。対象を特定できない行には付けない
  const focusId = (id: string | null | undefined): (() => void) | undefined =>
    id && (layout.facilities[id] || layout.terminalAreas[id]) ? () => focusEntity(id) : undefined;
  const firstAreaOf = (step: string, terminalId?: string): string | null =>
    Object.values(layout.terminalAreas).find((a) => a.kind === step && (terminalId === undefined || a.terminalId === terminalId))?.id ?? null;
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
        {r.morningWave && (
          <div data-testid="review-morning-wave">
            <Row
              label="朝の始発の波"
              value={`${r.morningWave.departures} 便（${formatClock(r.morningWave.firstTakeoff ?? 0)}〜${formatClock(r.morningWave.lastTakeoff ?? 0)}${r.morningWave.intervalsSec.length ? `、間隔 ${r.morningWave.intervalsSec.map((s) => `${Math.round(s / 60)}分`).join('・')}` : ''}）`}
            />
          </div>
        )}
        {r.maintenance && (
          <div data-testid="review-maintenance">
            <Row label="所属機の整備" value={`整備 ${r.maintenance.checked} 機・周期超過 ${r.maintenance.overdue} 機・不具合 ${r.maintenance.faults} 件（欠航 ${r.maintenance.techCancelled} 件）`} />
          </div>
        )}
        {r.morningReadiness && (
          <div data-testid="review-morning-readiness">
            <Row label="翌朝の出発可能機数" value={`予定 ${r.morningReadiness.scheduled} 機・確定可能 ${r.morningReadiness.ready} 機・リスクあり ${r.morningReadiness.atRisk} 機（06:00–10:00 の滞泊便）`} />
          </div>
        )}
        {r.hub && (
          <div data-testid="review-hub">
            <Row label="乗継" value={`発生 ${r.hub.spawned} 人・接続成功 ${r.hub.connected} 人・乗り遅れ ${r.hub.missed} 人・現れず ${r.hub.noShow} 人`} />
            {/* §6-2 後半: 日報ドロワーで接続成功率と乗り遅れの内訳まで追えるようにする（日報の既存フィールドのみで構成） */}
            <Row label="接続成功率" value={hubConnectionRate(r.hub) === null ? '—' : `${(hubConnectionRate(r.hub)! * 100).toFixed(1)}%`} />
            {transferMissedEntries(r.missedBreakdown).length > 0 && (
              <div data-testid="review-hub-missed">
                <b>乗継の乗り遅れ内訳</b>
                {transferMissedEntries(r.missedBreakdown).map((e, i) => (
                  <Row
                    key={`${e.category}:${e.spotId ?? ''}:${i}`}
                    label={`${MISS_BOTTLENECK_LABEL[e.category]}${e.spotId ? `（${displayName(layout, e.spotId)}）` : ''}`}
                    value={`${e.count} 人`}
                    onFocus={focusId(e.spotId)}
                  />
                ))}
              </div>
            )}
            {r.doorToDoor?.transfer && <Row label="ゲート間所要時間（中央値 / 95%点）" value={`${Math.round(r.doorToDoor.transfer.p50Sec / 60)} 分 / ${Math.round(r.doorToDoor.transfer.p95Sec / 60)} 分（${r.doorToDoor.transfer.pax} 人）`} />}
            {/* 第7段階b: hubOd（5A の OD 別計画配分記録）。上の実績（hub）とは別フェーズの計画値で、二重計上ではない */}
            {hubOdRows(r.hubOd).length > 0 && (
              <div data-testid="review-hub-od">
                <b>{PHASE7B_UI.hubOdTitle}</b>
                <div className="muted small">{PHASE7B_UI.hubOdExplain} {FOLLOWUP_UI.hubOdExplainFollowup}</div>
                <table className="board">
                  <thead>
                    <tr><th>{PHASE7B_UI.hubOdFrom}</th><th>{PHASE7B_UI.hubOdTo}</th><th>種類</th><th>人数</th><th>ペア数</th><th>魅力</th><th>{FOLLOWUP_UI.hubChoiceColumn}</th><th>接続品質</th><th>平均接続時間</th></tr>
                  </thead>
                  <tbody>
                    {hubOdRows(r.hubOd).map((row) => (
                      <tr key={row.key} data-testid={`review-hub-od-row-${row.key}`}>
                        <td>{row.fromName}</td>
                        <td>{row.toName}</td>
                        <td>{row.kindLabel}</td>
                        <td>{row.pax} 人</td>
                        <td>{row.pairs}</td>
                        <td>{row.appeal.toFixed(2)}</td>
                        <td>{row.choiceSharePct}%</td>
                        <td>{row.qualityPct}%</td>
                        <td>{row.gapMin} 分</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {r.cargo && (
          <div data-testid="review-cargo">
            <Row label="貨物" value={`取扱 ${r.cargo.carriedM3} m³（積み残し ${r.cargo.leftoverM3} m³）・収入 ${formatCr(r.cargo.revenue)}・荷役費 ${formatCr(r.cargo.handlingCost)}・トラック ${r.cargo.truckTrips} 台`} />
            {/* 格 7 の積替（翌日便接続のみ）: 積替がある日だけ分けて出す。無い日は従来表示と同一 */}
            {cargoTransshipmentText(r.cargo) !== null && (
              <div data-testid="review-cargo-transshipment">
                <Row label={FOLLOWUP_UI.cargoTransshipmentLabel} value={cargoTransshipmentText(r.cargo)!} />
              </div>
            )}
          </div>
        )}
        {r.doorToDoor && (r.doorToDoor.departure || r.doorToDoor.arrival || r.doorToDoor.transfer) && (
          <div data-testid="review-door-to-door">
            <b>Door-to-Door 所要時間（中央値 / 95%点）</b>
            {/* 5-23 外部境界: 出発の起点はアクセス移動を含む空港への到着時点（従来の入口起点から変更） */}
            {r.doorToDoor.departure && <Row label={REPORT_FOLLOWUP_UI.doorDepartureLabel} value={`${Math.round(r.doorToDoor.departure.p50Sec / 60)} 分 / ${Math.round(r.doorToDoor.departure.p95Sec / 60)} 分（${r.doorToDoor.departure.pax} 人）`} />}
            {r.doorToDoor.arrival && <Row label="到着（降機→退出）" value={`${Math.round(r.doorToDoor.arrival.p50Sec / 60)} 分 / ${Math.round(r.doorToDoor.arrival.p95Sec / 60)} 分（${r.doorToDoor.arrival.pax} 人）`} />}
            {r.doorToDoor.transfer && <Row label="乗継（ゲート間）" value={`${Math.round(r.doorToDoor.transfer.p50Sec / 60)} 分 / ${Math.round(r.doorToDoor.transfer.p95Sec / 60)} 分（${r.doorToDoor.transfer.pax} 人）`} />}
            {r.doorToDoor.stepFree.rate !== null && <Row label="Step-free 完了率" value={`${Math.round(r.doorToDoor.stepFree.rate * 100)}%（完了 ${r.doorToDoor.stepFree.completed} 人・乗り遅れ ${r.doorToDoor.stepFree.missed} 人）`} />}
            <div className="muted small">{REPORT_FOLLOWUP_UI.doorDepartureNote}</div>
            {/* 5-23: 工程別の待ち時間（処理時間ではなく待ち時間）。stepWaits を持たない旧日報では節ごと出さない */}
            {stepWaitRows(r.doorToDoor.stepWaits).length > 0 && (
              <div data-testid="review-door-step-waits">
                <b>{REPORT_FOLLOWUP_UI.stepWaitsTitle}</b>
                <div className="muted small">{REPORT_FOLLOWUP_UI.stepWaitsNote}</div>
                {stepWaitRows(r.doorToDoor.stepWaits).map((w) => (
                  <div key={w.step} data-testid={`review-door-step-wait-${w.step}`}>
                    <Row label={w.label} value={`中央値 ${duration(w.p50Sec)} / 95%点 ${duration(w.p95Sec)}（${w.pax} 人）`} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {r.processPeak && r.processPeak.length > 0 && (
          <div data-testid="review-process-peak">
            <b>最混雑60分の工程別実績</b>
            <div className="muted small">{REPORT_FOLLOWUP_UI.processPeakNote}</div>
            {r.processPeak.map((p) => (
              <Row key={p.step} label={PROCESS_STEP_LABEL[p.step] ?? p.step} value={processPeakValue(p)} onFocus={focusId(firstAreaOf(p.step))} highlighted={focusHour !== null && processPeakHourOf(p) === focusHour} />
            ))}
          </div>
        )}
        {r.processPeakByTerminal && new Set(r.processPeakByTerminal.map((p) => p.terminalId)).size >= 2 && (
          <div data-testid="review-process-peak-by-terminal">
            <b>工程別実績（ターミナル別）</b>
            {r.processPeakByTerminal.map((p) => (
              <Row key={`${p.terminalId}:${p.step}`} label={`${p.terminalId} / ${PROCESS_STEP_LABEL[p.step] ?? p.step}`} value={processPeakValue(p)} onFocus={focusId(firstAreaOf(p.step, p.terminalId))} highlighted={focusHour !== null && processPeakHourOf(p) === focusHour} />
            ))}
          </div>
        )}
        {r.linkUsage && r.linkUsage.length > 0 && (
          <div data-testid="review-link-usage">
            <b>連絡設備・上下移動の利用実績</b>
            {r.linkUsage.map((u) => (
              <Row key={u.linkId} label={u.kind === 'vertical' && u.areaKind ? `${AREA_KIND_LABEL[u.areaKind as keyof typeof AREA_KIND_LABEL] ?? u.areaKind}（${u.linkId.slice('vertical:'.length)}）` : u.label} value={`合計 ${u.total} 人・ピーク ${u.peakHour} 時台 ${u.peakCount} 人${u.capacityPerHour ? `（能力 ${u.capacityPerHour} 人/時）` : ''}`} onFocus={focusId(u.kind === 'vertical' ? u.linkId.slice('vertical:'.length) : layout.terminalLinks?.[u.linkId]?.fromAreaId)} highlighted={focusHour !== null && u.peakHour === focusHour} />
            ))}
          </div>
        )}
        {/* B4: 歩行ポータルの通過実績（portalUsage）。連絡設備（ターミナルリンク・上下移動）とは別集計なので節を分ける */}
        {portalUsageRows(r.portalUsage).length > 0 && (
          <div data-testid="review-portal-usage">
            <b>{PHASE7B_UI.portalUsageTitle}</b>
            <div className="muted small">{PHASE7B_UI.portalUsageExplain}</div>
            {portalUsageRows(r.portalUsage).map((u) => (
              <Row key={u.portalId} label={`${displayName(layout, u.facilityId)}（${u.portalId}）`} value={`入 ${u.enter} 人・出 ${u.exit} 人・合計 ${u.total} 人`} onFocus={focusId(u.facilityId)} />
            ))}
          </div>
        )}
        {r.groundUtilization && r.groundUtilization.length > 0 && (
          <div data-testid="review-ground-utilization">
            <b>地上支援の稼働率</b>
            {r.groundUtilization.map((u) => (
              <Row key={u.kind} label={UNIT_KIND_LABEL[u.kind as keyof typeof UNIT_KIND_LABEL] ?? u.kind} value={`${u.units} 台・人 / 稼働率 ${Math.round(u.utilization * 100)}%`} />
            ))}
            {r.groundWaits && r.groundWaits.length > 0 && (
              <Row label="資源待ちの内訳" value={r.groundWaits.map((w) => `${{ noVehicle: '車両不足', noStaff: '作業員不足', noEngineer: '整備士不足' }[w.reason] ?? w.reason} ${Math.round(w.sec / 60)} 分`).join('・')} />
            )}
          </div>
        )}
        {r.accessUsage && r.accessUsage.length > 0 && (
          <div data-testid="review-access-usage">
            <b>アクセスの利用実績</b>
            {r.accessUsage.map((u) => (
              <Row key={u.mode} label={{ road: '道路', curb: '降車帯', bus: 'バス', rail: '鉄道' }[u.mode] ?? u.mode} value={`合計 ${u.total} ${u.mode === 'road' || u.mode === 'curb' ? '台' : '人'}・ピーク ${u.peakHour} 時台 ${u.peakCount} ${u.mode === 'road' || u.mode === 'curb' ? '台' : '人'}`} />
            ))}
          </div>
        )}
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
        {review.missedBreakdown && review.missedBreakdown.summary.length > 0 && (
          <div data-testid="review-missed-breakdown">
            <Row
              label="乗り遅れの内訳"
              value={review.missedBreakdown.summary
                .map((s) => `${MISS_BOTTLENECK_LABEL[s.category]} ${s.count} 人${s.topSpotId ? `（${displayName(layout, s.topSpotId)}）` : ''}`)
                .join('・')}
            />
            <Row
              label="主なボトルネック"
              value={`${MISS_BOTTLENECK_LABEL[review.missedBreakdown.summary[0]!.category]} ${review.missedBreakdown.summary[0]!.count} 人${review.missedBreakdown.summary[0]!.topSpotId ? `（${displayName(layout, review.missedBreakdown.summary[0]!.topSpotId!)}）` : ''}`}
              tone="warn"
              onFocus={focusId(review.missedBreakdown.summary[0]!.topSpotId)}
            />
            {review.missedBreakdown.advice.map((a) => (
              <div key={a.category} className="small">
                改善案（{MISS_BOTTLENECK_LABEL[a.category]}）: {a.recommendation}
              </div>
            ))}
          </div>
        )}
        <Row label={DAY_LOOP.bags} value={`${k.leftBags} 個`} tone={k.leftBags > 0 ? 'warn' : undefined} />
        <Row label={DAY_LOOP.paxSat} value={num(k.paxSatisfaction)} />
        {k.paxSatisfactionDetail && (
          <div data-testid="review-pax-satisfaction-detail">
            <Row label="満足度の内訳" value={`待ち時間 −${k.paxSatisfactionDetail.waitPenalty}（平均 ${k.paxSatisfactionDetail.avgWaitMin} 分）・歩行 −${k.paxSatisfactionDetail.walkPenalty}（平均 ${k.paxSatisfactionDetail.avgWalkMin} 分）・遅延 −${k.paxSatisfactionDetail.delayPenalty}（平均 ${k.paxSatisfactionDetail.avgDelayMin} 分）・乗り遅れ −${k.paxSatisfactionDetail.missedPenalty}（${Math.round(k.paxSatisfactionDetail.missedRate * 1000) / 10}%）・手荷物 −${k.paxSatisfactionDetail.bagsPenalty}（${Math.round(k.paxSatisfactionDetail.leftRate * 1000) / 10}%）`} />
          </div>
        )}
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
          {r.city.nightMovements !== undefined && <Row label={`夜間運航（${formatMinute(CITY_NIGHT_CURFEW.fromMin)}〜${formatMinute(CITY_NIGHT_CURFEW.toMin)}）`} value={`${r.city.nightMovements} 回`} tone={r.city.nightMovements > 0 ? 'warn' : undefined} />}
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
              onFocus={focusId(d.target)}
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
              {(() => {
                const demand = a.components?.find((x) => x.key === 'demand' && x.score !== null);
                return demand ? (
                  <div className="card-sub" data-testid={`review-traffic-${a.id}`}>
                    {SCORE_LABEL.demand}: {pct(demand.facts.value ?? null)}（基準 {pct(demand.facts.target ?? null)}）{demand.facts.worstRoute && demand.facts.worstRouteLf !== undefined ? `・最も低いのは ${demand.facts.worstRoute}線 ${pct(demand.facts.worstRouteLf)}` : ''}
                  </div>
                ) : null;
              })()}
              {a.newComplaints?.map((k) => {
                const comp = a.components?.find((x) => x.key === k);
                return (
                  <div key={k} className="card-sub ng-text" data-testid={`review-complaint-${a.id}`}>
                    {GAME_UI.newComplaint(airlineDef(a.id).name, SCORE_LABEL[k])}
                    {comp ? <span className="muted"> — {complaintDetailText(comp)}</span> : null}
                  </div>
                );
              })}
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
            review.goals.completed.map((g) => <Row key={g.id} label={goalText(g).title} value={g.cash > 0 ? formatCr(g.cash) : goalText(g).reward} />)
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
      <summary
        onClick={() => {
          // 行選択で地図のスポット（なければゲート）へフォーカスする。開閉の既定動作は妨げない
          const target = f.standId ?? f.gateId;
          if (target) focusEntity(target);
        }}
      >
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
    case 'pax': return `乗り遅れ率 ${pct(facts.missedRate ?? value)}${facts.missedCount !== undefined && facts.bookedCount !== undefined ? `（${facts.missedCount}/${facts.bookedCount}人）` : ''}、手荷物積み残し率 ${pct(facts.leftRate ?? target)}${facts.leftCount !== undefined && facts.bagsCount !== undefined ? `（${facts.leftCount}/${facts.bagsCount}個）` : ''}`;
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
