import { editorStore, formatCr, scaledConstructionCost, useAnalysis, useEditor, useLayout } from '../editor/store';
import { computePreview } from '../editor/tools';
import { constructionCost } from '../core/economy/construction';
import { toolHint } from './Toolbox';

export function StatusBar() {
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
    const cost = scaledConstructionCost(editorStore.getState().company, constructionCost(layout, p.result.layout));
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

export function Toast() {
  const toast = useEditor((s) => s.toast);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} data-testid="toast">
      {toast.text}
    </div>
  );
}
