import { useMemo, useState } from 'react';
import { analyzeAccess } from '../core/access/model';
import { analyzeAirportCapacity, previewContractCapacity, type CapacityMetric, type CapacityPreview, type CapacityStatus } from '../core/economy/capacity';
import { AIRLINES, DESTINATIONS, airlineDef, destinationDef } from '../core/economy/registry';
import { PLAN_ISSUE_LABEL } from '../i18n/ja';
import { createContext } from '../core/sim/context';
import { planDayWithDemand } from '../core/economy/planning';
import { editorStore, useEditor, useLayout, actions } from '../editor/store';
import { PAX_FINAL_STATES } from '../core/sim/types';
import { useCompany } from './ManagementPanels';

const statusLabel: Record<CapacityStatus, string> = { adequate: '余裕あり', warning: '注意', shortage: '能力不足', uncomputed: '未算出' };
const statusClass: Record<CapacityStatus, string> = { adequate: 'ok-text', warning: 'warning-text', shortage: 'ng-text', uncomputed: 'muted' };
const fmt = (n: number | null, digits = 0) => n === null ? '未算出' : n.toLocaleString('ja-JP', { maximumFractionDigits: digits });
const unitLabel: Record<CapacityMetric['unit'], string> = { 'movements/h': '回/時', 'movements/day': '回/日', aircraft: '機', pax: '人', 'pax/h': '人/時', 'pax/day': '人/日', 'aircraft/day': '機/日', units: '台・人', 'pax/trip': '人/便' };

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
  const plan = useMemo(() => planDayWithDemand(company, company.day, access.factor, ctx.types), [company, access.factor, ctx]);
  const snapshot = analyzeAirportCapacity(company, ctx, closedGates, plan, currentPaxByTerminal);
  const [filter, setFilter] = useState('すべて');
  const [airlineId, setAirlineId] = useState(AIRLINES[0]?.id ?? '');
  const [destinationId, setDestinationId] = useState(DESTINATIONS[0]?.id ?? '');
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
      <div className="capacity-grid">{snapshot.summary.map((item) => <MetricCard key={item.name} item={item} />)}</div>
    </section>
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
    <section>
      <h4>時間帯別の需要</h4>
      {peakHours.length ? <table className="board"><thead><tr><th>時間帯</th><th>離着陸回数</th><th>出発旅客</th><th>滑走路能力に対する需要</th></tr></thead><tbody>{peakHours.map((h) => <tr key={h.hour}><td>{String(h.hour).padStart(2, '0')}:00–{String(h.hour + 1).padStart(2, '0')}:00</td><td>{h.movements}</td><td>{h.pax} 人</td><td>{snapshot.analysis.capacity.movementsPerHour > 0 ? `${(h.movements / snapshot.analysis.capacity.movementsPerHour * 100).toFixed(1)}%` : '滑走路能力なし'}</td></tr>)}</tbody></table> : <p className="muted">当日の運航計画がありません。</p>}
    </section>
    <section className="capacity-preview" data-testid="capacity-preview">
      <h4>契約・増便の仮想チェック</h4>
      <p className="muted">現在の空港・契約・セーブには反映しません。既存の計画生成と割当・能力警告で追加便を評価します。</p>
      <div className="capacity-form">
        <label>航空会社 <select value={airlineId} onChange={(e) => { const next = e.target.value; setAirlineId(next); setTypeId((company.fleets?.[next] ?? airlineDef(next).fleet)[0]?.typeId ?? ''); setPreview(null); }}>{AIRLINES.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>就航先 <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>{DESTINATIONS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
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
      </div>}
    </section>
  </div>;
}
