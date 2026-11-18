import { GOALS, chainGoalInfo, nextGoals, type GoalDef } from '../../../core/economy/goals';
import { formatCr } from '../../../editor/store';
import { GAME_UI } from '../../../i18n/ja';
import { useOps } from '../../OpsPanels';
import { Card, useSecondly } from '../Card';

/** 固定目標は GAME_UI の文言、連鎖目標（chain-N）は生成パラメータから組み立てる */
export function goalText(d: Pick<GoalDef, 'id'>): { title: string; reward: string } {
  const fixed = GAME_UI.goal[d.id];
  if (fixed) return fixed;
  const info = chainGoalInfo(Number(d.id.replace('chain-', '')) || 0);
  const title = info.kind === 'movements'
    ? `連鎖目標: 1 日 ${info.target} 発着`
    : info.kind === 'pax'
      ? `連鎖目標: 旅客 ${info.target.toLocaleString()} 人/日`
      : `連鎖目標: 定時率 ${Math.round(info.target * 100)}% を ${info.streakDays} 日連続`;
  return { title, reward: `${formatCr(info.cash)}${info.kind === 'otp' ? '・評価 +1' : ''}` };
}

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
            {goalText(d).title} <span className="muted small">（{goalText(d).reward}）</span>
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
            {x.day + 1}日目 {goalText(x).title}: {x.amount > 0 ? formatCr(x.amount) : goalText(x).reward}
          </div>
        ))}
      </div>
    </div>
  );
}
