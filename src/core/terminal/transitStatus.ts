import type { AirportLayout } from '../model/types';
import type { TerminalTransitRuntime } from '../sim/types';
import { buildTerminalModel, terminalLinkCapacityPerHour } from './model';

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
  const statuses = new Map<string, TerminalTransitStatus>();
  for (const link of Object.values(layout.terminalLinks ?? {})) {
    const from = layout.terminalAreas[link.fromAreaId];
    const to = layout.terminalAreas[link.toAreaId];
    statuses.set(link.id, {
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
    });
  }
  const model = buildTerminalModel(layout);
  for (const [fromId, links] of Object.entries(model.links)) {
    for (const link of links) {
      if (!link.verticalTransportId) continue;
      const id = `vertical:${link.verticalTransportId}`;
      if (statuses.has(id)) continue;
      const transport = layout.terminalAreas[link.verticalTransportId];
      const from = model.areas[fromId];
      const to = model.areas[link.to];
      if (!transport || !from || !to) continue;
      statuses.set(id, {
        id,
        name: transport.name || `階層移動 ${transport.id}`,
        fromAreaId: from.id,
        fromAreaName: layout.terminalAreas[from.id]?.name ?? from.id,
        toAreaId: to.id,
        toAreaName: layout.terminalAreas[to.id]?.name ?? to.id,
        fromTerminalId: from.terminalId,
        toTerminalId: to.terminalId,
        buildState: 'operational',
        capacityPerHour: link.capacityPerHour ?? 1,
        reservedThisHour: runtime?.passengersByLink[id] ?? 0,
        waitingPax: waitingByLink[id] ?? 0,
      });
    }
  }
  return [...statuses.values()].sort((a, b) => a.id.localeCompare(b.id));
}
