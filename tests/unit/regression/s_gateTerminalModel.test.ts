/**
 * 回帰（計画 1-10 / T-1 のモデル側）: 明示（connectedTo）がなく 2 つのターミナルに接するゲートは、所属を推測せず
 * terminalId=null・ambiguousTerminalIds に隣接ターミナルを入れる。検証コード GATE_TERMINAL_AMBIGUOUS は U（u_gateTwoTerminals）。
 */
import { describe, expect, it } from 'vitest';
import { addSecondTerminal } from '../../audit/b_helpers';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { placeFacility } from '../../../src/core/layout/operations';
import { createContext } from '../../../src/core/sim/context';
import { must } from '../helpers';

function ambiguous() {
  const tt = addSecondTerminal(createSampleAirport(), { x: 95, y: 49 });
  const r = must(placeFacility(tt.layout, 'gate', { x: 94, y: 49 }, { props: { boardingMode: 'bus', standId: null, jetBridge: false } }));
  return { ...tt, layout: r.layout, gateId: r.created[0]! };
}

describe('1-10 曖昧なゲート（モデル）', () => {
  it('2 つのターミナルに接するゲートは terminalId=null で、候補が ambiguousTerminalIds に入る', () => {
    const { layout, gateId, t1, t2 } = ambiguous();
    const a = createContext(layout).terminal.gates[gateId]!;
    expect(a.terminalId).toBeNull();
    expect(a.boarding).toBeNull();
    expect(a.deplane).toBeNull();
    expect([...(a.ambiguousTerminalIds ?? [])].sort()).toEqual([t1, t2].sort());
  });

  it('connectedTo を指定すれば null にならず、曖昧さの記録もない', () => {
    const { layout, gateId, t2 } = ambiguous();
    const l = structuredClone(layout);
    l.facilities[gateId]!.props.connectedTo = t2;
    const a = createContext(l).terminal.gates[gateId]!;
    expect(a.terminalId).toBe(t2);
    expect(a.ambiguousTerminalIds).toBeUndefined();
  });

  it('1 つのターミナルにだけ接するゲートは従来どおり（サンプルの全ゲート）', () => {
    const l = createSampleAirport();
    const gates = createContext(l).terminal.gates;
    for (const [id, a] of Object.entries(gates)) {
      expect(a.ambiguousTerminalIds, id).toBeUndefined();
      expect(a.terminalId, id).not.toBeNull();
    }
  });
});
