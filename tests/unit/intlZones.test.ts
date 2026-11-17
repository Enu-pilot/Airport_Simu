import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { buildTerminalModel, canMove, intlProcessingReady, type AreaNode } from '../../src/core/terminal/model';
import { intlAirport, intlGateId } from './intlLayout';

const node = (zone: AreaNode['zone'], kind: AreaNode['kind']): AreaNode =>
  ({ id: 'x', terminalId: 't', level: 0, kind, zone, x: 0, y: 0, w: 1, h: 1, center: { x: 0, y: 0 }, capacity: 10 });

describe('canMove: 国際区域の境界（フェーズ 4 §4.2）', () => {
  it('出発 → 国際出発は出国審査を通るときだけ', () => {
    expect(canMove(node('departure', 'waiting'), node('departureIntl', 'emigration'))).toBe(true);
    expect(canMove(node('departure', 'waiting'), node('departureIntl', 'waiting'))).toBe(false);
  });

  it('国際到着 → 到着は入国審査を通るときだけ', () => {
    expect(canMove(node('arrivalIntl', 'waiting'), node('arrival', 'immigration'))).toBe(true);
    expect(canMove(node('arrivalIntl', 'waiting'), node('arrival', 'arrivalCorridor'))).toBe(false);
  });

  it('到着 → 一般区域は税関からも出られる（従来の受取・出口に加えて）', () => {
    expect(canMove(node('arrival', 'arrivalCorridor'), node('landside', 'customs'))).toBe(true);
    expect(canMove(node('arrival', 'baggageClaim'), node('landside', 'exit'))).toBe(true);
    expect(canMove(node('arrival', 'arrivalCorridor'), node('landside', 'exit'))).toBe(true);
    expect(canMove(node('arrival', 'arrivalCorridor'), node('landside', 'hall'))).toBe(false);
  });

  it('乗継保安検査は到着 → 出発（国内・国際の一致する組み合わせ）を通す', () => {
    expect(canMove(node('arrival', 'arrivalCorridor'), node('departure', 'transferSecurity'))).toBe(true);
    expect(canMove(node('arrivalIntl', 'waiting'), node('departureIntl', 'transferSecurity'))).toBe(true);
    expect(canMove(node('arrival', 'arrivalCorridor'), node('departureIntl', 'transferSecurity'))).toBe(false);
    expect(canMove(node('arrivalIntl', 'waiting'), node('departure', 'transferSecurity'))).toBe(false);
  });

  it('従来の規則は変わらない', () => {
    expect(canMove(node('landside', 'hall'), node('departure', 'security'))).toBe(true);
    expect(canMove(node('landside', 'hall'), node('departure', 'waiting'))).toBe(false);
    expect(canMove(node('departure', 'waiting'), node('landside', 'hall'))).toBe(false);
    expect(canMove(node('departure', 'waiting'), node('departure', 'departureLobby'))).toBe(true);
  });
});

describe('ゲートの国際アクセスと処理可否（フェーズ 4 §4.2・§4.5）', () => {
  it('国際ゲートには国際側の搭乗口・降機口が付き、国内ゲートには付かない', () => {
    const l = intlAirport();
    const m = buildTerminalModel(l);
    const access = m.gates[intlGateId(l)]!;
    expect(access.routeType).toBe('international');
    expect(access.boardingIntl).toBe('ta_i1');
    expect(access.deplaneIntl).toBe('ta_i4');
    for (const [gid, a] of Object.entries(m.gates)) {
      if (gid === intlGateId(l)) continue;
      expect(a.boardingIntl).toBeUndefined();
      expect(a.deplaneIntl).toBeUndefined();
      expect(a.routeType).toBeUndefined();
    }
  });

  it('国際エリアのない従来の空港では形が変わらず、処理は不可', () => {
    const m = buildTerminalModel(createSampleAirport());
    expect(intlProcessingReady(m)).toBe(false);
    for (const a of Object.values(m.gates)) {
      expect(a.boardingIntl).toBeUndefined();
      expect(a.deplaneIntl).toBeUndefined();
    }
  });

  it('審査エリアと国際ゲートがそろえば処理可。税関を欠くと不可', () => {
    const l = intlAirport();
    expect(intlProcessingReady(buildTerminalModel(l))).toBe(true);
    delete l.terminalAreas['ta_i8'];
    expect(intlProcessingReady(buildTerminalModel(l))).toBe(false);
  });
});
