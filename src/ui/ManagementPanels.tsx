import { useMemo } from 'react';
import { AIRCRAFT_TYPES, resolveType } from '../core/sim/aircraftTypes';
import { createContext, operableTypes } from '../core/sim/context';
import { contractsOf, seatsFor, COST_CATEGORIES, REVENUE_CATEGORIES, type CompanyState, type DailyKpi, type DailyReport } from '../core/economy/company';
import { analyzeDayPlan, planDay } from '../core/economy/planning';
import { AIRLINES, airlineDef, destinationDef } from '../core/economy/registry';
import { BALANCE } from '../core/economy/balance';
import { forecastForDay } from '../core/sim/weather';
import { analyzeAccess, type AccessMode } from '../core/access/model';
import { companyActions } from '../editor/simRunner';
import { editorStore, formatCr, useEditor, useLayout } from '../editor/store';
import {
  ACCESS_MODE_LABEL,
  GAME_UI,
  AIRLINE_TYPE_LABEL,
  CONTRACT_STATUS_LABEL,
  COST_LABEL,
  KPI_LABEL,
  PLAN_ISSUE_LABEL,
  REVENUE_LABEL,
  WINDOW_LABEL,
  displayName,
  formatClock,
  formatMinute,
} from '../i18n/ja';

/**
 * 運航計画・経営のパネル（docs/14_management_rules.md）。
 * 運航中はシミュレーションの会社（最新）を、建設中はストアの会社を表示する。
 */
export function useCompany(): CompanyState {
  useEditor((s) => s.ops?.uiVersion ?? -1);
  const stored = useEditor((s) => s.company);
  return editorStore.getState().ops?.sim.company ?? stored;
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 1000) / 10}%`);

// ---------------------------------------------------------------- 運航計画

export function PlanPanel() {
  const c = useCompany();
  const layout = useLayout();
  const ctx = useMemo(() => createContext(layout), [layout]);
  const operable = operableTypes(ctx);
  // 実際の運航と同じアクセス係数（前日の混雑を反映）で計画する
  const plan = planDay(c, c.day, analyzeAccess(layout, { fees: c.fees, feedback: c.accessFeedback }).factor);
  const analysis = analyzeDayPlan(plan, ctx);
  const issueKeys = new Map<string, string[]>();
  for (const i of analysis.issues) for (const k of i.keys) issueKeys.set(k, [...(issueKeys.get(k) ?? []), PLAN_ISSUE_LABEL[i.code]]);
  const active = contractsOf(c, 'active');
  const offers = contractsOf(c, 'offered');
  const past = contractsOf(c)
    .filter((k) => k.status !== 'active' && k.status !== 'offered')
    .slice(-8);
  const name = (id: string | null) => (id ? displayName(layout, id).replace(/^(スポット|搭乗ゲート) /, '') : '—');

  return (
    <div className="issues mgmt" data-testid="plan-panel">
      <div className="issues-header">
        <strong>運航計画</strong>
        <span>{c.day + 1}日目の計画: {plan.flights.length}往復</span>
        <span className="muted">料金・単価はゲームバランス用の設定値で、実在の空港料金とは無関係です</span>
        {c.game?.weather === 'levels' && (
          <span data-testid="plan-forecast" title={GAME_UI.wxForecastNote(forecastForDay(c.seed, c.day, c.game).accuracy)}>
            {GAME_UI.wxForecastToday}: {forecastForDay(c.seed, c.day, c.game).summary}
          </span>
        )}
      </div>
      <div className="issues-list mgmt-grid">
        <section>
          <h4>契約中の路線</h4>
          <table className="board" data-testid="contracts">
            <thead>
              <tr>
                <th>航空会社</th>
                <th>就航先</th>
                <th>機種</th>
                <th>便数/日</th>
                <th>時間帯</th>
                <th>割引</th>
                <th>期間</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {active.map((k) => (
                <tr key={k.id} data-testid={`contract-${k.id}`}>
                  <td>{airlineDef(k.airlineId).name}</td>
                  <td>{destinationDef(k.destinationId).name}</td>
                  <td className={operable.includes(k.typeId) ? '' : 'ng-text'}>
                    <select
                      value={k.typeId}
                      onChange={(e) => companyActions.changeContractAircraft(k.id, e.target.value)}
                      title="機材変更（航空会社の保有機材から選ぶ。旅客定員・地上作業・適合性が変わる）"
                      data-testid={`contract-type-${k.id}`}
                    >
                      {[...new Set([k.typeId, ...(c.fleets?.[k.airlineId] ?? []).map((e) => e.typeId)])].map((id) => (
                        <option key={id} value={id}>
                          {resolveType(AIRCRAFT_TYPES, id).label}（{seatsFor(c, k.airlineId, id)}席）
                        </option>
                      ))}
                    </select>
                    {operable.includes(k.typeId) ? '' : ' 運航不可'}
                  </td>
                  <td>{k.perDay}</td>
                  <td>{WINDOW_LABEL[k.window]}</td>
                  <td>{Math.round(k.feeDiscount * 100)}%</td>
                  <td>
                    {k.startDay + 1}〜{k.endDay + 1}日目
                  </td>
                  <td>
                    <button onClick={() => companyActions.changeFrequency(k.id, 1)} title="増便を依頼（満足度60以上で応じる）" data-testid={`freq-up-${k.id}`}>
                      増便
                    </button>
                    <button onClick={() => companyActions.changeFrequency(k.id, -1)} title="減便（満足度が下がる）">
                      減便
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {active.length === 0 && <div className="empty">契約はありません。提案を受け入れてください</div>}

          <h4>契約の提案</h4>
          <table className="board" data-testid="offers">
            <tbody>
              {offers.map((k) => {
                const ok = operable.includes(k.typeId);
                return (
                  <tr key={k.id} data-testid={`offer-${k.id}`}>
                    <td>{airlineDef(k.airlineId).name}</td>
                    <td>{destinationDef(k.destinationId).name}</td>
                    <td className={ok ? '' : 'ng-text'}>
                      {resolveType(AIRCRAFT_TYPES, k.typeId).label}
                      {ok ? '' : '（未対応）'}
                    </td>
                    <td>{k.perDay}便/日</td>
                    <td>{WINDOW_LABEL[k.window]}</td>
                    <td>割引 {Math.round(k.feeDiscount * 100)}%</td>
                    <td>{k.offerExpiresDay + 1}日目まで</td>
                    <td>
                      <button className="primary" disabled={!ok} onClick={() => companyActions.acceptOffer(k.id)} data-testid={`accept-${k.id}`}>
                        契約
                      </button>
                      <button onClick={() => companyActions.rejectOffer(k.id)}>辞退</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {offers.length === 0 && <div className="empty">提案はありません（評価が上がると提案が増えます）</div>}

          {past.length > 0 && (
            <>
              <h4>終了した契約・提案</h4>
              <div className="muted small">
                {past.map((k) => `${airlineDef(k.airlineId).name}・${destinationDef(k.destinationId).name}（${CONTRACT_STATUS_LABEL[k.status]}）`).join(' / ')}
              </div>
            </>
          )}

          <h4>航空会社</h4>
          <table className="board">
            <tbody>
              {AIRLINES.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.code} {a.name}
                  </td>
                  <td>{AIRLINE_TYPE_LABEL[a.type]}</td>
                  <td>求める定時率 {Math.round(a.minOtp * 100)}%</td>
                  <td>料金への敏感さ {Math.round(a.priceSensitivity * 100)}%</td>
                  <td className={c.airlines[a.id]!.satisfaction < BALANCE.contracts.withdrawSat ? 'ng-text' : ''}>満足度 {Math.round(c.airlines[a.id]!.satisfaction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h4>料金（基準料金に対する倍率）</h4>
          <div className="fee-grid">
            {(
              [
                ['landing', '着陸料'],
                ['terminal', 'ターミナル使用料'],
                ['parking', '駐機料'],
              ] as const
            ).map(([k, label]) => (
              <label key={k}>
                {label}
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={c.fees[k]}
                  onChange={(e) => companyActions.setFees({ [k]: Number(e.target.value) })}
                  data-testid={`fee-${k}`}
                />
                <b>×{c.fees[k].toFixed(2)}</b>
              </label>
            ))}
          </div>
          <div className="muted small">料金を上げると1便あたりの収入は増えるが、搭乗率と航空会社の満足度が下がる。</div>

          <h4>運用時間</h4>
          <div className="fee-grid">
            <label>
              開始
              <select value={c.hours.openMin} onChange={(e) => companyActions.setHours({ openMin: Number(e.target.value), closeMin: c.hours.closeMin })}>
                {[5, 6, 7, 8].map((h) => (
                  <option key={h} value={h * 60}>
                    {h}:00
                  </option>
                ))}
              </select>
            </label>
            <label>
              終了
              <select value={c.hours.closeMin} onChange={(e) => companyActions.setHours({ openMin: c.hours.openMin, closeMin: Number(e.target.value) })}>
                {[20, 21, 22, 23].map((h) => (
                  <option key={h} value={h * 60}>
                    {h}:00
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="muted small">
            ピーク時間（着陸料 +{Math.round(BALANCE.fees.peakSurcharge * 100)}%）: {c.hours.peaks.map((p) => `${formatMinute(p.fromMin)}〜${formatMinute(p.toMin)}`).join('、')}
          </div>

          <h4>
            {c.day + 1}日目のスケジュール（予定）
            <span className="muted small">
              {' '}
              処理能力の目安: 離着陸 {analysis.capacity.movementsPerHour}回/時・保安検査 {analysis.capacity.securityPerHour}人/時・同時折り返し {analysis.capacity.turnarounds}機（ピーク {analysis.peakTurnarounds}機）
            </span>
          </h4>
          {analysis.issues.length > 0 && (
            <ul className="plan-issues" data-testid="plan-issues">
              {analysis.issues.map((i) => (
                <li key={`${i.code}:${i.detail ?? ''}`} className={i.severity === 'error' ? 'ng-text' : i.severity === 'info' ? 'muted' : 'warn-text'}>
                  {PLAN_ISSUE_LABEL[i.code]}
                  {i.detail ? `（${i.detail}）` : ''}: {i.keys.length}件
                </li>
              ))}
            </ul>
          )}
          <table className="board" data-testid="plan-schedule">
            <thead>
              <tr>
                <th>到着</th>
                <th>出発</th>
                <th>便名</th>
                <th>就航先</th>
                <th>機種</th>
                <th>旅客（着/発）</th>
                <th>スポット</th>
                <th>ゲート</th>
                <th>問題</th>
              </tr>
            </thead>
            <tbody>
              {plan.flights.map((f) => {
                const a = analysis.assignments[f.key];
                const problems = issueKeys.get(f.key) ?? [];
                return (
                  <tr key={f.key} className={problems.length ? 'warn-row' : ''}>
                    <td>{formatClock(f.arrivalAt)}</td>
                    <td>{formatClock(f.departureAt)}</td>
                    <td>
                      {f.arrNumber}/{f.depNumber}
                    </td>
                    <td>{destinationDef(f.destinationId).name}</td>
                    <td>{resolveType(AIRCRAFT_TYPES, f.typeId).shortLabel}</td>
                    <td>
                      {f.arrPax}/{f.depPax}
                    </td>
                    <td>{name(a?.standId ?? null)}</td>
                    <td>{name(a?.gateId ?? null)}</td>
                    <td className="muted">{problems.join('、')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {plan.flights.length === 0 && <div className="empty">この日の便はありません</div>}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 経営

function KpiCard({ k, value }: { k: keyof DailyKpi; value: string }) {
  return (
    <div className="kpi" title={KPI_LABEL[k].formula} data-testid={`kpi-${k}`}>
      <span>{KPI_LABEL[k].label}</span>
      <b>{value}</b>
    </div>
  );
}

function kpiValue(k: keyof DailyKpi, v: DailyKpi): string {
  const x = v[k];
  if (x === null || x === undefined) return '—';
  if (typeof x === 'object') return Object.entries(x).map(([m, n]) => `${ACCESS_MODE_LABEL[m as AccessMode]} ${n}`).join(' / ');
  switch (k) {
    case 'otp':
    case 'runwayUtil':
    case 'gateUtil':
    case 'facilityUtil':
      return pct(x);
    case 'avgDelayMin':
    case 'avgWaitMin':
    case 'avgWalkMin':
    case 'avgGroundMin':
    case 'roadDelayMin':
    case 'transitWaitMin':
      return `${x}分`;
    case 'accessFactor':
      return `×${x.toFixed(2)}`;
    default:
      return String(Math.round(x * 10) / 10);
  }
}

export function FinancePanel() {
  const c = useCompany();
  const latest: DailyReport | undefined = c.reports[c.reports.length - 1];
  const today = c.today;
  const todayRevenue = REVENUE_CATEGORIES.reduce((s, k) => s + (today[k] ?? 0), 0);
  const todayCost = COST_CATEGORIES.reduce((s, k) => s - (today[k] ?? 0), 0);
  const kpis: (keyof DailyKpi)[] = [
    'flights',
    'paxDeparted',
    'paxArrived',
    'otp',
    'avgDelayMin',
    'runwayUtil',
    'gateUtil',
    'facilityUtil',
    'avgWaitMin',
    'avgWalkMin',
    'avgGroundMin',
    'unprocessedPax',
    'missedPax',
    'leftBags',
    'paxSatisfaction',
    'airlineSatisfaction',
    'rating',
  ];
  return (
    <div className="issues mgmt" data-testid="finance-panel">
      <div className="issues-header">
        <strong>経営</strong>
        <span data-testid="finance-cash">資金 {formatCr(c.cash)}</span>
        <span>空港評価 {c.rating.toFixed(1)}</span>
        {c.negativeDays > 0 && (
          <span className="ng-text">
            資金不足 {c.negativeDays}日目（{BALANCE.bankruptcyDays}日続くと経営破綻）
          </span>
        )}
        <span className="muted">金額はゲーム内通貨 cr（実在の料金・費用とは無関係）</span>
      </div>
      <div className="issues-list mgmt-grid">
        <section>
          <h4>{c.day + 1}日目（未締め）</h4>
          <table className="board" data-testid="today-ledger">
            <tbody>
              {REVENUE_CATEGORIES.filter((k) => today[k]).map((k) => (
                <tr key={k}>
                  <td>{REVENUE_LABEL[k]}</td>
                  <td className="num">{formatCr(today[k]!)}</td>
                </tr>
              ))}
              {COST_CATEGORIES.filter((k) => today[k]).map((k) => (
                <tr key={k}>
                  <td>{COST_LABEL[k]}</td>
                  <td className="num ng-text">{formatCr(today[k]!)}</td>
                </tr>
              ))}
              {today.construction ? (
                <tr>
                  <td>建設・拡張投資</td>
                  <td className="num ng-text">{formatCr(today.construction)}</td>
                </tr>
              ) : null}
              <tr>
                <td>
                  <b>営業利益（収入 {formatCr(todayRevenue)} − 費用 {formatCr(todayCost)}）</b>
                </td>
                <td className="num">
                  <b>{formatCr(todayRevenue - todayCost)}</b>
                </td>
              </tr>
            </tbody>
          </table>

          <h4>日報</h4>
          <table className="board" data-testid="reports">
            <thead>
              <tr>
                <th>日</th>
                <th>収入</th>
                <th>費用</th>
                <th>営業利益</th>
                <th>投資</th>
                <th>資金</th>
                <th>便数</th>
                <th>定時率</th>
                <th>評価</th>
              </tr>
            </thead>
            <tbody>
              {[...c.reports]
                .reverse()
                .slice(0, 14)
                .map((r) => (
                  <tr key={r.day}>
                    <td>
                      {r.day + 1}日目{r.partial ? '（途中）' : ''}
                    </td>
                    <td className="num">{formatCr(r.totalRevenue)}</td>
                    <td className="num">{formatCr(r.totalCost)}</td>
                    <td className={`num ${r.operatingProfit < 0 ? 'ng-text' : ''}`}>{formatCr(r.operatingProfit)}</td>
                    <td className="num">{r.construction ? formatCr(r.construction) : ''}</td>
                    <td className="num">{formatCr(r.cashEnd)}</td>
                    <td>{r.kpi.flights}</td>
                    <td>{pct(r.kpi.otp)}</td>
                    <td>{r.kpi.rating.toFixed(1)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {c.reports.length === 0 && <div className="empty">まだ日報はありません（0:00 または運航終了時に締めます）</div>}
        </section>

        <section>
          {latest ? (
            <>
              <h4>
                {latest.day + 1}日目の KPI{latest.partial ? '（途中で締めた日）' : ''}
                <span className="muted small"> カーソルを合わせると計算式を表示</span>
              </h4>
              <div className="kpi-grid">
                {kpis.map((k) => (
                  <KpiCard key={k} k={k} value={kpiValue(k, latest.kpi)} />
                ))}
              </div>
              <h4>{latest.day + 1}日目の収支の内訳</h4>
              <table className="board" data-testid="report-breakdown">
                <tbody>
                  {REVENUE_CATEGORIES.filter((k) => latest.revenue[k]).map((k) => (
                    <tr key={k}>
                      <td>{REVENUE_LABEL[k]}</td>
                      <td className="num">{formatCr(latest.revenue[k]!)}</td>
                    </tr>
                  ))}
                  {COST_CATEGORIES.filter((k) => latest.cost[k]).map((k) => (
                    <tr key={k}>
                      <td>{COST_LABEL[k]}</td>
                      <td className="num ng-text">−{formatCr(latest.cost[k]!)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="empty">運航すると KPI が表示されます</div>
          )}
        </section>
      </div>
    </div>
  );
}
