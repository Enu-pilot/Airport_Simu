import { describe, expect, it } from 'vitest';
import { convertRunwayToFree, placeFreeRunway, placeRunway, setFreeRunwayGeometry, snapRunwayToGrid, updateEntity } from '../../src/core/layout/operations';
import { constructionCost, layoutItems } from '../../src/core/economy/construction';
import { createCareerCompany } from '../../src/core/economy/company';
import { prepareCareerEdit } from '../../src/core/economy/expansion';
import { BALANCE } from '../../src/core/economy/balance';
import { TILE_M } from '../../src/core/model/catalog';
import type { Heading } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

const HEADINGS: Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];
const per = BALANCE.construction.runwayPerTile;

describe('自由形の建設費（S8）', () => {
  it('任意の角度: 実長（m）から求める。幅で倍率が変わる', () => {
    for (const [deg, m, w] of [[37.5, 1000, 45], [123.456, 2345.6, 60], [0, 1500, 30], [271.3, 1800, 45]] as const) {
      const l = must(placeFreeRunway(emptyLayout(), { start: { x: 20.25, y: 30.5 }, headingDeg: deg, lengthM: m }, { surfaceWidthM: w })).layout;
      expect(layoutItems(l)['rwy_1']).toBe(Math.round((m / TILE_M) * per * (w / 30)));
    }
  });

  it('計画中は費用なし。建設費は編集の差で払う', () => {
    const base = emptyLayout();
    const l = must(placeFreeRunway(base, { start: { x: 10, y: 10 }, headingDeg: 33, lengthM: 1200 }, { buildState: 'planned' })).layout;
    expect(layoutItems(l)['rwy_1']).toBeUndefined();
    const built = must(placeFreeRunway(base, { start: { x: 10, y: 10 }, headingDeg: 33, lengthM: 1200 })).layout;
    expect(constructionCost(base, built)).toBeGreaterThan(0);
  });

  it('従来形から変換した自由形の費用は、従来形と同じ（8 方位 × 長さ）', () => {
    for (const h of HEADINGS) {
      for (const len of [3, 10, 37]) {
        for (const w of [30, 45, 60] as const) {
          const l = must(placeRunway(emptyLayout(), { x: 30, y: 30 }, h, len, { surfaceWidthM: w })).layout;
          const f = must(convertRunwayToFree(l, 'rwy_1')).layout;
          expect(layoutItems(f)['rwy_1']).toBe(layoutItems(l)['rwy_1']);
          expect(constructionCost(l, f)).toBe(0);
        }
      }
    }
  });
});

describe('拡張計画: 変換は改修工事にしない（S8）', () => {
  const career = () => {
    const c = createCareerCompany();
    const base = must(placeRunway(emptyLayout(), { x: 30, y: 30 }, 45, 20)).layout;
    return { c, base };
  };

  it('従来形 → 自由形、自由形 → 従来形（丸めが恒等のとき）の変換は工事を作らず、運用中のまま', () => {
    const { c, base } = career();
    const f = must(convertRunwayToFree(base, 'rwy_1')).layout;
    const after = prepareCareerEdit(c, base, f);
    expect(after.runways['rwy_1']!.buildState).toBe('operational');
    expect(c.projects['rwy_1']).toBeUndefined();
    const back = must(snapRunwayToGrid(f, 'rwy_1')).layout;
    const after2 = prepareCareerEdit(c, f, back);
    expect(after2.runways['rwy_1']!.buildState).toBe('operational');
    expect(c.projects['rwy_1']).toBeUndefined();
  });

  it('形状を変える編集は従来どおり改修工事（従来形の延長・自由形の方位・長さ・幅・肩）', () => {
    const { c, base } = career();
    const longer = prepareCareerEdit(c, base, must(updateEntity(base, 'rwy_1', { length: 30 })).layout);
    expect(longer.runways['rwy_1']!.buildState).toBe('underConstruction');
    expect(c.projects['rwy_1']).toMatchObject({ kind: 'renovation' });

    const f = must(convertRunwayToFree(base, 'rwy_1')).layout;
    for (const edit of [
      (l: typeof f) => must(setFreeRunwayGeometry(l, 'rwy_1', { headingDeg: 50 })).layout,
      (l: typeof f) => must(setFreeRunwayGeometry(l, 'rwy_1', { lengthM: 700 })).layout,
      (l: typeof f) => must(updateEntity(l, 'rwy_1', { surfaceWidthM: 60 })).layout,
      (l: typeof f) => must(updateEntity(l, 'rwy_1', { dims: { shoulderWidthM: 12 } })).layout,
    ]) {
      const c2 = createCareerCompany();
      const out = prepareCareerEdit(c2, f, edit(f));
      expect(out.runways['rwy_1']!.buildState).toBe('underConstruction');
      expect(c2.projects['rwy_1']).toMatchObject({ kind: 'renovation' });
    }
  });

  it('着陸帯・RESA・停止位置・名前の変更は工事ではない', () => {
    const { base } = career();
    const f = must(convertRunwayToFree(base, 'rwy_1')).layout;
    const c = createCareerCompany();
    const out = prepareCareerEdit(c, f, must(updateEntity(f, 'rwy_1', { name: 'X', dims: { resaLengthM: 120, stripHalfWidthM: 150, holdingPositionM: 100 }, designatorSuffix: 'L' })).layout);
    expect(out.runways['rwy_1']!.buildState).toBe('operational');
    expect(c.projects['rwy_1']).toBeUndefined();
  });

  it('変換と同時に形状も変えたら改修工事', () => {
    const { c, base } = career();
    const f = must(convertRunwayToFree(base, 'rwy_1')).layout;
    const moved = must(setFreeRunwayGeometry(f, 'rwy_1', { headingDeg: 46 })).layout;
    expect(prepareCareerEdit(c, base, moved).runways['rwy_1']!.buildState).toBe('underConstruction');
  });
});
