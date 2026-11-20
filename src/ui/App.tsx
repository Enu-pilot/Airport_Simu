import { useEffect, useMemo, useRef, useState } from 'react';
import { Viewport } from '../render/MapView';
import { actions, editorStore, useAnalysis, useEditor, useLayout, type BuildPanel } from '../editor/store';
import { buildAttentionItems } from '../core/attention';
import { composeCapabilityReadings } from '../core/capability';
import { SHELL_UI } from '../i18n/ja';
import { AirlinesPanel, ContractsPanel, FinancePanel, PlanPanel, useCompany } from './ManagementPanels';
import { AccessPanel, ExpansionPanel } from './AccessPanels';
import { CatalogPanel } from './CatalogPanel';
import { ScenarioPanel } from './AnalysisPanels';
import { GameSetupDialog } from './GameSetup';
import { ReviewDrawer } from './shell/ReviewDrawer';
import { SkipDayOverlay } from './SkipDayOverlay';
import { onKeyDown, onKeyUp } from '../editor/input';
import { ProjectPanel } from './ProjectPanel';
import { Toolbox } from './Toolbox';
import { FacilityList } from './FacilityList';
import { PropertiesPanel } from './PropertiesPanel';
import { IssuesPanel } from './IssuesPanel';
import { OperateLayout } from './operate/OperateLayout';
import { opsInboxAttentionFromSim } from './operate/alerts';
import { OpsBoard } from './operate/DetailOverlay';
import { opsUi } from './operate/opsUi';
import { StatusBar, Toast } from './StatusBar';
import { ManagementPage, type ManagementSection } from './ManagementPage';
import { CapacityPanel } from './CapacityPanel';
import { AtcApp } from './atc/AtcApp';
import { TopBar, type MainPage } from './shell/TopBar';
import { Rail } from './shell/Rail';
import { Timeline } from './shell/Timeline';
export function App() {
  // ゲームモード選択（経営 / 管制官）。ATC は専用ストア・画面で完結し、
  // EditorState には混ぜない（計画書 air_traffic_control_mode_plan.md §3.1）
  const [appMode, setAppMode] = useState<'management' | 'atc'>('management');
  const appModeRef = useRef(appMode);
  useEffect(() => {
    appModeRef.current = appMode;
  }, [appMode]);
  const currentLayout = useLayout();
  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'SUMMARY');
    const down = (e: KeyboardEvent) => {
      if (appModeRef.current === 'atc') return; // ATC モード中は経営側のキー処理をしない
      if (isEditable(e.target)) return;
      // 運航モードの大きなオーバーレイは Esc で閉じる（他のキー処理より先）
      if (e.key === 'Escape' && opsUi.get().overlay) {
        opsUi.closeOverlay();
        e.preventDefault();
        return;
      }
      if (onKeyDown({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (appModeRef.current === 'atc') return;
      onKeyUp({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    };
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
  // 経営ボードのスクロール位置（閉じても保持し、再び開いたら復元する。保存データには入れない）
  const boardScroll = useRef(0);
  const previousMode = useRef(mode);
  useEffect(() => {
    if (mode === previousMode.current) return;
    previousMode.current = mode;
    setPage(mode === 'operate' ? 'operations' : 'construction');
  }, [mode]);
  // レンズはページの別名として store に同期する（UIデザイン更新 第1段階）
  useEffect(() => {
    actions.setLens(page === 'construction' ? 'build' : page === 'management' ? 'manage' : 'operate');
  }, [page]);
  // 経営ボードは Esc で閉じて地図へ戻る（UIデザイン更新 第3段階。選択・セクション・スクロールは保持される）。
  // capture 段階で拾い、編集系の Esc（ツール取消など）より先に処理する。入力要素と運航オーバーレイは従来どおり優先
  useEffect(() => {
    if (page !== 'management') return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'SUMMARY')) return;
      if (opsUi.get().overlay) return;
      setPage('construction');
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [page]);
  const openConstruction = (id?: string) => {
    if (id) actions.select(id);
    setPage('construction');
  };
  if (appMode === 'atc') {
    // ATC レンズ（UIデザイン更新 第6段階）: 経営と同じワークスペース骨格（.app-shell）の枠に収める。
    // 中身は AtcApp が専用ヘッダー・レール・ボードで構成し、下部のタイムラインは通信ログが担う。
    // ATC は EditorState の外という分離（第1段階）は変えない。
    return (
      <div className="app-shell">
        <AtcApp
          currentLayout={currentLayout}
          onExit={() => setAppMode('management')}
          onExitTo={(p) => {
            setPage(p);
            setAppMode('management');
          }}
        />
      </div>
    );
  }
  return (
    <div className="app-shell">
      <TopBar page={page} setPage={setPage} onSavedProjects={() => { setManagementSection('project'); setPage('management'); }} onOpenAtc={() => setAppMode('atc')} />
      <div className="shell-body">
        <Rail page={page} setPage={setPage} onOpenAtc={() => setAppMode('atc')} />
        {/* 経営はボードモード（第3段階）: 背景のワークスペース（地図）はそのまま残し、ボードを重ねる。
            背景の下部タブはボードと内容が重なるため、ボード表示中は畳む */}
        <div className={`app mode-${mode} page-${page === 'management' ? (mode === 'operate' ? 'operations' : 'construction') : page}${page === 'management' && mode !== 'operate' ? ' board-open' : ''}`}>
          {mode === 'operate' && page !== 'construction' ? <OperateLayout /> : <BuildLayout readOnly={mode === 'operate'} boardOpen={page === 'management'} />}
        </div>
        {page === 'management' && (
          <div className="board-overlay" data-testid="management-board">
            <div className="board-backdrop" onClick={() => setPage('construction')} aria-hidden="true" />
            <ManagementPage onOpenConstruction={openConstruction} section={managementSection} onSectionChange={setManagementSection} onClose={() => setPage('construction')} scrollRef={boardScroll} />
          </div>
        )}
        {/* 運航ボード（第4段階）: 運航ナビの大きなパネル群を経営ボードと同じボードモードで開く */}
        {mode === 'operate' && <OpsBoard />}
        {/* 日報ドロワー（第5段階）: 振り返りと履歴を右ドロワーに同居させる。重なり順はボード類より上の 30 */}
        <ReviewDrawer />
      </div>
      <Timeline />
      <SkipDayOverlay />
      <GameSetupDialog />
    </div>
  );
}


/**
 * 建設レンズの画面（UIデザイン更新 第2段階）:
 * 左パネル=ツールボックス／施設一覧／要対応インボックスのタブ切替、右=インスペクタ（プロパティ）、
 * 地図下端にステータスバー。下部タブは経営系のみ残る（配置チェックはインボックスへ移行済み）。
 */
function BuildLayout({ readOnly = false, boardOpen = false }: { readOnly?: boolean; boardOpen?: boolean }) {
  return (
    <>
      <BuildLeftPanel readOnly={readOnly} />
      <main className="center">
        <Viewport />
        <StatusBar />
        <Toast />
      </main>
      <aside className="right inspector">
        <PropertiesPanel />
      </aside>
      {/* 経営ボード表示中は、ボードと内容が重なる下部タブを畳む（閉じれば元に戻る） */}
      {!boardOpen && (
        <footer className="bottom">
          <BuildBottom />
        </footer>
      )}
    </>
  );
}

/** 建設レンズの左パネル: ツールボックス・施設一覧・要対応（配置チェック＋案1の要対応）をタブで同居させる */
function BuildLeftPanel({ readOnly = false }: { readOnly?: boolean }) {
  const panel = useEditor((s) => s.buildPanel);
  const viewMode = useEditor((s) => s.viewMode);
  const layout = useLayout();
  const analysis = useAnalysis();
  const company = useCompany();
  const uiVersion = useEditor((s) => s.ops?.uiVersion ?? -1);
  const attentionCount = useMemo(
    () => buildAttentionItems({ layout, analysis, company, capabilities: composeCapabilityReadings(layout, editorStore.getState().ops?.sim.state), opsAlerts: opsInboxAttentionFromSim(editorStore.getState().ops?.sim, company) }).length,
    // uiVersion は運航中の閉鎖・故障（F6-04）の変化をバッジへ反映するための購読
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, analysis, company, uiVersion],
  );
  const tabBtn = (target: BuildPanel, label: string, testid: string) => (
    <button
      className={panel === target ? 'active' : ''}
      onClick={() => actions.setBuildPanel(target)}
      data-testid={testid}
      aria-pressed={panel === target}
    >
      {label}
      {target === 'inbox' && attentionCount > 0 && <span className="rail-badge" data-testid="build-panel-inbox-count">{attentionCount}</span>}
    </button>
  );
  return (
    <aside className="left build-panel">
      <div className="build-panel-tabs" role="tablist" aria-label="建設パネル">
        {tabBtn('tools', SHELL_UI.buildPanelTools, 'build-panel-tools')}
        {tabBtn('facilities', SHELL_UI.buildPanelFacilities, 'build-panel-facilities')}
        {tabBtn('inbox', SHELL_UI.buildPanelInbox, 'build-panel-inbox')}
      </div>
      <div className="build-panel-body">
        {panel === 'facilities' ? (
          <FacilityList />
        ) : panel === 'inbox' ? (
          <IssuesPanel />
        ) : readOnly ? (
          <div className="build-readonly"><strong>建設・確認</strong><span>運航中は空港構造を変更できません。運航を終了すると編集できます。</span></div>
        ) : viewMode === '3d' ? (
          <>
            <div className="build-readonly" data-testid="toolbox-3d-note"><strong>3D表示中</strong><span>3D は観賞用です。配置・編集はトップバーの「2D表示へ」で 2D に戻して行ってください。</span></div>
            <fieldset disabled className="guard-fieldset" aria-label="3D表示中は配置操作できません">
              <Toolbox />
            </fieldset>
          </>
        ) : (
          <Toolbox />
        )}
      </div>
    </aside>
  );
}

type BottomTab = 'plan' | 'contracts' | 'airlines' | 'capacity' | 'finance' | 'access' | 'expansion' | 'catalog' | 'scenarios' | 'project';

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
  const [tab, setTab] = useState<BottomTab>('plan');
  return (
    <div className="tabbed">
      <Tabs
        tabs={[
          ['plan', '運航計画'],
          ['contracts', '契約'],
          ['airlines', '航空会社'],
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
        ) : tab === 'contracts' ? (
          <ContractsPanel />
        ) : tab === 'airlines' ? (
          <AirlinesPanel />
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
          <PlanPanel />
        )}
      </div>
    </div>
  );
}
