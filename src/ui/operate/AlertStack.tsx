import { useEffect } from 'react';
import { disruptionActions } from '../../editor/simRunner';
import { OPS_UI } from '../../i18n/ja';
import { useCompany } from '../ManagementPanels';
import { useOps } from '../OpsPanels';
import { ALERT_VISIBLE, deriveAlerts, partitionAlerts, type Alert, type AlertAction } from './alerts';
import { focusTarget, selectAircraftAndFocus } from './focus';
import { opsUi, useOpsUi } from './opsUi';

interface FlowHistoryEntry {
  key: string;
  title: string;
  openedAt: number;
  resolvedAt: number | null;
}

function historyKey(projectId: string | null, seed: string, since: number): string {
  return `skyport.pax-flow-history.v1:${projectId ?? seed}:${since}`;
}

function readFlowHistory(key: string): FlowHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((x): x is FlowHistoryEntry => !!x && typeof x === 'object' && typeof x.key === 'string' && typeof x.title === 'string' && Number.isFinite(x.openedAt) && (x.resolvedAt === null || Number.isFinite(x.resolvedAt))).slice(-100);
  } catch {
    return [];
  }
}

function jump(a: Alert): void {
  if (a.target.kind === 'aircraft' && a.target.id) selectAircraftAndFocus(a.target.id);
  else if (a.target.kind === 'unit') opsUi.openOverlay('ground');
  else if (!focusTarget(a.target.id) && a.target.kind === 'area') opsUi.openOverlay(a.panel ?? 'terminal');
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
  const expanded = useOpsUi((s) => s.alertsExpanded);
  const result = o ? deriveAlerts(o.sim, company, dismissed) : { alerts: [], keys: [] };
  const allAlerts = o ? deriveAlerts(o.sim, company) : result;
  const historyStorageKey = o ? historyKey(o.sim.ctx.layout.name, o.sim.state.seed, o.sim.state.analytics.since) : '';
  const flowAlerts = allAlerts.alerts.filter((a) => a.key.startsWith('paxFlow:') || a.key.startsWith('paxStructure:') || a.key.startsWith('airsideStructure:'));
  const now = o?.sim.state.now ?? 0;
  const history = (() => {
    if (!historyStorageKey) return [];
    const current = readFlowHistory(historyStorageKey);
    const active = new Set(flowAlerts.map((a) => a.key));
    let next = current;
    for (let i = 0; i < current.length; i++) {
      const entry = current[i]!;
      if (entry.resolvedAt === null && !active.has(entry.key)) {
        if (next === current) next = current.slice();
        next[i] = { ...entry, resolvedAt: now };
      }
    }
    for (const alert of flowAlerts) {
      const index = next.findIndex((entry) => entry.key === alert.key && entry.resolvedAt === null);
      if (index < 0) {
        if (next === current) next = current.slice();
        next.push({ key: alert.key, title: alert.title, openedAt: now, resolvedAt: null });
      } else if (next[index]!.title !== alert.title) {
        if (next === current) next = current.slice();
        next[index] = { ...next[index]!, title: alert.title };
      }
    }
    return next === current ? current : next.slice(-100);
  })();
  const serializedHistory = JSON.stringify(history);
  useEffect(() => {
    if (!historyStorageKey) return;
    try {
      if (globalThis.localStorage?.getItem(historyStorageKey) !== serializedHistory) globalThis.localStorage?.setItem(historyStorageKey, serializedHistory);
    } catch {
      // 履歴の保存に失敗しても現在の運航監視は継続する
    }
  }, [historyStorageKey, serializedHistory]);
  const staleCount = dismissed.filter((k) => !result.keys.includes(k)).length;
  // 解消したアラートの「閉じた」記録は消す（同じ key で再び起きたら、また通知する）
  useEffect(() => {
    if (staleCount > 0) opsUi.patch({ dismissed: dismissed.filter((k) => result.keys.includes(k)) });
  }, [staleCount, dismissed, result.keys]);
  if (!o) return null;
  // 出し分け（決定C）: スタックに出すのは重大だけ。注意は要対応インボックスのみに出る
  const parts = partitionAlerts(result.alerts);
  const shown = expanded ? parts.stack : parts.stack.slice(0, ALERT_VISIBLE);
  const more = parts.stack.length - shown.length;
  const critical = parts.stack.length;
  const warnings = parts.inbox.length;
  return (
    <div className="alert-stack" data-testid="alert-stack">
      <button className="alert-status" onClick={() => opsUi.patch({ alertsExpanded: !expanded })} aria-expanded={expanded} data-testid="alert-status">
        旅客動線・運用状況: {result.alerts.length === 0 ? '問題なし' : `重大 ${critical} · 警告 ${warnings}`}
      </button>
      {warnings > 0 && (
        <div className="alert-inbox-note muted small" data-testid="alert-inbox-note">
          {OPS_UI.alertInboxNote(warnings)}
        </div>
      )}
      {shown.map((a) => (
        <div key={a.key} className={`alert ${a.severity}`} data-testid={`alert-${a.key}`}>
          <button className="alert-main" onClick={() => jump(a)} title={OPS_UI.jump} data-testid={`alert-focus-${a.key}`}>
            <span className="alert-sev">{a.severity === 'critical' ? OPS_UI.alertCritical : OPS_UI.alertWarning}</span>
            <span className="alert-title">{a.title}</span>
            {a.count > 1 && <span className="alert-count">×{a.count}</span>}
          </button>
          {a.detail && <div className="alert-detail">{a.detail}</div>}
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
      {expanded && history.some((entry) => entry.resolvedAt !== null) && (
        <div className="alert-history" data-testid="pax-flow-history">
          <strong>解消済みの動線エラー</strong>
          {history.filter((entry) => entry.resolvedAt !== null).slice(-10).reverse().map((entry, i) => (
            <div key={`${entry.key}:${entry.openedAt}:${i}`}>{entry.title} · {Math.round((entry.resolvedAt! - entry.openedAt) / 60)}分で解消</div>
          ))}
        </div>
      )}
      {(more > 0 || expanded) && (
        <span className="alert-more-row">
          <button className="alert-more" onClick={() => opsUi.patch({ alertsExpanded: !expanded })} aria-expanded={expanded} data-testid="alert-more">
            {expanded ? OPS_UI.alertLess : OPS_UI.alertMore(more)}
          </button>
          <button className="alert-more" onClick={() => opsUi.openOverlay('events')} data-testid="alert-events">
            {OPS_UI.alertOpenEvents}
          </button>
        </span>
      )}
    </div>
  );
}
