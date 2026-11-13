import { OPS_UI, eventText, formatClock } from '../../../i18n/ja';
import type { SimEvent } from '../../../core/sim/types';
import { importantEvents } from '../events';
import { Card, useSecondly } from '../Card';
import { selectAircraftAndFocus } from '../focus';

const severity = (k: SimEvent['kind']) =>
  k === 'conflict' || k === 'diverted' || k === 'cannotOperate' || k === 'equipmentDown' ? 'error' : k === 'hold' || k === 'goAround' || k === 'paxMissed' || k === 'bagsLeftBehind' || k === 'taskBlocked' ? 'warning' : 'info';

/** 最近のイベント 8 件（新しい順）。クリックで機体を選択して移動する */
export function EventsCard() {
  const list = useSecondly((o) => {
    const { state } = o.sim;
    const cs = (id: string) => state.aircraft[id]?.callsign ?? id;
    return importantEvents(state.events).map((e) => ({ e, text: eventText(e, cs) }));
  });
  return (
    <Card id="events" title={OPS_UI.eventsTitle} open="events">
      <div className="card-rows" data-testid="card-events-list">
        {(list ?? []).length === 0 && <div className="card-sub">{OPS_UI.noEvents}</div>}
        {(list ?? []).map(({ e, text }, i) => (
          <div key={`${e.t}-${i}`} className={`card-event ${severity(e.kind)}`} onClick={() => e.aircraftId && selectAircraftAndFocus(e.aircraftId)}>
            <span className="time">{formatClock(e.t)}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
