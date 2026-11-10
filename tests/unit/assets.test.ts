import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../src/core/aircraft/catalog';
import { AIRCRAFT_ASSETS, ASSET_VERSION, FALLBACK_ASSET_ID, assetOf, liveryOf, supportList } from '../../src/core/assets/registry';
import { AIRLINES } from '../../src/core/economy/registry';

describe('3D アセット登録簿', () => {
  it('カタログの全機種にアセットが登録され、専用モデルはない（すべて手続き生成）', () => {
    const rows = supportList(CATALOG);
    expect(rows).toHaveLength(Object.keys(CATALOG).length);
    expect(rows.filter((r) => r.level === 'missing')).toEqual([]);
    expect(rows.some((r) => r.level === 'dedicated')).toBe(false);
    // 汎用機材は代替（汎用の形）、実在機種は系統テンプレート
    for (const r of rows) expect(r.level).toBe(CATALOG[r.modelId]!.generic ? 'fallback' : 'template');
  });

  it('各アセットは版・原点・単位・LOD・出典・ライセンスを持つ', () => {
    for (const a of Object.values(AIRCRAFT_ASSETS)) {
      expect(a.version).toBe(ASSET_VERSION);
      expect(a.unitM).toBe(1);
      expect(a.lod.length).toBeGreaterThanOrEqual(2);
      expect(a.lod.at(-1)!.maxDistanceM).toBe(Infinity);
      expect(a.source).toBeTruthy();
      expect(a.license).toBeTruthy();
    }
  });

  it('未登録のアセット ID・航空会社は代替で表示する', () => {
    expect(assetOf('no-such-asset').id).toBe(FALLBACK_ASSET_ID);
    expect(liveryOf(null).airlineId).toBeNull();
    // 架空の航空会社にはそれぞれ塗装がある
    for (const a of AIRLINES) expect(liveryOf(a.id).airlineId).toBe(a.id);
  });
});
