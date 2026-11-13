import type { WeatherForecast } from '../../core/sim/weather';
import { GAME_UI } from '../../i18n/ja';

/** 天候の段階の色分けの札（0 = 晴れ … 4 = 悪天）。表示だけ */
export function LevelChip({ level, type, testId }: { level: number; type: string; testId?: string }) {
  return (
    <span className={`wx-chip wx-l${level}`} data-level={level} data-testid={testId}>
      {GAME_UI.wxType[type] ?? type} {level}
    </span>
  );
}

/** 予報（6〜12・12〜18・18〜24 時の最大段階と種類） */
export function ForecastBlocks({ f, testId }: { f: WeatherForecast; testId: string }) {
  return (
    <div className="wx-forecast" data-testid={testId}>
      {f.blocks.map((b) => (
        <div key={b.fromH} className="wx-block" data-testid={`${testId}-${b.fromH}`}>
          <span className="muted small">{GAME_UI.wxBlock(b.fromH, b.toH)}</span>
          <LevelChip level={b.level} type={b.type} />
        </div>
      ))}
      <div className="muted small">{GAME_UI.wxForecastNote(f.accuracy)}</div>
    </div>
  );
}
