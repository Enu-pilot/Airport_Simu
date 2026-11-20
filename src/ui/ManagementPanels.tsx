import { Fragment, useMemo, useState } from 'react';
import { AIRCRAFT_TYPES, resolveType } from '../core/sim/aircraftTypes';
import { createContext, operableTypes } from '../core/sim/context';
import { contractsOf, seatsFor, sortContracts, COST_CATEGORIES, REVENUE_CATEGORIES, type CompanyState, type Contract, type ContractSortKey, type DailyKpi, type DailyReport, type WorkOrderAssetKind, type WorkOrderKind } from '../core/economy/company';
import { analyzeDayPlan, planDayWithDemand } from '../core/economy/planning';
import { basedConditionDetails } from '../core/economy/basedConditions';
import { airlineDef, airlinesFor, classifyRoute, destinationDef, routeAvailability, routeCapabilitiesForAirport, type DestinationDef } from '../core/economy/registry';
import { previewLoadFactor } from '../core/economy/traffic';
import { renewalOutlook, RENEWAL_LEVEL_LABEL } from '../core/economy/renewal';
import { demandIndex, distanceFactor, essentialOf, monthOf, routeDemandSummary, seasonalWeekdayFactor } from '../core/economy/demand';
import { BALANCE } from '../core/economy/balance';
import { forecastForDay } from '../core/sim/weather';
import { analyzeAccess, type AccessMode } from '../core/access/model';
import { companyActions } from '../editor/simRunner';
import { addCityEvent, setCompanyCity, editorStore, formatCr, removeCityEvent, useEditor, useLayout } from '../editor/store';
import { NightOpsSettings } from './NightOpsSettings';
import { terminalCapacitySummaries } from '../core/terminal/terminalCapacitySummary';
import { airMarketPopulationOf, CITY_EVENT_CONGESTED, CITY_EVENT_KINDS, cityEventCost, cityEventOutcome, cityEventRisk, type CityEventKind, type CityEventLocation } from '../core/economy/city';
import {
  ACCESS_MODE_LABEL,
  DEMAND_UI,
  FOLLOWUP_UI,
  SEASONALITY_PROFILE_LABEL,
  GAME_UI,
  AIRLINE_TYPE_LABEL,
  CONTRACT_KIND_LABEL,
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


const WORK_ORDER_KIND_LABEL: Record<WorkOrderKind, string> = { inspection: '点検', repair: '修理', construction: '工事' };
const WORK_ORDER_STATUS_LABEL = { planned: '予定', active: '実施中（夜間枠で進行）', done: '完了', deferred: '延期' } as const;
const WORK_ORDER_ASSET_LABEL: Record<WorkOrderAssetKind, string> = { runway: '滑走路', taxiway: '誘導路', stand: 'スポット', gate: 'ゲート' };

/** 夜間整備・工事 Work Order（5-25）: 作成・進捗・延期・削除。実施は夜間枠 23:00〜05:00 で、実施中は対象資産を一時閉鎖する */
export function WorkOrdersPanel() {
  const c = useCompany();
  const layout = useLayout();
  const [assetKind, setAssetKind] = useState<WorkOrderAssetKind>('runway');
  const [assetId, setAssetId] = useState('');
  const [kind, setKind] = useState<WorkOrderKind>('inspection');
  const [engineers, setEngineers] = useState(1);
  const [durationMin, setDurationMin] = useState(120);
  const assets: { id: string; label: string }[] =
    assetKind === 'runway'
      ? Object.values(layout.runways).map((r) => ({ id: r.id, label: r.name || r.id }))
      : assetKind === 'taxiway'
        ? Object.values(layout.taxiways).map((t) => ({ id: t.id, label: t.id }))
        : assetKind === 'stand'
          ? Object.values(layout.stands).map((st) => ({ id: st.id, label: st.id }))
          : Object.values(layout.facilities).filter((f) => f.kind === 'gate').map((f) => ({ id: f.id, label: f.name || f.id }));
  const selected = assetId && assets.some((a) => a.id === assetId) ? assetId : (assets[0]?.id ?? '');
  const orders = Object.values(c.workOrders ?? {}).sort((a, b) => (a.id < b.id ? -1 : 1));
  const mode = useEditor((s) => s.mode);
  const readOnly = mode === 'operate';
  return (
    <section data-testid="work-orders">
      <h4>夜間整備・工事（Work Order）</h4>
      {readOnly && <p className="muted small" data-testid="wo-readonly">運航中は変更できません（建設モードで編集してください）。</p>}
      <p className="muted small">夜間枠（23:00〜05:00）に、整備士が足りる間だけ進みます。実施中は対象を一時閉鎖します（閉鎖は理由付きで管理され、終われば自動で解けます）。</p>
      <fieldset disabled={readOnly} className="guard-fieldset">
      <div className="work-order-form">
        <label>
          対象{' '}
          <select value={assetKind} onChange={(e) => setAssetKind(e.target.value as WorkOrderAssetKind)} data-testid="wo-asset-kind">
            {(Object.keys(WORK_ORDER_ASSET_LABEL) as WorkOrderAssetKind[]).map((k) => (
              <option key={k} value={k}>{WORK_ORDER_ASSET_LABEL[k]}</option>
            ))}
          </select>
        </label>
        <label>
          資産{' '}
          <select value={selected} onChange={(e) => setAssetId(e.target.value)} data-testid="wo-asset-id">
            {assets.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </label>
        <label>
          作業{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as WorkOrderKind)} data-testid="wo-kind">
            {(Object.keys(WORK_ORDER_KIND_LABEL) as WorkOrderKind[]).map((k) => (
              <option key={k} value={k}>{WORK_ORDER_KIND_LABEL[k]}</option>
            ))}
          </select>
        </label>
        <label>
          整備士 <input type="number" min={1} max={99} value={engineers} onChange={(e) => setEngineers(Math.max(1, Number(e.target.value) || 1))} data-testid="wo-engineers" />
        </label>
        <label>
          所要（分） <input type="number" min={10} max={6000} step={10} value={durationMin} onChange={(e) => setDurationMin(Math.max(10, Number(e.target.value) || 10))} data-testid="wo-duration" />
        </label>
        <button
          type="button"
          disabled={!selected}
          onClick={() => companyActions.createWorkOrder({ assetKind, assetId: selected, kind, engineers, durationMin })}
          data-testid="wo-create"
        >
          作成
        </button>
      </div>
      </fieldset>
      {orders.length === 0 ? (
        <p className="muted small">Work Order はありません。</p>
      ) : (
        <table className="board" data-testid="wo-list">
          <thead>
            <tr><th>対象</th><th>作業</th><th>状態</th><th>進捗</th><th></th></tr>
          </thead>
          <tbody>
            {orders.map((wo) => (
              <tr key={wo.id}>
                <td>{WORK_ORDER_ASSET_LABEL[wo.assetKind]} {wo.assetId}</td>
                <td>{WORK_ORDER_KIND_LABEL[wo.kind]}（整備士 {wo.engineers} 人 / {wo.durationMin} 分）</td>
                <td>{WORK_ORDER_STATUS_LABEL[wo.status]}</td>
                <td>{Math.floor(wo.progressMin)} / {wo.durationMin} 分</td>
                <td>
                  {wo.status === 'planned' || wo.status === 'active' ? (
                    <button type="button" disabled={readOnly} onClick={() => companyActions.deferWorkOrder(wo.id)}>延期</button>
                  ) : null}
                  {wo.status === 'deferred' ? (
                    <button type="button" disabled={readOnly} onClick={() => companyActions.resumeWorkOrder(wo.id)}>再開</button>
                  ) : null}
                  {wo.status !== 'done' ? (
                    <button type="button" disabled={readOnly} onClick={() => companyActions.deleteWorkOrder(wo.id)}>削除</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * 航空会社の使用ターミナル制限（運用ポリシー）: 会社ごとに国内線・国際線それぞれ、
 * 使ってよいターミナルを選ぶ。未設定（チェックなしで保存された状態）= 制限なし。
 * 制限がある場合、スポット割当は許可ターミナル内に限られ、空きがあっても他ターミナルへは回らない。
 * 契約の専用スポットと運航中のスポット指定は、より具体的な指示として制限より優先する。
 */
export function AirlineTerminalsPanel({ company: c }: { company: CompanyState }) {
  const layout = useLayout();
  const mode = useEditor((s) => s.mode);
  const readOnly = mode === 'operate';
  const terminals = Object.values(layout.facilities)
    .filter((f) => f.kind === 'terminal')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  // ターミナル別の余裕（スポット数・保安検査の能力と直近の使用率）。制限先を選ぶ判断材料
  const capacity = terminalCapacitySummaries(layout, c.reports[c.reports.length - 1]);
  const airlineIds = [...new Set([
    ...Object.values(c.contracts).filter((k) => k.status === 'active' || k.status === 'offered').map((k) => k.airlineId),
    ...Object.keys(c.airlineTerminals ?? {}),
  ])].sort((a, b) => airlineDef(a).name.localeCompare(airlineDef(b).name, 'ja') || (a < b ? -1 : 1));
  const toggle = (airlineId: string, rt: 'domestic' | 'international', terminalId: string, checked: boolean) => {
    const current = c.airlineTerminals?.[airlineId]?.[rt];
    const next = checked ? [...(current ?? []), terminalId] : (current ?? []).filter((id) => id !== terminalId);
    companyActions.setAirlineTerminals(airlineId, rt, next.length > 0 ? next : null);
  };
  const cell = (airlineId: string, rt: 'domestic' | 'international') => {
    const current = c.airlineTerminals?.[airlineId]?.[rt];
    return (
      <td>
        {terminals.map((t) => (
          <label key={t.id} className="small" style={{ display: 'block' }}>
            <input
              type="checkbox"
              disabled={readOnly}
              checked={!!current?.includes(t.id)}
              onChange={(e) => toggle(airlineId, rt, t.id, e.target.checked)}
              data-testid={`terminal-policy-${airlineId}-${rt}-${t.id}`}
            />{' '}
            {displayName(layout, t.id)}
            {(() => {
              const s = capacity.get(t.id);
              if (!s) return null;
              return (
                <span className="muted" data-testid={`terminal-capacity-${t.id}`}>
                  {' '}（スポット {s.stands}・保安 {s.securityPerHour.toLocaleString()}/時
                  {s.securityUtilization !== null ? `・使用率 ${Math.round(s.securityUtilization * 100)}%` : ''}）
                </span>
              );
            })()}
          </label>
        ))}
        {current && current.length > 0 ? (
          <button type="button" disabled={readOnly} onClick={() => companyActions.setAirlineTerminals(airlineId, rt, null)} data-testid={`terminal-policy-clear-${airlineId}-${rt}`}>
            制限なしに戻す
          </button>
        ) : (
          <span className="muted small">制限なし</span>
        )}
      </td>
    );
  };
  return (
    <section data-testid="airline-terminals-panel">
      <h4>航空会社の使用ターミナル</h4>
      <p className="muted small">
        チェックしたターミナルだけを、その航空会社の便が使えます（国内線・国際線は別々に設定できます）。制限なしの会社はどのターミナルでも使えます。
        制限のせいで許可ターミナル内にスポットがない便は、他のターミナルへは回らず待機します。設定は次のスポット割当から効き、運航中の機体のスポットは変わりません。貨物便は対象外です。
      </p>
      {readOnly && <p className="muted small" data-testid="airline-terminals-readonly">運航中は変更できません（建設モードで編集してください）。</p>}
      {terminals.length === 0 ? (
        <div className="empty">ターミナルがありません</div>
      ) : airlineIds.length === 0 ? (
        <div className="empty">契約のある航空会社がありません</div>
      ) : (
        <table className="board" data-testid="airline-terminals">
          <thead>
            <tr>
              <th>航空会社</th>
              <th>国内線で使えるターミナル</th>
              <th>国際線で使えるターミナル</th>
            </tr>
          </thead>
          <tbody>
            {airlineIds.map((id) => (
              <tr key={id} data-testid={`airline-terminals-${id}`}>
                <td>{airlineDef(id).name}</td>
                {cell(id, 'domestic')}
                {cell(id, 'international')}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 運航計画

/**
 * 路線の需要根拠（docs/46。バックエンド追随 項目2）: 目的地の解決済み定義と需要式の正本
 * （BALANCE.market / demand.ts の純関数）から組み立てる表示専用の読み取り。
 * 月係数だけを分離する純関数は demand.ts に無いため、月別表は作らず、季節プロファイルと
 * 「今日の季節・曜日係数」（seasonalWeekdayFactor の合成値そのもの）までを表示する。
 */
export interface RouteDemandBasisView {
  destId: string;
  /** 利用圏人口（未設定の目的地は都市人口で代用し、その旨を catchmentFallback で示す） */
  catchment: number;
  catchmentFallback: boolean;
  /** 出発側の航空市場人口（自都市。未設定・不正値なら都市人口にフォールバック） */
  originMarket: number;
  originFallback: boolean;
  aviationDependency: number;
  essential: number;
  leisure: number;
  demandIndex: number;
  distanceKm: number;
  distanceFactor: number;
  profile: DestinationDef['seasonalityProfile'];
  /** 今日の季節・曜日係数（seasonalWeekdayFactor の合成値。月係数の分離表示はしない） */
  todayFactor: number;
  /** 今日の月（1〜12） */
  month: number;
  k: number;
  alpha: number;
  beta: number;
}

export function routeDemandBasis(c: CompanyState, destId: string): RouteDemandBasisView | null {
  if (!c.city) return null;
  const dest = destinationDef(destId);
  if (!dest) return null; // 未知の行き先（destinationDef は非 null 宣言だが実行時は undefined を返しうる）
  const M = BALANCE.market;
  const rawMarket = c.city.airMarketPopulation;
  const originMarket = airMarketPopulationOf(c.city);
  return {
    destId,
    catchment: dest.catchmentPopulation ?? dest.population,
    catchmentFallback: dest.catchmentPopulation === null,
    originMarket,
    // airMarketPopulationOf が生の値をそのまま採用したときだけ「設定値」。それ以外は都市人口へのフォールバック
    originFallback: !(typeof rawMarket === 'number' && Number.isFinite(rawMarket) && originMarket === rawMarket),
    aviationDependency: dest.aviationDependency,
    essential: essentialOf(dest.demand),
    leisure: dest.demand.leisure,
    demandIndex: demandIndex(dest),
    distanceKm: dest.distanceKm,
    distanceFactor: distanceFactor(dest.distanceKm),
    profile: dest.seasonalityProfile,
    todayFactor: seasonalWeekdayFactor(dest, c.day),
    month: monthOf(c.day) + 1,
    k: M.K,
    alpha: M.alpha,
    beta: M.beta,
  };
}

const basisNum = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

/** 需要根拠の展開行の中身（路線表の行の下に差し込む。表示のみ） */
export function RouteBasisDetail({ basis }: { basis: RouteDemandBasisView }) {
  return (
    <div className="route-basis">
      <div>
        <b>{DEMAND_UI.basisTitle}</b>
      </div>
      <div>
        {DEMAND_UI.catchment}: {basis.catchment.toLocaleString('ja-JP')} 人
        {basis.catchmentFallback && <span className="muted">（{DEMAND_UI.catchmentFallback}）</span>}
        {' / '}
        {DEMAND_UI.originMarket}: {basis.originMarket.toLocaleString('ja-JP')} 人
        {basis.originFallback && <span className="muted">（{DEMAND_UI.originFallback}）</span>}
      </div>
      <div>
        {DEMAND_UI.aviationDependency}: {basisNum(basis.aviationDependency)}
        {' / '}
        {DEMAND_UI.essential}: {basisNum(basis.essential)}
        {' / '}
        {DEMAND_UI.leisure}: {basisNum(basis.leisure)}
        {' / '}
        {DEMAND_UI.demandIndex}: {basisNum(basis.demandIndex)}
      </div>
      <div>
        {DEMAND_UI.distance(basis.distanceKm)}
        {' / '}
        {DEMAND_UI.distanceFactor}: {basis.distanceFactor.toFixed(2)}
      </div>
      <div className="muted small">{DEMAND_UI.formula(basis.k, basis.alpha, basis.beta)}</div>
      <div data-testid={`traffic-route-seasonality-${basis.destId}`}>
        <b>{DEMAND_UI.seasonalityTitle}</b>: {DEMAND_UI.profile}{' '}
        {basis.profile ? SEASONALITY_PROFILE_LABEL[basis.profile] : DEMAND_UI.profileNone}
        {' / '}
        {DEMAND_UI.todayFactor}: ×{basis.todayFactor.toFixed(2)}（{DEMAND_UI.month(basis.month)}）
      </div>
    </div>
  );
}

interface PlanData {
  c: CompanyState;
  mode: string;
  layout: ReturnType<typeof useLayout>;
  ctx: ReturnType<typeof createContext>;
  operable: ReturnType<typeof operableTypes>;
  routeCapabilities: ReturnType<typeof routeCapabilitiesForAirport>;
  accessFactor: number;
  plan: ReturnType<typeof planDayWithDemand>;
  analysis: ReturnType<typeof analyzeDayPlan>;
  issueKeys: Map<string, string[]>;
  name: (id: string | null) => string;
}

/** 運航計画まわりの共通データ（需要・運航計画／契約／航空会社の各パネルで共有する） */
function usePlanData(): PlanData {
  const c = useCompany();
  const mode = useEditor((s) => s.mode);
  const layout = useLayout();
  const ctx = useMemo(() => createContext(layout), [layout]);
  const operable = operableTypes(ctx);
  const routeCapabilities = routeCapabilitiesForAirport(layout.countryId);
  // 実際の運航と同じアクセス係数（前日の混雑を反映）で計画する
  const accessFactor = analyzeAccess(layout, { fees: c.fees, feedback: c.accessFeedback, city: c.city, day: c.day }).factor;
  const plan = planDayWithDemand(c, c.day, accessFactor, ctx.types, routeCapabilities);
  const analysis = analyzeDayPlan(plan, ctx);
  const issueKeys = new Map<string, string[]>();
  for (const i of analysis.issues) for (const k of i.keys) issueKeys.set(k, [...(issueKeys.get(k) ?? []), PLAN_ISSUE_LABEL[i.code]]);
  const name = (id: string | null) => (id ? displayName(layout, id).replace(/^(スポット|搭乗ゲート) /, '') : '—');
  return { c, mode, layout, ctx, operable, routeCapabilities, accessFactor, plan, analysis, issueKeys, name };
}


export function PlanPanel() {
  const { c, mode, layout, ctx, routeCapabilities, accessFactor, plan, analysis, issueKeys, name } = usePlanData();
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
        <CityEventPlanner company={c} />
        {c.city && <NightOpsSettings city={c.city} readOnly={mode === 'operate'} onChange={(next) => { const { nightOps: _n, ...rest } = c.city!; void _n; setCompanyCity(next ? { ...rest, nightOps: next } : rest); }} />}
        <WorkOrdersPanel />
        <RouteTrafficSection c={c} accessFactor={accessFactor} ctx={ctx} routeCapabilities={routeCapabilities} />


        <section>
          <h4>料金（基準料金に対する倍率）</h4>
          {mode === 'operate' && <p className="muted small" data-testid="plan-fees-readonly">運航中は料金・運用時間を変更できません（建設モードで編集してください）。</p>}
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
                  disabled={mode === 'operate'}
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
              <select disabled={mode === 'operate'} value={c.hours.openMin} onChange={(e) => companyActions.setHours({ openMin: Number(e.target.value), closeMin: c.hours.closeMin })}>
                {[5, 6, 7, 8].map((h) => (
                  <option key={h} value={h * 60}>
                    {h}:00
                  </option>
                ))}
              </select>
            </label>
            <label>
              終了
              <select disabled={mode === 'operate'} value={c.hours.closeMin} onChange={(e) => companyActions.setHours({ openMin: c.hours.openMin, closeMin: Number(e.target.value) })}>
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
              滑走路基準 {analysis.capacity.movementsPerHour}回/時・保安検査 {analysis.capacity.securityPerHour}人/時・同時折り返し目安 {analysis.capacity.turnarounds}機（計画ピーク {analysis.peakTurnarounds}機）
            </span>
          </h4>
          <div className="muted small" data-testid="plan-capacity-details">
            駐機可能スポット {analysis.capacity.totalStands}（ターミナル直結 {analysis.capacity.contactStands} / リモート {analysis.capacity.remoteStands}）。滑走路基準は運用中の滑走路数 × 30回/時、折り返し目安は配置済み地上支援数による静的概算です。
            {Object.entries(analysis.terminalCapacity).map(([id, capacity]) => (
              <span key={id}>{' · '}{displayName(layout, id)}: チェックイン {capacity.checkInPerHour}人/時・保安検査 {capacity.securityPerHour}人/時。</span>
            ))}
            <br />
            算出条件不足: プッシュバック同時数・誘導路通過能力・バス輸送能力・1日処理能力。保有台数から時間能力を推定していません。
          </div>
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


/** 路線の需要と供給（今日）: 需要・運航計画セクションの部品 */
function RouteTrafficSection({ c, accessFactor, ctx, routeCapabilities }: { c: CompanyState; accessFactor: number; ctx: PlanData['ctx']; routeCapabilities: PlanData['routeCapabilities'] }) {
  const [basisDest, setBasisDest] = useState<string | null>(null);
  return (
    <section>
          {c.market && (
            <>
              <h4>路線の需要と供給（今日）</h4>
              <table className="board" data-testid="traffic-routes">
                <thead>
                  <tr>
                    <th>就航先</th>
                    <th>需要（人/日）</th>
                    <th>供給座席</th>
                    <th>基準搭乗率</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(routeDemandSummary(c, c.day, accessFactor, ctx.types, routeCapabilities)?.values() ?? [])].map((info) => {
                    const basis = basisDest === info.destinationId ? routeDemandBasis(c, info.destinationId) : null;
                    return (
                      <Fragment key={info.destinationId}>
                        <tr data-testid={`traffic-route-${info.destinationId}`}>
                          <td>
                            {destinationDef(info.destinationId).name}{' '}
                            <button className="small" onClick={() => setBasisDest(basisDest === info.destinationId ? null : info.destinationId)} data-testid={`traffic-route-basis-toggle-${info.destinationId}`}>
                              {DEMAND_UI.basisToggle}
                            </button>
                          </td>
                          <td>{Math.round(info.demand)}</td>
                          <td>{info.seats}</td>
                          <td>{Math.round(info.baseLf * 100)}%</td>
                        </tr>
                        {basis && (
                          <tr data-testid={`traffic-route-basis-${info.destinationId}`}>
                            <td colSpan={4}>
                              <RouteBasisDetail basis={basis} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted small" data-testid="traffic-lf-transfer-note">{FOLLOWUP_UI.trafficLfTransferNote}</p>
              <p className="muted small" data-testid="traffic-demand-note">{DEMAND_UI.demandNote}</p>
            </>
          )}

    </section>
  );
}

/** 契約セクション: 契約中の便・契約の提案・終了した契約／拠点契約の条件 */
export function ContractsPanel() {
  const { c, mode, ctx, operable, routeCapabilities, accessFactor } = usePlanData();
  const readOnly = mode === 'operate';
  const [contractSort, setContractSort] = useState<ContractSortKey>('airline');
  const [contractQuery, setContractQuery] = useState('');
  const query = contractQuery.trim().toLowerCase();
  const matchQuery = (k: Contract) =>
    query === '' ||
    airlineDef(k.airlineId).name.toLowerCase().includes(query) ||
    airlineDef(k.airlineId).code.toLowerCase().includes(query) ||
    destinationDef(k.destinationId).name.toLowerCase().includes(query);
  const active = sortContracts(contractsOf(c, 'active'), contractSort).filter(matchQuery);
  const offers = sortContracts(contractsOf(c, 'offered'), contractSort);
  const past = sortContracts(
    contractsOf(c).filter((k) => k.status !== 'active' && k.status !== 'offered'),
    contractSort,
  ).slice(-8);
  return (
    <div className="issues mgmt" data-testid="contracts-panel">
      {readOnly && <p className="muted small" data-testid="contracts-readonly">運航中は契約の変更・提案への回答はできません（建設モードで編集してください）。</p>}
      <div className="issues-list mgmt-grid">
        <section>
          <h4>契約中の便</h4>
          <div className="small">
            <label>
              並び替え{' '}
              <select value={contractSort} onChange={(e) => setContractSort(e.target.value as ContractSortKey)} data-testid="contract-sort">
                <option value="airline">航空会社</option>
                <option value="destination">行き先</option>
                <option value="window">時間帯</option>
                <option value="status">状態</option>
                <option value="perDay">便数</option>
                <option value="startDay">開始日</option>
                <option value="endDay">契約終了日</option>
                <option value="type">機材</option>
              </select>
            </label>{' '}
            <label>
              検索{' '}
              <input
                type="search"
                value={contractQuery}
                onChange={(e) => setContractQuery(e.target.value)}
                placeholder="航空会社名・就航先名"
                data-testid="contract-search"
              />
            </label>
            <span className="muted">（並び替えは契約中・提案・終了分すべてに、検索は契約中の便に適用されます）</span>
          </div>
          <table className="board" data-testid="contracts">
            <thead>
              <tr>
                <th>航空会社</th>
                <th>就航先</th>
                <th>機種</th>
                <th>便数/日</th>
                {c.market && <th>座席/日</th>}
                {c.market && <th>見込み搭乗率</th>}
                <th>時間帯</th>
                <th>割引</th>
                <th>期間</th>
                <th>更新の先行き</th>
                <th>専用スポット</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {active.map((k) => (
                <tr key={k.id} data-testid={`contract-${k.id}`}>
                  <td>
                    {airlineDef(k.airlineId).name}
                    {k.kind && (
                      <span data-testid={`contract-kind-${k.id}`}>
                        （{CONTRACT_KIND_LABEL[k.kind]}
                        {k.kind === 'based' && k.basedAircraft ? `・所属機 ${k.basedAircraft} 機` : ''}）
                      </span>
                    )}
                  </td>
                  <td>
                    {destinationDef(k.destinationId).name}（{classifyRoute(routeCapabilities.originCountryId, destinationDef(k.destinationId)) === 'domestic' ? '国内線' : '国際線'}）
                    {routeAvailability(airlineDef(k.airlineId), destinationDef(k.destinationId), routeCapabilities) === 'international-processing-required' && <span className="ng-text"> 国際旅客処理未実装</span>}
                    {routeAvailability(airlineDef(k.airlineId), destinationDef(k.destinationId), routeCapabilities) === 'airline-unsupported' && <span className="ng-text"> 航空会社未対応</span>}
                  </td>
                  <td className={operable.includes(k.typeId) ? '' : 'ng-text'}>
                    <select
                      value={k.typeId}
                      disabled={readOnly}
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
                  {c.market && <td data-testid={`contract-seats-${k.id}`}>{k.perDay * seatsFor(c, k.airlineId, k.typeId, ctx.types) * 2}</td>}
                  {c.market && (
                    <td data-testid={`contract-lf-${k.id}`}>
                      {(() => {
                        const p = previewLoadFactor(c, k, c.day, accessFactor, ctx.types, routeCapabilities);
                        return p ? `${Math.round(p.lf * 100)}%` : '—';
                      })()}
                    </td>
                  )}
                  <td>{WINDOW_LABEL[k.window]}</td>
                  <td>{Math.round(k.feeDiscount * 100)}%</td>
                  <td>
                    {k.startDay + 1}〜{k.endDay + 1}日目
                  </td>
                  <td data-testid={`contract-outlook-${k.id}`}>
                    {(() => {
                      const o = renewalOutlook(c, k);
                      return <span title={o.reason}>{RENEWAL_LEVEL_LABEL[o.level]}（残り {Math.max(0, o.daysLeft)} 日）</span>;
                    })()}
                  </td>
                  <td>
                    <select
                      value={k.dedicatedStandId ?? ''}
                      disabled={readOnly}
                      onChange={(e) => companyActions.setDedicatedStand(k.id, e.target.value || null)}
                      title="専用スポット: この契約の便が優先して使い、付属のゲートも占有されます。他の契約の便は空きがないときだけ使います"
                      data-testid={`dedicated-stand-${k.id}`}
                    >
                      <option value="">専用なし</option>
                      {Object.values(ctx.layout.stands).map((s) => (
                        <option key={s.id} value={s.id}>{s.id}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button disabled={readOnly} onClick={() => companyActions.changeFrequency(k.id, 1)} title="増便を依頼（満足度60以上で応じる）" data-testid={`freq-up-${k.id}`}>
                      増便
                    </button>
                    <button disabled={readOnly} onClick={() => companyActions.changeFrequency(k.id, -1)} title="減便（満足度が下がる）">
                      減便
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {active.length === 0 && <div className="empty">{query !== '' ? '検索に一致する契約中の便はありません' : '契約はありません。提案を受け入れてください'}</div>}

          {active.some((k) => k.kind === 'based') && (
            <section data-testid="plan-based-conditions">
              <h4>拠点契約の条件（滞泊・整備・人員）</h4>
              {active.filter((k) => k.kind === 'based').map((k) => {
                const d = basedConditionDetails(c, ctx, k.id);
                if (!d) return null;
                return (
                  <div key={k.id} className="based-summary" data-testid={`plan-based-${k.id}`}>
                    <strong>{airlineDef(k.airlineId).name}</strong>
                    {d.items.map((item) => (
                      <span key={item.key} className={item.met ? 'ok-text' : 'ng-text'} data-testid={`plan-based-${k.id}-${item.key}`}>
                        {item.name} {item.available}/{item.required} {item.unit}
                      </span>
                    ))}
                    <span className="muted small">{d.allMet ? '条件を満たしています' : `未達: ${d.unmet.join('・')}（3 日連続で撤退）`}。内訳と常駐機は経営ボード「乗継・拠点」で見られます</span>
                  </div>
                );
              })}
            </section>
          )}

          <h4>契約の提案</h4>
          <table className="board" data-testid="offers">
            <tbody>
              {offers.map((k) => {
                const routeStatus = routeAvailability(airlineDef(k.airlineId), destinationDef(k.destinationId), routeCapabilities);
                const ok = operable.includes(k.typeId) && routeStatus === 'available';
                return (
                  <tr key={k.id} data-testid={`offer-${k.id}`}>
                    <td>
                      {airlineDef(k.airlineId).name}
                      {k.kind && (
                        <span data-testid={`offer-kind-${k.id}`}>
                          （{CONTRACT_KIND_LABEL[k.kind]}
                          {k.kind === 'based' && k.basedAircraft ? `・所属機 ${k.basedAircraft} 機` : ''}）
                        </span>
                      )}
                    </td>
                    <td>
                      {destinationDef(k.destinationId).name}（{classifyRoute(routeCapabilities.originCountryId, destinationDef(k.destinationId)) === 'domestic' ? '国内線' : '国際線'}）
                      {routeStatus === 'international-processing-required' && <span className="ng-text"> 国際旅客処理未実装</span>}
                      {routeStatus === 'airline-unsupported' && <span className="ng-text"> 航空会社未対応</span>}
                    </td>
                    <td className={ok ? '' : 'ng-text'}>
                      {resolveType(AIRCRAFT_TYPES, k.typeId).label}
                      {ok ? '' : '（未対応）'}
                    </td>
                    <td>{k.perDay}便/日</td>
                    {c.market &&
                      (() => {
                        const p = previewLoadFactor(c, k, c.day, accessFactor, ctx.types, routeCapabilities);
                        return (
                          <>
                            <td data-testid={`offer-lf-${k.id}`}>見込み搭乗率 {p ? `${Math.round(p.lf * 100)}%` : '—'}</td>
                            <td data-testid={`offer-demand-${k.id}`}>路線需要 {p ? `${Math.round(p.demand)}人/日` : '—'}</td>
                          </>
                        );
                      })()}
                    <td>{WINDOW_LABEL[k.window]}</td>
                    <td>割引 {Math.round(k.feeDiscount * 100)}%</td>
                    <td>{k.offerExpiresDay + 1}日目まで</td>
                    <td>
                      <button className="primary" disabled={!ok || readOnly} onClick={() => companyActions.acceptOffer(k.id)} data-testid={`accept-${k.id}`}>
                        契約
                      </button>
                      <button disabled={readOnly} onClick={() => companyActions.rejectOffer(k.id)}>辞退</button>
                    </td>
                    <td data-testid={`counter-${k.id}`}>
                      <CounterOfferCell contract={k} disabled={readOnly} />
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

        </section>
      </div>
    </div>
  );
}

/** 航空会社セクション: 一覧（簡易表）と使用ターミナル。評価表（AirlineScoreTable）は経営ボード側で続けて出す */
export function AirlinesPanel() {
  const { c } = usePlanData();
  return (
    <div className="issues mgmt" data-testid="airlines-panel">
      <div className="issues-list mgmt-grid">
        <section>
          <h4>航空会社</h4>
          <table className="board">
            <tbody>
              {airlinesFor(c).map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.code} {a.name}
                  </td>
                  <td>{AIRLINE_TYPE_LABEL[a.type]}</td>
                  <td>求める定時率 {Math.round(a.minOtp * 100)}%</td>
                  <td>料金への敏感さ {Math.round(a.priceSensitivity * 100)}%</td>
                  <td className={(c.airlines[a.id]?.satisfaction ?? 0) < BALANCE.contracts.withdrawSat ? 'ng-text' : ''}>
                    {c.airlines[a.id] ? `満足度 ${Math.round(c.airlines[a.id]!.satisfaction)}` : c.rating < (a.minimumAirportRating ?? 0) ? `参入条件: 空港評価 ${a.minimumAirportRating}以上` : '未参入'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <AirlineTerminalsPanel company={c} />
      </div>
    </div>
  );
}

/** 契約の逆提案（5-08）: 時間帯・便数・割引の変更を航空会社に申し入れる小さなフォーム */
function CounterOfferCell({ contract: k, disabled = false }: { contract: Contract; disabled?: boolean }) {
  const [window, setWindow] = useState(k.window);
  const [perDay, setPerDay] = useState(k.perDay);
  const [discountPct, setDiscountPct] = useState(Math.round(k.feeDiscount * 100));
  return (
    <span className="counter-offer">
      <select disabled={disabled} value={window} onChange={(e) => setWindow(e.target.value as Contract['window'])} title="希望する時間帯" data-testid={`counter-window-${k.id}`}>
        {(Object.keys(WINDOW_LABEL) as Contract['window'][]).map((w) => (
          <option key={w} value={w}>{WINDOW_LABEL[w]}</option>
        ))}
      </select>
      <select disabled={disabled} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} title="希望する便数/日" data-testid={`counter-perday-${k.id}`}>
        {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
          <option key={n} value={n}>{n}便</option>
        ))}
      </select>
      <select disabled={disabled} value={discountPct} onChange={(e) => setDiscountPct(Number(e.target.value))} title="提示する割引率" data-testid={`counter-discount-${k.id}`}>
        {[0, 5, 10, 15, 20, 25, 30, 35, 40].map((n) => (
          <option key={n} value={n}>割引{n}%</option>
        ))}
      </select>
      <button
        disabled={disabled}
        onClick={() => companyActions.counterOffer(k.id, { window, perDay, feeDiscount: discountPct / 100 })}
        title="この条件で航空会社に逆提案します。割引を増やすと通りやすく、便数を増やすと通りにくくなります。断られると満足度が少し下がります"
        data-testid={`counter-submit-${k.id}`}
      >
        逆提案
      </button>
    </span>
  );
}

function CityEventPlanner({ company }: { company: CompanyState }) {
  const mode = useEditor((s) => s.mode);
  const city = company.city;
  const [day, setDay] = useState(company.day + 1);
  const [durationDays, setDurationDays] = useState(1);
  const [kind, setKind] = useState<CityEventKind>('festival');
  const [scale, setScale] = useState<1 | 2 | 3>(1);
  const [location, setLocation] = useState<CityEventLocation>('cityCenter');
  if (!city) return null;
  const labels: Record<CityEventKind, string> = { festival: '祭り', sports: 'スポーツ大会', conference: '会議・展示会' };
  const events = city.events ?? [];
  return (
    <section className="city-event-planner" data-testid="city-event-planner">
      <h4>都市イベント</h4>
      <p className="muted small">イベント日は旅客需要と道路混雑が増えます。予定には協力費がかかり、規模が大きいほど混雑に転ぶリスクがあります（混雑時は需要の伸びが ×{CITY_EVENT_CONGESTED.demandGrowthMul} に抑えられ、交通の増分が ×{CITY_EVENT_CONGESTED.trafficMul} になります）。開催前に取り消せば協力費は全額戻ります。</p>
      {events.length > 0 && <ul>{events.map((event) => (
        <li key={event.id}>
          {event.day + 1}日目〜{event.day + event.durationDays}日目 · {labels[event.kind]} · 規模{event.scale} · {event.location === 'cityCenter' ? '市街地' : '空港周辺'}
          {event.wagered && <> · 協力費 {formatCr(cityEventCost(event))}</>}
          {event.wagered && event.day <= company.day && <span data-testid={`event-outcome-${event.id}`}> · 結果: {cityEventOutcome(event) === 'congested' ? '混雑' : '順調'}</span>}
          {mode !== 'operate' && <button type="button" onClick={() => removeCityEvent(event.id)} aria-label="イベントを削除">削除</button>}
        </li>
      ))}</ul>}
      {mode !== 'operate' && (
        <form onSubmit={(e) => { e.preventDefault(); addCityEvent({ day: day - 1, durationDays, kind, scale, location }); }}>
          <label>開始日 <input type="number" min={company.day + 1} max={company.day + 91} value={day} onChange={(e) => setDay(Number(e.target.value))} /> 日目</label>
          <label>期間 <select value={durationDays} onChange={(e) => setDurationDays(Number(e.target.value))}>{[1, 2, 3, 5, 7].map((value) => <option key={value} value={value}>{value}日</option>)}</select></label>
          <label>種類 <select value={kind} onChange={(e) => setKind(e.target.value as CityEventKind)}>{CITY_EVENT_KINDS.map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
          <label>規模 <select value={scale} onChange={(e) => setScale(Number(e.target.value) as 1 | 2 | 3)}><option value={1}>地域</option><option value={2}>広域</option><option value={3}>大規模</option></select></label>
          <label>場所 <select value={location} onChange={(e) => setLocation(e.target.value as CityEventLocation)}><option value="cityCenter">市街地</option><option value="airportDistrict">空港周辺</option></select></label>
          <span className="muted small" data-testid="event-cost-preview">協力費 {formatCr(cityEventCost({ scale, durationDays }))} · 混雑リスク {Math.round(cityEventRisk({ scale }) * 100)}%</span>
          <button type="submit" disabled={company.cash < cityEventCost({ scale, durationDays })}>イベントを予定</button>
        </form>
      )}
    </section>
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
