import type { ReactNode } from 'react';
import { OPS_NAV } from '../../i18n/ja';
import { AccessPanel, ExpansionPanel } from '../AccessPanels';
import { AnalyticsPanel, ScenarioPanel } from '../AnalysisPanels';
import { CatalogPanel } from '../CatalogPanel';
import { IssuesPanel } from '../IssuesPanel';
import { FinancePanel, PlanPanel } from '../ManagementPanels';
import { BaggageBoard, DisruptionBoard, EventLog, GroundBoard, TerminalBoard } from '../OpsPanels';
import { ProjectPanel } from '../ProjectPanel';
import { AirlineScoreTable } from './cards/AirlineScoreTable';
import { GoalsPanel } from './cards/GoalsCard';
import { opsUi, useOpsUi, type OverlayKey } from './opsUi';

const BODY: Record<OverlayKey, () => ReactNode> = {
  terminal: () => <TerminalBoard />,
  ground: () => <GroundBoard />,
  baggage: () => <BaggageBoard />,
  events: () => <EventLog />,
  disruptions: () => <DisruptionBoard />,
  plan: () => <PlanPanel />,
  finance: () => <FinancePanel />,
  access: () => <AccessPanel />,
  expansion: () => <ExpansionPanel />,
  analytics: () => <AnalyticsPanel />,
  scenarios: () => <ScenarioPanel />,
  catalog: () => <CatalogPanel />,
  project: () => <ProjectPanel />,
  issues: () => <IssuesPanel />,
  airlines: () => <AirlineScoreTable />,
  goals: () => <GoalsPanel />,
};

/**
 * 大きなオーバーレイ（マップ中央・右列・下部の詳細の上に重ねる）。上部バーと左列（時計・倍率・停止）は覆わない。
 * 中身は従来のパネル部品そのもの。閉じる: × / Esc（App のキー処理）/ 同じボタンをもう一度 / モードの変更。
 */
export function DetailOverlay() {
  const key = useOpsUi((s) => s.overlay);
  if (!key) return null;
  const label = OPS_NAV.find(([k]) => k === key)?.[1] ?? key;
  return (
    <div className="ops-overlay" data-testid="detail-overlay" role="dialog" aria-label={label}>
      <div className="ops-overlay-head">
        <strong>{label}</strong>
        <button onClick={() => opsUi.closeOverlay()} data-testid="overlay-close" title="閉じる（Esc）">
          ×
        </button>
      </div>
      <div className="ops-overlay-body">{BODY[key]()}</div>
    </div>
  );
}
