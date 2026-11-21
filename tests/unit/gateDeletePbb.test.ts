import { describe, expect, it } from 'vitest';
import {
  deleteEntity,
  placeBoardingBridge,
  placeFacility,
  placeStand,
  updateEntity,
} from '../../src/core/layout/operations';
import { explicitPbbForGate } from '../../src/core/model/boardingBridge';
import { analyzeLayout } from '../../src/core/validation/validate';
import type { AirportLayout, Facility, Stand } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * ゲート削除の後始末: ゲート（施設種別 gate）だけを削除したときに、紐付く
 * PBB（施設種別 boardingBridge、props.gateId でゲートを参照）が孤児として
 * 残らないこと。PBB は parentFacilityId を持たず、削除の連動対象から
 * 漏れていた（削除後に PBB_GATE_MISMATCH のエラーが残り続けた）。
 */

interface Fixture {
  layout: AirportLayout;
  stand: Stand;
  gate: Facility;
  terminal: Facility;
}

function fixture(): Fixture {
  let l = emptyLayout(80, 60);
  l = must(placeFacility(l, 'apron', { x: 5, y: 5 }, { w: 40, h: 30 })).layout;
  l = must(placeStand(l, { x: 20, y: 20 }, 'L', 0)).layout;
  const stand = Object.values(l.stands)[0]!;
  l = must(placeFacility(l, 'terminal', { x: 8, y: 8 }, { props: { levels: 2 } })).layout;
  const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
  l = must(placeFacility(l, 'gate', { x: 18, y: 18 }, {
    props: { standId: stand.id, jetBridge: true },
  })).layout;
  const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
  return { layout: l, stand, gate, terminal };
}

const bridgesOf = (layout: AirportLayout): Facility[] =>
  Object.values(layout.facilities).filter((f) => f.kind === 'boardingBridge');

const allCodes = (layout: AirportLayout): string[] =>
  Object.values(analyzeLayout(layout).byTarget).flatMap((issues) => issues.map((i) => i.code));

describe('ゲート削除で PBB が残らない', () => {
  it('ゲートを削除すると紐付く PBB（main / upper の両方）が一緒に消える', () => {
    const f = fixture();
    let l = must(placeBoardingBridge(f.layout, f.gate.id, f.stand.id, { deck: 'main' })).layout;
    l = must(placeBoardingBridge(l, f.gate.id, f.stand.id, { deck: 'upper', bridgeType: 'tunnel2' })).layout;
    expect(bridgesOf(l)).toHaveLength(2);
    expect(explicitPbbForGate(l, f.gate.id)).toHaveLength(2);

    const after = must(deleteEntity(l, f.gate.id)).layout;
    expect(after.facilities[f.gate.id]).toBeUndefined();
    expect(bridgesOf(after)).toHaveLength(0);
    expect(explicitPbbForGate(after, f.gate.id)).toHaveLength(0);
    expect(allCodes(after)).not.toContain('PBB_GATE_MISMATCH');
  });

  it('ターミナルを削除すると配下ゲートの PBB も一緒に消える', () => {
    let l = emptyLayout(80, 60);
    l = must(placeFacility(l, 'apron', { x: 5, y: 5 }, { w: 40, h: 30 })).layout;
    l = must(placeStand(l, { x: 20, y: 20 }, 'L', 0)).layout;
    const stand = Object.values(l.stands)[0]!;
    l = must(placeFacility(l, 'terminal', { x: 8, y: 8 }, { props: { levels: 2 } })).layout;
    const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    // ターミナルの子としてゲートを置く（parentFacilityId 付き）
    l = must(placeFacility(l, 'gate', { x: 10, y: 10 }, {
      parentFacilityId: terminal.id,
      floorIndex: 0,
      props: { standId: stand.id, jetBridge: true },
    })).layout;
    const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
    expect(gate.parentFacilityId).toBe(terminal.id);
    l = must(placeBoardingBridge(l, gate.id, stand.id, { deck: 'main' })).layout;
    expect(bridgesOf(l)).toHaveLength(1);

    const after = must(deleteEntity(l, terminal.id)).layout;
    expect(after.facilities[gate.id]).toBeUndefined();
    expect(bridgesOf(after)).toHaveLength(0);
    expect(allCodes(after)).not.toContain('PBB_GATE_MISMATCH');
  });

  it('スポットを削除すると、そのスポットに紐付く PBB が消える（ゲートは standId が外れて残る）', () => {
    const f = fixture();
    const l = must(placeBoardingBridge(f.layout, f.gate.id, f.stand.id, { deck: 'main' })).layout;
    expect(bridgesOf(l)).toHaveLength(1);

    const after = must(deleteEntity(l, f.stand.id)).layout;
    expect(after.stands[f.stand.id]).toBeUndefined();
    expect(bridgesOf(after)).toHaveLength(0);
    expect(after.facilities[f.gate.id]).toBeDefined();
    expect(after.facilities[f.gate.id]!.props.standId).toBeNull();
    expect(allCodes(after)).not.toContain('PBB_GATE_MISMATCH');
  });

  it('別のゲートの PBB は巻き込まれない', () => {
    const f = fixture();
    let l = must(placeBoardingBridge(f.layout, f.gate.id, f.stand.id, { deck: 'main' })).layout;
    l = must(placeStand(l, { x: 30, y: 20 }, 'L', 0)).layout;
    const stand2 = Object.values(l.stands).find((s) => s.id !== f.stand.id)!;
    l = must(placeFacility(l, 'gate', { x: 28, y: 18 }, {
      props: { standId: stand2.id, jetBridge: true },
    })).layout;
    const gate2 = Object.values(l.facilities).find((x) => x.kind === 'gate' && x.id !== f.gate.id)!;
    l = must(placeBoardingBridge(l, gate2.id, stand2.id, { deck: 'main' })).layout;
    expect(bridgesOf(l)).toHaveLength(2);

    const after = must(deleteEntity(l, f.gate.id)).layout;
    expect(bridgesOf(after)).toHaveLength(1);
    expect(bridgesOf(after)[0]!.props.gateId).toBe(gate2.id);
    expect(explicitPbbForGate(after, gate2.id)).toHaveLength(1);
  });

  it('バスゲートを削除するとスポットの busGateId が外れる（従来の後始末の回帰確認）', () => {
    let l = emptyLayout(80, 60);
    l = must(placeFacility(l, 'apron', { x: 5, y: 5 }, { w: 40, h: 30 })).layout;
    l = must(placeStand(l, { x: 20, y: 20 }, 'L', 0)).layout;
    const stand = Object.values(l.stands)[0]!;
    l = must(placeFacility(l, 'gate', { x: 18, y: 18 }, {
      props: { standId: null, boardingMode: 'bus', jetBridge: false },
    })).layout;
    const busGate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
    l = must(updateEntity(l, stand.id, { remoteBoarding: 'bus', busGateId: busGate.id })).layout;
    expect(l.stands[stand.id]!.busGateId).toBe(busGate.id);

    const after = must(deleteEntity(l, busGate.id)).layout;
    expect(after.stands[stand.id]!.busGateId).toBeNull();
  });

  it('ゲートの standId を付け替えただけでは PBB は消えない（不整合は検証が拾う）', () => {
    const f = fixture();
    let l = must(placeBoardingBridge(f.layout, f.gate.id, f.stand.id, { deck: 'main' })).layout;
    l = must(placeStand(l, { x: 30, y: 20 }, 'L', 0)).layout;
    const stand2 = Object.values(l.stands).find((s) => s.id !== f.stand.id)!;

    const after = must(updateEntity(l, f.gate.id, { props: { standId: stand2.id } })).layout;
    expect(bridgesOf(after)).toHaveLength(1);
    expect(allCodes(after)).toContain('PBB_GATE_MISMATCH');
  });
});
