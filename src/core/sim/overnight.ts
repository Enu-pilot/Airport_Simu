import { checkStand } from '../aircraft/compat';
import { compareIds } from '../model/ids';
import { Rng } from '../rng';
import { BALANCE } from '../economy/balance';
import { overnightFeasible, overnightRequired } from '../economy/capacity';
import { analyzeDayPlan, planDayWithDemand, STAFF_PER_TURNAROUND } from '../economy/planning';
import { routeCapabilitiesForAirport } from '../economy/registry';
import type { BasedAircraft, CarryOverAircraft } from '../economy/phase4Types';
import { featureOn } from '../economy/unlocks';
import { resolveType } from './aircraftTypes';
import { createTurnaroundTasks } from './ground';
import { emptyFlightPax } from './passengers';
import { DAY_SEC } from './rules';
import { addDelayCause, logEvent, nextId, placeAtStand, setState, type Simulation } from './simulation';
import type { Aircraft, Flight } from './types';

/**
 * 夜間滞泊の「軽い方式」（フェーズ 4 §3.3）: 締めで日をまたぐ機体を会社に記録し、
 * 新しい sim ではスケジュール生成の前に置き直す。続けて運航・復元では機体が生きているので記録は使わない。
 */

const PARKED_STATES = ['parked', 'turnaround', 'readyForPushback'] as const;

/** 整備の結果（所属機 ID → 遅れ・欠航） */
export type TechResults = Map<string, { delaySec: number; cancel: boolean }>;

/** 締めの直前に、今夜スポットに残る機体を会社へ記録する（c.day++ の前に呼ぶ） */
export function recordCarryOver(sim: Simulation, tech: TechResults = new Map()): void {
  const { state } = sim;
  const c = sim.company;
  if (!c) return;
  const overnightOn = featureOn(c, 'overnight');
  const nightHoldOn = !!c.city?.nightOps;
  if (!overnightOn && !nightHoldOn) return;
  const aircraft: CarryOverAircraft[] = [];
  for (const ac of Object.values(state.aircraft)) {
    if (!(PARKED_STATES as readonly string[]).includes(ac.state)) continue;
    const dep = state.flights[ac.departureFlightId];
    const arr = state.flights[ac.arrivalFlightId];
    if (!dep || !arr || dep.status !== 'scheduled') continue;
    const isOvernight = dep.overnight === true;
    const isNightHold = dep.nightHold?.kind === 'stand';
    if (!isOvernight && !isNightHold) continue;
    if (isOvernight && !overnightOn) continue;
    if (isNightHold && !isOvernight && !nightHoldOn) continue;
    const t = dep.basedAircraftId ? tech.get(dep.basedAircraftId) : undefined;
    aircraft.push({
      sourceAircraftId: ac.id,
      typeId: ac.typeId,
      airlineId: dep.airlineId,
      contractId: dep.contractId,
      destinationId: dep.destinationId,
      callsign: ac.callsign,
      depNumber: Number(dep.number.replace(/\D/g, '')) || 0,
      standId: ac.standId ?? arr.plannedStandId ?? '',
      parkedBeforeSec: Math.max(0, state.now - (arr.block ?? state.now)),
      depSecOfDay: ((dep.scheduled % DAY_SEC) + DAY_SEC) % DAY_SEC,
      depDelaySec: Math.max(0, dep.estimated - dep.scheduled),
      depPax: dep.plannedPax,
      ...(dep.seats !== undefined ? { seats: dep.seats } : {}),
      ...(dep.basedAircraftId ? { basedAircraftId: dep.basedAircraftId } : {}),
      ...(dep.routeType ? { routeType: dep.routeType } : {}),
      ...(t && t.delaySec > 0 ? { techDelaySec: t.delaySec } : {}),
      ...(t?.cancel ? { techCancel: true as const } : {}),
    });
  }
  aircraft.sort((a, b) => compareIds(a.sourceAircraftId, b.sourceAircraftId));
  c.carryOver = { forDay: c.day + 1, aircraft };
}

/** 新しい sim の開始時に、記録された機体をスポットへ置き直す（createSimulation から呼ばれる） */
export function materializeCarryOver(sim: Simulation): void {
  const { state, ctx } = sim;
  const c = sim.company;
  if (!c?.carryOver || c.carryOver.forDay !== c.day) return;
  const dayStart = Math.floor(state.now / DAY_SEC) * DAY_SEC;
  for (const rec of c.carryOver.aircraft) {
    const type = resolveType(ctx.types, rec.typeId);
    // スポット: 記録のスポット → 同じ航空会社のホームスポット → ID 順で最初の適合スポット
    const fits = (standId: string | null | undefined): boolean => {
      if (!standId) return false;
      const st = ctx.stands[standId];
      const layoutStand = ctx.layout.stands[standId];
      if (!st || !layoutStand || !st.operational || !st.entry) return false;
      if (state.standAssignments[standId] || state.closures.stands.includes(standId)) return false;
      return checkStand(type, layoutStand, ctx.network).status === 'ok';
    };
    let standId: string | null = fits(rec.standId) ? rec.standId : null;
    if (!standId && rec.airlineId) {
      const homes = state.airlineStandHomes?.byAirline[rec.airlineId] ?? [];
      standId = homes.find((h) => fits(h)) ?? null;
    }
    if (!standId) {
      standId = Object.keys(ctx.stands).sort(compareIds).find((id) => fits(id)) ?? null;
    }
    const acId = nextId(state, 'ac');
    const arrId = nextId(state, 'fl');
    const depId = nextId(state, 'fl');
    const depScheduled = Math.max(dayStart + rec.depSecOfDay, state.now + 20 * 60);
    const arr: Flight = {
      id: arrId, number: rec.callsign, direction: 'arrival', aircraftId: acId,
      scheduled: dayStart - rec.parkedBeforeSec, estimated: dayStart - rec.parkedBeforeSec, actual: dayStart - rec.parkedBeforeSec,
      block: dayStart - rec.parkedBeforeSec, status: 'completed', runwayId: null, standId,
      delayCauses: [], pax: { ...emptyFlightPax(), generated: true, booked: 0 }, readyAt: null, criticalTask: null,
      airlineId: rec.airlineId, contractId: rec.contractId, destinationId: rec.destinationId,
      plannedPax: 0, plannedStandId: standId, carryOver: true,
      ...(rec.routeType ? { routeType: rec.routeType } : {}),
    };
    // 引き継ぐ遅延は当日中に収める。前日の見積りが翌朝までずれた遅延（夜間待機の解放時刻など）を
    // そのまま足すと、見積りがさらに翌日になって搭乗が始まらず、遅延が毎日自己増殖する
    const depEstimated = Math.min(depScheduled + rec.depDelaySec, dayStart + DAY_SEC - 1800);
    const dep: Flight = {
      id: depId, number: `${rec.callsign.replace(/\d+$/, '')}${rec.depNumber}`, direction: 'departure', aircraftId: acId,
      scheduled: depScheduled, estimated: depEstimated, actual: null, block: null,
      status: 'scheduled', runwayId: null, standId,
      delayCauses: [], pax: emptyFlightPax(), readyAt: null, criticalTask: null,
      airlineId: rec.airlineId, contractId: rec.contractId, destinationId: rec.destinationId,
      plannedPax: rec.depPax, plannedStandId: standId, overnight: true,
      ...(rec.seats !== undefined ? { seats: rec.seats } : {}),
      ...(rec.basedAircraftId ? { basedAircraftId: rec.basedAircraftId } : {}),
      ...(rec.routeType ? { routeType: rec.routeType } : {}),
      ...(rec.techDelaySec ? { techHoldUntil: depScheduled + rec.techDelaySec } : {}),
    };
    state.flights[arrId] = arr;
    state.flights[depId] = dep;
    const ac: Aircraft = {
      id: acId, typeId: rec.typeId, callsign: rec.callsign, arrivalFlightId: arrId, departureFlightId: depId,
      state: 'parked', stateSince: state.now, runwayId: null, standId,
      route: null, dist: 0, speed: 0, x: 0, y: 0, heading: 0, px: 0, py: 0, pheading: 0,
      holdReason: null, waitSince: null, eta: null, timerUntil: null, queuedSince: null, retryAt: 0,
      taxiStartedAt: null, crossing: null, history: [{ t: state.now, state: 'parked', note: 'carryOver' }],
    };
    state.aircraft[acId] = ac;
    if (!standId) {
      // 置くスポットがない: 出発便を欠航にする（補償は締めで delayedFlight60 と同額を計上する想定。ここでは記録とログ）
      dep.status = 'cancelled';
      state.stats.cancelled++;
      logEvent(state, { t: state.now, kind: 'cannotOperate', aircraftId: acId, note: 'overnightNoStand' });
      setState(state, ac, 'cannotOperate', 'overnightNoStand');
      continue;
    }
    state.standAssignments[standId] = acId;
    placeAtStand(sim, ac);
    createTurnaroundTasks(sim, ac, { skip: ['deplane', 'unload'] });
    if (rec.techCancel) {
      dep.status = 'cancelled';
      addDelayCause(dep, 'technical');
      state.stats.cancelled++;
      delete state.standAssignments[standId];
      ac.standId = null;
      setState(state, ac, 'cannotOperate', 'technical');
    }
  }
  delete c.carryOver;
}

// ---------------------------------------------------------------- 整備（フェーズ 4 §3.6）と拠点の条件（§3.5）

/** 1 晩の整備の枠（施設 ID → 枠のリスト。格納庫は大きさ制限つき、整備施設は S・M のみ） */
export function maintenanceSlots(sim: Simulation): { facilityId: string; maxRank: number }[] {
  const { ctx } = sim;
  const c = sim.company!;
  const slots: { facilityId: string; maxRank: number }[] = [];
  const RANK: Record<string, number> = { S: 1, M: 2, L: 3 };
  for (const f of Object.values(ctx.layout.facilities)) {
    if (f.buildState !== 'operational') continue;
    if (f.kind === 'hangar') {
      slots.push({ facilityId: f.id, maxRank: RANK[String(f.props.maxSize ?? 'M')] ?? 2 });
    } else if (f.kind === 'maintenance') {
      const bays = Number(f.props.bays ?? 0);
      if (!Number.isFinite(bays) || bays <= 0) continue;
      c.maintenanceCredit ??= {};
      const total = (c.maintenanceCredit[f.id] ?? 0) + bays * 0.5;
      const whole = Math.floor(total);
      c.maintenanceCredit[f.id] = total - whole;
      for (let i = 0; i < whole; i++) slots.push({ facilityId: f.id, maxRank: 2 });
    }
  }
  return slots;
}

/** 整備の能力（1 晩あたりの機数。条件判定用で端数の繰り越しはしない） */
export function maintenanceCapacityPerNight(sim: Simulation): number {
  const { ctx } = sim;
  let n = 0;
  for (const f of Object.values(ctx.layout.facilities)) {
    if (f.buildState !== 'operational') continue;
    if (f.kind === 'hangar') n += 1;
    else if (f.kind === 'maintenance') n += Math.floor(Number(f.props.bays ?? 0) * 0.5);
  }
  return n;
}

/** 整備士の数（整備施設の engineers の合計） */
export function engineerCount(sim: Simulation): number {
  let n = 0;
  for (const f of Object.values(sim.ctx.layout.facilities)) {
    if (f.kind === 'maintenance' && f.buildState === 'operational') n += Number(f.props.engineers ?? 0);
  }
  return n;
}

export interface Phase4SettleResult {
  maintenance?: { checked: number; overdue: number; faults: number; techCancelled: number };
  /** 翌朝の出発可能機数（F6-11、PO 承認 2026-11-19）。朝の窓に出発予定がある日だけ */
  readiness?: { scheduled: number; ready: number; atRisk: number };
  events: string[];
}

/** 翌朝の出発窓（決済時点 = 06:00 から 4 時間、朝の始発の波と対応させる） */
export const MORNING_WINDOW_SEC = 4 * 3600;

/**
 * 翌朝の出発可能機数（F6-11）。夜間滞泊した機材で翌朝の窓（06:00–10:00）に出発が
 * 予定されている便を数え、確定可能とリスクありに分ける。
 * - 確定可能: 周期整備の対象外か、今夜の整備枠で処理できた所属機で、スポットが閉鎖されていない
 * - リスクあり: 整備枠に入らなかった整備対象機（不具合は確率判定のため、ここでは確率を予測しない）、
 *   またはスポットが閉鎖されている機
 * 故障の抽選（settlePhase4 の (3)）より前に数えるため、予定は抽選結果に左右されない。
 */
export function morningReadiness(sim: Simulation, uncheckedDueBasedIds: ReadonlySet<string>): { scheduled: number; ready: number; atRisk: number } {
  const { state } = sim;
  const from = state.now;
  const to = from + MORNING_WINDOW_SEC;
  let scheduled = 0;
  let ready = 0;
  let atRisk = 0;
  for (const ac of Object.values(state.aircraft)) {
    if (!(PARKED_STATES as readonly string[]).includes(ac.state)) continue;
    const dep = state.flights[ac.departureFlightId];
    if (!dep || dep.direction !== 'departure' || dep.overnight !== true || dep.status !== 'scheduled') continue;
    if (dep.scheduled < from || dep.scheduled >= to) continue;
    scheduled++;
    const maintenanceRisk = dep.basedAircraftId !== undefined && uncheckedDueBasedIds.has(dep.basedAircraftId);
    const standClosed = ac.standId !== null && state.closures.stands.includes(ac.standId);
    if (maintenanceRisk || standClosed) atRisk++;
    else ready++;
  }
  return { scheduled, ready, atRisk };
}

/**
 * フェーズ 4 の締め処理（ops.settleDay から c.day++ の直前に呼ぶ）。
 * 順序（§3.6）: (1) 運航回数 → (2) 整備 → (3) 不具合 → (4) 記録 → (5) 拠点の条件と撤退。
 */
export function settlePhase4(sim: Simulation, periodStart: number): Phase4SettleResult {
  const { state, ctx } = sim;
  const c = sim.company;
  const events: string[] = [];
  if (!c) return { events };
  const tech: TechResults = new Map();
  let maintenance: Phase4SettleResult['maintenance'];
  let readiness: Phase4SettleResult['readiness'];
  if (featureOn(c, 'based') && c.basedFleet) {
    // (1) 当日の出発数を所属機へ ID 順に 1 回ずつ配る
    const based = Object.values(c.basedFleet).sort((a, b) => compareIds(a.id, b.id));
    const byContract = new Map<string, BasedAircraft[]>();
    for (const b of based) byContract.set(b.contractId, [...(byContract.get(b.contractId) ?? []), b]);
    for (const [contractId, fleet] of byContract) {
      const deps = Object.values(state.flights).filter((f) => f.contractId === contractId && f.direction === 'departure' && f.status === 'completed' && f.actual !== null && f.actual >= periodStart && f.actual < state.now).length;
      for (let i = 0; i < deps; i++) fleet[i % fleet.length]!.cycles++;
    }
    // (2) 今夜在泊している所属機のうち、周期を超えたものを枠の数だけ整備する
    const parkedIds = new Set<string>();
    for (const ac of Object.values(state.aircraft)) {
      if (!(PARKED_STATES as readonly string[]).includes(ac.state)) continue;
      const dep = state.flights[ac.departureFlightId];
      if (dep?.basedAircraftId && dep.overnight) parkedIds.add(dep.basedAircraftId);
    }
    const slots = maintenanceSlots(sim);
    const RANK: Record<string, number> = { S: 1, M: 2, L: 3 };
    const due = based.filter((b) => parkedIds.has(b.id) && b.cycles >= BALANCE.phase4.checkCycles)
      .sort((a, b) => b.cycles - a.cycles || compareIds(a.id, b.id));
    let checked = 0;
    const checkedIds = new Set<string>();
    for (const b of due) {
      const rank = RANK[resolveType(ctx.types, b.typeId).size] ?? 1;
      const slotIdx = slots.findIndex((s) => rank <= s.maxRank);
      if (slotIdx < 0) break;
      slots.splice(slotIdx, 1);
      b.cycles = 0;
      b.lastCheckDay = c.day;
      checked++;
      checkedIds.add(b.id);
    }
    // 翌朝の出発可能機数（F6-11）: 不具合の抽選 (3) より前に、整備枠へ入らなかった対象機をリスクとして数える
    {
      const uncheckedDue = new Set(due.filter((b) => !checkedIds.has(b.id)).map((b) => b.id));
      const r = morningReadiness(sim, uncheckedDue);
      if (r.scheduled > 0) readiness = r;
    }
    // (3) 整備されなかった所属機の不具合を決める（専用の種）
    let faults = 0;
    let techCancelled = 0;
    for (const b of based) {
      if (!parkedIds.has(b.id) || checkedIds.has(b.id)) continue;
      const over = Math.max(0, b.cycles - BALANCE.phase4.checkCycles) / BALANCE.phase4.checkCycles;
      if (over <= 0) continue;
      const rng = new Rng(`${c.seed}:tech:${c.day}:${b.id}`);
      if (rng.next() < Math.min(0.6, 0.3 * over)) {
        faults++;
        if (over >= 1 && rng.next() < 0.3) {
          tech.set(b.id, { delaySec: 0, cancel: true });
          techCancelled++;
        } else {
          tech.set(b.id, { delaySec: rng.int(30, 120) * 60, cancel: false });
        }
      }
    }
    const overdue = due.length - checked;
    maintenance = { checked, overdue, faults, techCancelled };
    // 続けて運航の便へ不具合を反映する（置き直しの場合は記録の値を使う）
    for (const ac of Object.values(state.aircraft)) {
      const dep = state.flights[ac.departureFlightId];
      if (!dep?.basedAircraftId) continue;
      const t = tech.get(dep.basedAircraftId);
      if (!t) continue;
      if (t.cancel && dep.status === 'scheduled') {
        dep.status = 'cancelled';
        addDelayCause(dep, 'technical');
        state.stats.cancelled++;
        if (ac.standId && state.standAssignments[ac.standId] === ac.id) delete state.standAssignments[ac.standId];
        setState(state, ac, 'cannotOperate', 'technical');
      } else if (t.delaySec > 0) {
        dep.techHoldUntil = dep.scheduled + t.delaySec;
      }
    }
  }
  // (4) 持ち越しの記録
  recordCarryOver(sim, tech);
  // (5) 拠点の条件と撤退
  if (featureOn(c, 'based')) {
    c.basedIssueDays ??= {};
    for (const k of Object.values(c.contracts)) {
      if (k.kind !== 'based' || k.status !== 'active') continue;
      const unmet = basedConditionsUnmet(sim, k.id);
      if (unmet.length === 0) {
        delete c.basedIssueDays[k.id];
        continue;
      }
      const days = (c.basedIssueDays[k.id] ?? 0) + 1;
      c.basedIssueDays[k.id] = days;
      if (days >= 3) {
        k.status = 'withdrawn';
        if (c.basedFleet) for (const b of Object.values(c.basedFleet)) if (b.contractId === k.id) delete c.basedFleet[b.id];
        delete c.basedIssueDays[k.id];
        c.rating = Math.max(0, c.rating - 5);
        if (c.airlines[k.airlineId]) c.airlines[k.airlineId]!.satisfaction = 30;
        events.push(`拠点契約の条件（${unmet.join('・')}）を満たせず、${k.airlineId} が拠点を撤退しました`);
      }
    }
  }
  // 拠点が無効な会社でも、滞泊便の翌朝出発は数える（整備リスクは無い）
  if (!readiness) {
    const r = morningReadiness(sim, new Set());
    if (r.scheduled > 0) readiness = r;
  }
  return { ...(maintenance ? { maintenance } : {}), ...(readiness ? { readiness } : {}), events };
}

/** 拠点契約の条件のうち満たさないもの（§3.5 (a) 滞泊の能力 (b) 整備の能力 (c) 人員） */
export function basedConditionsUnmet(sim: Simulation, contractId: string): string[] {
  const { ctx } = sim;
  const c = sim.company!;
  const k = c.contracts[contractId];
  if (!k) return ['契約なし'];
  const unmet: string[] = [];
  if (!overnightFeasible(ctx, overnightRequired(c, ctx, c.day), sim.state.closures.stands)) unmet.push('滞泊の能力');
  const n = k.basedAircraft ?? 1;
  const needChecks = Math.ceil((n * k.perDay) / BALANCE.phase4.checkCycles);
  if (maintenanceCapacityPerNight(sim) < needChecks) unmet.push('整備の能力');
  if (engineerCount(sim) < Math.ceil(n / 2)) unmet.push('整備士');
  // (c) 作業員: 当日の計画の同時折り返しのピーク × 1 回あたりの必要数（§3.5）
  let staff = 0;
  for (const b of ctx.bases) staff += b.units.staff ?? 0;
  const plan = planDayWithDemand(c, c.day, 1, ctx.types, routeCapabilitiesForAirport(ctx.layout.countryId));
  const peak = analyzeDayPlan(plan, ctx).peakTurnarounds;
  if (staff < STAFF_PER_TURNAROUND * peak) unmet.push('作業員');
  return unmet;
}

/** 朝の始発の波（§3.4）: その期間に離陸した滞泊の出発便から集計する */
export function morningWave(sim: Simulation, from: number, to: number): { departures: number; firstTakeoff: number | null; lastTakeoff: number | null; intervalsSec: number[] } | null {
  const { state } = sim;
  const takeoffs = Object.values(state.flights)
    .filter((f) => f.overnight && f.direction === 'departure' && f.actual !== null && f.actual >= from && f.actual < to)
    .map((f) => f.actual!)
    .sort((a, b) => a - b);
  if (takeoffs.length === 0) return null;
  const intervalsSec: number[] = [];
  for (let i = 1; i < takeoffs.length; i++) intervalsSec.push(takeoffs[i]! - takeoffs[i - 1]!);
  return { departures: takeoffs.length, firstTakeoff: takeoffs[0]!, lastTakeoff: takeoffs[takeoffs.length - 1]!, intervalsSec };
}
