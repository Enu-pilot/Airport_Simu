import { OPS_UI, PROJECT_KIND_LABEL, displayName } from '../../../i18n/ja';
import { useCompany } from '../../ManagementPanels';
import { useOps } from '../../OpsPanels';
import { Card } from '../Card';
import { focusTarget } from '../focus';

/** 工事中の施設と残り日数（キャリアモードの工事。残り日数は運航した日で進む） */
export function ConstructionCard() {
  const c = useCompany();
  const o = useOps();
  if (!o) return null;
  const layout = o.sim.ctx.layout;
  const list = Object.values(c.projects ?? {}).sort((a, b) => a.remaining - b.remaining);
  return (
    <Card id="construction" title={OPS_UI.constructionTitle} open="expansion" badge={list.length > 0 ? OPS_UI.projectsCount(list.length) : undefined}>
      {list.length === 0 && <div className="card-sub">{OPS_UI.noProjects}</div>}
      {list.map((p) => (
        <div key={p.id} className="card-item" data-testid={`card-project-${p.id}`}>
          <button className="link" onClick={() => focusTarget(p.id)} title={OPS_UI.jump}>
            {displayName(layout, p.id)}
          </button>
          <span className="muted">
            {PROJECT_KIND_LABEL[p.kind]} · {OPS_UI.remainingDays(p.remaining)}
          </span>
        </div>
      ))}
    </Card>
  );
}
