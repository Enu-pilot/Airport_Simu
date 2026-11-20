import { useMemo } from 'react';
import { analyzeAccess } from '../core/access/model';
import { basedConditionDetails } from '../core/economy/basedConditions';
import { BALANCE } from '../core/economy/balance';
import { analyzeAirportCapacity, type AirportCapacitySnapshot } from '../core/economy/capacity';
import { contractsOf, type CompanyState } from '../core/economy/company';
import type { BankWindow, HubSettings } from '../core/economy/phase4Types';
import { nextTierProgress, TIER_NAMES } from '../core/economy/goals';
import { connectionQuality, DEFAULT_MAX_CONNECT_MIN, hubChoiceShare } from '../core/economy/hub';
import { planDayWithDemand, type DayPlan } from '../core/economy/planning';
import { airlineDef, destinationDef, routeCapabilitiesForAirport } from '../core/economy/registry';
import { effectiveTier, featureOn, isUnlocked, lockLabel, UNLOCKS, type FeatureId } from '../core/economy/unlocks';
import { overnightReadings } from '../core/capability';
import { createContext } from '../core/sim/context';
import { AIRCRAFT_TYPES, resolveType } from '../core/sim/aircraftTypes';
import { areaProcessingPerHour } from '../core/terminal/capacity';
import type { TransferKind } from '../core/terminal/hub';
import { editorStore, useEditor, useLayout } from '../editor/store';
import { companyActions } from '../editor/simRunner';
import { AREA_KIND_LABEL, CONTRACT_KIND_LABEL, FOLLOWUP_UI, GAME_UI, PHASE7B_UI, formatClock, formatMinute } from '../i18n/ja';
import { NumberInput } from './fields';
import { useCompany } from './ManagementPanels';

/**
 * 乗継・拠点ボード（UIデザイン更新 第3段階・計画書 §6）。
 * ハブと based はバックエンド実装済みだが UI が薄く見えなかったため、
 * 解放前の要件・接続ペアの見込み・拠点契約の条件・常駐機をここに集約する。
 * すべて表示専用: 計画は既存の計画生成（planDayWithDemand + analyzeAirportCapacity、
 * CapacityPanel と同じ手順）を読み取るだけで、sim の計算・判定は変えない。
 */

const FEATURE_LABEL: Record<FeatureId, string> = {
  overnight: '夜間滞泊',
  based: '拠点航空会社',
  maintenance: '整備',
  international: '国際線',
  hub: '乗継・ハブ',
  cargo: '貨物',
};

const TRANSFER_KIND_LABEL: Record<TransferKind, string> = {
  DD: '国内→国内',
  DI: '国内→国際',
  ID: '国際→国内',
  II: '国際→国際',
};

export interface ConnectionPairRow {
  arrKey: string;
  depKey: string;
  arrNumber: string;
  depNumber: string;
  /** 到着便の相手都市（乗継の出発地） */
  fromName: string;
  /** 出発便の行き先（最終目的地） */
  toName: string;
  arrAt: number;
  depAt: number;
  kind: TransferKind;
  pax: number;
  /** 接続時間（分） */
  gapMin: number;
  /** その種類の空港 MCT（分）。接続不可の種類は null */
  mctMin: number | null;
  /** MCT からの余裕（分） */
  marginMin: number | null;
  /** 接続品質（0〜1。connectionQuality と同じ定義） */
  quality: number | null;
  /** 直行競合の採用率（0〜1。OD 単位で hubChoiceShare を表示側計算。人数には反映済み） */
  choiceShare: number;
}

/**
 * 計画便の connections（analyzeAirportCapacity が planConnections で付けた結果）を
 * 接続ペアの一覧に写す純関数。計画を作り直さず、付けられた結果を読むだけ。
 */
export function connectionPairRows(plan: DayPlan, mctMin: AirportCapacitySnapshot['hub']['mctMin']): ConnectionPairRow[] {
  const byKey = new Map(plan.flights.map((f) => [f.key, f]));
  const rows: ConnectionPairRow[] = [];
  for (const a of plan.flights) {
    for (const cn of a.connections ?? []) {
      const d = byKey.get(cn.depKey);
      if (!d) continue;
      const gapSec = d.departureAt - a.arrivalAt;
      const mct = mctMin[cn.kind].max;
      rows.push({
        arrKey: a.key,
        depKey: d.key,
        arrNumber: a.arrNumber,
        depNumber: d.depNumber,
        fromName: destinationDef(a.destinationId).name,
        toName: destinationDef(d.destinationId).name,
        arrAt: a.arrivalAt,
        depAt: d.departureAt,
        kind: cn.kind,
        pax: cn.pax,
        gapMin: Math.round(gapSec / 60),
        mctMin: mct,
        marginMin: mct !== null ? Math.round(gapSec / 60 - mct) : null,
        quality: mct !== null ? connectionQuality(gapSec, mct * 60) : null,
        choiceShare: hubChoiceShare(destinationDef(a.destinationId), destinationDef(d.destinationId)),
      });
    }
  }
  return rows.sort((x, y) => y.pax - x.pax || (x.arrKey < y.arrKey ? -1 : x.arrKey > y.arrKey ? 1 : 0) || (x.depKey < y.depKey ? -1 : x.depKey > y.depKey ? 1 : 0));
}

function FeatureUnlocks() {
  const company = useCompany();
  const tier = effectiveTier(company);
  const progress = nextTierProgress(company);
  return (
    <section data-testid="feature-unlocks">
      <h4>機能の解放状況</h4>
      <p className="muted small">解放は空港の格で決まります。解放済みでも、機能ごとに有効化（新規ゲーム設定／難易度・ルール）するまで動きません。不足分は数値で示します。</p>
      <table className="board">
        <thead>
          <tr><th>機能</th><th>必要な格</th><th>現在の格</th><th>状態</th><th>解放されるもの</th></tr>
        </thead>
        <tbody>
          {UNLOCKS.map((u) => {
            const unlocked = isUnlocked(company, u.feature);
            const on = featureOn(company, u.feature);
            const contents = [
              ...(u.areaKinds ?? []).map((k) => `エリア: ${AREA_KIND_LABEL[k]}`),
              ...(u.contractKinds ?? []).map((k) => `契約: ${CONTRACT_KIND_LABEL[k]}`),
              ...(u.settings ?? []).length > 0 ? ['会社の設定'] : [],
            ];
            return (
              <tr key={u.feature} data-testid={`feature-row-${u.feature}`}>
                <td>{FEATURE_LABEL[u.feature]}</td>
                <td>格 {u.tier}（{TIER_NAMES[u.tier]}）</td>
                <td>格 {tier}（{TIER_NAMES[tier]}）</td>
                <td data-testid={`feature-state-${u.feature}`}>
                  {!unlocked ? (
                    <span className="warn-text">{lockLabel(company, u.feature)}（あと {u.tier - tier} 格）</span>
                  ) : on ? (
                    <span className="ok-text">解放済み・有効</span>
                  ) : (
                    <span className="warn-text">解放済み・未有効化</span>
                  )}
                </td>
                <td className="muted">{u.feature === 'maintenance' ? '拠点の有効化に含まれる' : contents.join(' / ') || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {progress && progress.next !== null && (
        <div className="muted small" data-testid="feature-next-tier">
          次の格（{TIER_NAMES[progress.next]}）の要件:
          {progress.items
            .filter((i) => i.required !== null && i.current !== null)
            .map((i) => {
              const label = { movements: GAME_UI.nextTierMovements, pax: GAME_UI.nextTierPax, rating: GAME_UI.nextTierRating }[i.key as 'movements' | 'pax' | 'rating'] ?? i.key;
              return ` ${label} ${i.current}/${i.required}${i.met ? ' ✓' : `（あと ${i.shortfall}）`}`;
            })
            .join('・')}
          {progress.streak ? ` / ${GAME_UI.nextTierStreak(progress.streak.current, progress.streak.required)}` : ''}
          {progress.reportDay !== null ? `（${GAME_UI.nextTierBasedOn(progress.reportDay)}）` : `（${GAME_UI.nextTierNoReport}）`}
        </div>
      )}
    </section>
  );
}

const NO_CLOSED_GATES: readonly string[] = [];

const timeInputValue = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`;
const parseTimeInput = (v: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]);
  return total >= 0 && total <= 1440 ? total : null;
};

/**
 * ハブ設定の編集（UIデザイン更新 第7段階b・第3段階の残件）。
 * 保存先は company.hub（companyActions.setHubSettings が project 検証の受ける形に正規化して保存）。
 * 反映は既存経路: 接続計画（hub.maxConnectMin）と能力スナップショットのバンク統計（banks）。
 * 第5段階の日報 hubOd は記録済みの計画配分なので、この編集で過去分は変わらない。
 */
export function HubSettingsEditor({ company }: { company: CompanyState }) {
  const hub: HubSettings = company.hub ?? { banks: [], maxConnectMin: DEFAULT_MAX_CONNECT_MIN };
  const commit = (next: HubSettings) => companyActions.setHubSettings(next);
  const setBankField = (id: string, field: keyof Omit<BankWindow, 'id'>, v: string) => {
    const min = parseTimeInput(v);
    if (min === null) return;
    commit({ ...hub, banks: hub.banks.map((b) => (b.id === id ? { ...b, [field]: min } : b)) });
  };
  const addBank = () => {
    const nextId = `bank_${Math.max(0, ...hub.banks.map((b) => Number.parseInt(b.id.replace(/\D/g, ''), 10) || 0)) + 1}`;
    commit({ ...hub, banks: [...hub.banks, { id: nextId, arriveFromMin: 360, arriveToMin: 540, departFromMin: 570, departToMin: 720 }] });
  };
  const timeField = (b: BankWindow, field: keyof Omit<BankWindow, 'id'>, testid: string) => (
    <input type="time" value={timeInputValue(b[field])} onChange={(e) => setBankField(b.id, field, e.target.value)} data-testid={testid} />
  );
  return (
    <div data-testid="hub-settings-edit">
      <h5>{PHASE7B_UI.hubSettingsEdit}</h5>
      <label>
        {PHASE7B_UI.hubMaxConnect}{' '}
        <NumberInput value={hub.maxConnectMin} onCommit={(v) => commit({ ...hub, maxConnectMin: v })} testid="hub-max-connect" min={1} max={1440} />
      </label>
      {hub.banks.map((b) => (
        <div key={b.id} className="hub-bank-row" data-testid={`hub-bank-${b.id}`}>
          <span>{PHASE7B_UI.hubBankArrive}</span>
          {timeField(b, 'arriveFromMin', `hub-bank-${b.id}-arrive-from`)}
          <span>〜</span>
          {timeField(b, 'arriveToMin', `hub-bank-${b.id}-arrive-to`)}
          <span>{PHASE7B_UI.hubBankDepart}</span>
          {timeField(b, 'departFromMin', `hub-bank-${b.id}-depart-from`)}
          <span>〜</span>
          {timeField(b, 'departToMin', `hub-bank-${b.id}-depart-to`)}
          <button className="small danger" onClick={() => commit({ ...hub, banks: hub.banks.filter((x) => x.id !== b.id) })} data-testid={`hub-bank-remove-${b.id}`}>
            {PHASE7B_UI.hubBankRemove}
          </button>
        </div>
      ))}
      <button className="small" onClick={addBank} data-testid="hub-bank-add">{PHASE7B_UI.hubBankAdd}</button>
      <div className="muted small">{PHASE7B_UI.hubSettingsNote}</div>
    </div>
  );
}

export function HubPanel() {
  const company = useCompany();
  const layout = useLayout();
  useEditor((s) => s.ops?.uiVersion ?? -1);
  const ctx = useMemo(() => createContext(layout), [layout]);
  const access = analyzeAccess(layout, { fees: company.fees, feedback: company.accessFeedback, city: company.city, day: company.day });
  const closedGates = editorStore.getState().ops?.sim.state.closures.gates ?? NO_CLOSED_GATES;
  const plan = useMemo(
    () => planDayWithDemand(company, company.day, access.factor, ctx.types, routeCapabilitiesForAirport(layout.countryId)),
    [company, access.factor, ctx, layout.countryId],
  );
  const snapshot = useMemo(() => analyzeAirportCapacity(company, ctx, closedGates, plan), [company, ctx, closedGates, plan]);
  const pairs = useMemo(() => connectionPairRows(snapshot.plan, snapshot.hub.mctMin), [snapshot]);
  const hubUnlocked = isUnlocked(company, 'hub');
  const hubOn = featureOn(company, 'hub');
  const basedOn = featureOn(company, 'based');
  const basedContracts = contractsOf(company, 'active').filter((k) => k.kind === 'based');
  const tsAreas = Object.values(layout.terminalAreas).filter((a) => a.kind === 'transferSecurity');
  const tsPerHour = tsAreas.reduce((sum, a) => sum + areaProcessingPerHour(a.kind, a.props), 0);
  const banks = company.hub?.banks ?? [];
  const latest = company.reports[company.reports.length - 1];
  const overnight = overnightReadings(company, ctx, company.day);
  const fleet = Object.values(company.basedFleet ?? {}).sort((a, b) => (a.id < b.id ? -1 : 1));

  return (
    <div className="issues mgmt" data-testid="hub-panel">
      <div className="issues-header">
        <strong>乗継・拠点</strong>
        <span className="muted">ハブ（乗継）と拠点航空会社（based）の見込みと条件です。表示専用で、計画・判定は既存の計算を読み取っています</span>
      </div>
      <div className="issues-list mgmt-grid">
        <FeatureUnlocks />

        <section data-testid="hub-board">
          <h4>乗継・ハブ（{company.day + 1}日目の計画）</h4>
          {!hubUnlocked ? (
            <p className="warn-text" data-testid="hub-board-locked">
              乗継・ハブは{lockLabel(company, 'hub')}です。解放されるまで乗継は計画されません。下の最短乗継時間は、現在の配置のまま解放された場合の見込みです。
            </p>
          ) : !hubOn ? (
            <p className="warn-text" data-testid="hub-board-off">
              解放済みですが機能が無効です。有効化（新規ゲーム設定／難易度・ルールで「乗継と波」を ON）するまで乗継は計画されません。下の最短乗継時間は現在の配置での見込みです。
            </p>
          ) : (
            <p className="muted small">有効です。接続ペアは当日の計画に付けられた乗継（planConnections の結果）です。</p>
          )}
          <table className="board">
            <thead><tr><th>乗継の種類</th><th>最短乗継時間（最大）</th><th>最短乗継時間（中央値）</th></tr></thead>
            <tbody>
              {(['DD', 'DI', 'ID', 'II'] as const).map((kind) => (
                <tr key={kind} data-testid={`hub-mct-${kind}`}>
                  <td>{TRANSFER_KIND_LABEL[kind]}</td>
                  <td>{snapshot.hub.mctMin[kind].max !== null ? `${Math.round(snapshot.hub.mctMin[kind].max!)} 分` : '接続不可（経路なし）'}</td>
                  <td>{snapshot.hub.mctMin[kind].median !== null ? `${Math.round(snapshot.hub.mctMin[kind].median!)} 分` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="capacity-peak">
            1 日の乗継旅客（計画）: <span data-testid="hub-transfer-pax">{snapshot.hub.transferPaxPerDay} 人</span>
            {snapshot.hub.bankAircraft !== null && <> · バンク時の最大機数: {snapshot.hub.bankAircraft} 機</>}
            {snapshot.hub.bankPax !== null && <> · バンク時の乗継処理能力: {snapshot.hub.bankPax} 人/時</>}
          </div>
          <p className="muted small" data-testid="hub-transfer-security">
            乗継保安検査: {tsAreas.length === 0 ? '未設置（乗継の工程が処理できません）' : `${tsAreas.length} エリア・処理能力 ${tsPerHour.toLocaleString('ja-JP')} 人/時`}
          </p>
          <p className="muted small" data-testid="hub-settings">
            乗継の設定: 接続の上限 {company.hub?.maxConnectMin ?? DEFAULT_MAX_CONNECT_MIN} 分
            {banks.length > 0 ? ` · バンク ${banks.map((b) => `${formatMinute(b.arriveFromMin)}〜${formatMinute(b.departFromMin)}`).join('、')}` : ' · バンク未設定'}
          </p>
          <HubSettingsEditor company={company} />
          <h5>接続ペアごとの乗継見込み</h5>
          {pairs.length > 0 ? (
            <div className="capacity-table-scroll">
              <table className="board" data-testid="hub-connections">
                <thead>
                  <tr><th>到着便（出発地）</th><th>到着</th><th>出発便（行き先）</th><th>出発</th><th>種類</th><th>乗継人数</th><th>接続時間</th><th>MCT</th><th>余裕</th><th>接続品質</th><th>{FOLLOWUP_UI.hubChoiceColumn}</th></tr>
                </thead>
                <tbody>
                  {pairs.map((r) => (
                    <tr key={`${r.arrKey}:${r.depKey}`} data-testid={`hub-connection-${r.arrKey}-${r.depKey}`}>
                      <td>{r.arrNumber}（{r.fromName}）</td>
                      <td>{formatClock(r.arrAt)}</td>
                      <td>{r.depNumber}（{r.toName}）</td>
                      <td>{formatClock(r.depAt)}</td>
                      <td>{TRANSFER_KIND_LABEL[r.kind]}</td>
                      <td>{r.pax} 人</td>
                      <td>{r.gapMin} 分</td>
                      <td>{r.mctMin !== null ? `${Math.round(r.mctMin)} 分` : '—'}</td>
                      <td>{r.marginMin !== null ? `${r.marginMin} 分` : '—'}</td>
                      <td>{r.quality !== null ? `${Math.round(r.quality * 100)}%` : '—'}</td>
                      <td>{Math.round(r.choiceShare * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small" data-testid="hub-connections-empty">
              {hubOn
                ? '当日の計画に接続ペアはありません。接続には、MCT 以上・接続上限以内の間隔、同じ航空会社か乗継を受け入れる契約（transferShare）、出発便の空席が必要です。'
                : '機能が有効でないため、接続ペアは計画されていません。'}
            </p>
          )}
          <p className="muted small" data-testid="hub-choice-note">{FOLLOWUP_UI.hubChoiceNote}</p>
        </section>

        <section data-testid="based-board">
          <h4>拠点航空会社（based）</h4>
          {!isUnlocked(company, 'based') ? (
            <p className="warn-text" data-testid="based-board-locked">拠点航空会社は{lockLabel(company, 'based')}です。</p>
          ) : !basedOn ? (
            <p className="warn-text" data-testid="based-board-off">解放済みですが機能が無効です。有効化（新規ゲーム設定／難易度・ルールで「拠点航空会社」を ON）するまで拠点契約の提案は出ません。</p>
          ) : basedContracts.length === 0 ? (
            <p className="muted small" data-testid="based-board-empty">有効な拠点契約はありません。拠点にできる航空会社（canBase）から提案が来ます。</p>
          ) : null}
          {basedContracts.map((k) => {
            const details = basedConditionDetails(company, ctx, k.id);
            const issueDays = company.basedIssueDays?.[k.id] ?? 0;
            return (
              <div key={k.id} className="based-contract" data-testid={`based-contract-${k.id}`}>
                <div className="based-contract-head">
                  <strong>{airlineDef(k.airlineId).name}・{destinationDef(k.destinationId).name}</strong>
                  <span>{resolveType(AIRCRAFT_TYPES, k.typeId).label} · 所属機 {k.basedAircraft ?? 1} 機 · 折り返し {k.perDay} 回/日 · {k.startDay + 1}〜{k.endDay + 1}日目</span>
                  {details && (details.allMet ? <span className="ok-text">条件を満たしています</span> : <span className="ng-text">未達: {details.unmet.join('・')}</span>)}
                  {issueDays > 0 && <span className="warn-text" data-testid={`based-issue-days-${k.id}`}>条件未達が {issueDays}/3 日続いています（3 日連続で撤退）</span>}
                </div>
                {details && (
                  <table className="board">
                    <thead><tr><th>条件</th><th>必要</th><th>現在</th><th>判定</th><th>根拠</th></tr></thead>
                    <tbody>
                      {details.items.map((item) => (
                        <tr key={item.key} data-testid={`based-condition-${k.id}-${item.key}`}>
                          <td>{item.name}</td>
                          <td>{item.required} {item.unit}</td>
                          <td>{item.available} {item.unit}</td>
                          <td className={item.met ? 'ok-text' : 'ng-text'}>{item.met ? '満たす' : `不足 ${item.required - item.available} ${item.unit}`}</td>
                          <td className="capacity-explain">{item.basis}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}

          <h5>常駐機</h5>
          {fleet.length > 0 ? (
            <table className="board" data-testid="based-fleet">
              <thead><tr><th>機体</th><th>航空会社</th><th>機種</th><th>前回整備からの運航回数</th><th>次回整備まで</th><th>前回整備</th></tr></thead>
              <tbody>
                {fleet.map((b) => (
                  <tr key={b.id} data-testid={`based-aircraft-${b.id}`}>
                    <td>{b.id}</td>
                    <td>{airlineDef(b.airlineId).name}</td>
                    <td>{resolveType(AIRCRAFT_TYPES, b.typeId).label}</td>
                    <td>{b.cycles} / {BALANCE.phase4.checkCycles} 回</td>
                    <td>{b.cycles >= BALANCE.phase4.checkCycles ? <span className="ng-text">整備期限を超過</span> : `あと ${BALANCE.phase4.checkCycles - b.cycles} 回`}</td>
                    <td>{b.lastCheckDay !== null ? `${b.lastCheckDay + 1}日目` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">常駐機は登録されていません。</p>
          )}

          <h5>滞泊スポットの使用状況（今夜の必要数）</h5>
          <table className="board" data-testid="based-overnight">
            <thead><tr><th>サイズ</th><th>必要</th><th>滞泊可能</th><th>判定</th></tr></thead>
            <tbody>
              {overnight.map((r) => (
                <tr key={r.subjectId} data-testid={`based-overnight-${r.subjectId}`}>
                  <td>{r.label}</td>
                  <td>{r.demand ?? 0} 機</td>
                  <td>{r.theoretical ?? '未算出'} 機</td>
                  <td>{r.state === 'zeroCapacity' ? <span className="ng-text">能力なし</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">サイズ別の値は「そのサイズだけを置いた場合の最大機数」です（大きいスポットは小さい機にも使えるため合算できません）。今夜の計画上の滞泊便は {snapshot.plan.flights.filter((f) => f.overnight).length} 便です。</p>

          <h5>翌朝の出発準備（直近日報）</h5>
          {latest?.morningReadiness ? (
            <p data-testid="based-morning-readiness">
              {latest.day + 1}日目の朝: 予定 {latest.morningReadiness.scheduled} 機・確定可能 {latest.morningReadiness.ready} 機・リスクあり {latest.morningReadiness.atRisk} 機（06:00–10:00 の滞泊便。常駐機の整備状況がリスクに影響します）
            </p>
          ) : (
            <p className="muted small" data-testid="based-morning-readiness">未計測（日報がまだないか、朝の窓に滞泊便の出発がありません）。</p>
          )}
        </section>
      </div>
    </div>
  );
}
