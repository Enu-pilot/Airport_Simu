import { airlineDef } from '../../../core/economy/registry';
import { AIRLINE_TYPE_LABEL, OPS_UI, SCORE_LABEL, SCORE_LEVEL_LABEL, complaintDetailText, lackingText, scoreText } from '../../../i18n/ja';
import { useScorecard } from './useScorecard';
import { useOps } from '../../OpsPanels';
import { GAME_UI } from '../../../i18n/ja';

/**
 * 航空会社ごとの評価の詳細（要素別の点数と「足りないもの」）。既存のデータからの導出で、満足度の計算には使わない。
 * 点数は 0〜100 のゲーム用の指標。
 */
export function AirlineScoreTable() {
  const scores = useScorecard();
  const evalState = useOps()?.sim.company?.airlineEval;
  return (
    <div className="issues" data-testid="airline-scores">
      <div className="issues-header">
        <strong>{OPS_UI.airlineTitle}</strong>
        <span className="muted">{OPS_UI.airlineNote}</span>
      </div>
      <div className="issues-list score-grid">
        {(scores ?? []).map((s) => {
          const def = airlineDef(s.airlineId);
          return (
            <section key={s.airlineId} className={`score-panel ${s.active ? '' : 'inactive'}`} data-testid={`airline-score-${s.airlineId}`}>
              <h4>
                {def.code} {def.name} <span className="muted small">{AIRLINE_TYPE_LABEL[def.type]}{s.active ? '' : `・${OPS_UI.noContract}`}</span>
                <span className="score-sat">
                  {OPS_UI.satisfaction} <b>{Math.round(s.satisfaction)}</b>
                </span>
              </h4>
              <div className="score-rows">
                {s.components.map((c) => (
                  <div key={c.key} className={`score-row ${c.level}`} data-testid={`airline-score-${s.airlineId}-${c.key}`}>
                    <span className="score-label">{SCORE_LABEL[c.key]}</span>
                    <span className="bar">
                      <span style={{ width: `${c.score ?? 0}%` }} />
                    </span>
                    <span className="score-num">{c.score ?? '—'}</span>
                    <span className="score-level">{SCORE_LEVEL_LABEL[c.level]}</span>
                    <span className="score-text">{scoreText(c)}</span>
                    {evalState?.[s.airlineId]?.ema[c.key] !== undefined && (
                      <span className="muted small" title={GAME_UI.emaCol} data-testid={`airline-ema-${s.airlineId}-${c.key}`}>
                        {GAME_UI.emaCol} {Math.round(evalState[s.airlineId]!.ema[c.key]!)}{' '}
                        {c.score !== null ? (c.score >= evalState[s.airlineId]!.ema[c.key]! ? GAME_UI.trendUp : GAME_UI.trendDown) : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {evalState?.[s.airlineId]?.complaints.map((x) => {
                const comp = s.components.find((c) => c.key === x.key);
                return (
                  <div key={x.key} className="score-lacking ng-text" data-testid={`airline-complaint-${s.airlineId}-${x.key}`}>
                    {GAME_UI.complaintTitle}: {GAME_UI.complaintOf(SCORE_LABEL[x.key])}
                    {comp ? <div className="muted small">{complaintDetailText(comp)}</div> : null}
                  </div>
                );
              })}
              {evalState?.[s.airlineId]?.requests.map((x) => (
                <div key={x.id} className="score-lacking warn-text" data-testid={`airline-request-${s.airlineId}-${x.kind}`}>
                  {GAME_UI.requestTitle}: {GAME_UI.requestText(x.kind, x.arg)}（{GAME_UI.requestDue(x.dueDay)}）
                </div>
              ))}
              <div className={s.lacking.length ? 'score-lacking warn-text' : 'score-lacking muted'} data-testid={`airline-lacking-${s.airlineId}`}>
                {lackingText(s)}
              </div>
            </section>
          );
        })}
        {scores === null && <div className="empty">{OPS_UI.kpiNone}</div>}
      </div>
    </div>
  );
}
