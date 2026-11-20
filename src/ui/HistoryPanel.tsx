import { useCallback, useEffect, useState } from 'react';
import { formatCr, useEditor } from '../editor/store';
import { getHistoryStore, UNSAVED_KEY, type DayHistorySummary } from '../editor/dayHistoryStore';
import { notifyHistoryChanged, onHistoryChanged } from '../editor/dayHistory';
import { projectActions } from '../editor/project';
import { ops } from '../editor/simRunner';
import { dayFlowActions } from '../editor/dayFlowActions';
import { DAY_LOOP } from '../i18n/ja';

/** 日ごとの履歴の一覧（読み込み・振り返り・削除）。プロジェクトのパネルと、履歴のオーバーレイで使う */
export function HistoryList() {
  const key = useEditor((s) => s.projectId ?? UNSAVED_KEY);
  const operating = useEditor((s) => s.mode === 'operate');
  const [rows, setRows] = useState<DayHistorySummary[] | null>(null);
  const [memory, setMemory] = useState(false);
  const reload = useCallback(() => {
    void getHistoryStore()
      .then(async (st) => {
        setMemory(st.kind === 'memory');
        setRows(await st.list(key));
      })
      .catch(() => setRows([]));
  }, [key]);
  useEffect(() => {
    reload();
    return onHistoryChanged(reload);
  }, [reload]);

  return (
    <div data-testid="history-list">
      {memory && <div className="warn-text small">{DAY_LOOP.historyMemory}</div>}
      <div className="muted small">{DAY_LOOP.historyNote}</div>
      {rows !== null && rows.length === 0 && <div className="empty" data-testid="history-empty">{DAY_LOOP.historyEmpty}</div>}
      {rows !== null && rows.length > 0 && (
        <table className="board">
          <thead>
            <tr>
              <th>日</th>
              <th>資金</th>
              <th>評価</th>
              <th>営業利益</th>
              <th>保存</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.day} data-testid={`history-row-${r.day}`}>
                <td>{DAY_LOOP.historyDay(r.day)}</td>
                <td className="num">{formatCr(r.cash)}</td>
                <td className="num">{r.rating.toFixed(1)}</td>
                <td className="num">{formatCr(r.operatingProfit)}</td>
                <td className="small muted">{r.sizeKB} KB</td>
                <td>
                  <button onClick={() => ops.viewReview(r.review)} data-testid={`history-view-${r.day}`}>
                    {DAY_LOOP.historyView}
                  </button>{' '}
                  <button
                    className="primary"
                    disabled={operating}
                    title={operating ? DAY_LOOP.historyRestoreBlocked : undefined}
                    onClick={() => {
                      if (window.confirm(DAY_LOOP.historyRestoreConfirm(r.day))) {
                        void projectActions.restoreHistory(r.day).then((v) => {
                          if (v.ok) dayFlowActions.openHistory(false);
                        });
                      }
                    }}
                    data-testid={`history-restore-${r.day}`}
                  >
                    {DAY_LOOP.historyRestore}
                  </button>{' '}
                  <button
                    onClick={() => void getHistoryStore().then((st) => st.remove(key, r.day)).then(notifyHistoryChanged)}
                    data-testid={`history-delete-${r.day}`}
                  >
                    {DAY_LOOP.historyDelete}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
