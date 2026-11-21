import { formatCr, setOpsPrefs, useEditor } from '../../editor/store';
import { ops } from '../../editor/simRunner';
import { formatSimTime } from '../../i18n/ja';
import { useOps } from '../OpsPanels';

/**
 * 無描画運行モード（性能改善計画 第5弾）の最小ステータス表示。
 * 地図・運行表・カードを描画しない代わりに、運航の継続に必要な最小限の状態だけを出す。
 * 値の更新は simRunner の公開間引きに従うため、運航中は約1秒間隔になる（このコンポーネント
 * 自身は useOps の購読で再描画されるだけで、独自のタイマーは持たない）。
 * 一時停止／再開と速度変更は左列の運航コントロール、日報は締め後にここか上部バーから開く。
 */
export function HeadlessStatus() {
  const o = useOps();
  const hasReview = useEditor((s) => s.dayFlow.review !== null);
  if (!o) return null;
  const { state } = o.sim;
  const c = o.sim.company;
  const st = state.stats;
  return (
    <div className="headless-status" data-testid="headless-status">
      <div className="headless-title">無描画で運航中</div>
      <div className="sim-clock" data-testid="headless-clock">
        {formatSimTime(state.now + (state.economy?.dayOffset ?? 0) * 86400, true)}
      </div>
      <div className="stat-grid headless-grid">
        <span>資金</span>
        <b data-testid="headless-cash">{c ? formatCr(c.cash) : '—'}</b>
        <span>評価</span>
        <b data-testid="headless-rating">{c ? c.rating.toFixed(1) : '—'}</b>
        <span>着陸</span>
        <b>{st.arrivals}</b>
        <span>離陸</span>
        <b>{st.departures}</b>
        <span>欠航</span>
        <b>{st.cancelled}</b>
        <span>速度</span>
        <b data-testid="headless-speed">{o.clock.speed === 0 ? '一時停止中' : `×${o.clock.speed}`}</b>
      </div>
      {o.dropped && <div className="warn-text">処理が追いつかないため、ゲーム内時間を遅らせています</div>}
      <div className="headless-actions">
        <button onClick={() => setOpsPrefs({ noRender: false })} data-testid="headless-exit">
          描画に戻る
        </button>
        <button onClick={() => ops.openReview()} disabled={!hasReview} data-testid="headless-review">
          日報を見る
        </button>
      </div>
      <div className="muted small">
        地図・運行表・カード・アラートは表示されません。状態表示は約1秒ごとに更新されます。
        一時停止／再開・速度変更は左の運航コントロールから行えます。
      </div>
    </div>
  );
}
