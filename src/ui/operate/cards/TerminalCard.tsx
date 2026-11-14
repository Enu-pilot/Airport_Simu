import { compareIds } from '../../../core/model/ids';
import { areaOccupancy, facilityLoad, serversOf } from '../../../core/sim/passengers';
import { serviceSecPerPax } from '../../../core/terminal/capacity';
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
    const terminals = Object.keys(ctx.terminal.byTerminal).sort(compareIds).map((terminalId) => {
      const ids = ctx.terminal.byTerminal[terminalId]!;
      const occupants = ids.reduce((sum, id) => sum + (occ.get(id) ?? 0), 0);
      const capacity = (kind: 'security' | 'checkIn') => ids.reduce((sum, id) => {
        const area = ctx.terminal.areas[id]!;
        if (area.kind !== kind) return sum;
        const source = ctx.layout.terminalAreas[id]!;
        const serviceSec = serviceSecPerPax(area.kind, source.props);
        return sum + serversOf(o.sim, id) * 3600 / serviceSec;
      }, 0);
      const facilities = ids
        .filter((id) => ['checkIn', 'security'].includes(ctx.terminal.areas[id]!.kind))
        .map((id) => state.facilities[id])
        .filter((f) => f !== undefined);
      const served = facilities.reduce((sum, f) => sum + f.served, 0);
      const wait = facilities.reduce((sum, f) => sum + f.waitTotal, 0);
      return {
        id: terminalId,
        name: displayName(ctx.layout, terminalId),
        occupants,
        securityPerHour: Math.round(capacity('security')),
        checkInPerHour: Math.round(capacity('checkIn')),
        avgWaitMin: served ? Math.round(wait / served / 6) / 10 : 0,
      };
    });
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
    const busWait = state.bus ? state.activePax.reduce((n, id) => (state.paxGroups[id]!.state === 'waitingBus' ? n + state.paxGroups[id]!.count : n), 0) : null;
    return { inTerminal, missed: state.paxStats.missed, busWait, rows, terminals };
  });
  return (
    <Card id="terminal" title={OPS_UI.terminalTitle} open="terminal" badge={data ? OPS_UI.inTerminal(data.inTerminal) : undefined}>
      {data && (
        <>
          <CardRow label={OPS_UI.paxMissed} tone={data.missed > 0 ? 'warn' : undefined}>
            {data.missed}
          </CardRow>
          {data.busWait !== null && (
            <CardRow label={OPS_UI.busWait} tone={data.busWait > 60 ? 'warn' : undefined} testid="terminal-bus-wait">
              {data.busWait}
            </CardRow>
          )}
          {data.terminals.map((t) => (
            <div key={t.id} className="card-item" data-testid={`terminal-summary-${t.id}`}>
              <span>{t.name}</span>
              <span className="muted">館内 {t.occupants}人 · 保安 {t.securityPerHour}/時 · チェックイン {t.checkInPerHour}/時 · 平均待ち {t.avgWaitMin}分</span>
            </div>
          ))}
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
