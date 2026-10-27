import { useEffect, useRef } from 'react';
import { MapView } from '../render/MapView';
import { actions, replaceLayout, showToast, useAnalysis, useEditor, useLayout } from '../editor/store';
import { onKeyDown, onKeyUp } from '../editor/input';
import { exportLayout, importLayout } from '../core/io/serialize';
import { setBuildState } from '../core/layout/operations';
import { applyOp } from '../editor/store';
import { Toolbox, toolHint } from './Toolbox';
import { FacilityList } from './FacilityList';
import { PropertiesPanel } from './PropertiesPanel';
import { IssuesPanel } from './IssuesPanel';
import type { Overlays } from '../editor/store';

const OVERLAY_LABEL: Record<keyof Overlays, string> = {
  grid: 'グリッド',
  buildable: '建設不可エリア',
  network: '論理ネットワーク',
  issues: 'エラー表示',
  labels: 'ラベル',
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

  return (
    <div className="app">
      <TopBar />
      <aside className="left">
        <Toolbox />
        <FacilityList />
      </aside>
      <main className="center">
        <MapView />
        <StatusBar />
        <Toast />
      </main>
      <aside className="right">
        <PropertiesPanel />
      </aside>
      <footer className="bottom">
        <IssuesPanel />
      </footer>
    </div>
  );
}

function TopBar() {
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const overlays = useEditor((s) => s.overlays);
  const layout = useLayout();
  const fileRef = useRef<HTMLInputElement>(null);

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
      <span className="subtitle">建設エディタ</span>
      <div className="top-group">
        <button onClick={actions.undo} disabled={!canUndo} title="Ctrl+Z" data-testid="undo">
          ↶ 元に戻す
        </button>
        <button onClick={actions.redo} disabled={!canRedo} title="Ctrl+Shift+Z" data-testid="redo">
          ↷ やり直し
        </button>
      </div>
      <div className="top-group">
        <button onClick={actions.loadSample} data-testid="load-sample">サンプル空港を生成</button>
        <button onClick={actions.newEmpty} data-testid="new-empty">空の敷地</button>
        <button onClick={() => applyOp(setBuildState(layout, 'operational'))} title="計画・建設中の施設をすべて運用中にする">
          全施設を完成
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

function StatusBar() {
  const hover = useEditor((s) => s.hover);
  const zoom = useEditor((s) => s.camera.zoom);
  const tool = useEditor((s) => s.tool);
  const draft = useEditor((s) => s.draft);
  const analysis = useAnalysis();
  const layout = useLayout();
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
      <span className="hint">{draft?.kind === 'path' ? `頂点 ${draft.points.length} — ダブルクリック/Enter/右クリックで確定、Esc で取り消し` : toolHint(tool)}</span>
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
