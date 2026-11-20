import { useMemo, useState } from 'react';
import type { AirportLayout } from '../core/model/types';
import {
  SERVICE_CATEGORIES,
  serviceProfilesFor,
  type ServiceCategory,
  type ServiceCategoryStatus,
} from '../core/terminal/serviceProfile';
import { runServiceDetailSim, type ServiceDetailResult } from '../core/terminal/serviceDetailSim';
import type { ServiceCategoryUsage, ServiceGranularity } from '../core/sim/serviceAggregate';
import { setServiceGranularity, useEditor } from '../editor/store';
import { BALANCE } from '../core/economy/balance';
import { AREA_KIND_LABEL, ZONE_LABEL } from '../i18n/ja';

/**
 * 5-19 T11–T13（粒度分離バックエンド）の UI 接続（引き渡しメモ Step 5）。
 *
 * - ServiceGranularitySelect: 空港運営モードの店舗粒度（詳細/集約）の切替。実行時オプションで
 *   プロジェクトには保存されず、次回の運航開始から適用される。
 * - ServiceProfileSection: 集約 profile（カテゴリ×ターミナルの能力・状態・区域内訳）と、
 *   集約方式で運航中のときのカテゴリ実績を表示する。表示専用の読み取りのみ。
 * - ServiceDetailSection: ターミナル詳細シミュレーション（serviceDetailSim）の独立実行と
 *   店舗別実績・同一指標での集約表示。結果は表示・比較専用で、運航や会社データへは反映しない。
 * - ラウンジは 2A でエリア種別として実装済みで、集約 profile が席数ベースの実値を返すため、
 *   他のカテゴリと同じ通常行として描画する。根拠のない値（滞在・売上・平均）は未算出として区別する。
 * - 運営モードの実績は、ラウンジだけが詳細・集約の両方式で同じ usage マップへ記録される
 *   （店舗・飲食は集約方式のみ）。詳細方式ではラウンジ行だけを抜き出して出す。
 *   満席フォールバック人数（skipped）は集約方式でしか数えられない非対称性がある。
 *   満足度への換算係数（BALANCE.lounge）は暫定値で、満足度式には未接続（参考指標）。
 */

export const SERVICE_CATEGORY_LABEL: Record<ServiceCategory, string> = {
  retail: '物販',
  dining: '飲食',
  lounge: 'ラウンジ',
  waiting: '待合',
};

const STATUS_LABEL: Record<ServiceCategoryStatus, string> = {
  available: '利用可能',
  notOperational: '運航外',
  notConfigured: '未設置',
};

const fmt = (n: number | null, digits = 0): string => (n === null ? '未算出' : n.toLocaleString('ja-JP', { maximumFractionDigits: digits }));
const fmtSec = (sec: number | null): string => (sec === null ? '未算出' : sec >= 120 ? `${fmt(sec / 60, 1)} 分` : `${fmt(sec)} 秒`);
const avg = (total: number, users: number): number | null => (users > 0 ? total / users : null);

/** ラウンジ実績の前提（購買カテゴリでない・満足度換算は暫定で評価へ未反映）を両粒度で共通に示す脚注 */
const LOUNGE_SATISFACTION_NOTE =
  'ラウンジは購買カテゴリではないため売上はありません。満足度への換算係数は暫定値で、航空会社の満足度・空港評価にはまだ反映されません（参考指標です）。';

/**
 * 運航中実績からラウンジ行だけを抜き出す純関数（`${terminalId}|lounge` キー）。
 * ラウンジは詳細・集約の両方式で記録される唯一のカテゴリで、詳細方式の表示に使う。
 */
export function loungeUsageRows(liveUsage: ReadonlyMap<string, ServiceCategoryUsage> | null): { terminalId: string; usage: ServiceCategoryUsage }[] {
  if (!liveUsage) return [];
  return [...liveUsage.entries()]
    .filter(([key]) => key.endsWith('|lounge'))
    .map(([key, usage]) => ({ terminalId: key.slice(0, -'|lounge'.length), usage }))
    .sort((a, b) => (a.terminalId < b.terminalId ? -1 : 1));
}

/** 空港運営モードの店舗粒度の切替（⚙ メニューに置く） */
export function ServiceGranularitySelect() {
  const granularity = useEditor((s) => s.serviceGranularity);
  return (
    <label className="small">
      店舗シミュレーション粒度
      <select
        value={granularity}
        onChange={(e) => setServiceGranularity(e.target.value as ServiceGranularity)}
        data-testid="setting-service-granularity"
        title="空港運営モードで店舗利用を計算する粒度。集約=カテゴリ×ターミナルで計算（既定・大規模空港向け）、詳細=店舗ごとに経路・待ちを計算（従来方式）。次回の運航開始から適用され、プロジェクトには保存されません"
      >
        <option value="detailed">詳細（店舗ごと）</option>
        <option value="aggregate">集約（カテゴリ×ターミナル）</option>
      </select>
    </label>
  );
}

export function ServiceProfileSection({
  layout,
  liveGranularity,
  liveUsage,
}: {
  layout: AirportLayout;
  /** 運航中の sim の粒度。運航していないときは null */
  liveGranularity: ServiceGranularity | null;
  /** 運航中のカテゴリ実績（serviceAggregateUsage の読み取り結果。詳細方式ではラウンジ行だけが立つ） */
  liveUsage: ReadonlyMap<string, ServiceCategoryUsage> | null;
}) {
  const profiles = useMemo(() => serviceProfilesFor(layout), [layout]);
  const terminalName = (id: string): string => layout.facilities[id]?.name ?? id;
  const usageRows = liveUsage ? [...liveUsage.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) : [];
  return (
    <section data-testid="service-profile">
      <h4>店舗・サービス施設（カテゴリ×ターミナルの集約）</h4>
      <p className="muted small">
        個別の店舗・飲食・待合エリアから導出した集約プロファイルです（台帳は個別施設が正本で、ここは表示専用）。
        空港運営モードの「集約」粒度はこの単位で店舗利用を計算します。価格帯・サービス品質は算出根拠がないため未算出のままにしています。
      </p>
      {profiles.terminals.length === 0 && <p className="muted">ターミナルがありません。</p>}
      {profiles.terminals.map((terminalId) => (
        <div key={terminalId} data-testid={`service-profile-${terminalId}`}>
          <h5>{terminalName(terminalId)}</h5>
          <div className="capacity-table-scroll">
            <table className="board">
              <thead>
                <tr><th>カテゴリ</th><th>状態</th><th>施設数</th><th>処理能力</th><th>収容人数</th><th>滞在（根拠値）</th><th>売上/人（根拠値）</th><th>区域内訳</th></tr>
              </thead>
              <tbody>
                {SERVICE_CATEGORIES.map((category) => {
                  const p = profiles.byTerminalCategory.get(`${terminalId}|${category}`)!;
                  return (
                    <tr key={category} data-testid={`service-profile-${terminalId}-${category}`}>
                      <td>{SERVICE_CATEGORY_LABEL[category]}</td>
                      <td>{STATUS_LABEL[p.status]}</td>
                      <td>{p.operationalFacilityCount} / {p.facilityCount} 件</td>
                      <td>{fmt(p.totalCapacity)}</td>
                      <td>{fmt(p.totalAreaCapacity)} 人</td>
                      <td>{fmtSec(p.dwellSec)}</td>
                      <td>{p.spendPerPax === null ? '未算出' : `${fmt(p.spendPerPax)} cr`}</td>
                      <td className="capacity-explain">
                        {p.byZone.length === 0 ? '—' : p.byZone.map((z) => `${ZONE_LABEL[z.zone].replace(/（.*）/, '')} ${z.facilityCount}件・能力${fmt(z.totalCapacity)}`).join('、')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="muted small">ラウンジの処理能力は席数です。待合は購買カテゴリではないため、滞在・売上は未算出です。</p>
      {liveGranularity === 'aggregate' && liveUsage ? (
        <div data-testid="service-usage">
          <h5>運航中の集約実績（カテゴリ×ターミナル）</h5>
          {usageRows.length === 0 ? (
            <p className="muted small">まだ店舗利用の実績がありません。</p>
          ) : (
            <div className="capacity-table-scroll">
              <table className="board">
                <thead><tr><th>ターミナル</th><th>カテゴリ</th><th>利用者</th><th>グループ</th><th>平均滞在</th><th>売上</th><th>立寄り見送り</th></tr></thead>
                <tbody>
                  {usageRows.map(([key, u]) => {
                    const [terminalId, category] = key.split('|') as [string, ServiceCategory];
                    return (
                      <tr key={key} data-testid={`service-usage-${terminalId}-${category}`}>
                        <td>{terminalName(terminalId)}</td>
                        <td>{SERVICE_CATEGORY_LABEL[category] ?? category}</td>
                        <td>{fmt(u.users)} 人</td>
                        <td>{fmt(u.groups)}</td>
                        <td>{fmtSec(avg(u.dwellPaxSec, u.users))}</td>
                        <td>{fmt(u.revenue)} cr</td>
                        <td>{fmt(u.skipped)} 人</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">空港運営モード（集約粒度）で運航中の実績です。詳細粒度の店舗別実績と同じ指標定義で集約しています。</p>
          <p className="muted small">{LOUNGE_SATISFACTION_NOTE}</p>
        </div>
      ) : liveGranularity === 'detailed' ? (
        <div data-testid="service-usage-detailed">
          <p className="muted small">
            詳細粒度で運航中のため、店舗・飲食のカテゴリ集約の実績は記録されません（店舗別の実績は下の「ターミナル詳細シミュレーション」で確認できます）。
            ラウンジだけは詳細・集約の両粒度で記録されるため、実績があれば下に出ます。
          </p>
          {loungeUsageRows(liveUsage).length > 0 && (
            <div data-testid="service-usage-lounge-detailed">
              <h5>運航中のラウンジ実績（詳細粒度）</h5>
              <div className="capacity-table-scroll">
                <table className="board">
                  <thead><tr><th>ターミナル</th><th>利用者</th><th>グループ</th><th>平均滞在</th></tr></thead>
                  <tbody>
                    {loungeUsageRows(liveUsage).map(({ terminalId, usage: u }) => (
                      <tr key={terminalId} data-testid={`service-usage-${terminalId}-lounge`}>
                        <td>{terminalName(terminalId)}</td>
                        <td>{fmt(u.users)} 人</td>
                        <td>{fmt(u.groups)}</td>
                        <td>{fmtSec(avg(u.dwellPaxSec, u.users))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                詳細粒度では、満席時の待合フォールバック人数は数えられません（集約粒度でのみ記録されます）。
                ラウンジの実績は運航中のみの表示で、日報には残りません。{LOUNGE_SATISFACTION_NOTE}
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="muted small" data-testid="service-usage-none">
          運航を開始すると、カテゴリ実績がここに表示されます（ラウンジは詳細・集約の両粒度で記録されます）。
        </p>
      )}
    </section>
  );
}

/** 詳細シミュレーションの結果表示（店舗別実績と、同一指標のカテゴリ集約） */
export function ServiceDetailResultView({ layout, result }: { layout: AirportLayout; result: ServiceDetailResult }) {
  const profiles = serviceProfilesFor(layout);
  const categoryOf = new Map(profiles.facilities.map((f) => [f.areaId, f.category]));
  const storeRows = Object.values(result.records).sort((a, b) => (a.areaId < b.areaId ? -1 : 1));
  const areaName = (areaId: string): string => layout.terminalAreas[areaId]?.name ?? areaId;
  const areaKind = (areaId: string): string => {
    const kind = layout.terminalAreas[areaId]?.kind;
    return kind ? (AREA_KIND_LABEL[kind] ?? kind) : '';
  };
  const terminalRows = result.aggregated.byTerminal.get(result.terminalId) ?? [];
  return (
    <div data-testid="service-detail-result">
      <p>
        生成 {fmt(result.spawnedPax)} 人（{fmt(result.spawnedGroups)} グループ） · 搭乗口到達 {fmt(result.boarded)} 人
        · 期限後到達 {fmt(result.boardedLate)} 人 · 完了できなかった {fmt(result.failed)} 人 · 未完了 {fmt(result.unfinished)} 人
        · 店舗立寄りの見送り {fmt(result.shopSkipped)} 人
        · ラウンジ見送り（候補なし/満員/時間不足） {fmt(result.loungeSkipped)} 人
      </p>
      <div data-testid="service-detail-lounge">
        <h5>ラウンジ体験（参考値）</h5>
        <p>
          利用者 {fmt(result.loungeExperience.users)} 人 · 滞在 {fmt(result.loungeExperience.userHours, 1)} 人時
          · 満足度換算ポイント {result.loungeExperience.estimatedSatisfactionPoints === null ? '未算出' : `${fmt(result.loungeExperience.estimatedSatisfactionPoints, 1)} 点`}
        </p>
        <p className="muted small">
          換算は暫定係数（1人時あたり {BALANCE.lounge.satisfactionPerUserHour} 点・上限 {BALANCE.lounge.satisfactionCapPoints} 点）による参考値で、
          空港運営モードの満足度式には接続していません。ラウンジへは搭乗開始まで {BALANCE.lounge.minSlackMin} 分以上の余裕がある旅客だけが立ち寄ります。
        </p>
      </div>
      <p className="muted small">
        実行時間 {fmt(result.durationSec / 3600, 1)} 時間 · seed {result.seed} · 経路探索 {fmt(result.routeStats.calls)} 回
        （キャッシュ命中 {fmt(result.routeStats.cacheHits)}） · tick 処理 p50 {result.tickMs.p50.toFixed(3)} ms / p95 {result.tickMs.p95.toFixed(3)} ms / 最大 {result.tickMs.max.toFixed(3)} ms
      </p>
      <h5>店舗別実績</h5>
      {storeRows.length === 0 ? (
        <p className="muted small">利用実績のある店舗・待合エリアがありませんでした。</p>
      ) : (
        <div className="capacity-table-scroll">
          <table className="board">
            <thead><tr><th>店舗・エリア</th><th>カテゴリ</th><th>利用者</th><th>グループ</th><th>平均待ち</th><th>平均滞在</th><th>売上</th><th>利用できなかった</th></tr></thead>
            <tbody>
              {storeRows.map((r) => (
                <tr key={r.areaId} data-testid={`service-detail-store-${r.areaId}`}>
                  <td>{areaName(r.areaId)}<span className="muted">（{areaKind(r.areaId)}）</span></td>
                  <td>{SERVICE_CATEGORY_LABEL[categoryOf.get(r.areaId) ?? 'waiting']}</td>
                  <td>{fmt(r.users)} 人</td>
                  <td>{fmt(r.groups)}</td>
                  <td>{fmtSec(avg(r.waitPaxSec, r.users))}</td>
                  <td>{fmtSec(avg(r.dwellPaxSec, r.users))}</td>
                  <td>{fmt(r.revenue)} cr</td>
                  <td>{fmt(r.turnedAway)} 人</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h5>カテゴリ集約（同じ指標定義）</h5>
      <div className="capacity-table-scroll">
        <table className="board" data-testid="service-detail-aggregated">
          <thead><tr><th>範囲</th><th>カテゴリ</th><th>利用者</th><th>グループ</th><th>平均待ち</th><th>平均滞在</th><th>売上</th><th>利用できなかった</th></tr></thead>
          <tbody>
            {terminalRows.map((r) => (
              <tr key={`t-${r.category}`} data-testid={`service-detail-agg-terminal-${r.category}`}>
                <td>対象ターミナル</td>
                <td>{SERVICE_CATEGORY_LABEL[r.category]}</td>
                <td>{fmt(r.users)} 人</td>
                <td>{fmt(r.groups)}</td>
                <td>{fmtSec(r.avgWaitSec)}</td>
                <td>{fmtSec(r.avgDwellSec)}</td>
                <td>{fmt(r.revenue)} cr</td>
                <td>{fmt(r.turnedAway)} 人</td>
              </tr>
            ))}
            {result.aggregated.airport.map((r) => (
              <tr key={`a-${r.category}`} data-testid={`service-detail-agg-airport-${r.category}`}>
                <td>空港全体</td>
                <td>{SERVICE_CATEGORY_LABEL[r.category]}</td>
                <td>{fmt(r.users)} 人</td>
                <td>{fmt(r.groups)}</td>
                <td>{fmtSec(r.avgWaitSec)}</td>
                <td>{fmtSec(r.avgDwellSec)}</td>
                <td>{fmt(r.revenue)} cr</td>
                <td>{fmt(r.turnedAway)} 人</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">店舗別の合計とカテゴリ集約は、共通の集約（aggregateServiceRecords）で同じ定義にそろえています。結果は表示・比較専用で、運航中の空港や会社データには反映されません。</p>
    </div>
  );
}

export function ServiceDetailSection({ layout }: { layout: AirportLayout }) {
  const terminals = useMemo(
    () => Object.values(layout.facilities).filter((f) => f.kind === 'terminal').sort((a, b) => (a.id < b.id ? -1 : 1)),
    [layout],
  );
  const [terminalId, setTerminalId] = useState('');
  const [hours, setHours] = useState(2);
  const [groupsPerHour, setGroupsPerHour] = useState(60);
  const [stepFreePct, setStepFreePct] = useState(0);
  const [seed, setSeed] = useState('service-detail');
  const [result, setResult] = useState<ServiceDetailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = terminals.some((t) => t.id === terminalId) ? terminalId : (terminals[0]?.id ?? '');

  const run = () => {
    if (!selected) return;
    const gph = Number.isFinite(groupsPerHour) && groupsPerHour > 0 ? Math.min(2000, Math.floor(groupsPerHour)) : 0;
    if (gph <= 0) {
      setError('出発グループ/時は 1 以上で入力してください');
      setResult(null);
      return;
    }
    try {
      const r = runServiceDetailSim(layout, {
        terminalId: selected,
        durationSec: hours * 3600,
        groupsPerHour: gph,
        stepFreeRatio: Math.min(100, Math.max(0, stepFreePct)) / 100,
        seed: seed.trim() === '' ? 'service-detail' : seed.trim(),
        nowMs: () => performance.now(),
      });
      setResult(r);
      setError(null);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section data-testid="service-detail">
      <h4>ターミナル詳細シミュレーション（店舗別）</h4>
      <p className="muted small">
        対象ターミナルだけを、空港運航とは独立した時計・seed で実行します。入口 → チェックイン → 保安 → 店舗立寄り → 待合 → 搭乗口の流れを店舗ごとに計算し、
        店舗別の利用・待ち・滞在・売上を記録します。運航・会社・保存データには一切影響しません。
      </p>
      {terminals.length === 0 ? (
        <p className="muted">ターミナルがありません。</p>
      ) : (
        <>
          <div className="capacity-form">
            <label>対象ターミナル
              <select value={selected} onChange={(e) => setTerminalId(e.target.value)} data-testid="service-detail-terminal">
                {terminals.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label>実行時間
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))} data-testid="service-detail-duration">
                <option value={1}>1 時間</option>
                <option value={2}>2 時間</option>
                <option value={4}>4 時間</option>
              </select>
            </label>
            <label>出発グループ/時
              <input type="number" min={1} max={2000} value={groupsPerHour} onChange={(e) => setGroupsPerHour(Number(e.target.value))} data-testid="service-detail-groups" />
            </label>
            <label>Step-free 比率 %
              <input type="number" min={0} max={100} value={stepFreePct} onChange={(e) => setStepFreePct(Number(e.target.value))} data-testid="service-detail-stepfree" />
            </label>
            <label>seed
              <input type="text" value={seed} onChange={(e) => setSeed(e.target.value)} data-testid="service-detail-seed" />
            </label>
            <button onClick={run} data-testid="service-detail-run">実行</button>
          </div>
          {error && <p className="ng-text" data-testid="service-detail-error">{error}</p>}
          {result && <ServiceDetailResultView layout={layout} result={result} />}
        </>
      )}
    </section>
  );
}
