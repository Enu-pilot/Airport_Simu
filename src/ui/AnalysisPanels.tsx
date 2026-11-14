import { useMemo, useState } from 'react';
import { aggregate, airportKpis, bottlenecks, MIN_SAMPLE, type GroupKey } from '../core/analytics/kpi';
import { checkAirport } from '../core/aircraft/compat';
import { AIRCRAFT_TYPES, resolveType } from '../core/sim/aircraftTypes';
import { contractsOf } from '../core/economy/company';
import { catalogDiff, compareResults, type Scenario } from '../core/scenario/scenario';
import { CATALOG } from '../core/aircraft/catalog';
import { editorStore, formatCr, scenarioActions, useEditor } from '../editor/store';
import { focusEntity } from '../editor/input';
import {
  BOTTLENECK_AREA_LABEL,
  COMPAT_REASON_LABEL,
  COMPAT_STATUS_LABEL,
  GROUP_KEY_LABEL,
  SCENARIO_KPI_LABEL,
  TASK_LABEL,
  displayName,
} from '../i18n/ja';

/**
 * 運営分析（docs/18_analytics.md）: 実績の集計（切り口別）、空港全体の指標、ボトルネック、機種と施設の適合性。
 * 値はすべて運航の記録から計算した実績値。運航費だけは機種のゲーム値からの推定。
 */

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 1000) / 10}%`);
const num = (v: number | null, unit = '') => (v === null ? '—' : `${v}${unit}`);

export function AnalyticsPanel() {
  useEditor((s) => s.ops?.uiVersion ?? -1);
  const o = editorStore.getState().ops;
  const [key, setKey] = useState<GroupKey>('model');
  if (!o) return <div className="empty">運航中に表示します（シナリオの結果は「シナリオ」タブ）</div>;
  const { sim } = o;
  const recs = sim.state.analytics.records;
  const groups = aggregate(recs, key, sim.ctx.types);
  const k = airportKpis(sim);
  const bn = bottlenecks(sim);
  const name = (id: string) => (key === 'model' ? resolveType(sim.ctx.types, id).label : key === 'runway' || key === 'stand' || key === 'gate' ? displayName(sim.ctx.layout, id) : id);
  return (
    <div className="issues mgmt" data-testid="analytics-panel">
      <div className="issues-header">
        <strong>運営分析</strong>
        <span>記録 {recs.length}便（運航を終えた機体）</span>
        <label>
          切り口
          <select value={key} onChange={(e) => setKey(e.target.value as GroupKey)} data-testid="analytics-key">
            {(Object.keys(GROUP_KEY_LABEL) as GroupKey[]).map((g) => (
              <option key={g} value={g}>
                {GROUP_KEY_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">{MIN_SAMPLE}便未満の集計は「データ不足」（優劣の判断に使わない）</span>
      </div>
      <div className="issues-list">
        <table className="board" data-testid="analytics-groups">
          <thead>
            <tr>
              <th>{GROUP_KEY_LABEL[key]}</th>
              <th>便数</th>
              <th>完了率</th>
              <th>座席</th>
              <th>搭乗</th>
              <th>座席利用率</th>
              <th>折り返し</th>
              <th>スポット占有</th>
              <th>評価対象の出発遅延</th>
              <th>実出発遅延</th>
              <th>定時率</th>
              <th>作業（分）</th>
              <th>空港収入</th>
              <th title="航空会社の運航費。機種のゲーム値 × 1.5時間の推定">運航費（推定）</th>
              <th>障害の影響</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} className={g.lowSample ? 'muted' : ''} data-testid={`group-${g.key}`}>
                <td>
                  {name(g.key)}
                  {g.lowSample ? <span className="badge unset"> データ不足</span> : null}
                </td>
                <td className="num">{g.n}</td>
                <td className="num">{pct(g.completionRate)}</td>
                <td className="num">{g.seats}</td>
                <td className="num">{g.paxBoarded}</td>
                <td className="num">{pct(g.loadFactor)}</td>
                <td className="num">{num(g.avgTurnMin, '分')}</td>
                <td className="num">{num(g.avgStandMin, '分')}</td>
                <td className="num">{num(g.avgDepDelayMin, '分')}</td>
                <td className="num muted">{num(g.avgActualDepDelayMin, '分')}</td>
                <td className="num">{pct(g.otp)}</td>
                <td className="muted small">
                  {Object.entries(g.taskMin)
                    .map(([t, v]) => `${TASK_LABEL[t as keyof typeof TASK_LABEL]} ${v}`)
                    .join(' / ')}
                </td>
                <td className="num">{formatCr(g.revenue)}</td>
                <td className="num muted">{formatCr(g.estOpCost)}</td>
                <td className="num">{g.disrupted}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {groups.length === 0 && <div className="empty">まだ運航を終えた便がありません</div>}

        <div className="mgmt-grid">
          <section>
            <h4>ボトルネック（推定。根拠の指標と規則つき）</h4>
            {bn.length === 0 && <div className="empty">規則に当てはまる箇所はありません</div>}
            {bn.map((b) => (
              <div key={`${b.area}:${b.target}`} className="bottleneck" data-testid={`bottleneck-${b.area}`}>
                <b>
                  {BOTTLENECK_AREA_LABEL[b.area]}: {sim.ctx.layout.runways[b.target] || sim.ctx.layout.terminalAreas[b.target] || sim.ctx.layout.stands[b.target] ? (
                    <a onClick={() => focusEntity(b.target)}>{displayName(sim.ctx.layout, b.target)}</a>
                  ) : (
                    b.target
                  )}
                </b>{' '}
                <span className="muted small">深刻度 {Math.round(b.score * 100)}</span>
                <div className="muted small">
                  {b.evidence.map((e) => `${e.label} ${e.value}`).join(' ／ ')}（規則: {b.rule}）
                </div>
              </div>
            ))}
            <h4>空港全体</h4>
            <div className="muted small" data-testid="airport-kpis">
              到着 {k.arrivals} ／ 出発 {k.departures} ／ 運航不能 {k.cancelled}
              {Object.keys(k.failCauses).length ? `（${Object.entries(k.failCauses).map(([c, n]) => `${c} ${n}`).join('、')}）` : ''} ／ 平均走行 到着 {num(k.avgTaxiInMin, '分')}・出発{' '}
              {num(k.avgTaxiOutMin, '分')} ／ 平均地上移動 {num(k.avgGroundDistM, 'm')} ／ 平均空中待機 {num(k.avgAirborneHoldMin, '分')} ／ 乗り遅れ {k.missedPax}人 ／
              手荷物（預け入れ→積載）{num(k.bagProcessMin, '分')}・積み残し {k.bagsLeft}個
            </div>
            <table className="board">
              <tbody>
                {k.runways.map((r) => (
                  <tr key={r.id}>
                    <td>{displayName(sim.ctx.layout, r.id)}</td>
                    <td>占有率 {pct(r.util)}</td>
                    <td>離着陸 {r.ops}回</td>
                    <td>平均待ち {num(r.avgWaitMin, '分')}</td>
                  </tr>
                ))}
                {k.facilities.slice(0, 6).map((f) => (
                  <tr key={f.id}>
                    <td>{f.id.startsWith('gate:') ? displayName(sim.ctx.layout, f.id.slice(5)) : displayName(sim.ctx.layout, f.id)}</td>
                    <td>処理 {f.served}人</td>
                    <td>平均待ち {num(f.avgWaitMin, '分')}</td>
                    <td>最大待ち {f.maxQueue}人</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted small">
              稼働率: {Object.entries(k.unitUtil).map(([u, v]) => `${u} ${pct(v ?? 0)}`).join(' ／ ')}
            </div>
            {k.apronBus && (
              <div className="muted small" data-testid="analysis-apronBus">
                ランプバス: 運行 {k.apronBus.trips}回 ／ 旅客 {k.apronBus.pax}人 ／ 平均バス待ち {num(k.apronBus.avgWaitMin, '分')} ／ 不足 {k.apronBus.shortageMin}分 ／ 救援 {k.apronBus.rescues}回
              </div>
            )}
            <div className="muted small">
              時間帯別旅客（出発/到着）: {k.hourlyPax.map((h) => `${h.hour}時 ${h.dep}/${h.arr}`).join('、')}
            </div>
          </section>
          <section>
            <CompatAnalysis />
          </section>
        </div>
      </div>
    </div>
  );
}

/** 機種と施設の適合性分析（aircraft/compat.ts の判定を使う） */
function CompatAnalysis() {
  const s = editorStore.getState();
  const o = s.ops;
  const layout = o?.sim.ctx.layout ?? s.history.present;
  const company = o?.sim.company ?? s.company;
  const net = o?.sim.ctx.network;
  const result = useMemo(() => {
    const n = net ?? undefined;
    const ids = [...new Set(contractsOf(company, 'active').map((k) => k.typeId))];
    return ids.map((id) => ({ id, c: checkAirport(resolveType(AIRCRAFT_TYPES, id), layout, n ?? (o ? o.sim.ctx.network : (undefined as never))) }));
  }, [layout, company, net, o]);
  const failed = o ? o.sim.state.analytics.records.filter((r) => r.result !== 'completed' && r.causes.some((c) => ['hold:noStand', 'hold:noRunway', 'hold:noRoute', 'noStand', 'noRoute'].includes(c))) : [];
  if (!o) return null;
  return (
    <div data-testid="compat-analysis">
      <h4>使用中の機種と施設の適合性</h4>
      <table className="board">
        <tbody>
          {result.map(({ id, c }) => (
            <tr key={id}>
              <td>{resolveType(AIRCRAFT_TYPES, id).label}</td>
              <td className={c.status === 'ok' ? 'ok-text' : 'ng-text'}>{COMPAT_STATUS_LABEL[c.status]}</td>
              <td className="muted small">
                使えるスポット {c.stands.filter((x) => x.status === 'ok').length}/{c.stands.length}・使えない {c.stands.filter((x) => x.status === 'ng').length}・要確認{' '}
                {c.stands.filter((x) => x.status === 'unknown').length}
                {c.reasons.length ? `（${c.reasons.map((r) => COMPAT_REASON_LABEL[r]).join('、')}）` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>施設の制約で運航できなかった便</h4>
      {failed.length === 0 ? (
        <div className="empty">ありません</div>
      ) : (
        <div className="muted small">{failed.map((r) => `${r.arrNumber}（${resolveType(AIRCRAFT_TYPES, r.typeId).shortLabel}: ${r.causes.join('、')}）`).join(' ／ ')}</div>
      )}
      <h4>機材変更による適合性の変化（各契約の保有機材）</h4>
      <table className="board">
        <tbody>
          {contractsOf(company, 'active').map((k) => (
            <tr key={k.id}>
              <td>
                {k.airlineId} {k.id}
              </td>
              <td className="muted small">
                {(company.fleets?.[k.airlineId] ?? []).map((e) => {
                  const st = checkAirport(resolveType(AIRCRAFT_TYPES, e.typeId), layout, o.sim.ctx.network).status;
                  return (
                    <span key={e.typeId} className={st === 'ok' ? 'ok-text' : 'ng-text'}>
                      {resolveType(AIRCRAFT_TYPES, e.typeId).shortLabel}
                      {e.typeId === k.typeId ? '（現在）' : ''} {COMPAT_STATUS_LABEL[st]}{' '}
                    </span>
                  );
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- シナリオ

export function ScenarioPanel() {
  const scenarios = useEditor((s) => s.scenarios);
  const running = useEditor((s) => s.scenarioRun);
  const [base, setBase] = useState('');
  const [other, setOther] = useState('');
  const a = scenarios.find((x) => x.id === base);
  const b = scenarios.find((x) => x.id === other);
  const ra = a?.results[a.results.length - 1];
  const rb = b?.results[b.results.length - 1];
  return (
    <div className="issues mgmt" data-testid="scenario-panel">
      <div className="issues-header">
        <strong>シナリオ比較</strong>
        <button onClick={() => scenarioActions.createFromCurrent(`シナリオ ${scenarios.length + 1}`)} data-testid="scenario-create">
          現在の空港から作る
        </button>
        {running && <span data-testid="scenario-running">実行中… {Math.round(running.progress * 100)}%</span>}
        <span className="muted">同じ乱数シード・保存した機種データで実行するので、同じ条件なら同じ結果になります</span>
      </div>
      <div className="issues-list mgmt-grid">
        <section>
          {scenarios.length === 0 && <div className="empty">シナリオはありません</div>}
          {scenarios.map((s) => (
            <ScenarioCard key={s.id} s={s} busy={!!running} />
          ))}
        </section>
        <section>
          <h4>比較</h4>
          <div className="fee-grid">
            <select value={base} onChange={(e) => setBase(e.target.value)} data-testid="compare-a">
              <option value="">基準…</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select value={other} onChange={(e) => setOther(e.target.value)} data-testid="compare-b">
              <option value="">比較対象…</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          {ra && rb ? (
            <>
              {(ra.catalogUsed !== rb.catalogUsed || ra.simModelVersion !== rb.simModelVersion) && (
                <div className="warn-text">機種データ（{ra.catalogUsed}/{rb.catalogUsed}）またはモデルの版が異なるため、条件が同じではありません</div>
              )}
              <table className="board" data-testid="compare-table">
                <thead>
                  <tr>
                    <th>指標</th>
                    <th>{a!.name}</th>
                    <th>{b!.name}</th>
                    <th>差</th>
                    <th>判定</th>
                  </tr>
                </thead>
                <tbody>
                  {compareResults(ra.kpis, rb.kpis).map((r) => (
                    <tr key={r.metric}>
                      <td>{SCENARIO_KPI_LABEL[r.metric]}</td>
                      <td className="num">{fmt(r.a, r.metric)}</td>
                      <td className="num">{fmt(r.b, r.metric)}</td>
                      <td className="num">{r.diff === null ? '—' : fmt(r.diff, r.metric)}</td>
                      <td className={r.verdict === 'improved' ? 'ok-text' : r.verdict === 'worse' ? 'ng-text' : 'muted'}>
                        {{ improved: '改善', worse: '悪化', same: '同じ', 'n/a': '—' }[r.verdict]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="empty">結果のある2つのシナリオを選んでください</div>
          )}
        </section>
      </div>
    </div>
  );
}

const fmt = (v: number | null, metric: string) =>
  v === null ? '—' : metric === 'otp' || metric === 'loadFactor' ? `${Math.round(v * 1000) / 10}%` : Math.round(v * 10) / 10;

function ScenarioCard({ s, busy }: { s: Scenario; busy: boolean }) {
  const last = s.results[s.results.length - 1];
  const diff = useMemo(() => catalogDiff(s.catalog.models), [s.catalog.models]);
  const contracts = contractsOf(s.company, 'active');
  return (
    <div className="scenario-card" data-testid={`scenario-${s.id}`}>
      <h4>
        <input value={s.name} onChange={(e) => scenarioActions.rename(s.id, e.target.value)} />
        <span className="muted small">
          {' '}
          シード {s.seed} ／ カタログ {s.catalog.version} ／ モデル {s.simModelVersion}
        </span>
      </h4>
      <div className="fee-grid">
        <button disabled={busy} onClick={() => scenarioActions.run(s.id)} data-testid={`scenario-run-${s.id}`}>
          実行
        </button>
        <button disabled={busy || diff.length === 0} onClick={() => scenarioActions.run(s.id, true)} title="最新のカタログの機種データで実行（旧結果と区別して記録）">
          最新カタログで再実行
        </button>
        <button onClick={() => scenarioActions.duplicate(s.id)}>複製</button>
        <button onClick={() => scenarioActions.useCurrentLayout(s.id)} title="編集中の空港の配置を取り込む">
          現在の配置を取り込む
        </button>
        <label>
          時間
          <input type="number" min={1} max={48} value={s.durationHours} onChange={(e) => scenarioActions.setDuration(s.id, Number(e.target.value))} style={{ width: 50 }} />
        </label>
        <button className="danger" onClick={() => scenarioActions.remove(s.id)}>
          削除
        </button>
      </div>
      {diff.length > 0 && <div className="warn-text small">保存した機種データと最新カタログに {diff.length} 件の差があります（実行は保存したデータで行います）</div>}
      <table className="board">
        <tbody>
          {contracts.map((k) => (
            <tr key={k.id}>
              <td>
                {k.airlineId} {k.id}
              </td>
              <td>
                <select value={k.typeId} onChange={(e) => scenarioActions.changeAircraft(s.id, k.id, e.target.value)} data-testid={`scenario-type-${s.id}-${k.id}`}>
                  {[...new Set([k.typeId, ...Object.keys(CATALOG)])].map((id) => (
                    <option key={id} value={id}>
                      {(CATALOG[id] ?? s.catalog.models[id])?.name ?? id}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input type="number" min={1} max={20} value={k.perDay} onChange={(e) => scenarioActions.changeFrequency(s.id, k.id, Number(e.target.value))} style={{ width: 44 }} />
                便/日
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.changes.length > 0 && <div className="muted small">変更履歴: {s.changes.join(' ／ ')}</div>}
      {last && (
        <div className="muted small" data-testid={`scenario-result-${s.id}`}>
          結果（{last.catalogUsed === 'snapshot' ? '保存した機種データ' : '最新カタログ'}・{last.ranAt.slice(0, 16)}）: 便 {last.kpis.flights}・完了 {last.kpis.completed}・定時率{' '}
          {fmt(last.kpis.otp, 'otp')}・搭乗 {last.kpis.paxBoarded}・営業利益 {formatCr(last.kpis.operatingProfit)}
        </div>
      )}
    </div>
  );
}
