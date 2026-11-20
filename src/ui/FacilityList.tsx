import { useMemo, useState } from 'react';
import { sortedValues } from '../core/model/ids';
import { isFreeRunway, type AirportLayout, type BuildState } from '../core/model/types';
import { FACILITY_SPECS } from '../core/model/catalog';
import { useAnalysis, useEditor, useLayout } from '../editor/store';
import { focusEntity } from '../editor/input';
import { BUILD_STATE_LABEL, NODE_KIND_LABEL, RUNWAY_UI, displayName } from '../i18n/ja';
import type { LayoutAnalysis } from '../core/validation/validate';

interface Row {
  id: string;
  buildState?: BuildState;
  label?: string;
}

function groups(layout: AirportLayout, analysis: LayoutAnalysis): { title: string; rows: Row[] }[] {
  const facilities = sortedValues(layout.facilities);
  const named = sortedValues(layout.taxiNodes).filter((n) => {
    const kind = analysis.network.nodes[n.id]?.kind;
    return n.name || kind === 'runwayEntry' || kind === 'intersection';
  });
  return [
    { title: '滑走路', rows: sortedValues(layout.runways) },
    { title: '誘導路', rows: sortedValues(layout.taxiways) },
    {
      title: '交差点・滑走路入口',
      rows: named.map((n) => {
        const kind = analysis.network.nodes[n.id]?.kind ?? 'taxiway';
        return { id: n.id, label: `${NODE_KIND_LABEL[kind]} ${n.name || '#' + n.id.slice(n.id.indexOf('_') + 1)}` };
      }),
    },
    { title: '駐機スポット', rows: sortedValues(layout.stands) },
    { title: 'ターミナル・ゲート', rows: facilities.filter((f) => f.kind === 'terminal' || f.kind === 'gate' || f.kind === 'boardingBridge') },
    {
      title: '支援施設',
      rows: facilities.filter((f) => FACILITY_SPECS[f.kind].layer === 'building' && f.kind !== 'terminal'),
    },
    { title: 'エリア', rows: facilities.filter((f) => f.kind === 'apron' || FACILITY_SPECS[f.kind].layer === 'area') },
    { title: '道路', rows: sortedValues(layout.roads) },
  ];
}

export function FacilityList() {
  const layout = useLayout();
  const analysis = useAnalysis();
  const selection = useEditor((s) => s.selection);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ 誘導路: true, 道路: true });
  const data = useMemo(() => groups(layout, analysis), [layout, analysis]);

  return (
    <div className="facility-list" data-testid="facility-list">
      {data.map((g) => (
        <div key={g.title} className="list-group">
          <button className="list-group-title" onClick={() => setCollapsed((c) => ({ ...c, [g.title]: !c[g.title] }))}>
            {collapsed[g.title] ? '▸' : '▾'} {g.title} <span className="count">{g.rows.length}</span>
          </button>
          {!collapsed[g.title] &&
            g.rows.map((r) => {
              const issues = analysis.byTarget[r.id] ?? [];
              const sev = issues.some((i) => i.severity === 'error') ? 'error' : issues.some((i) => i.severity === 'warning') ? 'warning' : null;
              return (
                <div
                  key={r.id}
                  className={r.id === selection ? 'list-row selected' : 'list-row'}
                  onClick={() => focusEntity(r.id)}
                  data-testid={`row-${r.id}`}
                >
                  <span className="row-name">{r.label ?? displayName(layout, r.id)}</span>
                  {layout.runways[r.id] && (
                    <span className={isFreeRunway(layout.runways[r.id]!) ? 'badge free-badge' : 'badge legacy-badge'} data-testid={`badge-${r.id}`}>
                      {isFreeRunway(layout.runways[r.id]!) ? RUNWAY_UI.badgeFree : RUNWAY_UI.badgeLegacy}
                    </span>
                  )}
                  {r.buildState && r.buildState !== 'operational' && (
                    <span className={`badge ${r.buildState}`}>{BUILD_STATE_LABEL[r.buildState]}</span>
                  )}
                  {sev && <span className={`dot ${sev}`} title={`${issues.length}件の問題`} />}
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}
