import { ops } from '../editor/simRunner';
import { useEditor } from '../editor/store';
import { DAY_LOOP } from '../i18n/ja';

/** 1 日スキップ・夜間の早送りの進捗。画面は止めて計算だけを進めている間、進捗バーと中止ボタンを出す */
export function SkipDayOverlay() {
  const skip = useEditor((s) => s.dayFlow.skip);
  const phase = useEditor((s) => s.dayFlow.phase);
  if (phase !== 'skipping' || !skip) return null;
  const pct = Math.round(skip.progress * 100);
  return (
    <div className="day-skip" data-testid="skip-overlay" role="dialog" aria-label={DAY_LOOP.skipTitleDay}>
      <div className="day-skip-card">
        <h3>{skip.label === 'day' ? DAY_LOOP.skipTitleDay : DAY_LOOP.skipTitleNight}</h3>
        <div className="skip-bar" data-testid="skip-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-progress={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="skip-pct" data-testid="skip-pct">
          {pct}%
        </div>
        <div className="muted small">{DAY_LOOP.skipHint}</div>
        <button onClick={() => ops.cancelSkip()} data-testid="skip-cancel">
          {DAY_LOOP.skipCancel}
        </button>
      </div>
    </div>
  );
}
