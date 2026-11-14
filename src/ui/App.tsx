import { useEffect, useRef, useState } from 'react';
import { Viewport } from '../render/MapView';
import { actions, editorStore, formatCr, newGame, setOpsPrefs, useEditor, useLayout } from '../editor/store';
import { FinancePanel, PlanPanel, useCompany } from './ManagementPanels';
import { AccessPanel, ExpansionPanel } from './AccessPanels';
import { CatalogPanel } from './CatalogPanel';
import { ScenarioPanel } from './AnalysisPanels';
import { DAY_LOOP, GAME_UI, MODE_LABEL } from '../i18n/ja';
import { DayReviewOverlay } from './DayReview';
import { GameSetupDialog, gameSetupUi } from './GameSetup';
import { HistoryOverlay } from './HistoryPanel';
import { SkipDayOverlay } from './SkipDayOverlay';
import { dayFlowActions } from '../editor/dayFlowActions';
import { onKeyDown, onKeyUp } from '../editor/input';
import { projectActions } from '../editor/project';
import { downloadText, ProjectPanel } from './ProjectPanel';
import { setBuildState } from '../core/layout/operations';
import { applyOp } from '../editor/store';
import { Toolbox } from './Toolbox';
import { FacilityList } from './FacilityList';
import { PropertiesPanel } from './PropertiesPanel';
import { IssuesPanel } from './IssuesPanel';
import type { Overlays } from '../editor/store';
import { ops } from '../editor/simRunner';
import { OperateLayout } from './operate/OperateLayout';
import { OpsNav } from './operate/OpsNav';
import { opsUi } from './operate/opsUi';
import { useSecondly } from './operate/Card';
import { LevelChip } from './operate/WxView';
import { effectiveWx } from '../core/sim/weather';
import { StatusBar, Toast } from './StatusBar';
import { ManagementPage, type ManagementSection } from './ManagementPage';
import { CapacityPanel } from './CapacityPanel';

const OVERLAY_LABEL: Record<keyof Overlays, string> = {
  grid: 'グリッド',
  interior: 'ターミナル内部',
  buildable: '建設不可エリア',
  network: '論理ネットワーク・予約',
  issues: 'エラー表示',
  labels: 'ラベル',
  congestion: '混雑マップ',
  daylight: '昼夜表現',
};

export function App() {
  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    const down = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      // 運航モードの大きなオーバーレイは Esc で閉じる（他のキー処理より先）
      if (e.key === 'Escape' && opsUi.get().overlay) {
        opsUi.closeOverlay();
        e.preventDefault();
        return;
      }
      if (onKeyDown({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => onKeyUp({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const mode = useEditor((s) => s.mode);
  const [page, setPage] = useState<MainPage>(mode === 'operate' ? 'operations' : 'construction');
  const [managementSection, setManagementSection] = useState<ManagementSection>('plan');
  const previousMode = useRef(mode);
  useEffect(() => {
    if (mode === previousMode.current) return;
    previousMode.current = mode;
    setPage(mode === 'operate' ? 'operations' : 'construction');
  }, [mode]);
  const openConstruction = (id?: string) => {
    if (id) actions.select(id);
    setPage('construction');
  };
  return (
    <div className={`app mode-${mode} page-${page}`}>
      <TopBar page={page} setPage={setPage} onSavedProjects={() => { setManagementSection('project'); setPage('management'); }} />
      {page === 'management' ? <ManagementPage onOpenConstruction={openConstruction} section={managementSection} onSectionChange={setManagementSection} /> : page === 'operations' ? <OperateLayout /> : <BuildLayout readOnly={mode === 'operate'} />}
      <DayReviewOverlay />
      <SkipDayOverlay />
      <HistoryOverlay />
      <GameSetupDialog />
    </div>
  );
}

type MainPage = 'construction' | 'management' | 'operations';

/** 建設モードの画面（従来のまま: 左にツールボックスと一覧、右にプロパティ、下にタブ） */
function BuildLayout({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <>
      <aside className="left">
        {readOnly ? <div className="build-readonly"><strong>建設・確認</strong><span>運航中は空港構造を変更できません。運航を終了すると編集できます。</span></div> : <Toolbox />}
        <FacilityList />
      </aside>
      <main className="center">
        <Viewport />
        <StatusBar />
        <Toast />
      </main>
      <aside className="right">
        <PropertiesPanel />
      </aside>
      <footer className="bottom">
        <BuildBottom />
      </footer>
    </>
  );
}

type BottomTab = 'issues' | 'plan' | 'capacity' | 'finance' | 'access' | 'expansion' | 'catalog' | 'scenarios' | 'project';

function Tabs({ tabs, tab, setTab }: { tabs: readonly (readonly [BottomTab, string])[]; tab: BottomTab; setTab: (t: BottomTab) => void }) {
  return (
    <div className="tabs">
      {tabs.map(([k, label]) => (
        <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)} data-testid={`tab-${k}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function BuildBottom() {
  const [tab, setTab] = useState<BottomTab>('issues');
  return (
    <div className="tabbed">
      <Tabs
        tabs={[
          ['issues', '配置チェック'],
          ['plan', '運航計画'],
          ['capacity', '空港能力'],
          ['finance', '経営'],
          ['access', 'アクセス'],
          ['expansion', '拡張計画'],
          ['catalog', '機種カタログ'],
          ['scenarios', 'シナリオ'],
          ['project', 'プロジェクト'],
        ]}
        tab={tab}
        setTab={setTab}
      />
      <div className="tab-body">
        {tab === 'plan' ? (
          <PlanPanel />
        ) : tab === 'capacity' ? (
          <CapacityPanel />
        ) : tab === 'finance' ? (
          <FinancePanel />
        ) : tab === 'access' ? (
          <AccessPanel />
        ) : tab === 'expansion' ? (
          <ExpansionPanel />
        ) : tab === 'catalog' ? (
          <CatalogPanel />
        ) : tab === 'scenarios' ? (
          <ScenarioPanel />
        ) : tab === 'project' ? (
          <ProjectPanel />
        ) : (
          <IssuesPanel />
        )}
      </div>
    </div>
  );
}

function TopBar({ page, setPage, onSavedProjects }: { page: MainPage; setPage: (p: MainPage) => void; onSavedProjects: () => void }) {
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const overlays = useEditor((s) => s.overlays);
  const viewMode = useEditor((s) => s.viewMode);
  const layout = useLayout();
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = useEditor((s) => s.mode);
  const overlayKeys = (Object.keys(OVERLAY_LABEL) as (keyof Overlays)[]).filter((k) => mode === 'operate' || k !== 'daylight');
  const career = useEditor((s) => s.company.mode === 'career');
  const prefs = useEditor((s) => s.opsPrefs);
  const hasReview = useEditor((s) => s.dayFlow.review !== null);
  const skipping = useEditor((s) => s.dayFlow.phase === 'skipping');
  const [settingsOpen, setSettingsOpen] = useState(false);

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
      {mode === 'operate' && <WxBadge />}
      <nav className="primary-nav" aria-label="ゲームページ">
        <button className={page === 'construction' ? 'active' : ''} onClick={() => setPage('construction')} data-testid="page-construction">建設</button>
        <button className={page === 'management' ? 'active' : ''} onClick={() => setPage('management')} data-testid="page-management">経営</button>
        <button className={page === 'operations' ? 'active' : ''} onClick={() => mode === 'build' ? ops.start() : setPage('operations')} data-testid="page-operations">{mode === 'build' ? '運行開始' : '運行'}</button>
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
        <button data-testid="view-toggle" className={viewMode === '3d' ? 'active' : ''} onClick={() => actions.setViewMode(viewMode === '3d' ? '2d' : '3d')} title="2D マップと 3D ビューを切り替えます（運航は止まりません）">
          {viewMode === '3d' ? '2D表示へ' : '3D表示へ'}
        </button>
      </div>
      {mode === 'operate' ? (
        <details className="overlays-pop" data-testid="overlays-pop">
          <summary title="マップの表示切り替え">表示</summary>
          <div className="overlays-menu">
            {overlayKeys.map((k) => (
              <label key={k}>
                <input type="checkbox" checked={overlays[k]} onChange={() => actions.toggleOverlay(k)} data-testid={`overlay-${k}`} />
                {OVERLAY_LABEL[k]}
              </label>
            ))}
          </div>
        </details>
      ) : (
        <div className="top-group overlays">
          {overlayKeys.map((k) => (
            <label key={k}>
              <input type="checkbox" checked={overlays[k]} onChange={() => actions.toggleOverlay(k)} data-testid={`overlay-${k}`} />
              {OVERLAY_LABEL[k]}
            </label>
          ))}
        </div>
      )}
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
            <button disabled={mode === 'operate'} onClick={() => { if (window.confirm('空の敷地で現在の空港を置き換えますか？')) { actions.newEmpty(); setSettingsOpen(false); } }} data-testid="new-empty">空の敷地</button>
            <button onClick={() => { gameSetupUi.open('new'); setSettingsOpen(false); }} title={GAME_UI.setupNewTitle} data-testid="new-game-setup">新規ゲーム設定</button>
            <button onClick={() => { gameSetupUi.open('settings'); setSettingsOpen(false); }} title={GAME_UI.setupSettingsTitle} data-testid="tab-settings">難易度・ルール</button>
            <button onClick={download} data-testid="export-project">空港を保存</button>
            <button onClick={() => fileRef.current?.click()} data-testid="import-project">空港を読み込む</button>
            <button onClick={() => { onSavedProjects(); setSettingsOpen(false); }} data-testid="saved-projects">セーブデータ管理へ</button>
          </div>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          <p className="muted small">ゲーム全体を置き換える操作は確認後に実行します。保存済みスロットは「経営 → プロジェクト・保存」で管理できます。</p>
        </div>
      </details>
    </header>
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
