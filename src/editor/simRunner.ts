import { addTurnaround, createSimulation, setRunwayConfig, stepSimulation } from '../core/sim/simulation';
import { advanceClock, createClock } from '../core/sim/clock';
import { INBOUND_LEAD_SEC } from '../core/sim/rules';
import { setAreaClosed } from '../core/sim/passengers';
import { setUnitBroken } from '../core/sim/ground';
import { setEquipmentBroken } from '../core/sim/baggage';
import type { AircraftTypeId } from '../core/sim/aircraftTypes';
import type { RunwayConfig } from '../core/sim/types';
import { applyFinishedProjects, editorStore, forgetCharges, formatCr, showToast, type OpsState } from './store';
import { settleDay } from '../core/economy/ops';
import {
  acceptOffer,
  changeContractAircraft,
  removeFleetEntry,
  setFleetEntry,
  type FleetResult,
  changeFrequency,
  rejectOffer,
  setFees,
  setHours,
  type CompanyState,
  type ContractActionResult,
  type FeeSettings,
  type OperatingHours,
} from '../core/economy/company';
import { createContext, operableTypes } from '../core/sim/context';
import { CONTRACT_ACTION_LABEL, FLEET_RESULT_LABEL, RESPONSE_LABEL } from '../i18n/ja';
import {
  addDisruption,
  delayFlight,
  prioritize,
  reassignStand,
  resolveDisruption,
  type DisruptionInput,
  type ResponseResult,
} from '../core/sim/disruptions';

/**
 * 運航モードのループ。requestAnimationFrame の実時間からティック数を求め（core/sim/clock.ts）、
 * 固定刻みのティックを必要数だけ進めてから描画する。描画とゲーム内時間は独立している。
 */

const get = editorStore.getState;
const set = editorStore.setState;
let raf = 0;
let lastTs = 0;
let lastUi = 0;

function patchOps(patch: Partial<OpsState>): void {
  const ops = get().ops;
  if (ops) set({ ops: { ...ops, ...patch } });
}

function frame(ts: number): void {
  const ops = get().ops;
  if (!ops) return;
  const dt = lastTs ? (ts - lastTs) / 1000 : 0;
  lastTs = ts;
  const r = advanceClock(ops.clock, dt);
  for (let i = 0; i < r.ticks; i++) {
    stepSimulation(ops.sim);
    if (ops.sim.company?.bankrupt) {
      showToast('経営破綻: 資金のマイナスが続いたため、運航を続けられません', 'error');
      endOps();
      return;
    }
  }
  const ui = ts - lastUi > 100 || r.ticks === 0;
  if (ui) lastUi = ts;
  patchOps({ clock: r.clock, frame: ops.frame + 1, dropped: r.dropped, uiVersion: ui ? ops.uiVersion + 1 : ops.uiVersion });
  raf = requestAnimationFrame(frame);
}

export const ops = {
  start(seed?: string): void {
    const s = get();
    if (s.company.bankrupt) {
      showToast('経営破綻しています。新しいゲームを始めてください', 'error');
      return;
    }
    const sim = createSimulation(s.history.present, { ...(seed ? { seed } : {}), company: structuredClone(s.company) });
    if (Object.keys(sim.ctx.runways).length === 0) {
      showToast('滑走路がないため運航できません', 'error');
      return;
    }
    cancelAnimationFrame(raf);
    forgetCharges();
    set({
      mode: 'operate',
      tool: 'select',
      draft: null,
      selection: null,
      ops: { sim, clock: createClock(60), selectedAircraft: null, frame: 0, uiVersion: 0, dropped: false },
    });
    lastTs = 0;
    raf = requestAnimationFrame(frame);
    const n = Object.keys(sim.state.flights).length / 2;
    showToast(n > 0 ? `運航を開始しました（本日 ${n} 往復）` : '運航を開始しました。運航できる機種がないため便は生成されていません', n > 0 ? 'info' : 'error');
  },
  /** 運航を終了する。その日を途中で締めて、経営の状態を建設モードへ引き継ぐ */
  stop(): void {
    endOps();
  },
  restart(): void {
    endOps();
    ops.start();
  },
  setSpeed(speed: number): void {
    const o = get().ops;
    if (o) patchOps({ clock: { ...o.clock, speed }, uiVersion: o.uiVersion + 1 });
  },
  togglePause(): void {
    const o = get().ops;
    if (!o) return;
    patchOps({ clock: { ...o.clock, speed: o.clock.speed > 0 ? 0 : (pausedSpeed ?? 60) }, uiVersion: o.uiVersion + 1 });
    if (o.clock.speed > 0) pausedSpeed = o.clock.speed;
  },
  selectAircraft(id: string | null): void {
    const o = get().ops;
    if (o) patchOps({ selectedAircraft: id, uiVersion: o.uiVersion + 1 });
    if (id) set({ selection: null });
  },
  setRunway(runwayId: string, cfg: Partial<RunwayConfig>): void {
    const o = get().ops;
    if (!o) return;
    setRunwayConfig(o.sim, runwayId, cfg);
    patchOps({ uiVersion: o.uiVersion + 1 });
  },
  /** 到着便を今すぐ追加する（空域に現れ、折り返して出発する） */
  addArrival(typeId: AircraftTypeId): void {
    const o = get().ops;
    if (!o) return;
    const ac = addTurnaround(o.sim, typeId, o.sim.state.now + INBOUND_LEAD_SEC);
    patchOps({ uiVersion: o.uiVersion + 1 });
    showToast(`${ac.callsign} を追加しました`);
  },
  /** ターミナル内の施設を閉鎖 / 再開する */
  setAreaClosed(areaId: string, closed: boolean): void {
    const o = get().ops;
    if (!o) return;
    setAreaClosed(o.sim, areaId, closed);
    patchOps({ uiVersion: o.uiVersion + 1 });
  },
  /** 作業員・車両の故障 / 復旧 */
  setUnitBroken(unitId: string, broken: boolean): void {
    const o = get().ops;
    if (!o) return;
    setUnitBroken(o.sim, unitId, broken);
    patchOps({ uiVersion: o.uiVersion + 1 });
  },
  /** 仕分け設備・受取所ベルトの停止 / 復旧 */
  setEquipmentBroken(key: string, broken: boolean): void {
    const o = get().ops;
    if (!o) return;
    setEquipmentBroken(o.sim, key, broken);
    patchOps({ uiVersion: o.uiVersion + 1 });
  },
  setRandomFailures(on: boolean): void {
    const o = get().ops;
    if (!o) return;
    o.sim.state.settings.randomFailures = on;
    patchOps({ uiVersion: o.uiVersion + 1 });
  },
  setFlightsPerDay(n: number): void {
    const o = get().ops;
    if (!o) return;
    o.sim.state.settings.flightsPerDay = n;
    patchOps({ uiVersion: o.uiVersion + 1 });
  },
};

let pausedSpeed: number | null = null;

/** 障害・天候と対応（運航中のみ） */
function respond(fn: (o: OpsState) => ResponseResult | boolean, okText?: string): void {
  const o = get().ops;
  if (!o) return;
  const r = fn(o);
  patchOps({ uiVersion: o.uiVersion + 1 });
  if (r === false) showToast('操作できません', 'error');
  else if (r !== true && !r.ok) showToast(RESPONSE_LABEL[r.reason], 'error');
  else if (okText) showToast(okText);
}

export const disruptionActions = {
  add(input: DisruptionInput): void {
    respond((o) => !!addDisruption(o.sim, { ...input, origin: 'manual' }), '障害・天候を設定しました');
  },
  resolve(id: string): void {
    respond((o) => resolveDisruption(o.sim, id), '修理・解除しました（費用を計上）');
  },
  reassignStand(acId: string, standId: string): void {
    respond((o) => reassignStand(o.sim, acId, standId), '代替スポットに変更しました');
  },
  delay(flightId: string, minutes: number): void {
    respond((o) => delayFlight(o.sim, flightId, minutes), `${minutes}分遅らせました`);
  },
  prioritize(acId: string, on: boolean): void {
    respond((o) => prioritize(o.sim, acId, on), on ? '地上作業を優先します' : '優先を解除しました');
  },
  setRandom(on: boolean): void {
    const o = get().ops;
    if (!o) return;
    o.sim.state.settings.randomDisruptions = on;
    patchOps({ uiVersion: o.uiVersion + 1 });
  },
};

function endOps(): void {
  cancelAnimationFrame(raf);
  const o = get().ops;
  if (o?.sim.company) {
    const report = o.sim.company.bankrupt ? null : settleDay(o.sim, true);
    set({ mode: 'build', ops: null, company: o.sim.company });
    if (report) showToast(`${report.day + 1}日目を締めました（営業利益 ${formatCr(report.operatingProfit)}）`);
    applyFinishedProjects();
    return;
  }
  set({ mode: 'build', ops: null });
}

/**
 * 会社の設定を変える。運航中はシミュレーションの会社（最新）を、建設中はストアの会社を更新する。
 */
function mutateCompany(fn: (c: CompanyState) => ContractActionResult | FleetResult | void): boolean {
  const o = get().ops;
  let r: ContractActionResult | FleetResult | void;
  if (o?.sim.company) {
    r = fn(o.sim.company);
    patchOps({ uiVersion: o.uiVersion + 1 });
  } else {
    const c = structuredClone(get().company);
    r = fn(c);
    if (!r || r.ok) set({ company: c });
  }
  if (r && !r.ok) showToast((CONTRACT_ACTION_LABEL as Record<string, string>)[r.reason] ?? FLEET_RESULT_LABEL[r.reason as keyof typeof FLEET_RESULT_LABEL], 'error');
  return !r || r.ok;
}

export const companyActions = {
  acceptOffer(id: string): void {
    const s = get();
    const c = s.ops?.sim.company ?? s.company;
    const k = c.contracts[id];
    if (!k) return;
    const ctx = s.ops?.sim.ctx ?? createContext(s.history.present);
    if (mutateCompany((x) => acceptOffer(x, id, operableTypes(ctx).includes(k.typeId)))) {
      showToast(s.ops ? '契約しました（翌日の運航計画から運航します）' : '契約しました');
    }
  },
  rejectOffer(id: string): void {
    mutateCompany((c) => rejectOffer(c, id));
  },
  changeFrequency(id: string, delta: 1 | -1): void {
    mutateCompany((c) => changeFrequency(c, id, delta));
  },
  setFees(fees: Partial<FeeSettings>): void {
    mutateCompany((c) => setFees(c, fees));
  },
  setHours(hours: Partial<OperatingHours>): void {
    mutateCompany((c) => setHours(c, hours));
  },
  /** 保有機材の追加・座席数の変更（座席数は最大旅客定員まで） */
  setFleetEntry(airlineId: string, typeId: string, seats: number): boolean {
    return mutateCompany((c) => setFleetEntry(c, airlineId, typeId, seats));
  },
  removeFleetEntry(airlineId: string, typeId: string): void {
    mutateCompany((c) => removeFleetEntry(c, airlineId, typeId));
  },
  /** 契約の機材変更（翌日の運航計画から） */
  changeContractAircraft(contractId: string, typeId: string): void {
    if (mutateCompany((c) => changeContractAircraft(c, contractId, typeId))) showToast('機材を変更しました（次の運航計画から反映）');
  },
};
