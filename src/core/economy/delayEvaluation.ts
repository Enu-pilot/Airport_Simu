import type { ExternalDelayCause, Flight } from '../sim/types';

export interface DelayEvaluation {
  actualArrivalSec: number;
  actualDepartureSec: number;
  arrivalSec: number;
  departureSec: number;
  arrivalExternalSec: number;
  departureGraceSec: number;
}

export function addExternalDelay(flight: Flight, cause: ExternalDelayCause, seconds: number): void {
  const value = Math.max(0, Math.round(seconds));
  if (value <= 0) return;
  flight.externalDelaySec ??= {};
  flight.externalDelaySec[cause] = (flight.externalDelaySec[cause] ?? 0) + value;
}

export function externalDelayTotal(value: Partial<Record<ExternalDelayCause, number>> | undefined): number {
  return Object.values(value ?? {}).reduce((sum, seconds) => sum + Math.max(0, Number(seconds) || 0), 0);
}

/**
 * 評価用遅延。実績時刻はそのまま保持し、到着の外部要因実測秒だけを到着評価から控除する。
 * 折り返し出発の猶予は、到着実遅延が実際の予定余裕を超えた秒数だけ。
 */
export function evaluateDelayPair(input: {
  arrScheduled: number;
  arrActual: number | null;
  depScheduled: number;
  depBlockOut: number | null;
  turnaroundSec: number;
  arrivalExternalDelaySec?: Partial<Record<ExternalDelayCause, number>>;
  turnaroundBufferSec?: number;
}): DelayEvaluation {
  const actualArrivalSec = input.arrActual === null ? 0 : Math.max(0, input.arrActual - input.arrScheduled);
  const actualDepartureSec = input.depBlockOut === null ? 0 : Math.max(0, input.depBlockOut - input.depScheduled);
  const arrivalExternalSec = Math.min(actualArrivalSec, externalDelayTotal(input.arrivalExternalDelaySec));
  const buffer = Math.max(0, input.turnaroundBufferSec ?? (input.depScheduled - input.arrScheduled - input.turnaroundSec));
  const departureGraceSec = Math.max(0, actualArrivalSec - buffer);
  return {
    actualArrivalSec,
    actualDepartureSec,
    arrivalSec: Math.max(0, actualArrivalSec - arrivalExternalSec),
    departureSec: Math.max(0, actualDepartureSec - departureGraceSec),
    arrivalExternalSec,
    departureGraceSec,
  };
}
