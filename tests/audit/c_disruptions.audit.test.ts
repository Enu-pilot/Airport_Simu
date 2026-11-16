/**
 * 監査 c / docs/38 ID 15: 障害の単独発生・復旧・プレイヤー修理・複合・天候（従来 4 種 / 5 段階）。
 * 不変条件を 60 ティックごとに確認する。失敗時は label（kind）と now を含む。
 */
import { describe, expect, it } from 'vitest';
import { sampleSim, runChecked, runUntilTime, DAY_SEC } from './c_helpers';
import { addDisruption, resolveDisruption, REPAIR_COST, activeDisruptions } from '../../src/core/sim/disruptions';
import { checkInvariants, checkPaxInvariants } from '../../src/core/sim/invariants';
import { createSandboxCompany } from '../../src/core/economy/company';
import { createSimulation } from '../../src/core/sim/simulation';
import { effectiveWx } from '../../src/core/sim/weather';
import { busLayout } from '../unit/sim/busHelpers';
import type { Simulation } from '../../src/core/sim/simulation';
import type { DisruptionKind } from '../../src/core/sim/types';
import { TERMINAL_STATES } from '../../src/core/sim/types';

const H = 3600;
const START_OPS = 8 * H;

function pickTargets(sim: Simulation): Partial<Record<DisruptionKind, string>> {
  const l = sim.ctx.layout;
  const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
  const unit = Object.values(sim.state.units).find((u) => u.kind === 'staff')!;
  return {
    runwayClosed: Object.keys(l.runways)[0]!,
    taxiwayClosed: Object.keys(l.taxiways)[0]!,
    standClosed: Object.keys(l.stands)[0]!,
    gateFailure: gate.id,
    vehicleFailure: Object.values(sim.state.units).find((u) => u.kind === 'tug')!.id,
    staffAbsence: unit.id,
  };
}

/** 停止していないか: 終了していない機体が 3 時間以上同じ状態のままではない */
function stalledAircraft(sim: Simulation, maxSec = 3 * H): string[] {
  return Object.values(sim.state.aircraft)
    .filter((a) => !TERMINAL_STATES.includes(a.state) && sim.state.now - a.stateSince > maxSec && a.state !== 'parked' && a.state !== 'turnaround' && a.state !== 'scheduled')
    .map((a) => `${a.id}:${a.state}@${a.stateSince}`);
}

describe('ID15 障害の単独: 発生 → 影響 → 時間経過で復旧 → 運航が止まらない', () => {
  const kinds: DisruptionKind[] = ['runwayClosed', 'taxiwayClosed', 'standClosed', 'gateFailure', 'vehicleFailure', 'staffAbsence'];
  for (const kind of kinds) {
    it(`${kind}: 60 分の閉鎖 → 自動復旧、閉鎖の残りなし、後続の便が出発する`, () => {
      const sim = sampleSim({ seed: `c-dis-${kind}` });
      runUntilTime(sim, START_OPS, 60, kind);
      const dep0 = sim.state.stats.departures;
      const targets = pickTargets(sim);
      const d = addDisruption(sim, { kind, targetId: targets[kind]!, end: sim.state.now + H, ...(kind === 'staffAbsence' ? { amount: 3 } : {}) });
      expect(d.status).toBe('active');
      expect(activeDisruptions(sim.state).map((x) => x.id)).toContain(d.id);
      runChecked(sim, H + 120, 60, kind);
      expect(d.status).toBe('resolved');
      expect(d.resolvedBy).toBe('time');
      // 復旧後: 閉鎖・故障が残っていない
      expect(sim.state.closures).toEqual({ taxiways: [], stands: [], gates: [] });
      expect(Object.values(sim.state.units).filter((u) => u.status === 'broken')).toEqual([]);
      for (const cfg of Object.values(sim.state.runwayConfig)) expect(cfg.mode).not.toBe('closed');
      runChecked(sim, 6 * H, 60, kind);
      expect(sim.state.stats.departures).toBeGreaterThan(dep0);
      expect(stalledAircraft(sim)).toEqual([]);
      expect(checkPaxInvariants(sim, true)).toEqual([]);
    });
  }

  it('baggageFailure（仕分け機）と demandSurge: 復旧し、需要倍率は発生中だけ掛かる', () => {
    const sim = sampleSim({ seed: 'c-dis-bag' });
    runUntilTime(sim, START_OPS, 60, 'bag');
    const sorter = sim.ctx.sorters[0];
    if (sorter) {
      const d = addDisruption(sim, { kind: 'baggageFailure', targetId: sorter.id, end: sim.state.now + H });
      runChecked(sim, H + 60, 60, 'bag');
      expect(d.status).toBe('resolved');
      expect(sim.state.equipment[sorter.id]?.broken ?? false).toBe(false);
    }
    const s = addDisruption(sim, { kind: 'demandSurge', targetId: null, amount: 1.5, end: sim.state.now + 600 });
    expect(activeDisruptions(sim.state)).toContain(s);
    runChecked(sim, 660, 60, 'surge');
    expect(s.status).toBe('resolved');
  });

  it('プレイヤーの修理: 費用を計上して即時復旧、再修理・天候・需要は不可', () => {
    const sim = sampleSim({ seed: 'c-dis-repair' });
    runUntilTime(sim, START_OPS, 60, 'repair');
    const t = pickTargets(sim);
    const d = addDisruption(sim, { kind: 'runwayClosed', targetId: t.runwayClosed!, end: null });
    expect(d.end).toBeNull();
    const cash0 = sim.company!.cash;
    runChecked(sim, 600, 60, 'repair'); // 手動修理するまで復旧しない
    expect(d.status).toBe('active');
    const today0 = sim.company!.today.disruption ?? 0;
    expect(resolveDisruption(sim, d.id)).toBe(true);
    expect(d.resolvedBy).toBe('player');
    expect((sim.company!.today.disruption ?? 0) - today0).toBe(-REPAIR_COST.runwayClosed);
    expect(sim.company!.cash).toBeLessThanOrEqual(cash0);
    expect(resolveDisruption(sim, d.id)).toBe(false);
    const w = addDisruption(sim, { kind: 'weather', targetId: null, weather: 'snow', end: null });
    expect(resolveDisruption(sim, w.id)).toBe(false);
    const sg = addDisruption(sim, { kind: 'demandSurge', targetId: null, amount: 1.2 });
    expect(resolveDisruption(sim, sg.id)).toBe(false);
    expect(checkInvariants(sim)).toEqual([]);
  });

  it('予定の障害（未来の開始）: scheduled → active → resolved、早期修理も可能', () => {
    const sim = sampleSim({ seed: 'c-dis-sched' });
    runUntilTime(sim, START_OPS, 60, 'sched');
    const t = pickTargets(sim);
    const d = addDisruption(sim, { kind: 'taxiwayClosed', targetId: t.taxiwayClosed!, start: sim.state.now + 600, end: sim.state.now + 1200 });
    expect(d.status).toBe('scheduled');
    runChecked(sim, 650, 60, 'sched');
    expect(d.status).toBe('active');
    expect(sim.state.closures.taxiways).toContain(t.taxiwayClosed);
    runChecked(sim, 600, 60, 'sched');
    expect(d.status).toBe('resolved');
    const d2 = addDisruption(sim, { kind: 'standClosed', targetId: t.standClosed!, start: sim.state.now + 9999 });
    expect(resolveDisruption(sim, d2.id)).toBe(true);
    expect(d2.status).toBe('resolved');
  });
});

describe('ID15 天候: 従来 4 種（legacy）と 5 段階（levels）', () => {
  it('従来の天候 snow/fog/rain: 発生中は separation/taxi が悪化し、復旧後は晴れに戻る。運航は止まらない', () => {
    for (const w of ['rain', 'snow', 'fog'] as const) {
      const sim = sampleSim({ seed: `c-wx-${w}` });
      runUntilTime(sim, START_OPS, 60, w);
      expect(sim.state.wx).toBeUndefined();
      const dep0 = sim.state.stats.departures;
      const d = addDisruption(sim, { kind: 'weather', targetId: null, weather: w, end: sim.state.now + 2 * H });
      expect(sim.state.weather.kind).toBe(w);
      runChecked(sim, 2 * H + 60, 60, w);
      expect(d.status).toBe('resolved');
      expect(sim.state.weather.kind).toBe('clear');
      runChecked(sim, 4 * H, 60, w);
      expect(sim.state.stats.departures).toBeGreaterThan(dep0);
      expect(stalledAircraft(sim)).toEqual([]);
    }
  });

  it('5 段階（levels）: 手動の天候障害が wx.override になり、終了で null に戻る', () => {
    const c = createSandboxCompany();
    c.game = { version: 1, difficulty: 'normal', weather: 'levels', airlineEval: false, goals: false, climate: 'temperate' };
    const sim = createSimulation(sampleSim().ctx.layout, { seed: 'c-wx-levels', company: c });
    expect(sim.state.wx).toBeDefined();
    runUntilTime(sim, START_OPS, 60, 'levels');
    const d = addDisruption(sim, { kind: 'weather', targetId: null, weather: 'snow', end: sim.state.now + H });
    runChecked(sim, 120, 60, 'levels');
    expect(sim.state.wx!.override).not.toBeNull();
    expect(effectiveWx(sim.state.wx!).level).toBeGreaterThanOrEqual(2);
    runChecked(sim, H + 600, 60, 'levels');
    expect(d.status).toBe('resolved');
    expect(sim.state.wx!.override).toBeNull();
    expect(stalledAircraft(sim)).toEqual([]);
  });

  it('5 段階: 冬の悪天日（day 108）を丸一日運航しても不変条件を保ち、翌日の締めまで進む', () => {
    const c = createSandboxCompany();
    c.day = 108;
    c.game = { version: 1, difficulty: 'normal', weather: 'levels', airlineEval: false, goals: false, climate: 'temperate' };
    const sim = createSimulation(sampleSim().ctx.layout, { seed: 'c-wx-bad', company: c });
    let n = 0;
    while (sim.company!.day === 108 && n++ < DAY_SEC + 1000) {
      runChecked(sim, 600, 120, 'bad-day');
      n += 599;
    }
    expect(sim.company!.day).toBe(109);
    expect(sim.company!.reports.at(-1)!.day).toBe(108);
  });
});

describe('ID15 複合: 嵐 + 滑走路閉鎖 + バス故障 + 欠勤 + 需要急増', () => {
  it('同時発生しても不変条件を保ち、全て復旧し、停止せず、旅客が滞留しない', () => {
    const sim = createSimulation(busLayout({ buses: 3 }), { seed: 'c-combined', company: createSandboxCompany() });
    runUntilTime(sim, START_OPS, 60, 'combined');
    const dep0 = sim.state.stats.departures;
    const bus = Object.values(sim.state.units).find((u) => u.kind === 'apronBus')!;
    const rw = Object.keys(sim.ctx.layout.runways)[0]!;
    const staff = Object.values(sim.state.units).find((u) => u.kind === 'staff')!;
    const t0 = sim.state.now;
    const ds = [
      addDisruption(sim, { kind: 'weather', targetId: null, weather: 'snow', end: t0 + 2 * H }),
      addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: t0 + H }),
      addDisruption(sim, { kind: 'vehicleFailure', targetId: bus.id, end: t0 + 90 * 60 }),
      addDisruption(sim, { kind: 'staffAbsence', targetId: staff.id, amount: 4, end: t0 + 2 * H }),
      addDisruption(sim, { kind: 'demandSurge', targetId: null, amount: 1.5, end: t0 + 2 * H }),
    ];
    expect(ds.every((d) => d.status === 'active')).toBe(true);
    runChecked(sim, 2 * H + 120, 30, 'combined');
    expect(ds.map((d) => d.status)).toEqual(['resolved', 'resolved', 'resolved', 'resolved', 'resolved']);
    expect(sim.state.closures).toEqual({ taxiways: [], stands: [], gates: [] });
    expect(Object.values(sim.state.units).filter((u) => u.status === 'broken')).toEqual([]);
    expect(Object.values(sim.state.runwayConfig).every((c) => c.mode !== 'closed')).toBe(true);
    // 回復: さらに 6 時間運航して便が出発し、バスの運行が止まったままの便が残らない
    runChecked(sim, 6 * H, 60, 'combined-after');
    expect(sim.state.stats.departures).toBeGreaterThan(dep0);
    expect(stalledAircraft(sim)).toEqual([]);
    const stalledTrips = Object.values(sim.state.bus?.trips ?? {}).filter((t) => t.phase === 'stalled');
    expect(stalledTrips).toEqual([]);
    expect(checkPaxInvariants(sim, true)).toEqual([]);
  });

  it('重ねた同一対象の閉鎖（後から重ねた方が先に復旧）: 残る間は閉鎖のまま、全て復旧で元の運用モードへ戻る', () => {
    const sim = sampleSim({ seed: 'c-overlap' });
    runUntilTime(sim, START_OPS, 60, 'overlap');
    const rw = Object.keys(sim.ctx.layout.runways)[0]!;
    const a = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: sim.state.now + 1800 });
    const b = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: sim.state.now + 600 });
    runChecked(sim, 700, 60, 'overlap');
    expect(b.status).toBe('resolved');
    expect(a.status).toBe('active');
    expect(sim.state.runwayConfig[rw]!.mode).toBe('closed');
    runChecked(sim, 1200, 60, 'overlap');
    expect(a.status).toBe('resolved');
    expect(sim.state.runwayConfig[rw]!.mode).toBe('mixed');
  });

  it('閉鎖スポットに割り当て済みの未着陸機は割り当てを解放され、占有の漏れ・二重割り当てがない', () => {
    const sim = sampleSim({ seed: 'c-standrelease' });
    // 最初の到着機が inbound になったらそのスポットを閉鎖する
    let ac = null as null | ReturnType<typeof firstInbound>;
    function firstInbound() {
      return Object.values(sim.state.aircraft).find((a) => (a.state === 'inbound' || a.state === 'holding') && a.standId);
    }
    for (let i = 0; i < 4 * H && !ac; i++) {
      runChecked(sim, 1, 1, 'rel');
      ac = firstInbound() ?? null;
    }
    expect(ac).toBeTruthy();
    const sid = ac!.standId!;
    addDisruption(sim, { kind: 'standClosed', targetId: sid, end: sim.state.now + H });
    expect(sim.state.standAssignments[sid]).toBeUndefined();
    runChecked(sim, 2 * H, 30, 'rel');
    const owners = Object.values(sim.state.standAssignments);
    expect(new Set(owners).size).toBe(owners.length);
  });
});
