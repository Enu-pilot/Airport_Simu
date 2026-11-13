import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { findPaxRoute } from '../../src/core/terminal/route';
import { analyzeLayout } from '../../src/core/validation/validate';
import type { AirportLayout } from '../../src/core/model/types';

/** 12B-3a A3: 独立ゲート（connectedTo で接続先を明示し、ターミナルに隣接しない）の接続モデルと検証 */
function withGate(patch: (l: AirportLayout) => void): AirportLayout {
  const l = createSampleAirport();
  patch(l);
  return l;
}
const gateIds = (l: AirportLayout) => Object.values(l.facilities).filter((f) => f.kind === 'gate').map((f) => f.id);
const terminalId = (l: AirportLayout) => Object.values(l.facilities).find((f) => f.kind === 'terminal')!.id;
const far = (l: AirportLayout, x: number, y: number) => {
  const g = l.facilities[gateIds(l)[0]!]!;
  g.origin = { x, y };
  return g.id;
};

describe('独立ゲートの接続', () => {
  it('connectedTo のないレイアウトでは従来と同じ（合成ノード・接続なし）', () => {
    const l = createSampleAirport();
    const m = buildTerminalModel(l);
    expect(m.connectors).toEqual([]);
    expect(Object.values(m.areas).some((a) => a.synthetic)).toBe(false);
  });

  it('隣接しないゲートが connectedTo で接続され、合成ノードが byTerminal に入らず、入口から保安検査を経て歩いて着ける', () => {
    let gid = '';
    const l = withGate((x) => {
      gid = far(x, 60, 20);
      x.facilities[gid]!.props.connectedTo = terminalId(x);
    });
    const before = buildTerminalModel(createSampleAirport());
    const m = buildTerminalModel(l);
    const acc = m.gates[gid]!;
    expect(acc.boarding).toBe(`${gid}:dep`);
    expect(acc.deplane).toBe(`${gid}:arr`);
    expect(m.areas[acc.boarding!]!.synthetic).toBe(true);
    expect(m.connectors).toHaveLength(1);
    expect(m.connectors[0]!.lengthM).toBeGreaterThan(0);
    for (const ids of Object.values(m.byTerminal)) expect(ids.some((id) => id.includes(':'))).toBe(false);
    // 他のゲートの入口は不変
    for (const g of gateIds(l).slice(1)) expect(m.gates[g]).toEqual(before.gates[g]);
    const ent = m.byTerminal[terminalId(l)]!.find((id) => m.areas[id]!.kind === 'entrance')!;
    const sec = m.byTerminal[terminalId(l)]!.find((id) => m.areas[id]!.kind === 'security')!;
    expect(findPaxRoute(m, { from: ent, goals: new Map([[sec, 0]]) })).not.toBeNull();
    const r = findPaxRoute(m, { from: sec, goals: new Map([[acc.boarding!, 0]]) });
    expect(r).not.toBeNull();
    expect(r!.areas.at(-1)).toBe(acc.boarding);
    const exit = m.byTerminal[terminalId(l)]!.find((id) => m.areas[id]!.kind === 'exit')!;
    expect(findPaxRoute(m, { from: acc.deplane!, goals: new Map([[exit, 0]]) })).not.toBeNull();
  });

  it('検証: 接続済みは GATE_NOT_AT_TERMINAL を出さず、未接続は出す。接続先が不正なら GATE_CONNECTION_INVALID、遠すぎれば GATE_CONNECTOR_LONG', () => {
    let gid = '';
    const ok = withGate((x) => {
      gid = far(x, 60, 20);
      x.facilities[gid]!.props.connectedTo = terminalId(x);
    });
    const codesOf = (l: AirportLayout, id: string) => (analyzeLayout(l).byTarget[id] ?? []).map((i) => i.code);
    expect(codesOf(ok, gid)).not.toContain('GATE_NOT_AT_TERMINAL');
    expect(codesOf(ok, gid)).not.toContain('GATE_UNREACHABLE');
    expect(codesOf(ok, gid)).not.toContain('GATE_NO_BOARDING_ACCESS');
    const un = withGate((x) => {
      far(x, 60, 20);
    });
    expect(codesOf(un, gid)).toContain('GATE_NOT_AT_TERMINAL');
    const bad = withGate((x) => {
      far(x, 60, 20);
      x.facilities[gid]!.props.connectedTo = Object.values(x.facilities).find((f) => f.kind === 'hangar' || f.kind === 'gate' && f.id !== gid)!.id;
    });
    expect(codesOf(bad, gid)).toContain('GATE_CONNECTION_INVALID');
    const longL = withGate((x) => {
      far(x, 60, 20 - 0);
      x.facilities[gid]!.origin = { x: 60 + 90, y: 20 };
      x.facilities[gid]!.props.connectedTo = terminalId(x);
    });
    expect(codesOf(longL, gid)).toContain('GATE_CONNECTOR_LONG');
  });
});

describe('独立ゲートの運航', () => {
  it('接続されたゲートのスポットの便が搭乗でき、不変条件を保つ（乗り遅れ unreachable が出ない）', { timeout: 200_000 }, async () => {
    const { createSimulation, stepSimulation } = await import('../../src/core/sim/simulation');
    const { checkInvariants } = await import('../../src/core/sim/invariants');
    let gid = '';
    const l = withGate((x) => {
      gid = far(x, 60, 20);
      x.facilities[gid]!.props.connectedTo = terminalId(x);
    });
    const sim = createSimulation(l, { seed: 'indep', settings: { flightsPerDay: 120 } });
    for (let i = 0; i < 6 * 3600; i++) {
      stepSimulation(sim);
      if (i % 300 === 0) expect(checkInvariants(sim)).toEqual([]);
    }
    const viaGate = Object.values(sim.state.paxGroups).filter((g) => g.boardedGate === gid);
    expect(viaGate.length).toBeGreaterThan(0);
    expect(Object.values(sim.state.paxGroups).some((g) => g.state === 'missed' && g.reason === 'unreachable')).toBe(false);
  });
});
