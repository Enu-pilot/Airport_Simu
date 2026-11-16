import { describe, expect, it } from 'vitest';
import { busTwoTerminalLayout } from './b_helpers';
import { createContext } from '../../src/core/sim/context';
import { addDisruption } from '../../src/core/sim/disruptions';
import { checkInvariants } from '../../src/core/sim/invariants';
import { SIM_START_SEC as T0 } from '../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { resolveBusGateForStand } from '../../src/core/terminal/busGateAssignment';
import { updateEntity } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { analyzeLayout } from '../../src/core/validation/validate';
import type { AirportLayout } from '../../src/core/model/types';
import { must } from '../unit/helpers';

/**
 * docs/38 ID 10: 複数ターミナル・独立ゲート・バスゲート。
 * 特に「リモートスポットに対応するターミナルは一意に決まるか」を、現行実装の解決順
 *   stand.contact → ctx.standGate[stand]（隣接/connectedTo のターミナル）
 *   リモート → resolveBusGateForStand（'bus': busGateId 固定 / 'none' / 'auto'・旧データ: 最寄りの利用可能バスゲート、同距離は ID 順）
 *   → ctx.terminal.gates[gate].terminalId
 * に沿って確認する。再選択が起きる条件（E）は passing テストとして現行挙動を固定している。
 */
const standPoint = (ctx: ReturnType<typeof createContext>, id: string) => ctx.network.nodes[ctx.stands[id]!.node]?.pos ?? null;
const resolve = (layout: AirportLayout, id: string, closed: string[] = []) => {
  const ctx = createContext(layout);
  return resolveBusGateForStand(layout, ctx.terminal, id, standPoint(ctx, id), ctx.busGates, closed);
};

/** facilities / stands / terminalAreas の挿入順を逆にした等価なレイアウト */
function reversed(layout: AirportLayout): AirportLayout {
  const rev = <T>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).reverse());
  return { ...structuredClone(layout), facilities: rev(structuredClone(layout.facilities)), stands: rev(structuredClone(layout.stands)), terminalAreas: rev(structuredClone(layout.terminalAreas)) };
}

describe('10 リモートスポット → バスゲート → ターミナルの解決（静的）', () => {
  const { layout, t1, t2 } = busTwoTerminalLayout();

  it('auto/旧データ: 最寄りの利用可能バスゲートの所属ターミナルに決まる（std_8 → 隣接ゲート → A、std_9 → 独立ゲート → B）', () => {
    expect(resolve(layout, 'std_8')).toEqual({ gateId: 'fac_10', terminalId: t1 });
    expect(resolve(layout, 'std_9')).toEqual({ gateId: 'fac_11', terminalId: t2 });
  });

  it('同距離なら ID の小さいゲート（compareIds: fac_10 < fac_11、数値順）', () => {
    const ctx = createContext(layout);
    // ゲートは (84.5,48.5) と (90.5,48.5)。中点 x=87.5 は同距離
    const a = resolveBusGateForStand(layout, ctx.terminal, 'std_8', { x: 87.5, y: 44 }, ctx.busGates);
    expect(a.gateId).toBe('fac_10');
    // 入力順（候補配列の並び）に依存しない
    const b = resolveBusGateForStand(layout, ctx.terminal, 'std_8', { x: 87.5, y: 44 }, [...ctx.busGates].reverse());
    expect(b).toEqual(a);
  });

  it('レイアウトの挿入順を逆にしても、全スポットのゲート・ターミナルが同一（決定性）', () => {
    const a = createContext(layout);
    const b = createContext(reversed(layout));
    for (const id of Object.keys(layout.stands)) {
      const ra = resolveBusGateForStand(layout, a.terminal, id, standPoint(a, id), a.busGates);
      const rb = resolveBusGateForStand(b.layout, b.terminal, id, standPoint(b, id), b.busGates);
      expect(rb, id).toEqual(ra);
    }
    expect(b.terminal.gates).toEqual(a.terminal.gates);
    expect(b.standGate).toEqual(a.standGate);
  });

  it("明示 'bus': 指定ゲートだけを使い（最寄りでなくても）、閉鎖・不正でも別ターミナルへフォールバックしない", () => {
    const l = structuredClone(layout);
    l.stands.std_8!.remoteBoarding = 'bus';
    l.stands.std_8!.busGateId = 'fac_11'; // 最寄りは fac_10(A) だが B の独立ゲートを指定
    expect(resolve(l, 'std_8')).toEqual({ gateId: 'fac_11', terminalId: t2 });
    expect(resolve(l, 'std_8', ['fac_11'])).toEqual({ gateId: null, terminalId: null, failure: 'invalidGate' });
    l.stands.std_8!.busGateId = 'fac_3'; // コンタクトゲートは不可
    expect(resolve(l, 'std_8')).toMatchObject({ gateId: null, failure: 'invalidGate' });
    l.stands.std_8!.busGateId = null;
    expect(resolve(l, 'std_8')).toMatchObject({ gateId: null, failure: 'unconfigured' });
    l.stands.std_8!.remoteBoarding = 'none';
    expect(resolve(l, 'std_8')).toMatchObject({ gateId: null, failure: 'disabled' });
  });

  it("【E・現行挙動の固定】auto は最寄りゲートが閉鎖されると別ターミナルのゲートへ再選択される（スポット → ターミナルは時刻で変わりうる）", () => {
    expect(resolve(layout, 'std_8', ['fac_10'])).toEqual({ gateId: 'fac_11', terminalId: t2 });
    expect(resolve(layout, 'std_8', ['fac_10', 'fac_11'])).toMatchObject({ gateId: null, failure: 'unconfigured' });
  });

  it('バスゲートの利用条件: 搭乗口・降機口の両方が同一ターミナルに接続していること（独立ゲートは合成ノードで接続）', () => {
    const ctx = createContext(layout);
    expect(ctx.terminal.gates.fac_11).toMatchObject({ terminalId: t2, boarding: 'fac_11:dep', deplane: 'fac_11:arr' });
    expect(ctx.terminal.gates.fac_10!.boarding).toMatch(/^ta_/);
    expect(ctx.terminal.byTerminal[t2]).not.toContain('fac_11:dep'); // 合成ノードは byTerminal に入れない
    const l = structuredClone(layout);
    l.facilities.fac_11!.props.connectedTo = 'fac_nope'; // 存在しない接続先 → 隣接するターミナル A に戻る（独立ゲートではなくなる）
    expect(createContext(l).terminal.gates.fac_11!.terminalId).toBe(t1);
  });

  it('同一スポットに複数のコンタクトゲート: standGate は ID 最小のゲートに決まり、検証は STAND_MULTIPLE_GATES を出す', () => {
    let l = createSampleAirport();
    l = must(updateEntity(l, 'fac_4', { props: { ...l.facilities.fac_4!.props, standId: 'std_1' } })).layout;
    const ctx = createContext(l);
    expect(ctx.standGate.std_1).toBe('fac_3');
    expect(analyzeLayout(l).issues.some((i) => i.code === 'STAND_MULTIPLE_GATES' && i.targets.includes('std_1'))).toBe(true);
  });
});

function drive(sim: Simulation, seconds: number, every = 30): void {
  for (let i = 0; i < seconds; i++) {
    stepSimulation(sim);
    if (i % every === 0) {
      const v = checkInvariants(sim);
      if (v.length) throw new Error(`seed=${sim.state.seed} t=${sim.state.now - T0}: ${v.slice(0, 4).join(' / ')}`);
    }
  }
}
const groupsOf = (sim: Simulation, flightId: string) => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);
const plan = (standId: string | null) => ({ contractId: 'b10', destinationId: 'north', arrPax: 120, depPax: 150, standId, seats: 180 });

describe('10 リモートスポット便の運航（2 ターミナル + 2 バスゲート）', () => {
  it('auto・閉鎖なし: 同一スポットの到着・出発旅客は同じターミナル・同じバスゲートを使い、全員搭乗・退出する', { timeout: 300_000 }, () => {
    for (const [stand, gate, term] of [['std_8', 'fac_10', 't1'], ['std_9', 'fac_11', 't2']] as const) {
      const { layout, t1, t2 } = busTwoTerminalLayout();
      const sim = createSimulation(layout, { seed: `b10-${stand}`, settings: { autoSchedule: false } });
      const ac = addTurnaround(sim, 'narrow180', T0 + 20 * 60, { departureAt: T0 + 3 * 3600, plan: plan(stand) });
      const arr = sim.state.flights[ac.arrivalFlightId]!;
      const dep = sim.state.flights[ac.departureFlightId]!;
      drive(sim, 5 * 3600);
      const expected = term === 't1' ? t1 : t2;
      expect(arr.pax.gateId).toBe(gate);
      expect(dep.pax.gateId).toBe(gate);
      for (const f of [arr, dep]) expect(new Set(groupsOf(sim, f.id).map((g) => g.terminalId)), `${f.number}`).toEqual(new Set([expected]));
      expect(dep.pax.boarded).toBe(150);
      expect(arr.pax.exited).toBe(arr.pax.deplaned);
      expect(sim.ctx.layout.terminalAreas[arr.pax.claimAreaId ?? '']?.terminalId).toBe(expected);
    }
  });

  it("明示 'bus' で最寄りでないゲート（B）を指定: 到着・出発とも B の施設だけを使う", { timeout: 300_000 }, () => {
    const { layout, t2 } = busTwoTerminalLayout();
    layout.stands.std_8!.remoteBoarding = 'bus';
    layout.stands.std_8!.busGateId = 'fac_11';
    const sim = createSimulation(layout, { seed: 'b10-explicit', settings: { autoSchedule: false } });
    const ac = addTurnaround(sim, 'narrow180', T0 + 20 * 60, { departureAt: T0 + 3 * 3600, plan: plan('std_8') });
    drive(sim, 5 * 3600);
    for (const id of [ac.arrivalFlightId, ac.departureFlightId]) {
      const gs = groupsOf(sim, id);
      expect(gs.length).toBeGreaterThan(0);
      expect(gs.every((g) => g.terminalId === t2)).toBe(true);
    }
    expect(sim.state.flights[ac.departureFlightId]!.pax.boarded).toBe(150);
  });

  it("明示 'bus' ゲートが最初から閉鎖: 別ターミナルへ流さず旅客を生成しない（busFailure=invalidGate、BU 不変条件維持）", { timeout: 300_000 }, () => {
    const { layout } = busTwoTerminalLayout();
    layout.stands.std_8!.remoteBoarding = 'bus';
    layout.stands.std_8!.busGateId = 'fac_10';
    const sim = createSimulation(layout, { seed: 'b10-closed', settings: { autoSchedule: false } });
    addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_10', end: null });
    const ac = addTurnaround(sim, 'narrow180', T0 + 20 * 60, { departureAt: T0 + 3 * 3600, plan: plan('std_8') });
    drive(sim, 4 * 3600);
    const arr = sim.state.flights[ac.arrivalFlightId]!;
    expect(groupsOf(sim, arr.id).length).toBe(0);
    expect(arr.pax.busFailure).toBe('invalidGate');
    expect(Object.values(sim.state.paxGroups).every((g) => g.terminalId === null || g.terminalId === 'fac_2')).toBe(true);
    expect(Object.values(sim.state.paxGroups).filter((g) => g.terminalId === 'fac_21').length).toBe(0);
  });

  it('【K-1・計画 1-11 で更新】auto で旅客生成後に最寄りゲートが閉鎖: 出発旅客は生成時のゲート（A）に固定され、閉鎖中は待機し、締切までに再開しなければ facilityClosed で乗り遅れる（別ターミナルへ回さない。人数保存・不変条件は維持）', { timeout: 300_000 }, () => {
    // 旧（フェーズ 0 の特性固定）: 閉鎖のたびに別ターミナル（B）へ再選択され、1 便の出発旅客が 2 ターミナルにまたがり、経路がなければ unreachable で乗り遅れた。
    // 新（docs/42 §K-1・impl_phase1_plan 1-11）: 旅客生成後のバスゲートは固定。意図した挙動変更のため期待値を更新（弱体化ではない）。
    const { layout, t1 } = busTwoTerminalLayout();
    const sim = createSimulation(layout, { seed: 'b10-flip', settings: { autoSchedule: false } });
    const ac = addTurnaround(sim, 'narrow180', T0 + 20 * 60, { departureAt: T0 + 3 * 3600, plan: plan('std_8') });
    const arr = sim.state.flights[ac.arrivalFlightId]!;
    const dep = sim.state.flights[ac.departureFlightId]!;
    let closed = false;
    for (let i = 0; i < 5 * 3600; i++) {
      if (!closed && sim.state.now >= T0 + 5400) { addDisruption(sim, { kind: 'gateFailure', targetId: 'fac_10', end: null }); closed = true; }
      stepSimulation(sim);
      if (i % 30 === 0) expect(checkInvariants(sim)).toEqual([]);
    }
    expect(arr.pax.gateId).toBe('fac_10');
    expect(dep.pax.gateId).toBe('fac_10'); // 固定（旧: fac_11 へ再選択）
    expect(new Set(groupsOf(sim, arr.id).map((g) => g.terminalId))).toEqual(new Set([t1]));
    expect(new Set(groupsOf(sim, dep.id).map((g) => g.terminalId))).toEqual(new Set([t1])); // 1 便の出発旅客は 1 ターミナル（docs/35 §7.1）
    expect(dep.pax.boarded + dep.pax.missed).toBe(dep.pax.booked);
    expect(dep.pax.missed).toBeGreaterThan(0);
    expect(groupsOf(sim, dep.id).filter((g) => g.state === 'missed').every((g) => g.reason === 'facilityClosed' || g.reason === 'late')).toBe(true);
  });
});

describe('10 複数ターミナル（バスゲート混在）の長時間・複数シード', () => {
  for (const seed of ['b10-s1', 'b10-s2', 'b10-s3']) {
    it(`seed=${seed}: 不変条件（P6 含む）を保ち、到着旅客は 1 便 1 ターミナル、便ごとに保存則が成り立つ`, { timeout: 400_000 }, () => {
      const { layout, t1, t2 } = busTwoTerminalLayout();
      const sim = createSimulation(layout, { seed, settings: { flightsPerDay: 110 } });
      drive(sim, 6 * 3600, 60);
      const { state } = sim;
      const terminalsUsed = new Set<string>();
      let arrivals = 0;
      for (const f of Object.values(state.flights).filter((x) => x.pax.generated)) {
        const gs = groupsOf(sim, f.id);
        const terminals = new Set(gs.map((g) => g.terminalId));
        gs.forEach((g) => g.terminalId && terminalsUsed.add(g.terminalId));
        if (f.direction === 'arrival') {
          arrivals++;
          expect(terminals.size, `${f.number}`).toBeLessThanOrEqual(1);
          expect(gs.reduce((s, g) => s + g.count, 0)).toBe(f.pax.deplaned);
          if (f.pax.claimAreaId) expect(sim.ctx.layout.terminalAreas[f.pax.claimAreaId]?.terminalId).toBe([...terminals][0]);
        } else if (f.pax.boarding === 'closed') {
          const cancelled = gs.filter((g) => g.state === 'cancelled').reduce((s, g) => s + g.count, 0);
          expect(f.pax.boarded + f.pax.missed + cancelled).toBe(f.pax.booked);
        }
      }
      expect(arrivals).toBeGreaterThan(5);
      expect(terminalsUsed.has(t1)).toBe(true);
      expect(terminalsUsed.has(t2)).toBe(true);
    });
  }
});
