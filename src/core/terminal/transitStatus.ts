import type { AirportLayout } from '../model/types';
import type { TerminalTransitRuntime } from '../sim/types';
import { terminalLinkCapacityPerHour } from './model';

export interface TerminalTransitStatus {
  id: string;
  name: string;
  fromAreaId: string;
  fromAreaName: string;
  toAreaId: string;
  toAreaName: string;
  fromTerminalId: string;
  toTerminalId: string;
  buildState: 'planned' | 'underConstruction' | 'operational';
  capacityPerHour: number;
  reservedThisHour: number;
  waitingPax: number;
}

/** Snapshot of explicit terminal links; reservations are current-hour usage, not completed-trip history. */
export function terminalTransitStatus(
  layout: AirportLayout,
  runtime: TerminalTransitRuntime | undefined,
  waitingByLink: Readonly<Record<string, number>>,
): TerminalTransitStatus[] {
  return Object.values(layout.terminalLinks ?? {})
    .map((link) => {
      const from = layout.terminalAreas[link.fromAreaId];
      const to = layout.terminalAreas[link.toAreaId];
      return {
        id: link.id,
        name: link.name,
        fromAreaId: link.fromAreaId,
        fromAreaName: from?.name ?? link.fromAreaId,
        toAreaId: link.toAreaId,
        toAreaName: to?.name ?? link.toAreaId,
        fromTerminalId: from?.terminalId ?? '',
        toTerminalId: to?.terminalId ?? '',
        buildState: link.buildState,
        capacityPerHour: terminalLinkCapacityPerHour(link),
        reservedThisHour: runtime?.passengersByLink[link.id] ?? 0,
        waitingPax: waitingByLink[link.id] ?? 0,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
