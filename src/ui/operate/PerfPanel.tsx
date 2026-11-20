import { useEffect, useState } from 'react';
import { peekPerfSnapshot, takePerfSnapshot, type PerfStepKey } from '../../core/sim/perfStats';
import { editorStore, useEditor } from '../../editor/store';

const STEP_LABEL: Record<PerfStepKey, string> = {
  economy: '経済・日次',
  disruptions: '障害・天候',
  runwayTaxi: '滑走路・誘導路管制',
  aircraft: '機体',
  passengers: '旅客',
  accessBus: 'アクセス・バス',
  baggage: '手荷物',
  ground: '地上支援',
  conflicts: '競合検知',
  analytics: '分析記録',
  other: 'その他',
};

const fmtMs = (ms: number): string => (ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));

/**
 * 性能計測パネル（perf-audit.md §7）: tick 合計・サブステップ内訳・描画・規模・dropped を
 * 直近ウィンドウ（最大5秒）の平均で表示する。トグルで開閉し、既定は閉。
 * 開いている間は5秒ごとに集計ウィンドウをリセットし、表示は購読更新（約10Hz）のたびに peek で読む。
 * 計測値の取得は読み取り専用で、運航結果には影響しない。
 */
export function PerfPanel() {
  // useOps と同じ購読（約10Hz）。OpsPanels との循環 import を避けるためここで直接購読する
  useEditor((s) => s.ops?.uiVersion ?? -1);
  const o = editorStore.getState().ops;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    takePerfSnapshot(); // 開いた時点からウィンドウを始める
    const id = setInterval(() => takePerfSnapshot(), 5000);
    return () => clearInterval(id);
  }, [open ]);

  if (!o) return null;
  const snap = open ? peekPerfSnapshot() : null;
  const topSteps = snap ? snap.steps.filter((s) => s.avgMs > 0).slice(0, 5) : [];
  return (
    <div className="perf-panel-wrap">
      <div className="tool-group-title">性能計測</div>
      <button className="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="perf-panel-toggle">
        {open ? '計測を閉じる' : '計測を表示'}
      </button>
      {open && snap && (
        <div className="perf-panel" data-testid="perf-panel">
          <div className="stat-grid">
            <span>tick 合計</span>
            <b data-testid="perf-tick-avg">{fmtMs(snap.tickAvgMs)} ms/tick</b>
            <span>描画</span>
            <b data-testid="perf-draw-avg">{snap.drawCount > 0 ? `${fmtMs(snap.drawAvgMs)} ms/回` : 'なし（地図なし等）'}</b>
            <span>旅客グループ</span>
            <b data-testid="perf-pax-groups">{snap.scale.paxGroups}</b>
            <span>機体</span>
            <b data-testid="perf-aircraft">{snap.scale.aircraft}</b>
            <span>手荷物</span>
            <b data-testid="perf-bags">{snap.scale.bags}</b>
            <span>tick/フレーム</span>
            <b>{snap.ticksPerFrame.toFixed(1)}</b>
            <span>dropped</span>
            <b data-testid="perf-dropped" className={o.dropped || snap.droppedFrames > 0 ? 'ng-text' : ''}>
              {o.dropped ? '発生中' : snap.droppedFrames > 0 ? `${snap.droppedFrames} フレーム` : 'なし'}
            </b>
          </div>
          <div className="tool-group-title">tick 内訳（上位）</div>
          {topSteps.map((s) => (
            <div key={s.key} className="perf-step" data-testid={`perf-step-${s.key}`}>
              <span>{STEP_LABEL[s.key]}</span>
              <b>
                {fmtMs(s.avgMs)} ms（{Math.round(s.share * 100)}%）
              </b>
            </div>
          ))}
          <div className="muted small">直近ウィンドウ（{snap.ticks} tick）の平均です。計測は運航結果に影響しません。</div>
        </div>
      )}
    </div>
  );
}
