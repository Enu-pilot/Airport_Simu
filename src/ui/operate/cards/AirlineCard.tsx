import { airlineDef } from '../../../core/economy/registry';
import { OPS_UI, SCORE_LABEL, complaintDetailText, scoreText } from '../../../i18n/ja';
import { Card } from '../Card';
import { useOps } from '../../OpsPanels';
import { GAME_UI } from '../../../i18n/ja';
import { useScorecard } from './useScorecard';

/** 航空会社の評価（要約）: 満足度と、足りないもの（悪い順に 2 つ）。詳細は「航空会社」オーバーレイ */
export function AirlineCard() {
  const scores = useScorecard();
  const evalState = useOps()?.sim.company?.airlineEval;
  const active = (scores ?? []).filter((s) => s.active);
  return (
    <Card id="airline" title={OPS_UI.airlineTitle} open="airlines">
      {active.length === 0 && <div className="card-sub">{OPS_UI.airlineNone}</div>}
      {active.map((s) => (
        <div key={s.airlineId} className="card-airline" data-testid={`card-airline-${s.airlineId}`}>
          <div className="card-row">
            <span className="card-label">{airlineDef(s.airlineId).name}</span>
            <span className="card-value">
              <span className="bar" title={`${OPS_UI.satisfaction} ${Math.round(s.satisfaction)}`}>
                <span style={{ width: `${Math.max(0, Math.min(100, s.satisfaction))}%` }} />
              </span>{' '}
              <b data-testid={`card-airline-sat-${s.airlineId}`}>{Math.round(s.satisfaction)}</b>
            </span>
          </div>
          <div className={s.lacking.length ? 'card-sub warn-text' : 'card-sub'} data-testid={`card-airline-lacking-${s.airlineId}`}>
            {s.lacking.length ? s.lacking.map((c) => `${SCORE_LABEL[c.key]}: ${scoreText(c)}`).join(' / ') : OPS_UI.lackingNone}
          </div>
          {evalState?.[s.airlineId]?.complaints.map((x) => {
            const comp = s.components.find((c) => c.key === x.key);
            return (
              <div key={x.key} className="card-sub ng-text" data-testid={`airline-complaint-${s.airlineId}`}>
                {GAME_UI.complaintTitle}: {GAME_UI.complaintOf(SCORE_LABEL[x.key])}
                {comp ? <div className="muted small">{complaintDetailText(comp)}</div> : null}
              </div>
            );
          })}
          {evalState?.[s.airlineId]?.requests.map((x) => (
            <div key={x.id} className="card-sub warn-text" data-testid={`airline-request-${s.airlineId}`}>
              {GAME_UI.requestTitle}: {GAME_UI.requestText(x.kind, x.arg)}（{GAME_UI.requestDue(x.dueDay)}）
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}
