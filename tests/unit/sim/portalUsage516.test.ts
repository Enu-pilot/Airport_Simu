import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addPortal, placeFacility } from '../../../src/core/layout/operations';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { defaultCity } from '../../../src/core/economy/city';
import { addTurnaround, createSimulation, type Simulation } from '../../../src/core/sim/simulation';
import { peekPortalUsage, takePortalUsage } from '../../../src/core/sim/portalUsage';
import type { AirportLayout, TerminalAreaKind } from '../../../src/core/model/types';
import type { Aircraft, PaxGroup } from '../../../src/core/sim/types';
import { must } from '../helpers';
import { runUntil } from './helpers';

/**
 * 5-16 T8: 集約アクセスモデルとポータル実歩行の二重計上防止。
 * - 徒歩時間は、集約側の walkMin と実歩行の両方を数えず、実歩行分だけにする（相殺）。
 * - 人数・容量・料金の計上は集約側の1回だけ。Portal 通過人数は専用の記録で数え、
 *   区間を歩いたグループの人数と一致する（保存則）。
 * - ポータルのない空港では記録自体が生まれない。
 */
const manual = { autoSchedule: false };
const areaId = (l: AirportLayout, kind: TerminalAreaKind) => Object.values(l.terminalAreas).find((a) => a.kind === kind)!.id;
const groups = (sim: Simulation, flightId: string): PaxGroup[] => (sim.state.flightPax[flightId] ?? []).map((id) => sim.state.paxGroups[id]!);
const departed = (ac: Aircraft) => () => ac.state === 'departed';

function layoutWithPortals(): AirportLayout {
  let l = createSampleAirport();
  l = must(placeFacility(l, 'busTerminal', { x: 30, y: 58 })).layout;
  const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
  l = must(addPortal(l, { facilityId: bt.id, areaId: areaId(l, 'entrance') })).layout;
  l = must(addPortal(l, { facilityId: bt.id, areaId: areaId(l, 'exit') })).layout;
  return l;
}

function company() {
  const c = createSandboxCompany('portal-t8');
  c.city = defaultCity('regional');
  return c;
}

describe('5-16 T8 ポータルと集約アクセスの二重計上防止', () => {
  it('集約アクセス有効でも Portal 通過人数が区間を歩いた人数と一致し、徒歩は実歩行分だけ数える', () => {
    const sim = createSimulation(layoutWithPortals(), { seed: 'portal-t8', settings: manual, company: company() });
    expect(sim.state.access).not.toBeNull();
    const t = sim.state.now + 20 * 60;
    const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
    const dep = sim.state.flights[ac.departureFlightId]!;
    const arr = sim.state.flights[ac.arrivalFlightId]!;

    // 区間歩行中のグループを捕まえた瞬間の walkSec が実歩行の経過秒だけであることを見る
    // （相殺がなければ集約 walkMin（分単位）が上乗せされ、区間の所要秒を大きく超える）
    let captured: { walkSec: number; legLength: number } | undefined;
    runUntil(sim, () => {
      if (!captured) {
        const g = Object.values(sim.state.paxGroups).find((x) => x.state === 'accessWalk' && x.accessLeg?.phase === 'enter');
        if (g) captured = { walkSec: g.walkSec, legLength: g.legLength };
      }
      return ac.state === 'departed';
    }, 6 * 3600);
    expect(captured).toBeDefined();
    expect(captured!.walkSec).toBeLessThanOrEqual(Math.ceil(captured!.legLength));
    expect(dep.pax.boarded).toBe(dep.pax.booked);

    // 保存則: Portal 通過人数（enter）= 入口区間を歩いた出発グループの人数
    const usage = peekPortalUsage(sim.state);
    expect(usage.length).toBeGreaterThan(0);
    const enterTotal = usage.reduce((s, e) => s + e.enter, 0);
    const walkedEnter = groups(sim, dep.id).filter((g) => g.accessLeg?.phase === 'enter').reduce((s, g) => s + g.count, 0);
    expect(enterTotal).toBe(walkedEnter);
    expect(enterTotal).toBeGreaterThan(0);
    // 退出方向も、出口区間を歩いた到着グループと一致する（transit 手段は乗り場経由で区間を歩かない）
    const exitTotal = usage.reduce((s, e) => s + e.exit, 0);
    const walkedExit = groups(sim, arr.id).filter((g) => g.accessLeg?.phase === 'exit').reduce((s, g) => s + g.count, 0);
    expect(exitTotal).toBe(walkedExit);
    // 締め用に取り出すと記録は消える
    expect(takePortalUsage(sim.state)?.length).toBe(usage.length);
    expect(peekPortalUsage(sim.state)).toEqual([]);
  });

  it('ポータルがない空港では通過記録は生まれない', () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'portal-t8-none', settings: manual, company: company() });
    const t = sim.state.now + 20 * 60;
    const ac = addTurnaround(sim, 'narrow180', t, { departureAt: t + 150 * 60 });
    runUntil(sim, departed(ac), 6 * 3600);
    expect(peekPortalUsage(sim.state)).toEqual([]);
    expect(takePortalUsage(sim.state)).toBeUndefined();
  });
});
