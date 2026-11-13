import { useEffect, useRef } from 'react';
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
import { useState } from 'react';

const OVERLAY_LABEL: Record<keyof Overlays, string> = {
  grid: 'グリッド',
  interior: 'ターミナル内部',
  buildable: '建設不可エリア',
  network: '論理ネットワーク・予約',
  issues: 'エラー表示',
  labels: 'ラベル',
  congestion: '混雑マップ',
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
  return (
    <div className={`app mode-${mode}`}>
      <TopBar />
      {mode === 'build' ? <BuildLayout /> : <OperateLayout />}
      <DayReviewOverlay />
      <SkipDayOverlay />
      <HistoryOverlay />
      <GameSetupDialog />
    </div>
  );
}

/** 建設モードの画面（従来のまま: 左にツールボックスと一覧、右にプロパティ、下にタブ） */
function BuildLayout() {
  return (
    <>
      <aside className="left">
        <Toolbox />
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

type BottomTab = 'issues' | 'plan' | 'finance' | 'access' | 'expansion' | 'catalog' | 'scenarios' | 'project';

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

function TopBar() {
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const overlays = useEditor((s) => s.overlays);
  const viewMode = useEditor((s) => s.viewMode);
  const layout = useLayout();
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = useEditor((s) => s.mode);
  const career = useEditor((s) => s.company.mode === 'career');
  const prefs = useEditor((s) => s.opsPrefs);
  const hasReview = useEditor((s) => s.dayFlow.review !== null);
  const skipping = useEditor((s) => s.dayFlow.phase === 'skipping');

  // 書き出し・読み込みはプロジェクト単位（レイアウト・会社・機種データ・シナリオ）。旧形式のレイアウトファイルも読める
  const download = () => {
    const { fileName, json } = projectActions.exportJson();
    downloadText(fileName, json);
  };
  const upload = async (file: File) => {
    projectActions.importJson(await file.text(), file.name);
  };

  return (
    <header className="top">
      <span className="brand">✈ SkyPort</span>
      <span className="subtitle">{mode === 'build' ? '建設モード' : '運航モード'}</span>
      <CompanyBadge />
      {mode === 'operate' && <WxBadge />}
      <div className="top-group">
        {mode === 'build' ? (
          <button className="primary" onClick={() => ops.start()} data-testid="start-ops">
            ▶ 運航開始
          </button>
        ) : (
          <>
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
          </>
        )}
      </div>
      {mode === 'build' && (
        <>
        <div className="top-group">
          <button onClick={actions.undo} disabled={!canUndo} title="Ctrl+Z" data-testid="undo">
            ↶ 元に戻す
          </button>
          <button onClick={actions.redo} disabled={!canRedo} title="Ctrl+Shift+Z" data-testid="redo">
            ↷ やり直し
          </button>
        </div>
        <div className="top-group">
          <button
            onClick={() => window.confirm('新しいゲームを始めますか？（小さな飛行場・初期資金から。現在の空港と経営データは失われます）') && newGame('career')}
            data-testid="new-career"
          >
            新しいゲーム（小さな飛行場から）
          </button>
          <button
            onClick={() => window.confirm('サンドボックスを始めますか？（サンプル空港・潤沢な資金。現在の空港と経営データは失われます）') && newGame('sandbox')}
            data-testid="new-sandbox"
          >
            サンドボックス
          </button>
          <button onClick={() => gameSetupUi.open('new')} title={GAME_UI.setupNewTitle} data-testid="new-game-setup">
            {GAME_UI.setupNew}
          </button>
          <button onClick={() => gameSetupUi.open('settings')} title={GAME_UI.setupSettingsTitle} data-testid="tab-settings">
            {GAME_UI.setupSettings}
          </button>
          <button onClick={actions.loadSample} data-testid="load-sample" title="現在の資金で建設（キャリアでは建設費がかかる）">サンプル空港を生成</button>
          <button onClick={actions.newEmpty} data-testid="new-empty">空の敷地</button>
          <button
            onClick={() => applyOp(setBuildState(layout, 'operational'))}
            title={career ? '計画中の施設をすべて着工する（工期を待って完成）' : '計画・建設中の施設をすべて運用中にする'}
          >
            {career ? '全施設を着工' : '全施設を完成'}
          </button>
        </div>
        <div className="top-group">
          <button onClick={download}>書き出し</button>
          <button onClick={() => fileRef.current?.click()}>読み込み</button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </div>
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
            {(Object.keys(OVERLAY_LABEL) as (keyof Overlays)[]).map((k) => (
              <label key={k}>
                <input type="checkbox" checked={overlays[k]} onChange={() => actions.toggleOverlay(k)} data-testid={`overlay-${k}`} />
                {OVERLAY_LABEL[k]}
              </label>
            ))}
          </div>
        </details>
      ) : (
        <div className="top-group overlays">
          {(Object.keys(OVERLAY_LABEL) as (keyof Overlays)[]).map((k) => (
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
      {mode === 'operate' && <OpsNav />}
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
