import { describe, expect, it } from 'vitest';
import { orthogonalPolygonTiles, rectRing, validateOrthogonalPolygon } from '../../src/core/geometry/polygon';
import { facilityTiles } from '../../src/core/layout/footprint';
import { placeFacility, placeTerminalArea, setFacilityFootprint } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { deriveTerminalComplexes } from '../../src/core/terminal/complex';
import type { AirportLayout, Facility } from '../../src/core/model/types';
import { must } from './helpers';

/**
 * 5-15: 直交凹ポリゴンの建物形状（T2）とターミナル複合体の導出（T4）。
 * footprint 未設定の施設は従来の矩形と完全に同じ占有になる（旧セーブ互換）。
 */
describe('5-15 T2 直交ポリゴン', () => {
  it('L字・T字・コの字は有効で、タイル数は面積と一致する', () => {
    const lShape = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 8 }, { x: 0, y: 8 }];
    expect(validateOrthogonalPolygon(lShape)).toEqual([]);
    expect(orthogonalPolygonTiles(lShape)).toHaveLength(10 * 4 + 4 * 4); // 上段 40 + 左脚 16
    const tShape = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 3 }, { x: 8, y: 3 }, { x: 8, y: 8 }, { x: 4, y: 8 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
    expect(validateOrthogonalPolygon(tShape)).toEqual([]);
    expect(orthogonalPolygonTiles(tShape)).toHaveLength(12 * 3 + 4 * 5);
    const uShape = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 3 }, { x: 4, y: 3 }, { x: 4, y: 8 }, { x: 0, y: 8 }];
    expect(validateOrthogonalPolygon(uShape)).toEqual([]);
    expect(orthogonalPolygonTiles(uShape)).toHaveLength(12 * 8 - 4 * 5);
  });

  it('自己交差・重複点・非直交・ゼロ面積を拒否する', () => {
    const bowtie = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }, { x: 3, y: 6 }, { x: 3, y: -2 }, { x: 0, y: -2 }];
    expect(validateOrthogonalPolygon(bowtie)).toContain('selfIntersecting');
    const dup = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }];
    expect(validateOrthogonalPolygon(dup)).toContain('duplicatePoint');
    const diag = [{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 5 }, { x: 0, y: 5 }];
    expect(validateOrthogonalPolygon(diag)).toContain('nonOrthogonal');
    const flat = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 0 }];
    expect(validateOrthogonalPolygon(flat).length).toBeGreaterThan(0);
  });

  it('矩形リングのタイルは従来の矩形占有と一致する', () => {
    const ring = rectRing({ x: 3, y: 5 }, 7, 4);
    const tiles = orthogonalPolygonTiles(ring);
    expect(tiles).toHaveLength(28);
    expect(tiles[0]).toEqual({ x: 3, y: 5 });
  });

  it('footprint を設定すると占有が L 字になり、消すと矩形へ戻る', () => {
    const l = createSampleAirport();
    const term = l.facilities['fac_2']!;
    const rectCount = facilityTiles(term).length;
    const lShape = [
      { x: 46, y: 49 }, { x: 94, y: 49 }, { x: 94, y: 53 },
      { x: 52, y: 53 }, { x: 52, y: 57 }, { x: 46, y: 57 },
    ];
    const shaped = must(setFacilityFootprint(l, 'fac_2', lShape)).layout;
    expect(facilityTiles(shaped.facilities['fac_2']!)).toHaveLength(48 * 4 + 6 * 4);
    expect(facilityTiles(shaped.facilities['fac_2']!).length).toBeLessThan(rectCount);
    const cleared = must(setFacilityFootprint(shaped, 'fac_2', null)).layout;
    expect(facilityTiles(cleared.facilities['fac_2']!)).toHaveLength(rectCount);
    // 不正な形状は変更を拒否する
    expect(setFacilityFootprint(l, 'fac_2', [{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 5 }, { x: 0, y: 5 }]).ok).toBe(false);
  });
});

describe('5-15 T4 ターミナル複合体', () => {
  const withTerminal = (l: AirportLayout, id: string, x: number, y: number, extra: Partial<Facility> = {}): AirportLayout => {
    const placed = must(placeFacility(l, 'terminal', { x, y }, { w: 10, h: 6 }));
    const d = placed.layout;
    const f = Object.values(d.facilities).find((v) => v.kind === 'terminal' && v.origin.x === x && v.origin.y === y)!;
    const renamed: Facility = { ...f, id, ...extra };
    delete d.facilities[f.id];
    d.facilities[id] = renamed;
    return d;
  };

  it('辺を共有する建物は同じ複合体、角だけ・離れた建物は別', () => {
    let l = createStarterAirfield(); // 既存ターミナル x46-65, y49-56
    const base = deriveTerminalComplexes(l);
    expect(base).toHaveLength(1);
    l = withTerminal(l, 'term_b', 66, 49); // 右辺に接触
    let complexes = deriveTerminalComplexes(l);
    expect(complexes).toHaveLength(1);
    expect(complexes[0]!.buildingIds).toHaveLength(2);
    // 角だけ接触する建物を足しても別複合体
    l = withTerminal(l, 'term_c', 76, 55);
    complexes = deriveTerminalComplexes(l);
    expect(complexes).toHaveLength(2);
  });

  it('階層が違う建物は接していても別複合体', () => {
    let l = createStarterAirfield();
    l = withTerminal(l, 'term_b', 66, 49, { mapLevel: 1 });
    expect(deriveTerminalComplexes(l)).toHaveLength(2);
  });

  it('operational な高層連絡通路だけが離れた建物を結び、planned は結ばない', () => {
    let l = createStarterAirfield();
    l = withTerminal(l, 'term_b', 90, 49);
    expect(deriveTerminalComplexes(l)).toHaveLength(2);
    const t1 = Object.values(l.facilities).find((f) => f.kind === 'terminal' && f.id !== 'term_b')!;
    l = must(placeTerminalArea(l, t1.id, 0, 'waiting', { x: 50, y: 50 }, { w: 4, h: 2 })).layout;
    l = must(placeTerminalArea(l, 'term_b', 0, 'waiting', { x: 92, y: 50 }, { w: 4, h: 2 })).layout;
    const areas = Object.values(l.terminalAreas);
    const a1 = areas.find((a) => a.terminalId === t1.id)!;
    const a2 = areas.find((a) => a.terminalId === 'term_b')!;
    const link = {
      id: 'link_1', name: '連絡橋', kind: 'elevatedWalkway' as const,
      fromAreaId: a1.id, toAreaId: a2.id, distanceM: 100, travelSec: 120,
      bidirectional: true, buildState: 'planned' as const, allowedZones: [],
    };
    const withPlanned: AirportLayout = { ...l, terminalLinks: { link_1: link } };
    expect(deriveTerminalComplexes(withPlanned)).toHaveLength(2);
    const withOps: AirportLayout = { ...l, terminalLinks: { link_1: { ...link, buildState: 'operational' as const } } };
    expect(deriveTerminalComplexes(withOps)).toHaveLength(1);
  });
});
