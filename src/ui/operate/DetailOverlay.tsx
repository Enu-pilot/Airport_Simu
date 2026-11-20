import type { ReactNode } from 'react';
import { OPS_NAV } from '../../i18n/ja';
import { AccessPanel, ExpansionPanel } from '../AccessPanels';
import { AnalyticsPanel, ScenarioPanel } from '../AnalysisPanels';
import { CatalogPanel } from '../CatalogPanel';
import { IssuesPanel } from '../IssuesPanel';
import { FinancePanel, PlanPanel } from '../ManagementPanels';
import { BaggageBoard, DisruptionBoard, EventLog, GroundBoard, JournalPanel, TerminalBoard } from '../OpsPanels';
import { ProjectPanel } from '../ProjectPanel';
import { AirlineScoreTable } from './cards/AirlineScoreTable';
import { GoalsPanel } from './cards/GoalsCard';
import { FidsBoard } from './FidsBoard';
import { opsUi, useOpsUi, type OverlayKey } from './opsUi';

const BODY: Record<OverlayKey, () => ReactNode> = {
  flights: () => <FidsBoard />,
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
  journal: () => <JournalPanel />,
};

/** ボードで開けるオーバーレイの一覧（運航表 flights は全列表示がボード側にあるため含む。浮動パネルは要約表示） */
export const OPS_BOARD_KEYS = Object.keys(BODY) as OverlayKey[];

/** オーバーレイの表示名（OPS_NAV が正本。見つからなければキーそのもの） */
export function overlayLabel(key: OverlayKey): string {
  return OPS_NAV.find(([k]) => k === key)?.[1] ?? key;
}

/**
 * 運航ボード（UIデザイン更新 第4段階）: 運航ナビの大きなパネル群を、経営ボード（第3段階）と
 * 同じボードモードで開く。地図ワークスペースの上に背面を薄く残してシートを重ね、
 * 閉じる: × / Esc（App のキー処理）/ 背面クリック / 同じボタンをもう一度 / モードの変更。
 * 中身は従来のパネル部品そのもの。状態は opsUi（従来のオーバーレイと同じ置き場所）。
 */
export function OpsBoard() {
  const key = useOpsUi((s) => s.overlay);
  if (!key) return null;
  const label = overlayLabel(key);
  return (
    <div className="board-overlay ops-board-overlay">
      <div className="board-backdrop" onClick={() => opsUi.closeOverlay()} aria-hidden="true" />
      <div className="ops-board-sheet" data-testid="detail-overlay" role="dialog" aria-label={label}>
        <div className="ops-overlay-head">
          <strong>{label}</strong>
          <button onClick={() => opsUi.closeOverlay()} data-testid="overlay-close" title="閉じる（Esc）">
            ×
          </button>
        </div>
        <div className="ops-overlay-body">{BODY[key]()}</div>
      </div>
    </div>
  );
}
