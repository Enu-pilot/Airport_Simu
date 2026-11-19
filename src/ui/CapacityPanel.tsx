import { useMemo, useState } from 'react';
import { analyzeAccess } from '../core/access/model';
import { analyzeAirportCapacity, capacityDelta, previewContractCapacity, type CapacityMetric, type CapacityPreview, type CapacityStatus } from '../core/economy/capacity';
import { airlineDef, airlinesFor, destinationDef, destinationsFor, routeCapabilitiesForAirport } from '../core/economy/registry';
import { previewLoadFactor } from '../core/economy/traffic';
import { CAPABILITY_STATE_LABEL, OVERALL_CAPACITY_NOTE, OVERALL_CAPACITY_TITLE, OVERALL_LIMIT_LABEL, PLAN_ISSUE_LABEL } from '../i18n/ja';
import { capabilityUtilization, layoutCapabilities, maintenanceReading, overnightReadings, readingsFromProcessPeak } from '../core/capability';
import { AREA_KIND_LABEL } from '../i18n/ja';
import { createContext } from '../core/sim/context';
import { planDayWithDemand } from '../core/economy/planning';
import { editorStore, useEditor, useLayout, actions } from '../editor/store';
import { PAX_FINAL_STATES } from '../core/sim/types';
import { useCompany } from './ManagementPanels';

const statusLabel: Record<CapacityStatus, string> = { adequate: '余裕あり', warning: '注意', shortage: '能力不足', uncomputed: '未算出' };
const statusClass: Record<CapacityStatus, string> = { adequate: 'ok-text', warning: 'warning-text', shortage: 'ng-text', uncomputed: 'muted' };
const fmt = (n: number | null, digits = 0) => n === null ? '未算出' : n.toLocaleString('ja-JP', { maximumFractionDigits: digits });
const unitLabel: Record<CapacityMetric['unit'], string> = { 'movements/h': '回/時', 'movements/day': '回/日', aircraft: '機', pax: '人', 'pax/h': '人/時', 'pax/day': '人/日', 'aircraft/day': '機/日', units: '台・人', 'pax/trip': '人/便', 'vehicles/h': '台/時', 'trains/h': '本/時', 'fuel/h': '単位/時' };

function MetricCard({ item }: { item: CapacityMetric }) {
  return <article className={`capacity-card capacity-${item.status}`} title={item.basis}>
    <header><strong>{item.name}</strong><span className={statusClass[item.status]}>{statusLabel[item.status]}</span></header>
    <b>{fmt(item.capacity)} <small>{unitLabel[item.unit]}</small></b>
    <div>需要 {fmt(item.demand)}{item.demand !== null ? ` ${unitLabel[item.unit]}` : ''}</div>
    <div className="muted">使用率 {item.utilization === null ? '未算出' : `${(item.utilization * 100).toFixed(1)}%`} · 余力 {fmt(item.spare)}{item.spare !== null ? ` ${unitLabel[item.unit]}` : ''}</div>
    <small className="capacity-basis">{item.basis}</small>
  </article>;
}

export function CapacityPanel({ onSelectFacility }: { onSelectFacility?: (id: string) => void }) {
  const company = useCompany();
  const layout = useLayout();
  useEditor((s) => s.ops?.uiVersion ?? -1);
  const ctx = useMemo(() => createContext(layout), [layout]);
  const access = analyzeAccess(layout, { fees: company.fees, feedback: company.accessFeedback, city: company.city, day: company.day });
  const closedGates = editorStore.getState().ops?.sim.state.closures.gates ?? [];
  const simState = editorStore.getState().ops?.sim.state;
  const currentPaxByTerminal: Record<string, number> | undefined = simState ? Object.fromEntries(Object.keys(ctx.terminal.byTerminal).map((id) => [id, 0])) : undefined;
  if (simState && currentPaxByTerminal) for (const group of Object.values(simState.paxGroups)) {
    if (group.terminalId && !PAX_FINAL_STATES.includes(group.state)) currentPaxByTerminal[group.terminalId] = (currentPaxByTerminal[group.terminalId] ?? 0) + group.count;
  }
  const plan = useMemo(
    () => planDayWithDemand(company, company.day, access.factor, ctx.types, routeCapabilitiesForAirport(layout.countryId)),
    [company, access.factor, ctx, layout.countryId],
  );
  // 運航中は、閉鎖中の滑走路・スポットを数から除く（AS-5）
  const live = simState
    ? {
        closedRunwayIds: Object.entries(simState.runwayConfig).filter(([, cfg]) => cfg.mode === 'closed').map(([id]) => id),
        closedStandIds: [...simState.closures.stands],
      }
    : undefined;
  const snapshot = analyzeAirportCapacity(company, ctx, closedGates, plan, currentPaxByTerminal, live);
  // 投資効果のプレビュー（5-04 / B4）: 建設モードに入った時点の敷地と現在の能力の差分
  const buildBaseline = useEditor((s) => s.buildBaseline);
  const inBuildMode = useEditor((s) => s.mode) === 'build';
  const baselineSnapshot = useMemo(
    () => (buildBaseline && buildBaseline !== layout ? analyzeAirportCapacity(company, createContext(buildBaseline)) : null),
    [buildBaseline, layout, company],
  );
  const deltas = baselineSnapshot ? capacityDelta(baselineSnapshot, snapshot) : [];
  const [filter, setFilter] = useState('すべて');
  const [airlineId, setAirlineId] = useState(airlinesFor(company)[0]?.id ?? '');
  const [destinationId, setDestinationId] = useState(destinationsFor(company)[0]?.id ?? '');
  const fleet = company.fleets?.[airlineId] ?? airlineDef(airlineId).fleet;
  const [typeId, setTypeId] = useState(fleet[0]?.typeId ?? '');
  const [perDay, setPerDay] = useState(1);
  const [window, setWindow] = useState<'morning' | 'daytime' | 'evening' | 'any'>('any');
  const [preview, setPreview] = useState<CapacityPreview | null>(null);
  const categories = ['すべて', ...new Set(snapshot.facilities.map((r) => r.kind))];
  const rows = filter === 'すべて' ? snapshot.facilities : snapshot.facilities.filter((r) => r.kind === filter);
  const peakHours = [...snapshot.analysis.hourly.movements.entries()].filter(([, n]) => n > 0).map(([hour, movements]) => ({ hour, movements, pax: snapshot.analysis.hourly.depPax[hour] ?? 0 }));

  const runPreview = () => {
    if (!airlineId || !destinationId || !typeId) return;
    // The core preview creates its own copy and never writes to editor or simulation state.
    setPreview(previewContractCapacity(company, ctx, { airlineId, destinationId, typeId, perDay, window }, closedGates, access.factor));
  };

  return <div className="capacity-panel mgmt" data-testid="capacity-panel">
    <header className="capacity-heading">
      <div><h3>空港能力</h3><span className="muted">{company.day + 1}日目・計画需要 / 運用時間 {snapshot.operatingHours.toFixed(1)} 時間</span></div>
      <div className="capacity-peak">ピーク: {String(snapshot.peakHour.hour).padStart(2, '0')}:00 · {snapshot.peakHour.movements} 運航 / {snapshot.peakHour.departingPax} 出発旅客</div>
    </header>
    <p className="capacity-note">計算できる値は既存の計画・施設モデルを使用します。能力モデルがない工程は「未算出」と表示します。滑走路 30 回/時は計画用の基準値で、実運用保証値ではありません。</p>
    {inBuildMode && baselineSnapshot && (
      <section className="capacity-alert" data-testid="capacity-delta">
        <strong>建設前との比較（投資効果）</strong>
        {deltas.length === 0 ? <div className="muted small">能力の変わった指標はありません。</div> : (
          <ul>{deltas.map((d) => <li key={d.name}>{d.name}: {d.before ?? '未算出'} → {d.after ?? '未算出'} {d.unit}{d.delta !== null && d.delta !== 0 ? `（${d.delta > 0 ? '+' : ''}${d.delta}）` : ''}</li>)}</ul>
        )}
      </section>
    )}
    {snapshot.bottlenecks.length > 0 ? <section className="capacity-alert" data-testid="capacity-bottlenecks">
      <h4>先に確認するボトルネック</h4>
      {snapshot.bottlenecks.map((b) => <div className="capacity-bottleneck" key={b.name}>
        <b className={statusClass[b.status]}>{statusLabel[b.status]} · {b.name}</b>
        <span>能力 {fmt(b.capacity)} {unitLabel[b.unit]} / 需要 {fmt(b.demand)} {unitLabel[b.unit]} · {b.utilization === null ? '使用率未算出' : `${(b.utilization * 100).toFixed(1)}%`}</span>
        <small>{b.basis}</small>
      </div>)}
    </section> : <p className="ok-text">計画需要に対する算出可能な能力不足はありません。</p>}
    <section>
      <h4>空港全体</h4>
      <article className="capacity-card capacity-overall" data-testid="capacity-overall" title={OVERALL_CAPACITY_NOTE}>
        <header><strong>{OVERALL_CAPACITY_TITLE}</strong></header>
        <b>{fmt(snapshot.overall.capacity)} <small>{unitLabel['movements/h']}</small></b>
        <div data-testid="capacity-overall-limit">{snapshot.overall.limitedBy ? `制約: ${OVERALL_LIMIT_LABEL[snapshot.overall.limitedBy]}` : '制約: 未算出'}</div>
        <small className="capacity-basis">{OVERALL_CAPACITY_NOTE}</small>
      </article>
      <div className="capacity-grid">{snapshot.summary.map((item) => <MetricCard key={item.name} item={item} />)}</div>
    </section>
    {(snapshot.hub.transferPaxPerDay > 0 || Object.values(snapshot.hub.mctMin).some((m) => m.max !== null)) && (
      <section data-testid="capacity-hub">
        <h4>乗継・ハブ</h4>
        <table className="board">
          <thead><tr><th>乗継の種類</th><th>最短乗継時間（最大）</th><th>最短乗継時間（中央値）</th></tr></thead>
          <tbody>
            {([['DD', '国内→国内'], ['DI', '国内→国際'], ['ID', '国際→国内'], ['II', '国際→国際']] as const).map(([kind, label]) => (
              <tr key={kind} data-testid={`capacity-hub-mct-${kind}`}>
                <td>{label}</td>
                <td>{snapshot.hub.mctMin[kind].max !== null ? `${Math.round(snapshot.hub.mctMin[kind].max!)} 分` : '接続不可'}</td>
                <td>{snapshot.hub.mctMin[kind].median !== null ? `${Math.round(snapshot.hub.mctMin[kind].median!)} 分` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="capacity-peak">
          1 日の乗継旅客（計画）: <span data-testid="capacity-hub-transfer-pax">{snapshot.hub.transferPaxPerDay} 人</span>
          {snapshot.hub.bankAircraft !== null && <> · バンク時の最大機数: {snapshot.hub.bankAircraft} 機</>}
          {snapshot.hub.bankPax !== null && <> · バンク時の乗継処理能力: {snapshot.hub.bankPax} 人/時</>}
        </div>
      </section>
    )}
    <section className="capacity-detail">
      <div className="capacity-heading"><h4>施設別の能力・状態</h4><label>種類 <select value={filter} onChange={(e) => setFilter(e.target.value)}>{categories.map((c) => <option key={c}>{c}</option>)}</select></label></div>
      <div className="capacity-table-scroll"><table className="board" data-testid="capacity-facilities">
        <thead><tr><th>施設</th><th>種別</th><th>状態</th><th>能力</th><th>需要</th><th>判定</th><th>算出根拠</th><th></th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id} data-testid={`capacity-row-${r.id}`}>
          <td>{r.name}</td><td>{r.kind}{r.terminalId ? ` · ${r.terminalId}` : ''}</td><td>{r.state === 'operational' ? '運用中' : r.state === 'construction' ? '建設中' : '計画'}</td>
          <td>{fmt(r.capacity)} {unitLabel[r.unit]}</td><td>{fmt(r.demand)}{r.demand !== null ? ` ${unitLabel[r.unit]}` : ''}</td><td className={statusClass[r.status]}>{statusLabel[r.status]}</td><td className="capacity-explain">{r.basis}</td>
          <td>{onSelectFacility && <button className="link" onClick={() => { actions.select(r.id); onSelectFacility(r.id); }}>建設で確認</button>}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <section data-testid="capacity-common">
      <h4>共通能力ビュー（理論 / 有効能力と状態）</h4>
      {(() => {
        const readings = [...layoutCapabilities(layout), ...overnightReadings(company, ctx, company.day), maintenanceReading(layout)];
        const computed = readings.filter((r) => r.theoretical !== null);
        const uncomputedCount = readings.length - computed.length;
        const attention = computed.filter((r) => r.state === 'zeroCapacity' || r.state === 'underConstruction' || r.state === 'disconnected');
        return <>
          {attention.length > 0 && <div className="capacity-alert" data-testid="capacity-common-attention">
            <strong>要確認の施設</strong>
            <ul>{attention.map((r) => <li key={r.subjectId}>{r.label}: {CAPABILITY_STATE_LABEL[r.state] ?? r.state}（理論 {fmt(r.theoretical)} {r.unit} / 有効 {fmt(r.effective)} {r.unit}）</li>)}</ul>
          </div>}
          <div className="capacity-table-scroll"><table className="board">
            <thead><tr><th>施設</th><th>状態</th><th>理論能力</th><th>有効能力</th><th>根拠</th></tr></thead>
            <tbody>{computed.map((r) => <tr key={r.subjectId} data-testid={`capacity-common-${r.subjectId}`}>
              <td>{r.label}</td><td>{CAPABILITY_STATE_LABEL[r.state] ?? r.state}</td>
              <td>{fmt(r.theoretical)} {r.unit}</td><td>{fmt(r.effective)} {r.unit}</td>
              <td className="capacity-explain">{r.basis}</td>
            </tr>)}</tbody>
          </table></div>
          {uncomputedCount > 0 && <p className="muted small">能力式が定義されていない施設 {uncomputedCount} 件は「未算出」です（0 能力とは区別しています。理由は建設画面で施設を選ぶと表示されます）。</p>}
        </>;
      })()}
    </section>
    {(() => {
      const latest = company.reports[company.reports.length - 1];
      const actuals = latest ? readingsFromProcessPeak(latest) : [];
      if (actuals.length === 0) return null;
      return <section data-testid="capacity-common-actuals">
        <h4>工程の実績（直近日報・共通能力）</h4>
        <div className="capacity-table-scroll"><table className="board">
          <thead><tr><th>工程</th><th>能力</th><th>需要</th><th>ピーク実績</th><th>使用率（需要÷有効能力）</th></tr></thead>
          <tbody>{actuals.map((r) => {
            const u = capabilityUtilization(r);
            return <tr key={r.subjectId} data-testid={`capacity-actual-${r.subjectId}`}>
              <td>{AREA_KIND_LABEL[r.subjectId as keyof typeof AREA_KIND_LABEL] ?? r.subjectId}</td>
              <td>{fmt(r.effective)} {r.unit === 'pax/h' ? '人/時' : r.unit}</td>
              <td>{fmt(r.demand)} {r.unit === 'pax/h' ? '人/時' : r.unit}</td>
              <td>{fmt(r.actual)} 人</td>
              <td>{u === null ? '未算出' : `${Math.round(u * 100)}%`}</td>
            </tr>;
          })}</tbody>
        </table></div>
        <p className="muted small">実績は 5-21 の工程ピーク（日報）から共通能力の形で表示しています。計画側の能力・需要とは時間窓が異なります。</p>
        {latest?.morningReadiness && (
          <p data-testid="capacity-morning-readiness">翌朝の出発可能機数（直近日報）: 予定 {latest.morningReadiness.scheduled} 機・確定可能 {latest.morningReadiness.ready} 機・リスクあり {latest.morningReadiness.atRisk} 機（06:00–10:00 の滞泊便。リスクは整備枠に入らなかった周期整備対象機とスポット閉鎖中の機）</p>
        )}
      </section>;
    })()}
    <section>
      <h4>時間帯別の需要</h4>
      {peakHours.length ? <table className="board"><thead><tr><th>時間帯</th><th>離着陸回数</th><th>出発旅客</th><th>滑走路能力に対する需要</th></tr></thead><tbody>{peakHours.map((h) => <tr key={h.hour}><td>{String(h.hour).padStart(2, '0')}:00–{String(h.hour + 1).padStart(2, '0')}:00</td><td>{h.movements}</td><td>{h.pax} 人</td><td>{snapshot.analysis.capacity.movementsPerHour > 0 ? `${(h.movements / snapshot.analysis.capacity.movementsPerHour * 100).toFixed(1)}%` : '滑走路能力なし'}</td></tr>)}</tbody></table> : <p className="muted">当日の運航計画がありません。</p>}
    </section>
    <section className="capacity-preview" data-testid="capacity-preview">
      <h4>契約・増便の仮想チェック</h4>
      <p className="muted">現在の空港・契約・セーブには反映しません。既存の計画生成と割当・能力警告で追加便を評価します。</p>
      <div className="capacity-form">
        <label>航空会社 <select value={airlineId} onChange={(e) => { const next = e.target.value; setAirlineId(next); setTypeId((company.fleets?.[next] ?? airlineDef(next).fleet)[0]?.typeId ?? ''); setPreview(null); }}>{airlinesFor(company).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>就航先 <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>{destinationsFor(company).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label>機種 <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>{fleet.map((f) => <option key={f.typeId} value={f.typeId}>{f.typeId}</option>)}</select></label>
        <label>往復便数/日 <input type="number" min={1} max={20} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} /></label>
        <label>時間帯 <select value={window} onChange={(e) => setWindow(e.target.value as typeof window)}><option value="any">終日</option><option value="morning">朝</option><option value="daytime">昼</option><option value="evening">夕方</option></select></label>
        <button className="primary" onClick={runPreview} disabled={!typeId}>追加需要を評価</button>
      </div>
      {preview && <div className={`capacity-preview-result capacity-${preview.result}`}>
        <strong>{preview.result === 'acceptable' ? '受け入れ可能' : preview.result === 'conditional' ? '条件付きで受け入れ可能' : '受け入れ不可'}</strong>
        <span>{airlineDef(airlineId).name} · {destinationDef(destinationId).name} · {perDay} 往復/日</span>
        <p>{preview.reason}</p>
        {preview.newIssues.length > 0 ? <ul>{preview.newIssues.map((i) => <li key={`${i.code}:${i.detail}`}>{PLAN_ISSUE_LABEL[i.code]} · {i.keys.length} 便{i.detail ? ` · ${i.detail}` : ''}</li>)}</ul> : <p className="muted">追加便による新しい計画警告はありません。</p>}
        <small className="muted">計画便数 {preview.before.plan.flights.length} → {preview.after.plan.flights.length} 往復。能力 {fmt(preview.after.summary[0]?.capacity ?? null)} 回/時のように値を比較します。タクシーウェイ、バス時間能力、日次実運用上限は未算出です。</small>
        {company.market &&
          (() => {
            const p = previewLoadFactor(company, { airlineId, destinationId, typeId, perDay }, company.day, access.factor, ctx.types, routeCapabilitiesForAirport(layout.countryId));
            return p ? (
              <p data-testid="capacity-preview-lf">
                見込み搭乗率 {Math.round(p.lf * 100)}%（路線需要 {Math.round(p.demand)}人/日 ÷ 供給 {p.seats}席）
              </p>
            ) : null;
          })()}
      </div>}
    </section>
  </div>;
}
