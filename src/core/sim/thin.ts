import { DAY_SEC } from './rules';
import { PAX_FINAL_STATES, type SimState } from './types';

/**
 * 保存データの間引き（5-11）: 保存スナップショットを作るときに、前日以前に終わった便と
 * それに付随する旅客グループ・手荷物・タスク・機体を取り除く。
 * 生きている機体が参照する便と、当日の便はすべて残す（復元時の整合性チェックを通るため）。
 * 実行中の sim には適用しない（運航フィンガープリントを変えないため、保存時の複製にだけ使う）。
 */
const FINISHED_FLIGHT = new Set(['completed', 'diverted', 'cancelled']);
const GONE_AIRCRAFT = new Set(['departed', 'diverted', 'cannotOperate']);
const FINAL_BAG = new Set(['loaded', 'leftBehind', 'offloaded', 'collected']);

export function thinSnapshotState(state: SimState): { flights: number; groups: number; bags: number; aircraft: number } {
  // 間引きの境界は「当日 0:00」と「未締めの期間の始まり（economy.periodStart）」の早い方。
  // 0:00 ちょうど（日次締めの tick の前）に保存すると、前日はまだ締めていない。前日の便を間引くと、
  // 復元後の締めがその日の便を数えられず、翌日の計画（需要・搭乗見込み）まで変わってしまう（2026-11-28 修正）。
  // 日中の保存では periodStart = 当日 0:00 なので従来と同じ。
  const todayStart = Math.min(Math.floor(state.now / DAY_SEC) * DAY_SEC, state.economy?.periodStart ?? Infinity);
  const liveAircraft = Object.values(state.aircraft).filter((a) => !GONE_AIRCRAFT.has(a.state));
  const keepFlights = new Set<string>();
  for (const a of liveAircraft) {
    keepFlights.add(a.arrivalFlightId);
    keepFlights.add(a.departureFlightId);
  }
  for (const f of Object.values(state.flights)) {
    if (!FINISHED_FLIGHT.has(f.status) || f.scheduled >= todayStart) keepFlights.add(f.id);
  }
  const prunedFlights = new Set(Object.keys(state.flights).filter((id) => !keepFlights.has(id)));
  // 残る機体（離陸済みでも片方の便だけ新しい等）の参照先は消さない。両便とも間引き対象の機体だけが対象になる
  for (const a of Object.values(state.aircraft)) {
    if (!GONE_AIRCRAFT.has(a.state)) continue;
    const arrGone = prunedFlights.has(a.arrivalFlightId) || !state.flights[a.arrivalFlightId];
    const depGone = prunedFlights.has(a.departureFlightId) || !state.flights[a.departureFlightId];
    if (arrGone && depGone) continue;
    prunedFlights.delete(a.arrivalFlightId);
    prunedFlights.delete(a.departureFlightId);
  }

  let groups = 0;
  for (const g of Object.values(state.paxGroups)) {
    if (prunedFlights.has(g.flightId) && PAX_FINAL_STATES.includes(g.state)) {
      delete state.paxGroups[g.id];
      groups++;
    }
  }
  if (groups > 0) {
    state.activePax = state.activePax.filter((id) => state.paxGroups[id]);
    for (const fac of Object.values(state.facilities)) {
      fac.queue = fac.queue.filter((id) => state.paxGroups[id]);
      fac.inService = fac.inService.filter((id) => state.paxGroups[id]);
    }
  }

  let bags = 0;
  for (const b of Object.values(state.bags)) {
    if (!prunedFlights.has(b.flightId) || !FINAL_BAG.has(b.state)) continue;
    if (b.transferToFlightId && !prunedFlights.has(b.transferToFlightId)) continue; // 付け替え先が生きている
    delete state.bags[b.id];
    bags++;
  }

  let aircraft = 0;
  for (const a of Object.values(state.aircraft)) {
    if (!GONE_AIRCRAFT.has(a.state)) continue;
    if (!prunedFlights.has(a.arrivalFlightId) || !prunedFlights.has(a.departureFlightId)) continue;
    for (const taskId of state.aircraftTasks[a.id] ?? []) delete state.tasks[taskId];
    delete state.aircraftTasks[a.id];
    if (a.standId && state.standAssignments[a.standId] === a.id) delete state.standAssignments[a.standId];
    delete state.aircraft[a.id];
    aircraft++;
  }

  for (const id of prunedFlights) delete state.flights[id];
  return { flights: prunedFlights.size, groups, bags, aircraft };
}
