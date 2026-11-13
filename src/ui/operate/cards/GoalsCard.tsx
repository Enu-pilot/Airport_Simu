import { GOALS, nextGoals } from '../../../core/economy/goals';
import { formatCr } from '../../../editor/store';
import { GAME_UI } from '../../../i18n/ja';
import { useOps } from '../../OpsPanels';
import { Card, useSecondly } from '../Card';

/** 目標（次の 3 つ）。game.goals の会社だけ。詳細（全目標・報酬の記録）は「目標」オーバーレイ */
export function GoalsCard() {
  useSecondly(() => 0);
  const o = useOps();
  const g = o?.sim.company?.goals;
  if (!o || !g) return null;
  const next = nextGoals(g);
  return (
    <Card id="goals" title={GAME_UI.goalsTitle} open="goals" badge={GAME_UI.tier[g.tier]}>
      <div data-testid="goals-card">
        {next.length === 0 && <div className="card-sub">{GAME_UI.goalsAllDone}</div>}
        {next.map((d) => (
          <div key={d.id} className="card-item" data-testid={`goal-${d.id}`}>
            {GAME_UI.goal[d.id]?.title} <span className="muted small">（{GAME_UI.goal[d.id]?.reward}）</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 目標の全一覧・空港の格・報酬の記録（大きなオーバーレイ） */
export function GoalsPanel() {
  const o = useOps();
  const g = o?.sim.company?.goals;
  if (!g) return <div className="empty">{GAME_UI.goalsAllDone}</div>;
  return (
    <div className="issues" data-testid="goals-panel">
      <div className="issues-header">
        <strong data-testid="goals-tier">{GAME_UI.tierLabel(GAME_UI.tier[g.tier]!)}</strong>
        <span className="muted">{GAME_UI.goalsOverlayNote}</span>
      </div>
      <div className="issues-list">
        {GOALS.map((d) => (
          <div key={d.id} className={g.done[d.id] !== undefined ? 'card-row ok' : 'card-row'} data-testid={`goal-row-${d.id}`}>
            <span className="card-label">
              {g.done[d.id] !== undefined ? '✓ ' : ''}
              {GAME_UI.goal[d.id]?.title}
            </span>
            <span className="card-value">{g.done[d.id] !== undefined ? GAME_UI.goalsDone(g.done[d.id]!) : GAME_UI.goal[d.id]?.reward}</span>
          </div>
        ))}
        {g.grants.slice(-8).reverse().map((x, i) => (
          <div key={i} className="card-sub">
            {x.day + 1}日目 {GAME_UI.goal[x.id]?.title}: {x.amount > 0 ? formatCr(x.amount) : GAME_UI.goal[x.id]?.reward}
          </div>
        ))}
      </div>
    </div>
  );
}
