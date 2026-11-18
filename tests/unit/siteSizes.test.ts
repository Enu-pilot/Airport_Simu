import { describe, expect, it } from 'vitest';
import { SITE_SIZES, createSite, siteSizeById, terrainAt } from '../../src/core/model/site';
import { Terrain } from '../../src/core/model/types';
import { createEmptyLayout } from '../../src/core/layout/operations';
import { buildProject, serializeProject, validateProject } from '../../src/core/io/project';
import { createSandboxCompany } from '../../src/core/economy/company';

/**
 * 敷地サイズの選択肢（2026-11-18 追加）: 標準・大・特大の 3 段階。
 * 大きな敷地でも地形生成・保存・読み込みが成り立つことを確認する。
 */
describe('敷地サイズ', () => {
  it('選択肢は標準 160×112・中 200×144・大 240×180・特大 288×208 で、標準が既定の大きさ', () => {
    expect(SITE_SIZES.map((s) => [s.width, s.height])).toEqual([[160, 112], [200, 144], [240, 180], [288, 208]]);
    expect(siteSizeById('huge').width).toBe(288);
    expect(siteSizeById('unknown').id).toBe('standard');
  });

  it('大きな敷地でも地形が生成され、外周は未取得地、中央は建設できる', () => {
    const site = createSite({ width: 288, height: 208, seed: 'skyport' });
    expect(site.terrain.length).toBe(288 * 208);
    expect(terrainAt(site, 0, 0)).toBe(Terrain.offsite);
    expect(terrainAt(site, 287, 207)).toBe(Terrain.offsite);
    expect(terrainAt(site, 144, 104)).toBe(Terrain.grass);
  });

  it('大きな敷地の空レイアウトが保存・読み込みできる', () => {
    const layout = createEmptyLayout(createSite({ width: 240, height: 180, seed: 'skyport' }));
    expect(layout.site.width).toBe(240);
    const p = buildProject({ name: 't', savedAt: '2026-11-18T00:00:00.000Z', layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    const v = validateProject(serializeProject(p), { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(true);
    if (v.ok && v.project) {
      const back = v.project.layout;
      expect(back.site.width).toBe(240);
      expect(back.site.height).toBe(180);
      expect(back.site.terrain.length).toBe(240 * 180);
    }
  });
});
