import { describe, expect, it } from 'vitest';
import { DEFAULT_PROPS, PROP_SCHEMAS, propDefault } from '../../src/core/model/catalog';
import { apronBusesOf, connectedTerminal, gateMode } from '../../src/core/model/gates';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { deleteEntity, updateEntity } from '../../src/core/layout/operations';
import { must } from './helpers';

describe('12B-3a A2: ゲートの搭乗方式・接続先・ランプバスのプロパティ', () => {
  const layout = createSampleAirport();
  const gate = Object.values(layout.facilities).find((f) => f.kind === 'gate')!;
  const base = Object.values(layout.facilities).find((f) => f.kind === 'gseBase')!;
  const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!;

  it('DEFAULT_PROPS は変えない（新しく置いたゲート・基地の JSON は従来と同じ）', () => {
    expect(DEFAULT_PROPS.gate).toEqual({ standId: null, jetBridge: true });
    expect(DEFAULT_PROPS.gseBase).toEqual({ staff: 20, tugs: 2, beltLoaders: 3, baggageTractors: 3, fuelTrucks: 2, cateringTrucks: 2, cleaningVans: 2 });
    expect(JSON.stringify(gate.props)).not.toContain('boardingMode');
  });

  it('欠落 = 従来の値として読む', () => {
    expect(gateMode(gate)).toBe('contact');
    expect(connectedTerminal(gate, layout)).toBeNull();
    expect(apronBusesOf(base)).toBe(0);
    const def = PROP_SCHEMAS.gate.find((d) => d.key === 'boardingMode')!;
    expect(propDefault(def)).toBe('contact');
  });

  it('更新の検証: boardingMode は列挙、connectedTo はターミナルか null、apronBuses は 0〜30 の整数', () => {
    const upd = (id: string, props: Record<string, unknown>) => updateEntity(layout, id, { props });
    const bus = must(upd(gate.id, { boardingMode: 'bus', standId: null, jetBridge: false }));
    expect(gateMode(bus.layout.facilities[gate.id]!)).toBe('bus');
    expect(upd(gate.id, { boardingMode: 'rail' }).ok).toBe(false);
    expect(upd(gate.id, { connectedTo: terminal.id }).ok).toBe(true);
    expect(upd(gate.id, { connectedTo: null }).ok).toBe(true);
    expect(upd(gate.id, { connectedTo: base.id }).ok).toBe(false);
    expect(upd(gate.id, { connectedTo: 'fac_999' }).ok).toBe(false);
    expect(upd(base.id, { apronBuses: 3 }).ok).toBe(true);
    expect(upd(base.id, { apronBuses: 31 }).ok).toBe(false);
    expect(upd(base.id, { apronBuses: 1.5 }).ok).toBe(false);
  });

  it('接続先のターミナルを削除すると connectedTo のキーが消える（従来のゲートは不変）', () => {
    const l1 = must(updateEntity(layout, gate.id, { props: { connectedTo: terminal.id } })).layout;
    expect(connectedTerminal(l1.facilities[gate.id]!, l1)).toBe(terminal.id);
    const r = deleteEntity(l1, terminal.id);
    if (r.ok) expect('connectedTo' in r.layout.facilities[gate.id]!.props).toBe(false);
    else expect(r.ok).toBe(false);
    // 他のゲートには何も起きない
    const other = Object.values(layout.facilities).find((f) => f.kind === 'gate' && f.id !== gate.id)!;
    if (r.ok) expect(r.layout.facilities[other.id]!.props).toEqual(other.props);
  });
});
