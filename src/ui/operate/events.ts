import type { SimEvent } from '../../core/sim/types';

/** カードに出さない記録（毎回出る状態変化・作業完了など）。全件は「イベント」オーバーレイ */
const MINOR: readonly SimEvent['kind'][] = ['spawn', 'state', 'taskDone', 'finance', 'scheduleGenerated', 'boardingOpen', 'boardingClosed', 'standAssigned'];
export const EVENT_CARD_LIMIT = 8;

export function importantEvents(events: readonly SimEvent[], limit = EVENT_CARD_LIMIT): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) if (!MINOR.includes(events[i]!.kind)) out.push(events[i]!);
  return out;
}
