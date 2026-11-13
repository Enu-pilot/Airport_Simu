import { ACCESS_MODES, type AccessMode } from '../../../core/access/model';
import { ACCESS_MODE_LABEL, OPS_UI } from '../../../i18n/ja';
import { useOps } from '../../OpsPanels';
import { Card, CardRow } from '../Card';

/** 空港アクセスの状況: 手段別の旅客、駐車場の満車、乗り場の待ち。詳細・料金は「アクセス」オーバーレイ */
export function AccessCard() {
  const o = useOps();
  if (!o) return null;
  const a = o.sim.state.access;
  if (!a) {
    return (
      <Card id="access" title={OPS_UI.accessTitle} open="access">
        <div className="card-sub">{OPS_UI.accessNone}</div>
      </Card>
    );
  }
  const s = a.stats;
  const modes = ACCESS_MODES.filter((m) => a.available.includes(m) && s.pax[m] > 0);
  const parkedNow = a.parked.length;
  const queue = (m: AccessMode) => (m === 'taxi' || m === 'bus' || m === 'rail' ? (a.queues[m]?.length ?? 0) : 0);
  const waiting = (['taxi', 'bus', 'rail'] as const).reduce((sum, m) => sum + queue(m), 0);
  return (
    <Card id="access" title={OPS_UI.accessTitle} open="access" badge={`×${a.factor.toFixed(2)}`}>
      {modes.length === 0 && <div className="card-sub">{OPS_UI.accessNoPax}</div>}
      {modes.map((m) => (
        <CardRow key={m} label={ACCESS_MODE_LABEL[m]} testid={`card-access-${m}`}>
          {OPS_UI.paxCount(s.pax[m])}
          {queue(m) > 0 ? ` · ${OPS_UI.waiting(queue(m))}` : ''}
        </CardRow>
      ))}
      <CardRow label={OPS_UI.parking} tone={a.parkingSpaces > 0 && parkedNow >= a.parkingSpaces ? 'bad' : undefined}>
        {OPS_UI.parkingText(parkedNow, a.parkingSpaces)}
      </CardRow>
      <CardRow label={OPS_UI.parkingFull} tone={s.parkingFull > 0 ? 'warn' : undefined}>
        {s.parkingFull}
      </CardRow>
      <CardRow label={OPS_UI.transitWait} tone={waiting > 20 ? 'warn' : undefined}>
        {OPS_UI.waiting(waiting)}
      </CardRow>
    </Card>
  );
}
