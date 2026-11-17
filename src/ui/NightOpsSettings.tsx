import type { CityConfig, CityNightOps } from '../core/economy/city';
import { NIGHT_OPS_RANGES, clampNightOps, defaultCityNightOps } from '../core/economy/city';
import { NIGHT_UI, formatMinute } from '../i18n/ja';

/**
 * 夜間の運用（最終出発時刻など。フェーズ 2、docs/40 R1・R2・R10〜R12）の設定。建設モードだけ変更できる。
 * `onChange(null)` = 設定を外す（従来の計画・運航）。
 */
export function NightOpsSettings({ city, readOnly, onChange }: { city: CityConfig; readOnly: boolean; onChange: (next: CityNightOps | null) => void }) {
  const n = city.nightOps;
  const cutoffs: number[] = [];
  for (let m = NIGHT_OPS_RANGES.departureCutoffMin.min; m <= NIGHT_OPS_RANGES.departureCutoffMin.max; m += 5) cutoffs.push(m);
  const num = (key: 'airborneHoldMaxMin' | 'warnLeadMin', raw: string) => {
    if (!n || raw.trim() === '') return;
    onChange(clampNightOps({ ...n, [key]: Number(raw) }));
  };
  return (
    <section className="night-ops" data-testid="night-ops">
      <h4>{NIGHT_UI.title}</h4>
      <p className="muted small">{NIGHT_UI.note}</p>
      <label>
        <input type="checkbox" checked={!!n} disabled={readOnly} onChange={(e) => onChange(e.target.checked ? defaultCityNightOps() : null)} data-testid="nightops-enabled" />
        {NIGHT_UI.enabled}
      </label>
      {readOnly && <p className="muted small" data-testid="nightops-readonly">{NIGHT_UI.readOnly}</p>}
      {n && (
        <div className="night-ops-fields">
          <label>
            {NIGHT_UI.cutoff}{' '}
            <select value={n.departureCutoffMin} disabled={readOnly} onChange={(e) => onChange(clampNightOps({ ...n, departureCutoffMin: Number(e.target.value) }))} data-testid="nightops-cutoff">
              {cutoffs.map((m) => <option key={m} value={m}>{formatMinute(m)}</option>)}
            </select>
          </label>
          <p className="muted small">{NIGHT_UI.cutoffHelp}</p>
          <label>
            {NIGHT_UI.airborneMax}{' '}
            <input type="number" min={NIGHT_OPS_RANGES.airborneHoldMaxMin.min} max={NIGHT_OPS_RANGES.airborneHoldMaxMin.max} step={5} value={n.airborneHoldMaxMin} disabled={readOnly} onChange={(e) => num('airborneHoldMaxMin', e.target.value)} data-testid="nightops-airborne-max" />
          </label>
          <p className="muted small">{NIGHT_UI.airborneMaxHelp}</p>
          <label>
            {NIGHT_UI.warnLead}{' '}
            <input type="number" min={NIGHT_OPS_RANGES.warnLeadMin.min} max={NIGHT_OPS_RANGES.warnLeadMin.max} step={5} value={n.warnLeadMin} disabled={readOnly} onChange={(e) => num('warnLeadMin', e.target.value)} data-testid="nightops-warn-lead" />
          </label>
          <p className="muted small">{NIGHT_UI.warnLeadHelp}</p>
          <label>
            <input type="checkbox" checked={n.prioritizeAtRisk} disabled={readOnly} onChange={(e) => onChange({ ...n, prioritizeAtRisk: e.target.checked })} data-testid="nightops-prioritize" />
            {NIGHT_UI.prioritize}
          </label>
          <p className="muted small">{NIGHT_UI.inboundPolicy}。{NIGHT_UI.manualWarn}</p>
        </div>
      )}
    </section>
  );
}
