import { describe, expect, it } from 'vitest';
import { SITE_SIZES, createSite, siteSizeById, terrainAt } from '../../src/core/model/site';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { analyzeLayout } from '../../src/core/validation/validate';
import { editorStore, newGame } from '../../src/editor/store';
import { Terrain } from '../../src/core/model/types';
import { createEmptyLayout } from '../../src/core/layout/operations';
import { buildProject, serializeProject, validateProject } from '../../src/core/io/project';
import { createSandboxCompany } from '../../src/core/economy/company';

/**
 * 敷地サイズの選択肢（2026-11-18 追加）: 標準・中・大・特大の 4 段階。
 * 大きな敷地でも地形生成・保存・読み込みが成り立つことを確認する。
 * （2026-11-19: プリセットの実態（大 288×208・特大 350×332）に合わせて期待値を訂正。
 * 以前の期待値 240×180 / 288×208 は実装変更にテストが追随しておらず既定ブランチで失敗していた。）
 */
describe('敷地サイズ', () => {
  it('選択肢は標準 160×112・中 200×144・大 288×208・特大 350×332 で、標準が既定の大きさ', () => {
    expect(SITE_SIZES.map((s) => [s.width, s.height])).toEqual([[160, 112], [200, 144], [288, 208], [350, 332]]);
    expect(siteSizeById('huge').width).toBe(350);
    expect(siteSizeById('unknown').id).toBe('standard');
  });

  it('大きな敷地でも地形が生成され、外周は未取得地、中央は建設できる', () => {
    const site = createSite({ width: 288, height: 208, seed: 'skyport' });
    expect(site.terrain.length).toBe(288 * 208);
    expect(terrainAt(site, 0, 0)).toBe(Terrain.offsite);
    expect(terrainAt(site, 287, 207)).toBe(Terrain.offsite);
    expect(terrainAt(site, 144, 104)).toBe(Terrain.grass);
  });

  it('新規ゲームの空港（サンプル／スターター）も大きい敷地で作れ、検証結果は標準と同じ', () => {
    const std = createSampleAirport();
    const huge = createSampleAirport('skyport', 'huge');
    expect(huge.site.width).toBe(350);
    expect(huge.site.height).toBe(332);
    expect(Object.keys(huge.stands)).toHaveLength(Object.keys(std.stands).length);
    expect(Object.keys(huge.runways)).toHaveLength(Object.keys(std.runways).length);
    const codes = (l: typeof std) => analyzeLayout(l).issues.map((i) => i.code).sort();
    expect(codes(huge)).toEqual(codes(std));

    const starterStd = createStarterAirfield();
    const starterLarge = createStarterAirfield('skyport-starter', 'large');
    expect(starterLarge.site.width).toBe(288);
    expect(starterLarge.site.height).toBe(208);
    expect(codes(starterLarge)).toEqual(codes(starterStd));
  });

  it('ストアの新規ゲームにサイズを渡すと、その敷地で始まる', () => {
    newGame('sandbox', null, null, 'huge');
    const layout = editorStore.getState().history.present;
    expect(layout.site.width).toBe(350);
    expect(layout.site.height).toBe(332);
    newGame('career', null, null, 'medium');
    const layout2 = editorStore.getState().history.present;
    expect(layout2.site.width).toBe(200);
    expect(layout2.site.height).toBe(144);
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
