import type { AtcEvent, AtcEventKind, AtcSessionState } from './types';

/** イベント追記（ID はセッション内連番で決定的） */
export function pushEvent(
  state: AtcSessionState,
  input: { kind: AtcEventKind; aircraftId?: string; clearanceId?: string; message: string },
): AtcEvent {
  const seq = state.nextEventSeq;
  state.nextEventSeq += 1;
  const event: AtcEvent = {
    id: `evt_${seq}`,
    atSec: state.clockSec,
    kind: input.kind,
    aircraftId: input.aircraftId,
    clearanceId: input.clearanceId,
    message: input.message,
  };
  state.events.push(event);
  return event;
}
