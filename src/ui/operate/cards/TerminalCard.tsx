import { compareIds } from '../../../core/model/ids';
import { areaOccupancy, facilityLoad } from '../../../core/sim/passengers';
import { OPS_UI, displayName } from '../../../i18n/ja';
import { Card, CardRow, useSecondly } from '../Card';
import { focusTarget } from '../focus';

const PROCESSING: readonly string[] = ['checkIn', 'security', 'baggageClaim', 'restroom', 'shop', 'restaurant'];

/** 処理施設（チェックイン・保安検査など）の待ちの上位 4 施設、館内の人数、乗り遅れ */
export function TerminalCard() {
  const data = useSecondly((o) => {
    const { state, ctx } = o.sim;
    const occ = areaOccupancy(state);
    const inTerminal = [...occ.values()].reduce((s, n) => s + n, 0);
    const rows = Object.values(ctx.terminal.areas)
      .filter((a) => PROCESSING.includes(a.kind) && state.facilities[a.id])
      .map((a) => {
        const load = facilityLoad(state, a.id);
        const fac = state.facilities[a.id]!;
        const here = occ.get(a.id) ?? 0;
        return {
          id: a.id,
          name: displayName(ctx.layout, a.id).replace(/^\dF /, ''),
          queued: load.queued,
          avgWaitMin: fac.served ? Math.round(fac.waitTotal / fac.served / 6) / 10 : 0,
          crowd: a.capacity > 0 ? Math.round((here / a.capacity) * 100) : 0,
          closed: state.closedAreas.includes(a.id),
        };
      })
      .sort((a, b) => b.queued - a.queued || b.avgWaitMin - a.avgWaitMin || compareIds(a.id, b.id))
      .slice(0, 4);
    return { inTerminal, missed: state.paxStats.missed, rows };
  });
  return (
    <Card id="terminal" title={OPS_UI.terminalTitle} open="terminal" badge={data ? OPS_UI.inTerminal(data.inTerminal) : undefined}>
      {data && (
        <>
          <CardRow label={OPS_UI.paxMissed} tone={data.missed > 0 ? 'warn' : undefined}>
            {data.missed}
          </CardRow>
          {data.rows.length === 0 && <div className="card-sub">{OPS_UI.noTerminal}</div>}
          {data.rows.map((r) => (
            <div key={r.id} className="card-item" data-testid={`card-terminal-${r.id}`}>
              <button className="link" onClick={() => focusTarget(r.id)} title={OPS_UI.jump}>
                {r.name}
              </button>
              <span className={r.queued > 50 ? 'ng-text' : r.queued > 20 ? 'warn-text' : 'muted'}>{OPS_UI.queueText(r.queued, r.avgWaitMin, r.crowd)}</span>
              {r.closed && <span className="badge">{OPS_UI.closed}</span>}
            </div>
          ))}
        </>
      )}
    </Card>
  );
}
