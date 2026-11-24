import { useEffect, useMemo, useRef, useState } from 'react';
import { Viewport } from '../render/MapView';
import { actions, editorStore, useAnalysis, useEditor, useLayout, type BuildPanel } from '../editor/store';
import { SHELL_UI } from '../i18n/ja';
import { useCompany } from './ManagementPanels';
import { GameSetupDialog } from './GameSetup';
import { ReviewDrawer } from './shell/ReviewDrawer';
import { SkipDayOverlay } from './SkipDayOverlay';
import { onKeyDown, onKeyUp } from '../editor/input';
import { Toolbox } from './Toolbox';
import { TerminalWorkspace } from './TerminalWorkspace';
import { FacilityList } from './FacilityList';
import { PropertiesPanel } from './PropertiesPanel';
import { IssuesPanel } from './IssuesPanel';
import { OperateLayout } from './operate/OperateLayout';
import { OpsBoard } from './operate/DetailOverlay';
import { opsUi } from './operate/opsUi';
import { StatusBar, Toast } from './StatusBar';
import { ManagementPage, type ManagementSection } from './ManagementPage';
import { AtcApp } from './atc/AtcApp';
import { TopBar, type MainPage } from './shell/TopBar';
import { Rail } from './shell/Rail';
import { Timeline } from './shell/Timeline';
import { sharedAttentionItems } from './attentionShared';
import { ShortcutHelp, shortcutHelp } from './ShortcutHelp';
import { quickTools } from './quickTools';
import { quickSlotForCode } from '../editor/shortcuts';
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
      // UX-1: ? でショートカット一覧を開閉、Esc で閉じる（他のキー処理より先）
      if (e.key === '?') {
        shortcutHelp.toggle();
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && shortcutHelp.isOpen()) {
        shortcutHelp.set(false);
        e.preventDefault();
        return;
      }
      if (editorStore.getState().mode === 'build' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // UX-4: / でツール検索へ（ツールタブを開いてからフォーカス）
        if (e.key === '/') {
          actions.setBuildPanel('tools');
          setTimeout(() => (document.querySelector('[data-testid="tool-search"]') as HTMLInputElement | null)?.focus(), 0);
          e.preventDefault();
          return;
        }
        // UX-3: Shift+1〜6 でクイックバーのツール（キー配列に依存しないよう e.code で判定）
        const slot = e.shiftKey ? quickSlotForCode(e.code) : null;
        if (slot !== null) {
          const target = quickTools.slots()[slot];
          if (target) actions.setTool(target);
          e.preventDefault();
          return;
        }
      }
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
          {mode === 'operate' && page !== 'construction' ? <OperateLayout /> : <BuildLayout readOnly={mode === 'operate'} boardOpen={page === 'management'} onOpenManagement={(section) => { setManagementSection(section); setPage('management'); }} />}
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
      <ShortcutHelp />
    </div>
  );
}


/**
 * 建設レンズの画面（UIデザイン更新 第2段階）:
 * 左パネル=ツールボックス／施設一覧／要対応インボックスのタブ切替、右=インスペクタ（プロパティ）、
 * 地図下端にステータスバー。下部タブは経営系のみ残る（配置チェックはインボックスへ移行済み）。
 */
function BuildLayout({ readOnly = false, boardOpen = false, onOpenManagement }: { readOnly?: boolean; boardOpen?: boolean; onOpenManagement: (section: ManagementSection) => void }) {
  // ターミナル専用設計 Workspace（5-18）: 開いている間は左パネルだけを差し替える。
  // 運航中（readOnly）は開かない（store 側でも運航中は開けない）
  const workspace = useEditor((s) => s.terminalWorkspace);
  return (
    <>
      {workspace && !readOnly ? <TerminalWorkspace /> : <BuildLeftPanel readOnly={readOnly} />}
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
          <BuildBottom onOpenManagement={onOpenManagement} />
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
    () => sharedAttentionItems(layout, analysis, company, uiVersion).length,
    // uiVersion は運航中の閉鎖・故障（F6-04）の変化をバッジへ反映するための購読
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

/**
 * 建設画面の下部（UX-7、2026-11-24）: 従来の下部タブ（表示高 約 170px）は経営画面と内容が重複し、中身の大半が隠れていたため、
 * 1 行の「経営への近道」に置き換えた。ボタンは従来と同じ data-testid（tab-*）で、押すと経営ボードの該当区分を全画面で開く。
 * 内容の正本は経営ボード（ManagementPage）だけになり、地図が縦に広がる。
 */
const BOTTOM_SHORTCUTS: readonly (readonly [BottomTab, string, ManagementSection])[] = [
  ['plan', '運航計画', 'plan'],
  ['contracts', '契約', 'contracts'],
  ['airlines', '航空会社', 'airlines'],
  ['capacity', '空港能力', 'capacity'],
  ['finance', '経営', 'finance'],
  ['access', 'アクセス', 'access'],
  ['expansion', '拡張計画', 'expansion'],
  ['catalog', '機種カタログ', 'catalog'],
  ['scenarios', 'シナリオ', 'scenarios'],
  ['project', 'プロジェクト', 'project'],
];

function BuildBottom({ onOpenManagement }: { onOpenManagement: (section: ManagementSection) => void }) {
  return (
    <div className="bottom-shortcuts" data-testid="bottom-shortcuts">
      <span className="muted small">経営</span>
      {BOTTOM_SHORTCUTS.map(([k, label, section]) => (
        <button key={k} className="tab" onClick={() => onOpenManagement(section)} data-testid={`tab-${k}`} title={`経営画面の「${label}」を開く`}>
          {label}
        </button>
      ))}
    </div>
  );
}
