import { sortedValues } from '../model/ids';
import { nominalOutSec, predictTakeoffAt } from '../sim/nightOps';
import type { Simulation } from '../sim/simulation';

/**
 * 離陸の遅れ（フェーズ 2、docs/36。既存の出発の実遅延・評価対象の遅延とは別の指標）。
 * = max(0, 実離陸 − (出発の予定 + 標準の離陸までの秒数))。スポットを離れた後の待機・夜間の待機を含む。
 * 標準の離陸までの秒数は配置・スポット・機種から決まる（保存項目を増やさない）。未離陸・経路なしは null。
 */
export function takeoffDelaySec(sim: Simulation, aircraftId: string): number | null {
  const ac = sim.state.aircraft[aircraftId];
  if (!ac) return null;
  const dep = sim.state.flights[ac.departureFlightId];
  if (!dep || dep.actual === null) return null;
  const nominal = nominalOutSec(sim, { ...ac, standId: dep.standId ?? ac.standId });
  if (nominal === null) return null;
  return Math.max(0, dep.actual - (dep.scheduled + nominal));
}

export interface NightDayReport {
  /** その日に予定された最後の出発の離陸の遅れ（分）。離陸していなければ予測離陸から求める。出発がなければ null */
  lastDepartureDelayMin: number | null;
  standHeld: number;
  originHeld: number;
  carriedOver: number;
  diverted: number;
  cancelled: number;
}

/** 日次締めの夜間の集計（R15）。`city.nightOps` があるときだけ呼ぶ。from〜to はその日の期間（秒） */
export function nightDayReport(sim: Simulation, from: number, to: number): NightDayReport {
  const { state } = sim;
  let standHeld = 0;
  let originHeld = 0;
  let diverted = 0;
  let cancelled = 0;
  let carriedOver = 0;
  let last: { scheduled: number; id: string; delaySec: number | null } | null = null;
  for (const ac of sortedValues(state.aircraft)) {
    const dep = state.flights[ac.departureFlightId];
    const arr = state.flights[ac.arrivalFlightId];
    for (const f of [arr, dep]) {
      const h = f?.nightHold;
      if (!f || !h || h.decidedAt < from || h.decidedAt >= to) continue;
      if (h.kind === 'stand') standHeld++;
      else if (h.kind === 'origin') originHeld++;
      else if (ac.state === 'diverted') diverted++;
      if (f.status === 'cancelled') cancelled++;
    }
    if (!dep || dep.scheduled < from || dep.scheduled >= to || dep.status === 'cancelled') continue;
    const nominal = nominalOutSec(sim, { ...ac, standId: dep.standId ?? ac.standId });
    let delaySec: number | null = null;
    if (dep.actual !== null) delaySec = takeoffDelaySec(sim, ac.id);
    else {
      carriedOver++;
      const predicted = nominal === null ? null : predictTakeoffAt(sim, { ...ac, standId: dep.standId ?? ac.standId }, Math.max(state.now, dep.estimated));
      if (predicted !== null && nominal !== null) delaySec = Math.max(0, predicted - (dep.scheduled + nominal));
    }
    if (!last || dep.scheduled > last.scheduled || (dep.scheduled === last.scheduled && ac.id > last.id)) last = { scheduled: dep.scheduled, id: ac.id, delaySec };
  }
  return {
    lastDepartureDelayMin: last && last.delaySec !== null ? Math.round(last.delaySec / 60) : null,
    standHeld, originHeld, carriedOver, diverted, cancelled,
  };
}


