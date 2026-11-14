import type { AircraftModel } from '../aircraft/catalog';
import type { FlightRecord } from './records';

export interface SpottingEntry {
  kind: 'aircraft' | 'airline';
  id: string;
  name: string;
  firstDay: number;
  visits: number;
  rare: boolean;
}

export interface Journal {
  version: 1;
  spotted: Record<string, SpottingEntry>;
  typeMovements: Record<string, number>;
  records: {
    busiestDay: { day: number; movements: number } | null;
    busiestHour: { day: number; hour: number; movements: number } | null;
    largestAircraft: { typeId: string; name: string; wingspanM: number; day: number } | null;
    longestDelay: { flight: string; typeId: string; delaySec: number; day: number } | null;
    onTimeStreak: { days: number; lastDay: number };
  };
}

export const createJournal = (): Journal => ({
  version: 1,
  spotted: {},
  typeMovements: {},
  records: { busiestDay: null, busiestHour: null, largestAircraft: null, longestDelay: null, onTimeStreak: { days: 0, lastDay: -1 } },
});

export function hasJournalData(journal: Journal | undefined): boolean {
  return !!journal && (Object.keys(journal.spotted).length > 0 || Object.keys(journal.typeMovements).length > 0 ||
    journal.records.busiestDay !== null || journal.records.busiestHour !== null || journal.records.largestAircraft !== null ||
    journal.records.longestDelay !== null || journal.records.onTimeStreak.days > 0);
}

/** Runtime validation for the optional additive project field. */
export function checkJournal(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['journal の形式が不正です'];
  const j = value as Partial<Journal>;
  if (j.version !== 1 || !j.spotted || typeof j.spotted !== 'object' || Array.isArray(j.spotted) || !j.typeMovements || typeof j.typeMovements !== 'object' || Array.isArray(j.typeMovements) || !j.records || typeof j.records !== 'object') return ['journal の形式が不正です'];
  for (const [key, entry] of Object.entries(j.spotted)) {
    if (!entry || (entry.kind !== 'aircraft' && entry.kind !== 'airline') || typeof entry.id !== 'string' || typeof entry.name !== 'string' || !Number.isInteger(entry.firstDay) || !Number.isInteger(entry.visits) || entry.visits < 1 || typeof entry.rare !== 'boolean' || key !== `${entry.kind}:${entry.id}`) return [`journal.spotted.${key} の形式が不正です`];
  }
  for (const [id, count] of Object.entries(j.typeMovements)) if (!id || typeof count !== 'number' || !Number.isInteger(count) || count < 0) return [`journal.typeMovements.${id} の形式が不正です`];
  const nullable = (v: unknown, keys: readonly string[]): boolean => v === null || !!v && typeof v === 'object' && keys.every((k) => typeof (v as Record<string, unknown>)[k] === 'string' || typeof (v as Record<string, unknown>)[k] === 'number');
  const r = j.records;
  if (!nullable(r.busiestDay, ['day', 'movements']) || !nullable(r.busiestHour, ['day', 'hour', 'movements']) || !nullable(r.largestAircraft, ['typeId', 'name', 'wingspanM', 'day']) || !nullable(r.longestDelay, ['flight', 'typeId', 'delaySec', 'day']) || !r.onTimeStreak || !Number.isInteger(r.onTimeStreak.days) || r.onTimeStreak.days < 0 || !Number.isInteger(r.onTimeStreak.lastDay)) return ['journal.records の形式が不正です'];
  return [];
}

const recordTime = (r: FlightRecord): number => r.takeoffAt ?? r.blockOut ?? r.landedAt ?? r.depScheduled;

/** Update from actual completed-flight logs at day close. No capacity or event values are inferred. */
export function updateJournal(previous: Journal | undefined, records: readonly FlightRecord[], from: number, to: number, day: number, models: Record<string, AircraftModel>): Journal {
  const journal = structuredClone(previous ?? createJournal());
  const daily = records.filter((r) => recordTime(r) >= from && recordTime(r) < to);
  const hours = new Map<number, number>();
  let movements = 0;
  let onTime = true;
  for (const r of daily) {
    const model = models[r.typeId];
    const wide = model?.wingspanM.value ?? null;
    const aircraftKey = `aircraft:${r.typeId}`;
    const aircraft = journal.spotted[aircraftKey];
    if (aircraft) aircraft.visits++;
    else journal.spotted[aircraftKey] = { kind: 'aircraft', id: r.typeId, name: model?.name ?? r.typeId, firstDay: day, visits: 1, rare: r.contractId === null || (wide !== null && wide >= 65) };
    if (r.airlineId) {
      const key = `airline:${r.airlineId}`;
      const airline = journal.spotted[key];
      if (airline) airline.visits++;
      else journal.spotted[key] = { kind: 'airline', id: r.airlineId, name: r.airlineId, firstDay: day, visits: 1, rare: false };
    }
    const events = [r.landedAt, r.takeoffAt].filter((t): t is number => t !== null && t >= from && t < to);
    journal.typeMovements[r.typeId] = (journal.typeMovements[r.typeId] ?? 0) + events.length;
    movements += events.length;
    for (const t of events) hours.set(Math.floor((t - from) / 3600), (hours.get(Math.floor((t - from) / 3600)) ?? 0) + 1);
    if (wide !== null && (!journal.records.largestAircraft || wide > journal.records.largestAircraft.wingspanM)) {
      journal.records.largestAircraft = { typeId: r.typeId, name: model?.name ?? r.typeId, wingspanM: wide, day };
    }
    const delaySec = Math.max(0, r.landedAt === null ? 0 : r.landedAt - r.arrScheduled, r.takeoffAt === null ? 0 : r.takeoffAt - r.depScheduled);
    if (delaySec > (journal.records.longestDelay?.delaySec ?? -1)) journal.records.longestDelay = { flight: `${r.arrNumber}/${r.depNumber}`, typeId: r.typeId, delaySec, day };
    if (events.some((t) => (t === r.landedAt ? t - r.arrScheduled : t - r.depScheduled) > 15 * 60)) onTime = false;
  }
  if (movements > (journal.records.busiestDay?.movements ?? 0)) journal.records.busiestDay = { day, movements };
  for (const [hour, count] of hours) if (count > (journal.records.busiestHour?.movements ?? 0)) journal.records.busiestHour = { day, hour, movements: count };
  const prev = journal.records.onTimeStreak;
  journal.records.onTimeStreak = { days: daily.length && onTime ? (prev.lastDay === day - 1 ? prev.days + 1 : 1) : 0, lastDay: day };
  return journal;
}
