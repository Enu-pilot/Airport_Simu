import { useMemo } from 'react';
import { ACCESS_MODES, analyzeAccess } from '../core/access/model';
import { connectionMatrix, type ConnectionMatrixRow } from '../core/terminal/connectionMatrix';
import { BALANCE } from '../core/economy/balance';
import { cityDemandCeiling } from '../core/economy/city';
import { constructionCost as constructionCostOf, layoutValue, scaleFactor } from '../core/economy/construction';
import { analyzeDayPlan, planDayWithDemand } from '../core/economy/planning';
import { routeCapabilitiesForAirport } from '../core/economy/registry';
import { applyCompletedProjects } from '../core/economy/expansion';
import { sortedValues } from '../core/model/ids';
import { Terrain } from '../core/model/types';
import { setBuildState } from '../core/layout/operations';
import { createContext } from '../core/sim/context';
import { companyActions } from '../editor/simRunner';
import { applyOp, editorStore, formatCr, useEditor, useLayout } from '../editor/store';
import { focusEntity } from '../editor/input';
import { useCompany } from './ManagementPanels';
import {
  ACCESS_MODE_LABEL,
  ACCESS_UNAVAILABLE_LABEL,
  GAME_UI,
  PLAN_ISSUE_LABEL,
  PROJECT_KIND_LABEL,
  displayName,
} from '../i18n/ja';

/**
 * 空港アクセス・拡張計画のパネル（docs/15_access_rules.md）。
 */

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

const connLabel = (s: ConnectionMatrixRow['toEntrance']): string =>
  s === 'operational' ? '○ 接続済み' : s === 'underConstruction' ? '△ 完成待ち' : s === 'noPortal' ? 'Portalなし（徒歩判定）' : '× 未接続';

export function AccessPanel() {
  const c = useCompany();
  const layout = useLayout();
  useEditor((s) => s.ops?.uiVersion ?? -1);
  const live = editorStore.getState().ops?.sim.state.access ?? null;
  const a = useMemo(() => analyzeAccess(layout, { fees: c.fees, feedback: c.accessFeedback, city: c.city, day: c.day }), [layout, c.fees, c.accessFeedback, c.city, c.day]);
  const matrix = useMemo(() => connectionMatrix(layout, a), [layout, a]);
  const fb = c.accessFeedback;
  return (
    <div className="issues mgmt" data-testid="access-panel">
      <div className="issues-header">
        <strong>空港アクセス</strong>
        <span data-testid="access-factor" title="旅客の需要（搭乗率）に掛かる係数。0.3〜1.1">アクセス係数 ×{a.factor.toFixed(2)}</span>
        <span>一般車の出入口 {a.entrances}か所</span>
        {c.city
          ? <span data-testid="city-demand">{GAME_UI.cityType[c.city.type]}・人口 {Math.round(c.city.population).toLocaleString('ja-JP')}人・需要上限 {Math.round(cityDemandCeiling(c.city, a.factor)).toLocaleString('ja-JP')}人/日・道路/鉄道 {c.city.roadQuality}/{c.city.railQuality}</span>
          : <span data-testid="city-demand-off" className="muted">都市連動なし（従来の需要計算）</span>}
        <span className="muted">交通手段の選択はゲーム用の簡易モデル（所要時間・運賃・容量・接続で分担率が変わる）</span>
      </div>
      <div className="issues-list mgmt-grid">
        <section>
          <h4>手段ごとの状況（次の運航日の見込み）</h4>
          <table className="board" data-testid="access-modes">
            <thead>
              <tr>
                <th>手段</th>
                <th>利用</th>
                <th>分担率</th>
                <th>所要時間</th>
                <th>うち徒歩・待ち・混雑</th>
                <th>運賃</th>
                <th>処理能力</th>
              </tr>
            </thead>
            <tbody>
              {ACCESS_MODES.map((m) => {
                const x = a.modes[m];
                return (
                  <tr key={m} data-testid={`mode-${m}`}>
                    <td>{ACCESS_MODE_LABEL[m]}</td>
                    <td className={x.available ? '' : 'ng-text'}>{x.available ? '○' : `× ${ACCESS_UNAVAILABLE_LABEL[x.reason!]}`}</td>
                    <td className="num">{x.available ? pct(x.share) : '—'}</td>
                    <td className="num">{x.available ? `${x.timeMin}分` : ''}</td>
                    <td className="num muted">{x.available ? `${x.walkMin} / ${x.waitMin} / ${x.delayMin}分` : ''}</td>
                    <td className="num">{x.available ? formatCr(x.fare) : ''}</td>
                    <td className="num">{x.capacityPerHour !== null ? `${x.capacityPerHour}人/時` : m === 'car' ? `${a.parkingSpaces}台` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="muted small">
            道路 {a.roadCapacityPerHour}台/時・車寄せ {a.curbCapacityPerHour}台/時・バス {a.busesPerHour}便/時・列車 {a.trainsPerHour}本/時・タクシー乗車枠 {a.taxiBerths}
          </div>
          <div className="muted small">
            前日の混雑: 道路の遅れ {fb.roadDelayMin}分・車寄せ {fb.curbDelayMin}分・駐車場の満車率 {pct(fb.parkingFullRate)}
            {Object.entries(fb.waitMin).map(([m, v]) => `・${ACCESS_MODE_LABEL[m as keyof typeof ACCESS_MODE_LABEL]}待ち ${v}分`).join('')}
          </div>

          <h4>職員・周辺施設</h4>
          <table className="board">
            <tbody>
              <tr className={a.staffSpaces < a.staffSpacesNeeded ? 'warn-row' : ''}>
                <td>職員用駐車場</td>
                <td className="num" data-testid="staff-parking">
                  {a.staffSpaces} / 必要 {a.staffSpacesNeeded}台（職員 {a.staff}人 × {BALANCE.accessModel.staffParkingPerStaff}）
                </td>
                <td className="muted">不足 1台あたり 通勤対策費 {formatCr(BALANCE.daily.staffCommutePerMissing)}/日</td>
              </tr>
              <tr>
                <td>空港ホテル</td>
                <td className="num">{a.hotelRooms}室</td>
                <td className="muted">宿泊客が歩いて来る（徒歩の分担率）・客室収入</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h4>接続マトリクス（施設 × 方向）</h4>
          <table className="board" data-testid="connection-matrix">
            <thead>
              <tr>
                <th>施設</th>
                <th>手段</th>
                <th>外部への接続</th>
                <th>入口へ（来港）</th>
                <th>出口から（帰宅）</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((r) => (
                <tr key={r.facilityId} data-testid={`matrix-${r.facilityId}`}>
                  <td>{displayName(layout, r.facilityId)}</td>
                  <td>{r.mode ? ACCESS_MODE_LABEL[r.mode] : '—'}</td>
                  <td className={r.outside === 'connected' ? '' : 'ng-text'}>
                    {r.outside === 'connected' ? '○ 接続' : r.outside === 'notOperational' ? '工事中・運休' : `× ${ACCESS_UNAVAILABLE_LABEL[(r.outsideReason ?? 'notConnected') as keyof typeof ACCESS_UNAVAILABLE_LABEL] ?? '未接続'}`}
                  </td>
                  <td className={r.toEntrance === 'operational' ? '' : 'ng-text'}>{connLabel(r.toEntrance)}</td>
                  <td className={r.fromExit === 'operational' ? '' : 'ng-text'}>{connLabel(r.fromExit)}</td>
                </tr>
              ))}
              {matrix.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">交通施設（駅・バスターミナル・バス停・タクシー乗場・駐車場）がありません</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="muted small">ターミナル側は Portal の到達性で判定します。Portal がない施設は徒歩距離による従来の判定です。</div>
        </section>

        <section>
          <h4>交通の料金（基準に対する倍率）</h4>
          <div className="fee-grid">
            {(
              [
                ['carPark', `駐車料金（基準 ${formatCr(BALANCE.carPark.feePerCar)}/台）`],
                ['taxi', `タクシー使用料（${BALANCE.accessFees.taxi}/人）`],
                ['bus', `バス使用料（${BALANCE.accessFees.bus}/人）`],
                ['rail', `駅の使用料（${BALANCE.accessFees.rail}/人）`],
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
          <div className="muted small">使用料は旅客の運賃に上乗せされる。上げると収入は増えるが、その手段が選ばれにくくなり、アクセス係数（需要）も下がる。</div>

          {live && (
            <>
              <h4>運航中の実績（当日）</h4>
              <table className="board" data-testid="access-live">
                <tbody>
                  {ACCESS_MODES.map((m) => (
                    <tr key={m}>
                      <td>{ACCESS_MODE_LABEL[m]}</td>
                      <td className="num">{live.stats.pax[m]}人</td>
                      <td className="muted">{m === 'taxi' || m === 'bus' || m === 'rail' ? `乗り場で待機 ${live.queues[m].length}組` : ''}</td>
                    </tr>
                  ))}
                  <tr className={live.stats.parkingFull > 0 ? 'warn-row' : ''}>
                    <td>駐車場</td>
                    <td className="num" data-testid="parking-live">
                      {live.parked.length} / {live.parkingSpaces}台
                    </td>
                    <td className="muted">満車で停められなかった {live.stats.parkingFull}組</td>
                  </tr>
                  <tr>
                    <td>道路の平均遅れ</td>
                    <td className="num">{live.stats.roadDelayN > 0 ? Math.round((live.stats.roadDelaySum / live.stats.roadDelayN) * 10) / 10 : 0}分</td>
                    <td className="muted">バス・鉄道の満員で次の便へ {live.stats.transitFull}組</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 拡張計画

export function ExpansionPanel() {
  const c = useCompany();
  const layout = useLayout();
  const mode = useEditor((s) => s.mode);
  const projects = sortedValues(c.projects);
  const planned = [
    ...Object.values(layout.runways),
    ...Object.values(layout.taxiways),
    ...Object.values(layout.roads),
    ...Object.values(layout.stands),
    ...Object.values(layout.facilities),
  ].filter((e) => e.buildState === 'planned');
  const plannedIds = planned.map((e) => e.id);
  const startAll = setBuildState(layout, 'operational', plannedIds);
  const plannedCost = startAll.ok ? constructionCostOf(layout, startAll.layout) : 0;

  // 工事の影響: いまの配置と、工事がすべて終わった配置で、次の運航日の計画を比べる
  const impact = useMemo(() => {
    const access = analyzeAccess(layout, { fees: c.fees, feedback: c.accessFeedback, city: c.city, day: c.day }).factor;
    const now = analyzeDayPlan(planDayWithDemand(c, c.day, access, undefined, routeCapabilitiesForAirport(layout.countryId)), createContext(layout));
    const clone = structuredClone(c);
    for (const p of Object.values(clone.projects)) p.remaining = 0;
    const after = applyCompletedProjects(clone, layout) ?? layout;
    const afterAccess = analyzeAccess(after, { fees: c.fees, feedback: c.accessFeedback, city: c.city, day: c.day }).factor;
    const later = analyzeDayPlan(planDayWithDemand(c, c.day, afterAccess, undefined, routeCapabilitiesForAirport(after.countryId)), createContext(after));
    const ops = (l: typeof layout) => ({
      runways: Object.values(l.runways).filter((r) => r.buildState === 'operational').length,
      stands: Object.values(l.stands).filter((s) => s.buildState === 'operational').length,
    });
    return { now, later, opsNow: ops(layout), opsLater: ops(after), access, afterAccess };
  }, [layout, c]);

  const owned = layout.site.terrain.filter((t) => t !== Terrain.offsite).length;
  const scale = scaleFactor(layout);
  return (
    <div className="issues mgmt" data-testid="expansion-panel">
      <div className="issues-header">
        <strong>拡張計画</strong>
        <span>資産額 {formatCr(layoutValue(layout))}</span>
        <span title="空港の規模による建設費・維持費の割増">規模係数 ×{scale.toFixed(2)}</span>
        <span>
          敷地 {owned.toLocaleString('ja-JP')}タイル（購入 {layout.site.purchased ?? 0}）・土地 {formatCr(BALANCE.construction.landPerTile * scale)}/タイル
        </span>
      </div>
      <div className="issues-list mgmt-grid">
        <section>
          <h4>工事中{c.mode === 'sandbox' ? '（サンドボックスは工期なし）' : ''}</h4>
          <table className="board" data-testid="projects">
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} onClick={() => focusEntity(p.id)} data-testid={`project-${p.id}`}>
                  <td>{displayName(layout, p.id)}</td>
                  <td>{PROJECT_KIND_LABEL[p.kind]}</td>
                  <td className="num">{p.remaining > 0 ? `残り ${p.remaining}日 / ${p.days}日` : '完了（運航終了時に運用開始）'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {projects.length === 0 && <div className="empty">工事はありません</div>}
          <div className="muted small">
            キャリアでは、新設は工期を待ってから使える。運用中の施設を移設・延長・拡幅すると改修工事になり、そのあいだ閉鎖される。工期は運航した日ごとに進む。
          </div>

          <h4>計画中（未着工）</h4>
          <div className="muted small">
            {planned.length}件（{planned.slice(0, 6).map((e) => displayName(layout, e.id)).join('、')}
            {planned.length > 6 ? ' ほか' : ''}）・着工すると {formatCr(plannedCost)}
          </div>
          <button disabled={planned.length === 0 || mode === 'operate'} onClick={() => startAll.ok && applyOp(startAll)} data-testid="start-planned">
            計画中の施設をすべて着工
          </button>
        </section>

        <section>
          <h4>工事の影響（{c.day + 1}日目の運航計画）</h4>
          <table className="board" data-testid="impact">
            <thead>
              <tr>
                <th></th>
                <th>現在</th>
                <th>工事完了後</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>運用中の滑走路・スポット</td>
                <td className={impact.opsNow.runways === 0 ? 'ng-text' : ''}>
                  {impact.opsNow.runways}本・{impact.opsNow.stands}か所
                </td>
                <td>
                  {impact.opsLater.runways}本・{impact.opsLater.stands}か所
                </td>
              </tr>
              <tr>
                <td>アクセス係数</td>
                <td>×{impact.access.toFixed(2)}</td>
                <td>×{impact.afterAccess.toFixed(2)}</td>
              </tr>
              {Object.keys(PLAN_ISSUE_LABEL).map((code) => {
                const n = (x: typeof impact.now) => x.issues.filter((i) => i.code === code).reduce((s, i) => s + i.keys.length, 0);
                const a = n(impact.now);
                const b = n(impact.later);
                if (a === 0 && b === 0) return null;
                return (
                  <tr key={code}>
                    <td>{PLAN_ISSUE_LABEL[code as keyof typeof PLAN_ISSUE_LABEL]}</td>
                    <td className={a > 0 ? 'ng-text' : ''}>{a}件</td>
                    <td>{b}件</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {impact.opsNow.runways === 0 && <div className="ng-text small">運用中の滑走路がありません。工事中は便が着陸できず、ダイバート・欠航になります</div>}
        </section>
      </div>
    </div>
  );
}
