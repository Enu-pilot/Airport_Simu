import { useEffect, useRef } from 'react';
import { MapView } from '../render/MapView';
import { actions, editorStore, formatCr, newGame, replaceLayout, showToast, useAnalysis, useEditor, useLayout } from '../editor/store';
import { FinancePanel, PlanPanel, useCompany } from './ManagementPanels';
import { AccessPanel, ExpansionPanel } from './AccessPanels';
import { CatalogPanel } from './CatalogPanel';
import { AnalyticsPanel, ScenarioPanel } from './AnalysisPanels';
import { computePreview } from '../editor/tools';
import { constructionCost } from '../core/economy/construction';
import { MODE_LABEL } from '../i18n/ja';
import { onKeyDown, onKeyUp } from '../editor/input';
import { exportLayout, importLayout } from '../core/io/serialize';
import { setBuildState } from '../core/layout/operations';
import { applyOp } from '../editor/store';
import { Toolbox, toolHint } from './Toolbox';
import { FacilityList } from './FacilityList';
import { PropertiesPanel } from './PropertiesPanel';
import { IssuesPanel } from './IssuesPanel';
import type { Overlays } from '../editor/store';
import { ops } from '../editor/simRunner';
import { AircraftPanel, BaggageBoard, DisruptionBoard, EventLog, FlightBoard, GroundBoard, OpsControls, TerminalBoard } from './OpsPanels';
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
  const hasAircraft = useEditor((s) => !!s.ops?.selectedAircraft);
  return (
    <div className={`app mode-${mode}`}>
      <TopBar />
      <aside className="left">
        {mode === 'build' ? <Toolbox /> : <OpsControls />}
        <FacilityList />
      </aside>
      <main className="center">
        <MapView />
        <StatusBar />
        <Toast />
      </main>
      <aside className="right">{mode === 'operate' && hasAircraft ? <AircraftPanel /> : <PropertiesPanel />}</aside>
      <footer className="bottom">{mode === 'build' ? <BuildBottom /> : <OpsBottom />}</footer>
    </div>
  );
}

type BottomTab = 'flights' | 'terminal' | 'ground' | 'baggage' | 'events' | 'issues' | 'plan' | 'finance' | 'access' | 'expansion' | 'catalog' | 'disruptions' | 'analytics' | 'scenarios';

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
        ) : (
          <IssuesPanel />
        )}
      </div>
    </div>
  );
}

function OpsBottom() {
  const [tab, setTab] = useState<BottomTab>('flights');
  return (
    <div className="tabbed">
      <Tabs
        tabs={[
          ['flights', '運航表'],
          ['terminal', 'ターミナル'],
          ['ground', '地上支援'],
          ['baggage', '手荷物'],
          ['plan', '運航計画'],
          ['finance', '経営'],
          ['disruptions', '天候・障害'],
          ['analytics', '分析'],
          ['scenarios', 'シナリオ'],
          ['access', 'アクセス'],
          ['expansion', '拡張計画'],
          ['catalog', '機種カタログ'],
          ['events', 'イベント'],
          ['issues', '配置チェック'],
        ]}
        tab={tab}
        setTab={setTab}
      />
      <div className="tab-body">{tab === 'flights' ? (
          <FlightBoard />
        ) : tab === 'terminal' ? (
          <TerminalBoard />
        ) : tab === 'ground' ? (
          <GroundBoard />
        ) : tab === 'baggage' ? (
          <BaggageBoard />
        ) : tab === 'plan' ? (
          <PlanPanel />
        ) : tab === 'finance' ? (
          <FinancePanel />
        ) : tab === 'access' ? (
          <AccessPanel />
        ) : tab === 'expansion' ? (
          <ExpansionPanel />
        ) : tab === 'catalog' ? (
          <CatalogPanel />
        ) : tab === 'disruptions' ? (
          <DisruptionBoard />
        ) : tab === 'analytics' ? (
          <AnalyticsPanel />
        ) : tab === 'scenarios' ? (
          <ScenarioPanel />
        ) : tab === 'events' ? (
          <EventLog />
        ) : (
          <IssuesPanel />
        )}</div>
    </div>
  );
}

function TopBar() {
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const overlays = useEditor((s) => s.overlays);
  const layout = useLayout();
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = useEditor((s) => s.mode);
  const career = useEditor((s) => s.company.mode === 'career');

  const download = () => {
    const blob = new Blob([exportLayout(layout)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${layout.name || 'airport'}.skyport.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const upload = async (file: File) => {
    try {
      replaceLayout(importLayout(await file.text()), `${file.name} を読み込みました`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '読み込みに失敗しました', 'error');
    }
  };

  return (
    <header className="top">
      <span className="brand">✈ SkyPort</span>
      <span className="subtitle">{mode === 'build' ? '建設モード' : '運航モード'}</span>
      <CompanyBadge />
      <div className="top-group">
        {mode === 'build' ? (
          <button className="primary" onClick={() => ops.start()} data-testid="start-ops">
            ▶ 運航開始
          </button>
        ) : (
          <>
            <button onClick={() => ops.restart()} data-testid="restart-ops">最初から</button>
            <button
              className="primary"
              onClick={() => {
                if (window.confirm('運航を終了して建設モードに戻りますか？（その日を途中で締め、運航の状態は破棄されます）')) ops.stop();
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
      <div className="top-group overlays">
        {(Object.keys(OVERLAY_LABEL) as (keyof Overlays)[]).map((k) => (
          <label key={k}>
            <input type="checkbox" checked={overlays[k]} onChange={() => actions.toggleOverlay(k)} data-testid={`overlay-${k}`} />
            {OVERLAY_LABEL[k]}
          </label>
        ))}
      </div>
    </header>
  );
}

/** 資金・日・評価 */
function CompanyBadge() {
  const c = useCompany();
  return (
    <span className={`company-badge ${c.cash < 0 ? 'negative' : ''}`} data-testid="company-badge">
      <span>{MODE_LABEL[c.mode]}</span>
      <b data-testid="cash">💴 {formatCr(c.cash)}</b>
      <span data-testid="company-day">{c.day + 1}日目</span>
      <span title="空港評価（旅客満足度・航空会社満足度・定時率から）">評価 {c.rating.toFixed(1)}</span>
      {c.bankrupt && <b className="ng-text">経営破綻</b>}
    </span>
  );
}

function StatusBar() {
  const hover = useEditor((s) => s.hover);
  const zoom = useEditor((s) => s.camera.zoom);
  const tool = useEditor((s) => s.tool);
  const draft = useEditor((s) => s.draft);
  const analysis = useAnalysis();
  const layout = useLayout();
  const mode = useEditor((s) => s.mode);
  const cash = useEditor((s) => s.company.cash);
  // 配置・移動・土地購入のプレビューの建設費（確定時と同じ計算）
  const estimate = (() => {
    if (mode !== 'build' || (tool === 'select' && draft?.kind !== 'move')) return null;
    const p = computePreview(editorStore.getState());
    if (!p?.result.ok) return null;
    const cost = constructionCost(layout, p.result.layout);
    return cost === 0 ? null : cost;
  })();
  return (
    <div className="status" data-testid="status">
      <span data-testid="status-tile">{hover ? `タイル (${hover.x}, ${hover.y})` : 'タイル —'}</span>
      <span>ズーム {zoom.toFixed(1)} px/タイル</span>
      <span>
        滑走路 {Object.keys(layout.runways).length} / 誘導路 {Object.keys(layout.taxiways).length} / スポット {Object.keys(layout.stands).length} / 施設{' '}
        {Object.keys(layout.facilities).length}
      </span>
      <span>
        エラー {analysis.counts.error} · 警告 {analysis.counts.warning}
      </span>
      {estimate !== null && (
        <span className={estimate > cash ? 'ng-text' : ''} data-testid="cost-estimate">
          {estimate >= 0 ? `建設費 ${formatCr(estimate)}` : `払い戻し ${formatCr(-estimate)}`}
          {estimate > cash ? '（資金不足）' : ''}
        </span>
      )}
      <span className="hint">{mode === 'operate' ? '機体をクリックで選択 / Space: 一時停止 / 1〜5: 時間倍率 / 右ドラッグ: パン' : draft?.kind === 'path' ? `頂点 ${draft.points.length} — ダブルクリック/Enter/右クリックで確定、Esc で取り消し` : toolHint(tool)}</span>
    </div>
  );
}

function Toast() {
  const toast = useEditor((s) => s.toast);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} data-testid="toast">
      {toast.text}
    </div>
  );
}
