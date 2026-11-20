import { describe, expect, it } from 'vitest';
import { sizeClassOf, type AircraftModel } from '../../src/core/aircraft/catalog';
import { STAND_DIMS } from '../../src/core/model/catalog';
import { legacyStandEntry, standEntry } from '../../src/core/layout/footprint';
import { buildAirsideNetwork } from '../../src/core/airside/network';
import type { Stand } from '../../src/core/model/types';
import { emptyLayout } from './helpers';

/**
 * スポットサイズ再編: 区分はコード A/B=S・C=M・D/E/F=L、寸法は S 2×2・M 3×2・L 4×4。
 * 入口は「中央に最も近いタイル」。旧寸法の入口位置も接続互換として扱う。
 */
const model = (wingspan: number): AircraftModel =>
  ({ id: 'fake', generic: false, wingspanM: { value: wingspan } }) as unknown as AircraftModel;

const stand = (size: Stand['size'], rotation: Stand['rotation']): Stand => ({
  id: 's', name: '', origin: { x: 10, y: 10 }, rotation, size, buildState: 'operational',
});

describe('機種のサイズ区分', () => {
  it('コード A/B は S、C は M、D/E/F は L（F は codeF）', () => {
    expect(sizeClassOf(model(20))).toEqual({ size: 'S', codeF: false });
    expect(sizeClassOf(model(30))).toEqual({ size: 'M', codeF: false });
    expect(sizeClassOf(model(40))).toEqual({ size: 'L', codeF: false });
    expect(sizeClassOf(model(60))).toEqual({ size: 'L', codeF: false });
    expect(sizeClassOf(model(70))).toEqual({ size: 'L', codeF: true });
  });

  it('寸法は S 2×2・M 3×2・L 4×4', () => {
    expect(STAND_DIMS).toEqual({ S: { w: 2, d: 2 }, M: { w: 3, d: 2 }, L: { w: 4, d: 4 } });
  });
});

describe('スポット入口（中央に最も近いタイル）', () => {
  it('S 2×2: 偶数幅は左/上に寄る', () => {
    expect(standEntry(stand('S', 0))).toEqual({ x: 10, y: 12 });
    expect(standEntry(stand('S', 90))).toEqual({ x: 9, y: 10 });
    expect(standEntry(stand('S', 180))).toEqual({ x: 10, y: 9 });
    expect(standEntry(stand('S', 270))).toEqual({ x: 12, y: 10 });
  });

  it('M 3×2: 横 3 は従来どおり中央、奥行き 2 で入口が近づく', () => {
    expect(standEntry(stand('M', 0))).toEqual({ x: 11, y: 12 });
    expect(standEntry(stand('M', 90))).toEqual({ x: 9, y: 11 });
    expect(standEntry(stand('M', 180))).toEqual({ x: 11, y: 9 });
    expect(standEntry(stand('M', 270))).toEqual({ x: 12, y: 11 });
  });

  it('L 4×4: 偶数幅は左/上に寄る', () => {
    expect(standEntry(stand('L', 0))).toEqual({ x: 11, y: 14 });
    expect(standEntry(stand('L', 90))).toEqual({ x: 9, y: 11 });
    expect(standEntry(stand('L', 180))).toEqual({ x: 11, y: 9 });
    expect(standEntry(stand('L', 270))).toEqual({ x: 14, y: 11 });
  });

  it('旧寸法の入口（互換用）は従来の位置を再現する', () => {
    expect(legacyStandEntry(stand('S', 0))).toEqual({ x: 11, y: 13 }); // 旧 S 3×3
    expect(legacyStandEntry(stand('M', 0))).toEqual({ x: 11, y: 14 }); // 旧 M 3×4
    expect(legacyStandEntry(stand('L', 0))).toEqual({ x: 12, y: 15 }); // 旧 L 5×5
  });
});

describe('旧セーブ互換（ネットワーク接続）', () => {
  it('誘導路ノードが旧入口にだけあってもスポットは接続される', () => {
    const layout = emptyLayout(60, 40);
    const s = stand('M', 0);
    layout.stands[s.id] = s;
    const legacy = legacyStandEntry(s);
    layout.taxiNodes['n1'] = { id: 'n1', pos: legacy, name: '', holdShort: false };
    const net = buildAirsideNetwork(layout);
    expect(net.standLinks[s.id]).toBe('n1');
  });

  it('新入口にノードがあればそちらで接続される', () => {
    const layout = emptyLayout(60, 40);
    const s = stand('M', 0);
    layout.stands[s.id] = s;
    layout.taxiNodes['n2'] = { id: 'n2', pos: standEntry(s), name: '', holdShort: false };
    const net = buildAirsideNetwork(layout);
    expect(net.standLinks[s.id]).toBe('n2');
  });
});
