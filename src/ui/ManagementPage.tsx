import { AccessPanel, ExpansionPanel } from './AccessPanels';
import { AnalyticsPanel, ScenarioPanel } from './AnalysisPanels';
import { CapacityPanel } from './CapacityPanel';
import { CatalogPanel } from './CatalogPanel';
import { IssuesPanel } from './IssuesPanel';
import { FinancePanel, PlanPanel } from './ManagementPanels';
import { ProjectPanel } from './ProjectPanel';
import { AirlineScoreTable } from './operate/cards/AirlineScoreTable';
import { GoalsPanel } from './operate/cards/GoalsCard';
import { JournalPanel } from './OpsPanels';
import { dayFlowActions } from '../editor/dayFlowActions';

const sections = [
  ['plan', '需要・運航計画'],
  ['capacity', '空港能力'],
  ['contracts', '契約・航空会社'],
  ['access', 'アクセス'],
  ['finance', '収支・財務'],
  ['analysis', '分析・履歴'],
  ['expansion', '拡張計画'],
  ['airport', '空港チェック'],
  ['catalog', '機種カタログ'],
  ['scenarios', 'シナリオ'],
  ['project', 'プロジェクト・保存'],
  ['goals', '目標'],
] as const;
export type ManagementSection = (typeof sections)[number][0];

export function ManagementPage({ onOpenConstruction, section, onSectionChange }: { onOpenConstruction: (id?: string) => void; section: ManagementSection; onSectionChange: (section: ManagementSection) => void }) {
  return <main className="management-page" data-testid="management-page">
    <header className="management-page-head">
      <div><h2>経営</h2><p>空港の需要・処理能力・契約・収支を確認し、計画を判断します。</p></div>
      <button onClick={() => onOpenConstruction()} data-testid="go-construction">建設画面へ</button>
    </header>
    <nav className="management-sections" aria-label="経営メニュー">
      {sections.map(([id, label]) => <button key={id} className={section === id ? 'active' : ''} onClick={() => onSectionChange(id)} data-testid={`management-${id}`}>{label}</button>)}
    </nav>
    <div className="management-content">
      {section === 'plan' ? <PlanPanel /> :
        section === 'capacity' ? <CapacityPanel onSelectFacility={onOpenConstruction} /> :
        section === 'contracts' ? <div className="management-stack"><PlanPanel /><AirlineScoreTable /></div> :
        section === 'access' ? <AccessPanel /> :
        section === 'finance' ? <FinancePanel /> :
        section === 'analysis' ? <div className="management-stack"><AnalyticsPanel /><JournalPanel /><button onClick={() => dayFlowActions.openHistory(true)}>日次振り返りの履歴を開く</button></div> :
        section === 'expansion' ? <ExpansionPanel /> :
        section === 'airport' ? <IssuesPanel /> :
        section === 'catalog' ? <CatalogPanel /> :
        section === 'scenarios' ? <ScenarioPanel /> :
        section === 'project' ? <ProjectPanel /> : <GoalsPanel />}
    </div>
  </main>;
}
