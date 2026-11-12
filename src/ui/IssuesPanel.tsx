import { useState } from 'react';
import { worldToMap } from '../core/geometry/frames';
import type { Severity } from '../core/validation/validate';
import { actions, useAnalysis, useLayout } from '../editor/store';
import { focusEntity } from '../editor/input';
import { RUNWAY_UI, SEVERITY_LABEL, issueText } from '../i18n/ja';

const ICON: Record<Severity, string> = { error: '⛔', warning: '⚠', info: 'ℹ' };

export function IssuesPanel() {
  const layout = useLayout();
  const analysis = useAnalysis();
  const [show, setShow] = useState<Record<Severity, boolean>>({ error: true, warning: true, info: false });
  const list = analysis.issues.filter((i) => show[i.severity]);

  return (
    <div className="issues" data-testid="issues">
      <div className="issues-header">
        <strong>配置・接続チェック</strong>
        {(['error', 'warning', 'info'] as const).map((sev) => (
          <label key={sev} className={`sev-toggle ${sev}`}>
            <input type="checkbox" checked={show[sev]} onChange={(e) => setShow((s) => ({ ...s, [sev]: e.target.checked }))} />
            {ICON[sev]} {SEVERITY_LABEL[sev]} <span data-testid={`count-${sev}`}>{analysis.counts[sev]}</span>
          </label>
        ))}
      </div>
      <div className="issues-list">
        {list.length === 0 && <div className="empty">表示する問題はありません</div>}
        {list.map((iss) => (
          <div
            key={iss.key}
            className={`issue ${iss.severity}`}
            onClick={() => {
              const target = iss.targets[0];
              if (iss.at) actions.focus(worldToMap(iss.at), target);
              else if (target) focusEntity(target);
            }}
          >
            <span className="icon">{ICON[iss.severity]}</span>
            <span>
              {issueText(layout, iss)}
              {iss.params.criterion === 'real' && (
                <span className="badge free-badge" data-testid="issue-real" title={RUNWAY_UI.freeCriterion}>
                  {RUNWAY_UI.tagReal}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
