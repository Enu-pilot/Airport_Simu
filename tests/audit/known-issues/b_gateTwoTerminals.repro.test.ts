import { expect, it } from 'vitest';
import { addSecondTerminal } from '../b_helpers';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { placeFacility } from '../../../src/core/layout/operations';
import { createContext } from '../../../src/core/sim/context';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { must } from '../../unit/helpers';

/**
 * 既知の不具合（docs/38 ID 10, docs/35 §2.1 手順 4）:
 * 「複数ターミナル環境で所属を一意に決定できない場合、ターミナルを推測しない」とあるが、1 つのゲートが 2 つのターミナルに
 * 同時に隣接している場合（ターミナル A=fac_2 が x=46..93、ターミナル B が x=95.. で、(94,49) のゲートが両方に接する）、
 * buildTerminalModel は sortedValues 順で最初の隣接ターミナル(fac_2)を黙って選ぶ（terminal/model.ts: `.find(...)`）。
 * 検証(analyzeLayout)にも曖昧さの警告がない。
 * 期待: 曖昧なゲートは terminalId=null（未接続）になるか、検証が曖昧さを報告する。
 */
it('2 つのターミナルに隣接するゲートは所属を推測せず、未確定（null）か検証の警告になる', () => {
  const tt = addSecondTerminal(createSampleAirport(), { x: 95, y: 49 });
  const r = must(placeFacility(tt.layout, 'gate', { x: 94, y: 49 }, { props: { boardingMode: 'bus', standId: null, jetBridge: false } }));
  const gateId = r.created[0]!;
  const access = createContext(r.layout).terminal.gates[gateId]!;
  const reported = analyzeLayout(r.layout).issues.some((i) => i.targets.includes(gateId) && /AMBIG|MULTIPLE|TERMINAL/.test(i.code));
  expect(access.terminalId === null || reported, `terminalId=${access.terminalId}, 曖昧さの報告=${reported}`).toBe(true);
});
