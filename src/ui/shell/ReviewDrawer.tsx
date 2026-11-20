import { useEffect, useRef } from 'react';
import { useEditor } from '../../editor/store';
import { dayFlowActions } from '../../editor/dayFlowActions';
import { ops } from '../../editor/simRunner';
import { SHELL_UI } from '../../i18n/ja';
import { DayReviewPanel } from '../DayReview';
import { HistoryList } from '../HistoryPanel';
import { reviewUi, useReviewUi } from './reviewUi';

/**
 * UIデザイン更新 第5段階: 日報ドロワー。
 * 従来は全画面オーバーレイだった日次振り返りと履歴を、右ドロワー（地図は背後に残る）の
 * タブとして同居させる。重なり順は運航ボード（20）・経営ボード（25）より上の 30。
 * 中身（DayReviewPanel / HistoryList）は従来の部品をそのまま使う。
 * ライブの振り返り（締め直後）は「次の日へ／建設に戻る」の選択が必須なので × では閉じない。
 */
export function ReviewDrawer() {
  const df = useEditor((s) => s.dayFlow);
  const mode = useEditor((s) => s.mode);
  const live = mode === 'operate' && df.phase === 'review';
  const review = live ? df.review : df.viewing;
  const reviewKey = review ? `${live ? 'live' : 'view'}:${review.day}` : null;
  const hasReview = review !== null;
  const historyOpen = df.historyOpen;
  const tab = useReviewUi((s) => s.tab);

  // 開くきっかけ（履歴を開く／新しい振り返り）にタブを同期する。以降の手動選択は尊重される
  useEffect(() => {
    reviewUi.syncDrawer({ historyOpen, reviewKey, hasReview });
  }, [historyOpen, reviewKey, hasReview]);

  // ドロワーが閉じたらタイムラインの時間帯指定を消す
  const visible = review !== null || historyOpen;
  const wasVisible = useRef(false);
  useEffect(() => {
    if (wasVisible.current && !visible) reviewUi.clearFocusHour();
    wasVisible.current = visible;
  }, [visible]);

  if (!review && !historyOpen) return null;
  const showReview = tab === 'review' && review !== null;
  return (
    <div className="review-drawer" data-testid="review-drawer">
      <div className="review-drawer-tabs" role="tablist" aria-label={SHELL_UI.drawerLabel}>
        {review && (
          <button
            className={showReview ? 'active' : ''}
            onClick={() => reviewUi.setTab('review')}
            data-testid="review-drawer-tab-review"
            aria-pressed={showReview}
          >
            {SHELL_UI.drawerReviewTab}
          </button>
        )}
        <button
          className={!showReview ? 'active' : ''}
          onClick={() => reviewUi.setTab('history')}
          data-testid="review-drawer-tab-history"
          aria-pressed={!showReview}
        >
          {SHELL_UI.drawerHistoryTab}
        </button>
        {!showReview ? (
          <button
            className="review-drawer-close"
            onClick={() => {
              dayFlowActions.openHistory(false);
              if (review) reviewUi.setTab('review');
            }}
            data-testid="history-close"
            title="閉じる"
          >
            ×
          </button>
        ) : !live ? (
          <button
            className="review-drawer-close"
            onClick={() => ops.viewReview(null)}
            data-testid="review-drawer-close"
            title="閉じる"
          >
            ×
          </button>
        ) : null}
      </div>
      {showReview ? (
        <DayReviewPanel />
      ) : (
        <div className="review-drawer-history" data-testid="history-overlay" role="dialog" aria-label={SHELL_UI.drawerHistoryTab}>
          <HistoryList />
        </div>
      )}
    </div>
  );
}
