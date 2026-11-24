import { GOALS, chainGoalInfo, nextGoals, nextTierProgress, tierRoadmap, type GoalDef, type TierProgressItem, type TierRoadmapEntry } from '../../../core/economy/goals';
import type { CompanyState } from '../../../core/economy/company';
import type { FlightRecord } from '../../../core/analytics/records';
import { formatCr } from '../../../editor/store';
import { GAME_UI } from '../../../i18n/ja';
import { resolveType } from '../../../core/sim/aircraftTypes';
import { operableTypes } from '../../../core/sim/context';
import { DAY_SEC } from '../../../core/sim/rules';
import { useOps } from '../../OpsPanels';
import { useCompany } from '../../ManagementPanels';
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

const fmtTierNum = (v: number): string => (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1));

function tierItemText(item: TierProgressItem): { label: string; value: string } {
  const label = {
    movements: GAME_UI.nextTierMovements,
    pax: GAME_UI.nextTierPax,
    rating: GAME_UI.nextTierRating,
    heavy: GAME_UI.nextTierHeavy,
    intlOps: GAME_UI.nextTierIntlOps,
    transferOps: GAME_UI.nextTierTransferOps,
  }[item.key];
  if (item.required !== null && item.current !== null) {
    const base = `${fmtTierNum(item.current)} / ${fmtTierNum(item.required)}`;
    return { label, value: item.met ? `${base} ${GAME_UI.nextTierMet}` : `${base}（${GAME_UI.nextTierShortfall(fmtTierNum(item.shortfall ?? 0))}）` };
  }
  const mark = item.met === null
    ? GAME_UI.nextTierUnknown
    : item.met
      ? GAME_UI.nextTierMet
      : item.key === 'heavy' ? GAME_UI.nextTierCannot : GAME_UI.nextTierMissing;
  return { label, value: mark };
}

type Ops = NonNullable<ReturnType<typeof useOps>>;

/**
 * 締め（evaluateGoals）と同じ定義で到達度の材料をそろえる: 大型機は現在の空港の運航可否、
 * 国際線・乗継の実績は直近の締め日（現在の期間の開始から 1 日分）の記録で見る。
 * 運航中でない（経営ボードを建設モードで開いた等）場合は材料がなく undefined（到達度は不明表示）。
 */
function tierFacts(o: Ops | null, c: CompanyState): { largeOperable: boolean; records?: readonly FlightRecord[] } | undefined {
  if (!o) return undefined;
  const largeOperable = operableTypes(o.sim.ctx).some((t) => resolveType(o.sim.ctx.types, t).size === 'L');
  const periodStart = o.sim.state.economy?.periodStart ?? o.sim.state.now;
  const records = c.reports.length > 0
    ? o.sim.state.analytics.records.filter((r) => {
      const t = r.takeoffAt ?? r.blockOut ?? r.landedAt ?? r.depScheduled;
      return t >= periodStart - DAY_SEC && t < periodStart;
    })
    : undefined;
  return { largeOperable, records };
}

/** 次の格までの到達度（5-20 T6。表示のみで判定には使わない） */
export function NextTierView({ o, panel }: { o: Ops; panel?: boolean }) {
  const c = o.sim.company;
  if (!c?.goals) return null;
  const p = nextTierProgress(c, tierFacts(o, c));
  if (!p) return null;
  if (p.next === null) return <div className="card-sub" data-testid="next-tier">{GAME_UI.nextTierMax}</div>;
  const rows = p.items.map((item) => ({ key: item.key as string, ...tierItemText(item) }));
  if (p.streak) rows.push({ key: 'streak', label: GAME_UI.nextTierStreak(p.streak.current, p.streak.required), value: '' });
  return (
    <div data-testid="next-tier">
      <div className="card-sub">{GAME_UI.nextTierTitle(GAME_UI.tier[p.next]!)}</div>
      {rows.map((r) => (panel
        ? (
          <div key={r.key} className="card-row" data-testid={`next-tier-${r.key}`}>
            <span className="card-label">{r.label}</span>
            <span className="card-value">{r.value}</span>
          </div>
        )
        : <div key={r.key} className="card-item" data-testid={`next-tier-${r.key}`}>{r.value ? `${r.label} ${r.value}` : r.label}</div>))}
      {panel && <div className="card-sub">{p.reportDay !== null ? GAME_UI.nextTierBasedOn(p.reportDay) : GAME_UI.nextTierNoReport}</div>}
      {panel && p.items.some((i) => i.key === 'intlOps' || i.key === 'transferOps') && <div className="card-sub">{GAME_UI.nextTierRecordNote}</div>}
    </div>
  );
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
        <NextTierView o={o} />
      </div>
    </Card>
  );
}

function roadmapStatusText(status: TierRoadmapEntry['status']): string {
  return {
    achieved: GAME_UI.roadmapAchieved,
    current: GAME_UI.roadmapCurrent,
    next: GAME_UI.roadmapNext,
    locked: GAME_UI.roadmapLocked,
  }[status];
}

/** 全ての格のロードマップ（2026-GOALS。格ごとの要件・現在の達成状況・連続達成と最長記録） */
export function TierRoadmapView({ c, o }: { c: CompanyState; o: Ops | null }) {
  const rm = tierRoadmap(c, tierFacts(o, c));
  if (!rm) return null;
  return (
    <div data-testid="tier-roadmap">
      <div className="card-sub">{GAME_UI.roadmapTitle}</div>
      {rm.streak
        ? <div className="card-sub" data-testid="roadmap-streak">{GAME_UI.nextTierStreak(rm.streak.current, rm.streak.required)}（{GAME_UI.roadmapBestStreak(rm.streak.best)}）</div>
        : <div className="card-sub">{GAME_UI.nextTierMax}</div>}
      {rm.entries.map((e) => (
        <div key={e.tier} data-testid={`roadmap-tier-${e.tier}`} data-status={e.status}>
          <div className="card-row">
            <span className="card-label">
              {GAME_UI.tier[e.tier]} <span className="muted small">{roadmapStatusText(e.status)}</span>
            </span>
            <span className="card-value">{e.reachedDay !== null ? GAME_UI.tierReachedDay(e.reachedDay) : ''}</span>
          </div>
          {e.items.map((item) => {
            const { label, value } = tierItemText(item);
            return (
              <div key={item.key} className="card-row" data-testid={`roadmap-tier-${e.tier}-${item.key}`}>
                <span className="card-label">{label}</span>
                <span className="card-value">{value}</span>
              </div>
            );
          })}
          {e.req && (
            <div className="card-row" data-testid={`roadmap-tier-${e.tier}-streakDays`}>
              <span className="card-label">{GAME_UI.roadmapStreakLabel}</span>
              <span className="card-value">{GAME_UI.roadmapStreakDays(e.req.streakDays)}</span>
            </div>
          )}
        </div>
      ))}
      <div className="card-sub">{rm.reportDay !== null ? GAME_UI.nextTierBasedOn(rm.reportDay) : GAME_UI.nextTierNoReport}</div>
      {rm.entries.some((e) => e.items.some((i) => i.key === 'intlOps' || i.key === 'transferOps')) && <div className="card-sub">{GAME_UI.nextTierRecordNote}</div>}
    </div>
  );
}

/** 目標の全一覧・空港の格ロードマップ・報酬の記録（大きなオーバーレイ／経営ボードの目標タブ） */
export function GoalsPanel() {
  // 会社は useCompany（運航中は sim の会社・建設中はストアの会社）から取る。
  // 運航中のみの useOps では建設モードで会社を引けず、目標タブが空になっていた（2026-GOALS）。
  const c = useCompany();
  const o = useOps();
  const g = c.goals;
  if (!g) return <div className="empty">{GAME_UI.goalsNone}</div>;
  return (
    <div className="issues" data-testid="goals-panel">
      <div className="issues-header">
        <strong data-testid="goals-tier">{GAME_UI.tierLabel(GAME_UI.tier[g.tier]!)}</strong>
        <span className="muted">{GAME_UI.goalsOverlayNote}</span>
      </div>
      <TierRoadmapView c={c} o={o} />
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
