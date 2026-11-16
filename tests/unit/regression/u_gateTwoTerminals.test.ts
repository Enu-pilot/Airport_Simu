import { describe, expect, it } from 'vitest';
import { addSecondTerminal } from '../../audit/b_helpers';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { placeFacility, updateEntity } from '../../../src/core/layout/operations';
import { createContext } from '../../../src/core/sim/context';
import { issueText } from '../../../src/i18n/ja';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { must } from '../helpers';

/**
 * 1-10 / T-1（docs/38 ID 10, docs/35 §2.1 手順 4）: 複数ターミナル環境で所属を一意に決定できない場合、ターミナルを推測しない。
 * 修正前は、2 つのターミナルに同時に隣接するゲート（ターミナル A=fac_2 が x=46..93、ターミナル B が x=95.. で、(94,49) のゲートが両方に接する）を、
 * buildTerminalModel が sortedValues 順で最初のターミナルに黙って割り当て、検証にも曖昧さの報告がなかった。
 * 修正: モデル側（Track S）は terminalId=null・ambiguousTerminalIds、検証側（Track U）は GATE_TERMINAL_AMBIGUOUS（error）。
 */
function ambiguousLayout() {
  const tt = addSecondTerminal(createSampleAirport(), { x: 95, y: 49 });
  const r = must(placeFacility(tt.layout, 'gate', { x: 94, y: 49 }, { props: { boardingMode: 'bus', standId: null, jetBridge: false } }));
  return { tt, layout: r.layout, gateId: r.created[0]! };
}

describe('2 つのターミナルに隣接するゲート（T-1）', () => {
  it('所属は推測せず null、検証が曖昧さを error で報告する（対象=ゲート、関連=ターミナル群）', () => {
    const { tt, layout, gateId } = ambiguousLayout();
    const access = createContext(layout).terminal.gates[gateId]!;
    expect(access.terminalId).toBeNull();
    expect(access.ambiguousTerminalIds).toEqual([tt.t1, tt.t2]);
    const hit = analyzeLayout(layout).issues.find((i) => i.code === 'GATE_TERMINAL_AMBIGUOUS')!;
    expect(hit.severity).toBe('error');
    expect(hit.targets).toEqual([gateId]);
    expect(hit.related).toEqual([tt.t1, tt.t2]);
    const text = issueText(layout, hit);
    expect(text).toContain('が複数のターミナル（');
    expect(text).toContain('「接続先ターミナル」を指定してください');
  });

  it('connectedTo を指定すれば null にならず、曖昧さの報告も出ない', () => {
    const { tt, layout, gateId } = ambiguousLayout();
    for (const t of [tt.t1, tt.t2]) {
      const l = must(updateEntity(layout, gateId, { props: { connectedTo: t } })).layout;
      const access = createContext(l).terminal.gates[gateId]!;
      expect(access.terminalId, t).toBe(t);
      expect(access.ambiguousTerminalIds).toBeUndefined();
      expect(analyzeLayout(l).issues.some((i) => i.code === 'GATE_TERMINAL_AMBIGUOUS')).toBe(false);
    }
  });

  it('1 つのターミナルにだけ接するゲートは従来どおり（曖昧さなし）', () => {
    const base = createSampleAirport();
    const issues = analyzeLayout(base).issues;
    expect(issues.some((i) => i.code === 'GATE_TERMINAL_AMBIGUOUS')).toBe(false);
    const ctx = createContext(base);
    for (const g of Object.values(base.facilities).filter((f) => f.kind === 'gate')) {
      expect(ctx.terminal.gates[g.id]!.ambiguousTerminalIds).toBeUndefined();
      expect(ctx.terminal.gates[g.id]!.terminalId).not.toBeNull();
    }
  });

  it('2 つ目のターミナルがあっても、片方にだけ接するゲートは曖昧にならない', () => {
    const tt = addSecondTerminal(createSampleAirport());
    expect(analyzeLayout(tt.layout).issues.some((i) => i.code === 'GATE_TERMINAL_AMBIGUOUS')).toBe(false);
  });
});
