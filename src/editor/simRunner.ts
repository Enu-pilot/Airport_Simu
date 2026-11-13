import { addTurnaround, cancelFlightEarly, createSimulation, setRunwayConfig, type Simulation } from '../core/sim/simulation';
import { majorDisruptionWatcher, nextCloseAt, nightEndAt, stepTicks, type StepResult } from '../core/sim/dayloop';
import { buildDayReview, emptyResponses, type DayReview, type ReviewResponses } from '../core/analytics/review';
import { recordDayClose } from './dayHistory';
import { buildTypeTable } from '../core/sim/aircraftTypes';
import { effectiveModels } from '../core/io/project';
import { advanceClock, createClock } from '../core/sim/clock';
import { INBOUND_LEAD_SEC } from '../core/sim/rules';
import { setAreaClosed } from '../core/sim/passengers';
import { setUnitBroken } from '../core/sim/ground';
import { setEquipmentBroken } from '../core/sim/baggage';
import type { AircraftTypeId } from '../core/sim/aircraftTypes';
import type { RunwayConfig } from '../core/sim/types';
import { applyFinishedProjects, editorStore, forgetCharges, formatCr, initialDayFlow, saveCompanyAutosave, showToast, type OpsState } from './store';
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

/** 1 日のループの追跡（UI 側。シミュレーションには入れない）: 日の初めの時刻・航空会社の満足度・プレイヤーの対応の回数 */
let track: { dayStart: number; airlinesBefore: Record<string, number>; responses: ReviewResponses } = { dayStart: 0, airlinesBefore: {}, responses: emptyResponses() };

function resetTrack(sim: Simulation): void {
  track = {
    dayStart: sim.state.economy?.periodStart ?? sim.state.now,
    airlinesBefore: Object.fromEntries(Object.entries(sim.company?.airlines ?? {}).map(([id, a]) => [id, a.satisfaction])),
    responses: emptyResponses(),
  };
}

/** 日次の締めの直後の処理: 振り返りを作り、オートセーブと履歴を残して、次の日の追跡を始める */
function handleDayClose(sim: Simulation): DayReview | null {
  const company = sim.company;
  if (!company || company.reports.length === 0) return null;
  const review = buildDayReview({ sim, company, dayStart: track.dayStart, airlinesBefore: track.airlinesBefore, responses: track.responses, access: sim.state.access?.factor ?? 1 });
  saveCompanyAutosave(company);
  recordDayClose(sim, review);
  resetTrack(sim);
  set({ dayFlow: { ...get().dayFlow, review } });
  return review;
}

function toReviewPhase(clock: OpsState['clock']): OpsState['clock'] {
  if (clock.speed > 0) pausedSpeed = clock.speed;
  set({ dayFlow: { ...get().dayFlow, phase: 'review', atClose: true, skip: null } });
  return { ...clock, speed: 0, acc: 0 };
}

function frame(ts: number): void {
  const ops = get().ops;
  if (!ops) return;
  const dt = lastTs ? (ts - lastTs) / 1000 : 0;
  lastTs = ts;
  const r = advanceClock(ops.clock, dt);
  let clock = r.clock;
  let remaining = r.ticks;
  while (remaining > 0) {
    const res = stepTicks(ops.sim, remaining, { stopAtDayClose: true });
    remaining -= res.ticks;
    if (res.stop === 'bankrupt') {
      showToast('経営破綻: 資金のマイナスが続いたため、運航を続けられません', 'error');
      endOps();
      return;
    }
    if (res.stop === 'dayClose') {
      handleDayClose(ops.sim);
      // 設定が ON なら、締めの直後で一時停止して振り返りを出す（OFF なら続けて走る）
      if (get().opsPrefs.pauseAtDayClose) {
        clock = toReviewPhase(clock);
        break;
      }
    }
  }
  const ui = ts - lastUi > 100 || r.ticks === 0;
  if (ui) lastUi = ts;
  patchOps({ clock, frame: ops.frame + 1, dropped: r.dropped, uiVersion: ui ? ops.uiVersion + 1 : ops.uiVersion });
  raf = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 1 日スキップ・夜間の早送り（ヘッドレス）

/** 1 チャンクの最大 tick 数と、1 回に使う実時間（ミリ秒）。描画・操作に制御を返すためのもの（core には入れない） */
const SKIP_CHUNK_TICKS = 2000;
const SKIP_BUDGET_MS = 12;
let skipToken = 0;
let skipCancelled = false;

function resumeLoop(): void {
  cancelAnimationFrame(raf);
  lastTs = 0;
  const o = get().ops;
  if (o) patchOps({ uiVersion: o.uiVersion + 1, frame: o.frame + 1 });
  raf = requestAnimationFrame(frame);
}

/**
 * ヘッドレスで進める。day = 次の締めまで（重大な障害で止める設定あり）、night = 締めの直後の夜間を次の到着の少し前まで。
 * ライブ運航と同じ stepTicks（stepSimulation の繰り返し）だけで進めるので、結果は画面で進めた場合と同一。
 */
function runHeadless(kind: 'day' | 'night'): void {
  const o0 = get().ops;
  if (!o0) return;
  const sim = o0.sim;
  cancelAnimationFrame(raf);
  const token = ++skipToken;
  skipCancelled = false;
  const start = sim.state.now;
  const end = kind === 'day' ? nextCloseAt(sim) + 1 : nightEndAt(sim);
  const stopWhen = kind === 'day' && get().opsPrefs.skipAutoStop ? majorDisruptionWatcher(sim) : undefined;
  set({ dayFlow: { ...get().dayFlow, phase: 'skipping', atClose: false, skip: { progress: 0, label: kind, stopReason: null } } });

  const finish = (res: StepResult | 'cancel' | 'night'): void => {
    const cur = get().ops;
    if (!cur || cur.sim !== sim || token !== skipToken) return;
    const df = get().dayFlow;
    if (res === 'night') {
      set({ dayFlow: { ...df, phase: 'none', skip: null } });
      patchOps({ clock: { ...cur.clock, speed: pausedSpeed ?? 60, acc: 0 } });
      resumeLoop();
      return;
    }
    if (res !== 'cancel' && res.stop === 'bankrupt') {
      showToast('経営破綻: 資金のマイナスが続いたため、運航を続けられません', 'error');
      endOps();
      return;
    }
    if (res !== 'cancel' && res.stop === 'dayClose') {
      handleDayClose(sim);
      patchOps({ clock: toReviewPhase(cur.clock) });
      resumeLoop();
      return;
    }
    // 中止・重大な障害: 途中の時刻で一時停止の運航に戻る
    if (cur.clock.speed > 0) pausedSpeed = cur.clock.speed;
    set({ dayFlow: { ...df, phase: 'none', skip: null } });
    patchOps({ clock: { ...cur.clock, speed: 0, acc: 0 } });
    resumeLoop();
    showToast(res === 'cancel' ? 'スキップを中止しました（その時刻で一時停止しています）' : '重大な障害が起きたためスキップを止めました（一時停止しています）', res === 'cancel' ? 'info' : 'error');
  };

  const chunk = (): void => {
    const cur = get().ops;
    if (!cur || cur.sim !== sim || token !== skipToken) return;
    if (skipCancelled) return finish('cancel');
    const t0 = performance.now();
    let result: StepResult | null = null;
    do {
      if (kind === 'night') {
        const n = Math.min(SKIP_CHUNK_TICKS, end - sim.state.now);
        if (n <= 0) return finish('night');
        const r = stepTicks(sim, n);
        if (r.stop) result = r;
      } else {
        const r = stepTicks(sim, SKIP_CHUNK_TICKS, { stopAtDayClose: true, ...(stopWhen ? { stopWhen } : {}) });
        if (r.stop) result = r;
      }
    } while (!result && performance.now() - t0 < SKIP_BUDGET_MS);
    if (result) return finish(result);
    const df = get().dayFlow;
    if (df.skip) set({ dayFlow: { ...df, skip: { ...df.skip, progress: Math.min(1, (sim.state.now - start) / Math.max(1, end - start)) } } });
    setTimeout(chunk, 0);
  };
  setTimeout(chunk, 0);
}

export const ops = {
  start(seed?: string): void {
    const s = get();
    if (s.company.bankrupt) {
      showToast('経営破綻しています。新しいゲームを始めてください', 'error');
      return;
    }
    // プロジェクトが保存時の機種データで固定されていれば、その値で運航する
    const types = s.catalogPin ? buildTypeTable(effectiveModels(s.catalogPin)) : undefined;
    // ゲームのモデル（会社の game）がある会社は、運航を始める日ごとに運航のシードを変える（同じ日付の運航が毎回同じにならない）
    const runSeed = seed ?? (s.company.game ? `${s.history.present.site.seed}:ops:${s.company.day}` : undefined);
    const sim = createSimulation(s.history.present, { ...(runSeed ? { seed: runSeed } : {}), company: structuredClone(s.company), ...(types ? { types } : {}) });
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
    resetTrack(sim);
    set({ dayFlow: { ...initialDayFlow(), review: get().dayFlow.review } });
    raf = requestAnimationFrame(frame);
    const n = Object.keys(sim.state.flights).length / 2;
    showToast(n > 0 ? `運航を開始しました（本日 ${n} 往復）` : '運航を開始しました。運航できる機種がないため便は生成されていません', n > 0 ? 'info' : 'error');
  },
  /** 保存した運航状態から再開する（一時停止の状態で始める） */
  resume(sim: Simulation): void {
    cancelAnimationFrame(raf);
    forgetCharges();
    set({
      mode: 'operate',
      tool: 'select',
      draft: null,
      selection: null,
      ops: { sim, clock: { ...createClock(60), speed: 0 }, selectedAircraft: null, frame: 0, uiVersion: 0, dropped: false },
    });
    pausedSpeed = 60;
    lastTs = 0;
    resetTrack(sim);
    set({ dayFlow: { ...initialDayFlow(), review: get().dayFlow.review } });
    raf = requestAnimationFrame(frame);
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
    if (get().dayFlow.phase !== 'none') return;
    if (o) patchOps({ clock: { ...o.clock, speed }, uiVersion: o.uiVersion + 1 });
  },
  togglePause(): void {
    const o = get().ops;
    if (!o || get().dayFlow.phase !== 'none') return;
    patchOps({ clock: { ...o.clock, speed: o.clock.speed > 0 ? 0 : (pausedSpeed ?? 60) }, uiVersion: o.uiVersion + 1 });
    if (o.clock.speed > 0) pausedSpeed = o.clock.speed;
  },
  /** 残りの 1 日をヘッドレスで進めて、締めの振り返りを出す（建設モードからなら運航を始めてすぐ進める） */
  skipDay(): void {
    if (!get().ops) {
      ops.start();
      if (!get().ops) return;
    }
    if (get().dayFlow.phase === 'skipping') return;
    const o = get().ops!;
    if (o.clock.speed > 0) pausedSpeed = o.clock.speed;
    runHeadless('day');
  },
  /** スキップの中止（その時刻で一時停止の運航になる） */
  cancelSkip(): void {
    skipCancelled = true;
  },
  /**
   * 振り返りから次の日へ。締めの直後なら夜間をヘッドレスで早送りしてから元の倍率で再開する。
   * 締めの直後でなければ（「前日の振り返り」から開いた場合）そのまま再開する。
   */
  nextDay(): void {
    const o = get().ops;
    const df = get().dayFlow;
    if (!o || df.phase !== 'review') return;
    if (df.atClose) runHeadless('night');
    else {
      set({ dayFlow: { ...df, phase: 'none' } });
      patchOps({ clock: { ...o.clock, speed: pausedSpeed ?? 60, acc: 0 } });
    }
  },
  /** 直近の振り返りを開く（運航中は一時停止する。建設モードでは読み取り専用で表示する） */
  openReview(): void {
    const df = get().dayFlow;
    if (!df.review) return;
    const o = get().ops;
    if (o) {
      if (df.phase !== 'none') return;
      if (o.clock.speed > 0) pausedSpeed = o.clock.speed;
      patchOps({ clock: { ...o.clock, speed: 0, acc: 0 } });
      set({ dayFlow: { ...df, phase: 'review', atClose: false } });
    } else set({ dayFlow: { ...df, viewing: df.review } });
  },
  /** 履歴から過去の振り返りを読み取り専用で開く */
  viewReview(review: DayReview | null): void {
    set({ dayFlow: { ...get().dayFlow, viewing: review } });
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
function respond(fn: (o: OpsState) => ResponseResult | boolean, okText?: string, count?: keyof ReviewResponses): void {
  const o = get().ops;
  if (!o) return;
  const r = fn(o);
  if (count && (r === true || (r !== false && r.ok))) track.responses[count]++;
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
    respond((o) => resolveDisruption(o.sim, id), '修理・解除しました（費用を計上）', 'repairs');
  },
  reassignStand(acId: string, standId: string): void {
    respond((o) => reassignStand(o.sim, acId, standId), '代替スポットに変更しました', 'reassigns');
  },
  delay(flightId: string, minutes: number): void {
    respond((o) => delayFlight(o.sim, flightId, minutes), `${minutes}分遅らせました`, 'delays');
  },
  cancelEarly(acId: string): void {
    respond((o) => cancelFlightEarly(o.sim, acId), '先行欠航にしました（補償なし・航空会社の満足度 −1）');
  },
  prioritize(acId: string, on: boolean): void {
    respond((o) => prioritize(o.sim, acId, on), on ? '地上作業を優先します' : '優先を解除しました', on ? 'priorities' : undefined);
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
  skipToken++; // 実行中のスキップを無効にする
  const o = get().ops;
  const df = get().dayFlow;
  // 締めの直後に建設へ戻るときは、すでに締め済みなので締めをやり直さない（空の日報を作らない）
  const atClose = df.atClose;
  const keep = { ...initialDayFlow(), review: df.review };
  if (o?.sim.company) {
    const report = o.sim.company.bankrupt || atClose ? null : settleDay(o.sim, true);
    set({ mode: 'build', ops: null, company: o.sim.company, dayFlow: keep });
    if (report) showToast(`${report.day + 1}日目を締めました（営業利益 ${formatCr(report.operatingProfit)}）`);
    else if (atClose && df.review) showToast(`${df.review.day + 1}日目の締めは済んでいます（営業利益 ${formatCr(df.review.report.operatingProfit)}）。次の日の準備ができます`);
    applyFinishedProjects();
    return;
  }
  set({ mode: 'build', ops: null, dayFlow: keep });
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
