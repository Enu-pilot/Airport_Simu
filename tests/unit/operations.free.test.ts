import { describe, expect, it } from 'vitest';
import {
  convertRunwayToFree,
  defaultDuplicateOffset,
  duplicateEntity,
  moveEntity,
  placeFreeRunway,
  placeFreeRunwayByEnds,
  placeRunway,
  rotateEntity,
  setFreeRunwayGeometry,
  snapRunwayToGrid,
  updateEntity,
  updateLayoutSettings,
} from '../../src/core/layout/operations';
import { runwayAxis, positionOnRunway } from '../../src/core/layout/runway';
import { checkLayout } from '../../src/core/io/project';
import { commit, createHistory, undo } from '../../src/core/editor/history';
import { POS_EPS_T } from '../../src/core/geometry/tolerance';
import { TILE_M } from '../../src/core/model/catalog';
import type { AirportLayout, Heading, RunwayFree, RunwayGrid8 } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

const HEADINGS: Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];
const freeOf = (l: AirportLayout, id: string): RunwayFree => l.runways[id] as RunwayFree;
const mid = (r: RunwayFree) => {
  const a = runwayAxis(r);
  return { x: (a.start.x + a.end.x) / 2, y: (a.start.y + a.end.y) / 2 };
};
const place = (g: { start: { x: number; y: number }; headingDeg: number; lengthM: number }, l = emptyLayout(), o = {}) => {
  const r = must(placeFreeRunway(l, g, o));
  return { layout: r.layout, id: r.created[0]! };
};

describe('自由形の配置 placeFreeRunway / ByEnds（S4）', () => {
  it('配置すると自由形のデータができ、新しい項目は指定したときだけ書かれる', () => {
    const { layout, id } = place({ start: { x: 10.25, y: 20.5 }, headingDeg: 37.5, lengthM: 2345.678 });
    expect(id).toBe('rwy_1');
    expect(layout.runways[id]).toEqual({
      id,
      name: '',
      alignment: 'free',
      start: { x: 10.25, y: 20.5 },
      headingDeg: 37.5,
      lengthM: 2345.678,
      surfaceWidthM: 45,
      buildState: 'operational',
    });
    const withOpts = place({ start: { x: 0, y: 0 }, headingDeg: 0, lengthM: 1000 }, emptyLayout(), { dims: { resaLengthM: 120 }, designatorSuffix: 'C', surfaceWidthM: 60, name: 'A' });
    expect(withOpts.layout.runways[withOpts.id]).toMatchObject({ dims: { resaLengthM: 120 }, designatorSuffix: 'C', surfaceWidthM: 60, name: 'A' });
    // 空の dims は書かない
    const e = place({ start: { x: 0, y: 0 }, headingDeg: 0, lengthM: 1000 }, emptyLayout(), { dims: {} });
    expect('dims' in e.layout.runways[e.id]!).toBe(false);
  });

  it('方位は正規化される（-10 → 350、360 → 0、725 → 5）', () => {
    for (const [i, o] of [[-10, 350], [360, 0], [725, 5], [-0, 0]] as const) {
      const { layout, id } = place({ start: { x: 0, y: 0 }, headingDeg: i, lengthM: 1000 });
      expect(freeOf(layout, id).headingDeg).toBe(o);
    }
  });

  it('不正な値は INVALID_VALUE（NaN・無限・範囲外の長さ・不正な幅・負の dims・始点の NaN）', () => {
    const l = emptyLayout();
    const ok0 = { start: { x: 0, y: 0 }, headingDeg: 0, lengthM: 1000 };
    const bad = (g: object, o = {}) => placeFreeRunway(l, { ...ok0, ...g }, o);
    expect(bad({ headingDeg: NaN })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({ headingDeg: Infinity })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({ lengthM: NaN })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({ lengthM: 24 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({ lengthM: 1e6 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({ start: { x: NaN, y: 0 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({}, { surfaceWidthM: 50 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({}, { dims: { resaLengthM: -1 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({}, { dims: { unknown: 1 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({}, { designatorSuffix: 'X' })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(bad({ lengthM: 25 })).toMatchObject({ ok: true });
  });

  it('任意の角度の長さ: |end − start| × 25 = lengthM（相対誤差 1e-12）。0〜359° の整数と 0.25° 刻み', () => {
    for (let k = 0; k < 360 * 4; k++) {
      const deg = k / 4;
      const { layout, id } = place({ start: { x: 3.3, y: -7.7 }, headingDeg: deg, lengthM: 3456.789 });
      const a = runwayAxis(freeOf(layout, id));
      const len = Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y) * TILE_M;
      expect(Math.abs(len - 3456.789) / 3456.789).toBeLessThan(1e-12);
    }
  });

  it('始点・終点からの配置: 方位と長さが端点から決まり、端点がそのまま復元される', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 30, y: 40 };
    const r = must(placeFreeRunwayByEnds(emptyLayout(), a, b));
    const f = freeOf(r.layout, r.created[0]!);
    expect(f.lengthM).toBeCloseTo(50 * TILE_M, 9);
    expect(f.headingDeg).toBeCloseTo(180 - (Math.atan2(30, 40) * 180) / Math.PI, 9);
    const ax = runwayAxis(f);
    expect(Math.hypot(ax.end.x - b.x, ax.end.y - b.y)).toBeLessThan(POS_EPS_T);
    // 東（+x）と北（-y）
    expect(freeOf(must(placeFreeRunwayByEnds(emptyLayout(), a, { x: 10, y: 0 })).layout, 'rwy_1').headingDeg).toBe(90);
    expect(freeOf(must(placeFreeRunwayByEnds(emptyLayout(), a, { x: 0, y: -10 })).layout, 'rwy_1').headingDeg).toBe(0);
    // 同じ点・短すぎる・NaN は拒否
    expect(placeFreeRunwayByEnds(emptyLayout(), a, a)).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(placeFreeRunwayByEnds(emptyLayout(), a, { x: 0.5, y: 0 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(placeFreeRunwayByEnds(emptyLayout(), a, { x: NaN, y: 0 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
});

describe('自由形の回転・幾何の変更（S4）', () => {
  it('中点まわりの回転（rotateEntity、既定 15°）: 中点と長さを保ち、方位が +15°', () => {
    const { layout, id } = place({ start: { x: 10.5, y: 20.25 }, headingDeg: 350, lengthM: 3000 });
    const before = freeOf(layout, id);
    const r = freeOf(must(rotateEntity(layout, id)).layout, id);
    expect(r.headingDeg).toBe(5);
    expect(r.lengthM).toBe(3000);
    const m0 = mid(before);
    const m1 = mid(r);
    expect(Math.hypot(m0.x - m1.x, m0.y - m1.y)).toBeLessThan(1e-12);
    // 指定刻み
    expect(freeOf(must(rotateEntity(layout, id, 5)).layout, id).headingDeg).toBe(355);
    expect(freeOf(must(rotateEntity(layout, id, -350)).layout, id).headingDeg).toBe(0);
    expect(rotateEntity(layout, id, NaN)).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(rotateEntity(layout, id, 0)).toEqual({ ok: false, reason: 'NO_CHANGE' });
  });

  it('360 回の 1° 回転で元に戻る（中点は毎回保たれ、始点は POS_EPS_T 以内）', () => {
    const { layout, id } = place({ start: { x: 17.3, y: 41.9 }, headingDeg: 10, lengthM: 3333.3 });
    const first = freeOf(layout, id);
    const m0 = mid(first);
    let l = layout;
    for (let i = 0; i < 360; i++) {
      l = must(rotateEntity(l, id, 1)).layout;
      const m = mid(freeOf(l, id));
      expect(Math.hypot(m.x - m0.x, m.y - m0.y)).toBeLessThan(1e-9);
    }
    const last = freeOf(l, id);
    expect(last.headingDeg).toBe(10);
    expect(last.lengthM).toBe(3333.3);
    expect(Math.hypot(last.start.x - first.start.x, last.start.y - first.start.y)).toBeLessThan(POS_EPS_T);
  });

  it('従来形の回転は従来どおり 45°（stepDeg は無視）', () => {
    const { layout, created } = must(placeRunway(emptyLayout(), { x: 10, y: 20 }, 90, 40));
    const r = must(rotateEntity(layout, created[0]!, 7)).layout.runways[created[0]!] as RunwayGrid8;
    expect(r.heading).toBe(135);
    expect(r.alignment).toBeUndefined();
    expect('headingDeg' in r).toBe(false);
  });

  it('setFreeRunwayGeometry: 基準点（中点・始点・終点）が固定される', () => {
    const { layout, id } = place({ start: { x: 5, y: 5 }, headingDeg: 60, lengthM: 2000 });
    const r0 = freeOf(layout, id);
    const a0 = runwayAxis(r0);
    const byStart = freeOf(must(setFreeRunwayGeometry(layout, id, { headingDeg: 100, lengthM: 3000 }, 'start')).layout, id);
    expect(byStart.start).toEqual(r0.start);
    expect([byStart.headingDeg, byStart.lengthM]).toEqual([100, 3000]);
    const byEnd = freeOf(must(setFreeRunwayGeometry(layout, id, { headingDeg: 100, lengthM: 3000 }, 'end')).layout, id);
    const e = runwayAxis(byEnd).end;
    expect(Math.hypot(e.x - a0.end.x, e.y - a0.end.y)).toBeLessThan(1e-12);
    const byMid = freeOf(must(setFreeRunwayGeometry(layout, id, { lengthM: 3000 }, 'mid')).layout, id);
    const m = mid(byMid);
    const m0 = mid(r0);
    expect(Math.hypot(m.x - m0.x, m.y - m0.y)).toBeLessThan(1e-12);
    expect(byMid.headingDeg).toBe(60);
    // 変化なし・不正な値・従来形・存在しない ID
    expect(setFreeRunwayGeometry(layout, id, { headingDeg: 60 })).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect(setFreeRunwayGeometry(layout, id, { lengthM: 5 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(setFreeRunwayGeometry(layout, id, { headingDeg: Infinity })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(setFreeRunwayGeometry(layout, 'rwy_99', { headingDeg: 1 })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    const g = must(placeRunway(emptyLayout(), { x: 1, y: 1 }, 90, 10));
    expect(setFreeRunwayGeometry(g.layout, g.created[0]!, { headingDeg: 1 })).toEqual({ ok: false, reason: 'NOT_SUPPORTED' });
  });

  it('setFreeRunwayGeometry: 端点の指定（終点だけ = 始点固定、始点だけ = 終点固定、併用不可）', () => {
    const { layout, id } = place({ start: { x: 0, y: 0 }, headingDeg: 90, lengthM: 1000 });
    const a = runwayAxis(freeOf(layout, id));
    const endOnly = freeOf(must(setFreeRunwayGeometry(layout, id, { end: { x: 0, y: 40 } })).layout, id);
    expect(endOnly.start).toEqual({ x: 0, y: 0 });
    expect(endOnly.headingDeg).toBe(180);
    expect(endOnly.lengthM).toBe(40 * TILE_M);
    const startOnly = freeOf(must(setFreeRunwayGeometry(layout, id, { start: { x: 20, y: 20 } })).layout, id);
    const e = runwayAxis(startOnly).end;
    expect(Math.hypot(e.x - a.end.x, e.y - a.end.y)).toBeLessThan(1e-9);
    expect(startOnly.start).toEqual({ x: 20, y: 20 });
    expect(setFreeRunwayGeometry(layout, id, { end: { x: 5, y: 5 }, headingDeg: 3 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(setFreeRunwayGeometry(layout, id, { end: { x: 0.1, y: 0 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('移動・複製: 自由形は start を delta だけ動かす／複製は進行方向に直交して 12 タイル', () => {
    const { layout, id } = place({ start: { x: 5.5, y: 5.5 }, headingDeg: 33, lengthM: 2000 });
    const moved = freeOf(must(moveEntity(layout, id, { x: 3, y: -2 })).layout, id);
    expect(moved.start).toEqual({ x: 8.5, y: 3.5 });
    expect(moved.headingDeg).toBe(33);
    const east = place({ start: { x: 0, y: 0 }, headingDeg: 90, lengthM: 2000 });
    expect(defaultDuplicateOffset(east.layout, east.id)).toEqual({ x: 0, y: 12 });
    const dup = must(duplicateEntity(east.layout, east.id, { x: 0, y: 12 }));
    expect(freeOf(dup.layout, dup.created[0]!)).toMatchObject({ alignment: 'free', headingDeg: 90, lengthM: 2000, start: { x: 0, y: 12 } });
    const north = place({ start: { x: 0, y: 0 }, headingDeg: 0, lengthM: 2000 });
    expect(defaultDuplicateOffset(north.layout, north.id)).toEqual({ x: 12, y: 0 });
  });
});

describe('従来形 ↔ 自由形の変換（S4。明示操作のみ）', () => {
  it('従来形 → 自由形: 8 方位 × 長さで、始点・方位・ID・名前・幅は同じ、長さは丸めない実長、dims は書かない', () => {
    for (const h of HEADINGS) {
      for (const len of [3, 17, 40, 200]) {
        const p = must(placeRunway(emptyLayout(), { x: 9, y: 11 }, h, len, { surfaceWidthM: 60, name: 'N', buildState: 'planned' }));
        const id = p.created[0]!;
        const g = p.layout.runways[id] as RunwayGrid8;
        const c = must(convertRunwayToFree(p.layout, id)).layout;
        const f = freeOf(c, id);
        expect(f).toEqual({ id, name: 'N', alignment: 'free', start: { x: 9, y: 11 }, headingDeg: h, lengthM: runwayAxis(g).lengthT * TILE_M, surfaceWidthM: 60, buildState: 'planned' });
        expect('dims' in f).toBe(false);
        const ga = runwayAxis(g);
        const fa = runwayAxis(f);
        expect(Math.hypot(fa.end.x - ga.end.x, fa.end.y - ga.end.y)).toBeLessThan(1e-9);
        expect(fa.lengthM).toBe(ga.lengthM);
        // 入口・端のノード位置（整数タイル）が変換後も滑走路上にあり、位置 t も一致する
        for (let i = 0; i <= len; i += Math.max(1, Math.floor(len / 5))) {
          const step = { x: Math.round(ga.dir.x * (h % 90 === 0 ? 1 : Math.SQRT2)), y: Math.round(ga.dir.y * (h % 90 === 0 ? 1 : Math.SQRT2)) };
          const pt = { x: 9 + step.x * i, y: 11 + step.y * i };
          const tg = positionOnRunway(g, pt);
          const tf = positionOnRunway(f, pt);
          expect(tg).not.toBeNull();
          expect(tf).not.toBeNull();
          expect(Math.abs(tg! - tf!)).toBeLessThan(1e-9);
        }
        expect(positionOnRunway(f, g.start)).toBe(0);
        expect(positionOnRunway(f, ga.end)).toBe(1);
      }
    }
  });

  it('変換した 200 ステップの斜めでも保存検査（長さの範囲）を通る', () => {
    const p = must(placeRunway(emptyLayout(80, 60), { x: 0, y: 0 }, 135, 200));
    const c = must(convertRunwayToFree(p.layout, p.created[0]!)).layout;
    expect(checkLayout(c)).toEqual([]);
  });

  it('変換は対象の滑走路だけを変え、ほかの滑走路・誘導路・元のレイアウトは変えない。自由形への変換は NO_CHANGE', () => {
    let l = emptyLayout();
    const a = must(placeRunway(l, { x: 5, y: 5 }, 90, 30));
    l = a.layout;
    const b = must(placeRunway(l, { x: 5, y: 15 }, 90, 30));
    const snapshot = JSON.stringify(b.layout);
    const c = must(convertRunwayToFree(b.layout, a.created[0]!)).layout;
    expect(JSON.stringify(b.layout)).toBe(snapshot);
    expect(c.runways[b.created[0]!]).toEqual(b.layout.runways[b.created[0]!]);
    expect(convertRunwayToFree(c, a.created[0]!)).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect(convertRunwayToFree(c, 'rwy_99')).toEqual({ ok: false, reason: 'NOT_FOUND' });
    // Undo で元に戻る
    const h = commit(createHistory(b.layout), c);
    expect(undo(h).present).toBe(b.layout);
  });

  it('自由形 → グリッド: 恒等な丸めなら位置は変わらず、変換 → 戻しで元の従来形と完全一致（8 方位 × 長さ）', () => {
    for (const h of HEADINGS) {
      for (const len of [1, 5, 40, 200]) {
        const p = must(placeRunway(emptyLayout(80, 60), { x: 4, y: 6 }, h, len, { surfaceWidthM: 30 }));
        const id = p.created[0]!;
        const back = must(snapRunwayToGrid(must(convertRunwayToFree(p.layout, id)).layout, id)).layout;
        expect(back.runways[id]).toEqual(p.layout.runways[id]);
        expect(JSON.stringify(back.runways[id])).toBe(JSON.stringify(p.layout.runways[id]));
      }
    }
  });

  it('自由形 → グリッド: 方位は 45° の倍数・始点は整数・長さはステップ数に丸め、dims は捨てる', () => {
    const { layout, id } = place({ start: { x: 3.4, y: 5.6 }, headingDeg: 100, lengthM: 30 * TILE_M + 7 }, emptyLayout(), { dims: { resaLengthM: 10 }, designatorSuffix: 'R' });
    const g = must(snapRunwayToGrid(layout, id)).layout.runways[id] as RunwayGrid8;
    expect(g).toEqual({ id, name: '', start: { x: 3, y: 6 }, heading: 90, length: 30, surfaceWidthM: 45, buildState: 'operational', designatorSuffix: 'R' });
    expect('dims' in g).toBe(false);
    expect('alignment' in g).toBe(false);
    // 斜め: 長さは √2 タイルのステップ数
    const d = place({ start: { x: 0, y: 0 }, headingDeg: 133, lengthM: 10 * Math.SQRT2 * TILE_M * 1.04 });
    expect((must(snapRunwayToGrid(d.layout, d.id)).layout.runways[d.id] as RunwayGrid8).length).toBe(10);
    // 359.9° → 0°、極端に短い → 1
    const n = place({ start: { x: 0, y: 0 }, headingDeg: 359.9, lengthM: 25 });
    expect(must(snapRunwayToGrid(n.layout, n.id)).layout.runways[n.id]).toMatchObject({ heading: 0, length: 1 });
    // 従来形・存在しない ID
    const gp = must(placeRunway(emptyLayout(), { x: 1, y: 1 }, 0, 5));
    expect(snapRunwayToGrid(gp.layout, gp.created[0]!)).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect(snapRunwayToGrid(gp.layout, 'rwy_9')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('updateEntity（自由形）と空港の設定（S4）', () => {
  it('共通項目・dims・番号の接尾辞を更新でき、heading / length は INVALID_VALUE', () => {
    const { layout, id } = place({ start: { x: 5, y: 5 }, headingDeg: 60, lengthM: 2000 });
    const u = (patch: Record<string, unknown>) => updateEntity(layout, id, patch);
    expect(freeOf(must(u({ name: 'X', surfaceWidthM: 60, buildState: 'planned', designatorSuffix: 'L' })).layout, id)).toMatchObject({ name: 'X', surfaceWidthM: 60, buildState: 'planned', designatorSuffix: 'L' });
    expect(u({ heading: 90 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(u({ length: 10 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(u({ surfaceWidthM: 50 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(u({ designatorSuffix: 'Z' })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    const withDims = must(u({ dims: { resaLengthM: 150, elevationStartM: -3 } })).layout;
    expect(freeOf(withDims, id).dims).toEqual({ resaLengthM: 150, elevationStartM: -3 });
    expect('dims' in freeOf(must(updateEntity(withDims, id, { dims: {} })).layout, id)).toBe(false);
    expect(u({ dims: { resaLengthM: -1 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(u({ dims: { bogus: 1 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(u({ dims: 5 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('headingDeg・lengthM の更新は中点を保つ（併用可）。変化なしは NO_CHANGE', () => {
    const { layout, id } = place({ start: { x: 5, y: 5 }, headingDeg: 60, lengthM: 2000 });
    const m0 = mid(freeOf(layout, id));
    const r = freeOf(must(updateEntity(layout, id, { headingDeg: 200, lengthM: 3500, name: 'Q' })).layout, id);
    expect(r).toMatchObject({ headingDeg: 200, lengthM: 3500, name: 'Q' });
    const m1 = mid(r);
    expect(Math.hypot(m1.x - m0.x, m1.y - m0.y)).toBeLessThan(1e-12);
    expect(updateEntity(layout, id, { headingDeg: 60 })).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect(updateEntity(layout, id, { lengthM: -5 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('従来形にも designatorSuffix を設定できる（明示の上書き）', () => {
    const p = must(placeRunway(emptyLayout(), { x: 1, y: 1 }, 90, 20));
    const r = must(updateEntity(p.layout, p.created[0]!, { designatorSuffix: 'R' })).layout.runways[p.created[0]!];
    expect(r!.designatorSuffix).toBe('R');
    expect(updateEntity(p.layout, p.created[0]!, { designatorSuffix: 'W' })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('updateLayoutSettings: 偏角と ruleSet。既定値のときはキーを書かない', () => {
    const l = emptyLayout();
    const a = must(updateLayoutSettings(l, { magneticVariationDeg: -7.5, ruleSet: 'realistic' })).layout;
    expect(a.magneticVariationDeg).toBe(-7.5);
    expect(a.ruleSet).toBe('realistic');
    const b = must(updateLayoutSettings(a, { magneticVariationDeg: 0, ruleSet: 'classic' })).layout;
    expect('magneticVariationDeg' in b).toBe(false);
    expect('ruleSet' in b).toBe(false);
    expect(b).toEqual(l);
    expect(updateLayoutSettings(l, { magneticVariationDeg: 181 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(updateLayoutSettings(l, { magneticVariationDeg: NaN })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(updateLayoutSettings(l, { ruleSet: 'x' as 'classic' })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(updateLayoutSettings(l, {})).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect(updateLayoutSettings(l, { magneticVariationDeg: 0, ruleSet: 'classic' })).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect('magneticVariationDeg' in must(updateLayoutSettings(a, { magneticVariationDeg: null })).layout).toBe(false);
    expect(checkLayout(a)).toEqual([]);
  });

  it('従来形の操作は新しい項目を書かない（JSON が従来と同じ）', () => {
    const p = must(placeRunway(emptyLayout(), { x: 10, y: 20 }, 90, 40));
    const id = p.created[0]!;
    let l = must(rotateEntity(p.layout, id)).layout;
    l = must(moveEntity(l, id, { x: 1, y: 1 })).layout;
    l = must(updateEntity(l, id, { length: 30 })).layout;
    const dup = must(duplicateEntity(l, id, { x: 0, y: 12 }));
    const json = JSON.stringify(dup.layout.runways);
    for (const k of ['alignment', 'headingDeg', 'lengthM', 'dims', 'designatorSuffix']) expect(json).not.toContain(`"${k}"`);
  });
});
