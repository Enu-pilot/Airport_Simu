import { useMemo, useState } from 'react';
import { buildAttentionItems, type AttentionBand } from '../core/attention';
import { worldToMap } from '../core/geometry/frames';
import type { Severity } from '../core/validation/validate';
import { actions, useAnalysis, useLayout } from '../editor/store';
import { focusEntity } from '../editor/input';
import { ATTENTION_UI, RUNWAY_UI, SEVERITY_LABEL, issueText } from '../i18n/ja';
import { useCompany } from './ManagementPanels';

const ICON: Record<Severity, string> = { error: '⛔', warning: '⚠', info: 'ℹ' };
const BAND_ICON: Record<AttentionBand, string> = { high: '⛔', mid: '⚠', low: 'ℹ' };

export function IssuesPanel() {
  const layout = useLayout();
  const analysis = useAnalysis();
  const company = useCompany();
  const [show, setShow] = useState<Record<Severity, boolean>>({ error: true, warning: true, info: false });
  const list = analysis.issues.filter((i) => show[i.severity]);
  // 案1: 要対応の一元化。検証項目は上の第1セクションが全文を出すので、第2セクションでは重ねて出さない
  const attention = useMemo(() => buildAttentionItems({ layout, analysis, company }), [layout, analysis, company]);
  const opsAttention = attention.filter((i) => i.source !== 'validation');
  const hasReport = company.reports.length > 0;

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
      <div className="attention" data-testid="attention">
        <div className="issues-header">
          <strong>{ATTENTION_UI.title}</strong>
          {(['high', 'mid', 'low'] as const).map((band) => (
            <span key={band} className={`sev-toggle ${band === 'high' ? 'error' : band === 'mid' ? 'warning' : 'info'}`}>
              {BAND_ICON[band]} {ATTENTION_UI.band[band]} <span data-testid={`attention-count-${band}`}>{opsAttention.filter((i) => i.band === band).length}</span>
            </span>
          ))}
        </div>
        <div className="attention-list">
          {!hasReport && <div className="empty">{ATTENTION_UI.noReport}</div>}
          {hasReport && opsAttention.length === 0 && <div className="empty">{ATTENTION_UI.none}</div>}
          {opsAttention.map((item) => (
            <div
              key={item.id}
              className={`issue ${item.band}`}
              data-testid={`attention-${item.source}-${item.subjectId}`}
              onClick={() => {
                if (item.at) actions.focus(worldToMap(item.at), item.targetId);
                else if (item.targetId) focusEntity(item.targetId);
              }}
            >
              <span className="icon">{BAND_ICON[item.band]}</span>
              <span>
                {item.title} <span className="muted">{item.detail}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
