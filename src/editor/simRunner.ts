import { addTurnaround, createSimulation, setRunwayConfig, stepSimulation } from '../core/sim/simulation';
import { advanceClock, createClock } from '../core/sim/clock';
import { INBOUND_LEAD_SEC } from '../core/sim/rules';
import type { AircraftTypeId } from '../core/sim/aircraftTypes';
import type { RunwayConfig } from '../core/sim/types';
import { editorStore, showToast, type OpsState } from './store';

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
  for (let i = 0; i < r.ticks; i++) stepSimulation(ops.sim);
  const ui = ts - lastUi > 100 || r.ticks === 0;
  if (ui) lastUi = ts;
  patchOps({ clock: r.clock, frame: ops.frame + 1, dropped: r.dropped, uiVersion: ui ? ops.uiVersion + 1 : ops.uiVersion });
  raf = requestAnimationFrame(frame);
}

export const ops = {
  start(seed?: string): void {
    const s = get();
    const sim = createSimulation(s.history.present, seed ? { seed } : {});
    if (Object.keys(sim.ctx.runways).length === 0) {
      showToast('滑走路がないため運航できません', 'error');
      return;
    }
    cancelAnimationFrame(raf);
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
  stop(): void {
    cancelAnimationFrame(raf);
    set({ mode: 'build', ops: null });
  },
  restart(): void {
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
  setFlightsPerDay(n: number): void {
    const o = get().ops;
    if (!o) return;
    o.sim.state.settings.flightsPerDay = n;
    patchOps({ uiVersion: o.uiVersion + 1 });
  },
};

let pausedSpeed: number | null = null;
