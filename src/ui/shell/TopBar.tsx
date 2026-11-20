import { useRef, useState } from 'react';
import { actions, editorStore, formatCr, newGame, setOpsPrefs, useEditor, useLayout } from '../../editor/store';
import { useCompany } from '../ManagementPanels';
import { DAY_LOOP, GAME_UI, MODE_LABEL } from '../../i18n/ja';
import { gameSetupUi } from '../GameSetup';
import { dayFlowActions } from '../../editor/dayFlowActions';
import { projectActions } from '../../editor/project';
import { downloadText } from '../ProjectPanel';
import { setBuildState } from '../../core/layout/operations';
import { SITE_SIZES } from '../../core/model/site';
import { applyOp } from '../../editor/store';
import { ops } from '../../editor/simRunner';
import { OpsNav } from '../operate/OpsNav';
import { useSecondly } from '../operate/Card';
import { LevelChip } from '../operate/WxView';
import { effectiveWx } from '../../core/sim/weather';
import { nextTierProgress } from '../../core/economy/goals';
import { ServiceGranularitySelect } from '../ServiceModesPanel';

/**
 * UIデザイン更新 第1段階: トップバー（ワークスペース骨格の上段）。
 * 中身は従来の App 内 TopBar をそのまま移したもの（配置だけが変わる）。
 */

export type MainPage = 'construction' | 'management' | 'operations';

// オーバーレイ切替と混雑マップの凡例は、第2段階でレールのレイヤーポップオーバーへ移した（shell/Rail.tsx）

export function TopBar({ page, setPage, onSavedProjects, onOpenAtc }: { page: MainPage; setPage: (p: MainPage) => void; onSavedProjects: () => void; onOpenAtc: () => void }) {
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const viewMode = useEditor((s) => s.viewMode);
  const layout = useLayout();
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = useEditor((s) => s.mode);
  const career = useEditor((s) => s.company.mode === 'career');
  const prefs = useEditor((s) => s.opsPrefs);
  const hasReview = useEditor((s) => s.dayFlow.review !== null);
  const skipping = useEditor((s) => s.dayFlow.phase === 'skipping');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [emptySiteSize, setEmptySiteSize] = useState('standard');

  // 書き出し・読み込みはプロジェクト単位（レイアウト・会社・機種データ・シナリオ）。旧形式のレイアウトファイルも読める
  const download = () => {
    const { fileName, json } = projectActions.exportJson();
    downloadText(fileName, json);
  };
  const upload = async (file: File) => {
    if (!window.confirm(mode === 'operate' ? '読み込みで現在の運航状態を置き換えます。続けますか？' : '読み込んだ空港・会社で現在の内容を置き換えます。続けますか？')) return;
    projectActions.importJson(await file.text(), file.name);
    setSettingsOpen(false);
  };

  return (
    <header className="top">
      <span className="brand">✈ SkyPort</span>
      <span className="subtitle">{page === 'construction' ? '建設' : page === 'management' ? '経営' : '運行'} · {mode === 'build' ? '編集可能' : '運航中'}</span>
      <CompanyBadge />
      <NextTierChip />
      {mode === 'operate' && <WxBadge />}
      <nav className="primary-nav" aria-label="ゲームページ">
        <button className={page === 'construction' ? 'active' : ''} onClick={() => setPage('construction')} data-testid="page-construction" title={mode === 'operate' ? '運航中は閲覧専用です。建設するには「建設モードに戻る」で運航を終了してください' : undefined}>{mode === 'operate' ? '建設（閲覧）' : '建設'}</button>
        <button className={page === 'management' ? 'active' : ''} onClick={() => setPage('management')} data-testid="page-management">経営</button>
        <button className={page === 'operations' ? 'active' : ''} onClick={() => mode === 'build' ? ops.start() : setPage('operations')} data-testid="page-operations">{mode === 'build' ? '運行開始' : '運行'}</button>
        <button onClick={onOpenAtc} disabled={mode === 'operate'} title={mode === 'operate' ? '運航中は管制官モードへ移れません（モードを同時に進行させないため）。建設モードに戻ってから開いてください' : '管制官モード（ATC）を開きます。経営モードの状態は変更されません'} data-testid="page-atc">管制官</button>
      </nav>
      {mode === 'operate' && <div className="top-group">
            <button onClick={() => ops.restart()} title="今日を締めて（結果を日報に記録して）次の日を 0:00 から始めます。同じ日をやり直すものではありません" data-testid="restart-ops">
              今日を締めて次の日へ
            </button>
            <button
              className="primary"
              onClick={() => {
                const closed = editorStore.getState().dayFlow.atClose;
                if (window.confirm(closed ? '運航を終了して建設モードに戻りますか？（締めは済んでいます。運航の状態は破棄されます）' : '運航を終了して建設モードに戻りますか？（その日を途中で締め、運航の状態は破棄されます）')) ops.stop();
              }}
              data-testid="stop-ops"
            >
              ■ 建設モードに戻る
            </button>
      </div>}
      {mode === 'build' && page === 'construction' && (
        <>
        <div className="top-group">
          <button onClick={actions.undo} disabled={!canUndo} title="Ctrl+Z" data-testid="undo">
            ↶ 元に戻す
          </button>
          <button onClick={actions.redo} disabled={!canRedo} title="Ctrl+Shift+Z" data-testid="redo">
            ↷ やり直し
          </button>
        </div>
          <button
            onClick={() => applyOp(setBuildState(layout, 'operational'))}
            title={career ? '計画中の施設をすべて着工する（工期を待って完成）' : '計画・建設中の施設をすべて運用中にする'}
          >
            {career ? '全施設を着工' : '全施設を完成'}
          </button>
        </>
      )}
      <div className="top-group">
        <button data-testid="view-toggle" className={viewMode === '3d' ? 'active' : ''} onClick={() => actions.setViewMode(viewMode === '3d' ? '2d' : '3d')} title="2D マップと 3D ビューを切り替えます（運航は止まりません）。3D は観賞用です（編集は 2D で行います）">
          {viewMode === '3d' ? '2D表示へ' : '3D表示へ'}
        </button>
      </div>
      <div className="top-group">
        <button className="small day-btn" onClick={() => ops.skipDay()} disabled={skipping} title={DAY_LOOP.skipDayTitle} data-testid="skip-day">
          {DAY_LOOP.skipDay}
        </button>
        {hasReview && (
          <button className="small day-btn" onClick={() => ops.openReview()} data-testid="open-review">
            {DAY_LOOP.openReview}
          </button>
        )}
        <button className="small day-btn" onClick={() => dayFlowActions.openHistory(true)} data-testid="open-history">
          {DAY_LOOP.openHistory}
        </button>
        <details className="day-prefs-pop">
          <summary title="1 日のループの設定">⚙ 日の設定</summary>
          <div className="day-prefs">
          <label title={DAY_LOOP.prefPauseTitle}>
            <input type="checkbox" checked={prefs.pauseAtDayClose} onChange={(e) => setOpsPrefs({ pauseAtDayClose: e.target.checked })} data-testid="pref-pause-at-close" />
            {DAY_LOOP.prefPause}
          </label>
          <label title={DAY_LOOP.prefAutoStopTitle}>
            <input type="checkbox" checked={prefs.skipAutoStop} onChange={(e) => setOpsPrefs({ skipAutoStop: e.target.checked })} data-testid="pref-skip-autostop" />
            {DAY_LOOP.prefAutoStop}
          </label>
          </div>
        </details>
      </div>
      {mode === 'operate' && page === 'operations' && <OpsNav />}
      <details className="settings-pop" open={settingsOpen} onToggle={(e) => setSettingsOpen(e.currentTarget.open)} data-testid="settings-menu">
        <summary>⚙ メニュー</summary>
        <div className="settings-menu-body">
          <strong>ゲーム設定・保存</strong>
          <div className="settings-menu-actions">
            <button onClick={() => { if (!window.confirm(mode === 'operate' ? '運航を停止して新しいゲームを始めますか？現在の運航状態は失われます。' : '新しいゲームを始めますか？現在の空港と経営データは置き換わります。')) return; if (mode === 'operate') ops.stop(); newGame('career'); setPage('construction'); setSettingsOpen(false); }} data-testid="new-career">新しいゲーム</button>
            <button onClick={() => { if (!window.confirm(mode === 'operate' ? '運航を停止してサンドボックスを始めますか？現在の運航状態は失われます。' : 'サンドボックスを始めますか？現在の空港と経営データは置き換わります。')) return; if (mode === 'operate') ops.stop(); newGame('sandbox'); setPage('construction'); setSettingsOpen(false); }} data-testid="new-sandbox">サンドボックス</button>
            <button disabled={mode === 'operate'} onClick={() => { if (window.confirm('サンプル空港で現在の配置を置き換えますか？')) { actions.loadSample(); setSettingsOpen(false); } }} data-testid="load-sample">サンプル空港</button>
            <label className="small">空の敷地の大きさ
              <select value={emptySiteSize} onChange={(e) => setEmptySiteSize(e.target.value)} data-testid="new-empty-size">
                {SITE_SIZES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <button disabled={mode === 'operate'} onClick={() => { if (window.confirm('空の敷地で現在の空港を置き換えますか？')) { actions.newEmpty(emptySiteSize); setSettingsOpen(false); } }} data-testid="new-empty">空の敷地</button>
            <button onClick={() => { gameSetupUi.open('new'); setSettingsOpen(false); }} title={GAME_UI.setupNewTitle} data-testid="new-game-setup">新規ゲーム設定</button>
            <button onClick={() => { gameSetupUi.open('settings'); setSettingsOpen(false); }} title={GAME_UI.setupSettingsTitle} data-testid="tab-settings">難易度・ルール</button>
            <button onClick={download} data-testid="export-project">空港を保存</button>
            <button onClick={() => fileRef.current?.click()} data-testid="import-project">空港を読み込む</button>
            <button onClick={() => { onSavedProjects(); setSettingsOpen(false); }} data-testid="saved-projects">セーブデータ管理へ</button>
          </div>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          <ServiceGranularitySelect />
          <p className="muted small">店舗シミュレーション粒度は次回の運航開始から適用され、プロジェクトには保存されません。既定は集約（カテゴリ×ターミナル）で、詳細（店舗ごと）は従来方式です。結果の見方は経営ボード「空港能力」の店舗・サービス施設の節に出ます。</p>
          <p className="muted small">ゲーム全体を置き換える操作は確認後に実行します。保存済みスロットは「経営 → プロジェクト・保存」で管理できます。</p>
        </div>
      </details>
    </header>
  );
}

/**
 * 次の格までの進捗チップ（UIデザイン更新 第3段階）: 不足分を数値で出す。
 * 判定は nextTierProgress（表示専用。5-20 T6 と同じ定義）を読むだけ。
 */
function NextTierChip() {
  const c = useCompany();
  const p = nextTierProgress(c);
  if (!p) return null;
  if (p.next === null) {
    return (
      <span className="tier-chip" data-testid="next-tier-chip">
        {GAME_UI.nextTierMax}
      </span>
    );
  }
  const label = { movements: GAME_UI.nextTierMovements, pax: GAME_UI.nextTierPax, rating: GAME_UI.nextTierRating } as const;
  const fmtNum = (v: number) => (Number.isInteger(v) ? v.toLocaleString('ja-JP') : v.toFixed(1));
  const unmet = p.items.filter((i) => i.required !== null && i.current !== null && !i.met);
  const summary =
    unmet.length === 0
      ? '要件を達成中'
      : unmet.map((i) => `${label[i.key as keyof typeof label] ?? i.key} ${GAME_UI.nextTierShortfall(fmtNum(i.shortfall ?? 0))}`).join('・');
  return (
    <span
      className="tier-chip"
      data-testid="next-tier-chip"
      title={`${GAME_UI.nextTierTitle(GAME_UI.tier[p.next]!)}: ${summary}${p.streak ? ` / ${GAME_UI.nextTierStreak(p.streak.current, p.streak.required)}` : ''}`}
    >
      次の格まで {summary}
    </span>
  );
}

/** 運航中の天候の段階（天候 5 段階の運航だけ） */
function WxBadge() {
  const eff = useSecondly((o) => (o.sim.state.wx ? effectiveWx(o.sim.state.wx) : null));
  if (!eff) return null;
  return <LevelChip level={eff.level} type={eff.type} testId="weather-level-top" />;
}

/** 資金・日・評価 */
function CompanyBadge() {
  const c = useCompany();
  return (
    <span className={`company-badge ${c.cash < 0 ? 'negative' : ''}`} data-testid="company-badge">
      <span>{MODE_LABEL[c.mode]}</span>
      <b data-testid="cash">💴 {formatCr(c.cash)}</b>
      <span data-testid="company-day">{c.day + 1}日目</span>
      {c.goals && <span data-testid="airport-tier" title={GAME_UI.goalsTitle}>{GAME_UI.tier[c.goals.tier]}</span>}
      <span className="muted" data-testid="game-difficulty" title={c.game ? GAME_UI.difficultyHint[c.game.difficulty] : GAME_UI.rulesLegacy}>
        {c.game ? GAME_UI.difficultyBadge(GAME_UI.difficulty[c.game.difficulty]!) : GAME_UI.rulesLegacy}
      </span>
      <span title="空港評価（旅客満足度・航空会社満足度・定時率から）">評価 {c.rating.toFixed(1)}</span>
      {c.bankrupt && <b className="ng-text">経営破綻</b>}
    </span>
  );
}
