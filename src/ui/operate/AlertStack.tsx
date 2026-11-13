import { useEffect } from 'react';
import { disruptionActions } from '../../editor/simRunner';
import { OPS_UI } from '../../i18n/ja';
import { useCompany } from '../ManagementPanels';
import { useOps } from '../OpsPanels';
import { ALERT_VISIBLE, deriveAlerts, type Alert, type AlertAction } from './alerts';
import { focusTarget, selectAircraftAndFocus } from './focus';
import { opsUi, useOpsUi } from './opsUi';

function jump(a: Alert): void {
  if (a.target.kind === 'aircraft' && a.target.id) selectAircraftAndFocus(a.target.id);
  else focusTarget(a.target.id);
}

/** 既存の対応（sim/disruptions.ts）を呼ぶ。マップへの移動・パネルを開く操作は表示だけの処理 */
function run(a: Alert, action: AlertAction): void {
  switch (action) {
    case 'focus':
      jump(a);
      break;
    case 'repair':
      if (a.disruptionId) disruptionActions.resolve(a.disruptionId);
      break;
    case 'delay15':
      if (a.flightId) disruptionActions.delay(a.flightId, 15);
      break;
    case 'reassign':
      if (a.flightId) opsUi.patch({ fidsMenu: a.flightId, fidsCollapsed: false });
      break;
    case 'openPanel':
      if (a.panel) opsUi.openOverlay(a.panel);
      break;
  }
}

/** マップ左上の重要通知（最大 3 件）。クリックで対象へ移動し、対応ボタンを出す */
export function AlertStack() {
  const o = useOps();
  const company = useCompany();
  const dismissed = useOpsUi((s) => s.dismissed);
  const result = o ? deriveAlerts(o.sim, company, dismissed) : { alerts: [], keys: [] };
  const staleCount = dismissed.filter((k) => !result.keys.includes(k)).length;
  // 解消したアラートの「閉じた」記録は消す（同じ key で再び起きたら、また通知する）
  useEffect(() => {
    if (staleCount > 0) opsUi.patch({ dismissed: dismissed.filter((k) => result.keys.includes(k)) });
  }, [staleCount, dismissed, result.keys]);
  if (!o || result.alerts.length === 0) return null;
  const shown = result.alerts.slice(0, ALERT_VISIBLE);
  const more = result.alerts.length - shown.length;
  return (
    <div className="alert-stack" data-testid="alert-stack">
      {shown.map((a) => (
        <div key={a.key} className={`alert ${a.severity}`} data-testid={`alert-${a.key}`}>
          <button className="alert-main" onClick={() => jump(a)} title={OPS_UI.jump} data-testid={`alert-focus-${a.key}`}>
            <span className="alert-sev">{a.severity === 'critical' ? OPS_UI.alertCritical : OPS_UI.alertWarning}</span>
            <span className="alert-title">{a.title}</span>
            {a.count > 1 && <span className="alert-count">×{a.count}</span>}
          </button>
          <span className="alert-actions">
            {a.actions
              .filter((x) => x !== 'focus')
              .map((x) => (
                <button key={x} className="small" onClick={() => run(a, x)} data-testid={`alert-act-${x}-${a.key}`}>
                  {OPS_UI.alertAction[x]}
                </button>
              ))}
            <button className="small" onClick={() => opsUi.dismiss(a.key)} aria-label={OPS_UI.close} data-testid={`alert-dismiss-${a.key}`}>
              ×
            </button>
          </span>
        </div>
      ))}
      {more > 0 && (
        <button className="alert-more" onClick={() => opsUi.openOverlay('events')} data-testid="alert-more">
          {OPS_UI.alertMore(more)}
        </button>
      )}
    </div>
  );
}
