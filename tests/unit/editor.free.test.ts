import { beforeEach, describe, expect, it } from 'vitest';
import { bearingToDir } from '../../src/core/geometry/angle';
import { runwayAxis } from '../../src/core/layout/runway';
import { designatorsOf } from '../../src/core/layout/designators';
import { placeFreeRunway, placeRunway } from '../../src/core/layout/operations';
import { isFreeRunway, type RunwayFree } from '../../src/core/model/types';
import {
  CENTERLINE_SNAP_TILES,
  freeHandleGeometry,
  freeRunwayFromDrag,
  freeRunwayFromNumeric,
  handleAt,
  nextTaxiPoint,
  snapAngleDeg,
  snapLengthM,
  snapPointW,
} from '../../src/editor/tools';
import { actions, editorStore } from '../../src/editor/store';
import { onKeyDown, onPointerDown, onPointerMove, onPointerUp } from '../../src/editor/input';
import { createHistory } from '../../src/core/editor/history';
import { emptyLayout, must } from './helpers';

const SNAP = { gridSnap: 'tile', angleSnapDeg: 1, lengthSnapM: 10 } as const;

describe('自由形ツール: 吸着', () => {
  it('格子: タイル・半タイル・なし', () => {
    expect(snapPointW({ x: 3.4, y: -2.6 }, 'tile')).toEqual({ x: 3, y: -3 });
    expect(snapPointW({ x: 3.4, y: 2.6 }, 'half')).toEqual({ x: 3.5, y: 2.5 });
    expect(snapPointW({ x: 3.41, y: 2.62 }, 'off')).toEqual({ x: 3.41, y: 2.62 });
    expect(Object.is(snapPointW({ x: -0.2, y: 0.2 }, 'tile').x, -0)).toBe(false);
  });
  it('方位: 刻み 0（なし）・1・5・15・45 と 360 の折り返し', () => {
    expect(snapAngleDeg(33.3, 0)).toBeCloseTo(33.3, 12);
    expect(snapAngleDeg(33.6, 1)).toBe(34);
    expect(snapAngleDeg(33.6, 5)).toBe(35);
    expect(snapAngleDeg(352.6, 5)).toBe(355);
    expect(snapAngleDeg(358, 5)).toBe(0);
    expect(snapAngleDeg(100, 15)).toBe(105);
    expect(snapAngleDeg(22.4, 45)).toBe(0);
    expect(snapAngleDeg(22.6, 45)).toBe(45);
    expect(snapAngleDeg(-10, 1)).toBe(350);
  });
  it('長さ: 刻み 0（なし）・10・50・100、最小 1 ステップ', () => {
    expect(snapLengthM(1234, 0)).toBe(1234);
    expect(snapLengthM(1234, 10)).toBe(1230);
    expect(snapLengthM(1234, 50)).toBe(1250);
    expect(snapLengthM(1234, 100)).toBe(1200);
    expect(snapLengthM(3, 10)).toBe(10);
  });
});

describe('自由形ツール: ドラッグ・数値からの配置', () => {
  it('始点→カーソルで方位・長さが決まる（東向き 40 タイル = 1000 m）', () => {
    const g = freeRunwayFromDrag({ x: 10.2, y: 20.1 }, { x: 50, y: 20 }, SNAP)!;
    expect(g.start).toEqual({ x: 10, y: 20 });
    expect(g.headingDeg).toBe(90);
    expect(g.lengthM).toBe(1000);
  });
  it('斜め（30°）: 角度の吸着が効く・吸着なしならそのまま', () => {
    const dir = bearingToDir(30);
    const cur = { x: 10 + dir.x * 60.3, y: 10 + dir.y * 60.3 };
    const a = freeRunwayFromDrag({ x: 10, y: 10 }, cur, { gridSnap: 'tile', angleSnapDeg: 5, lengthSnapM: 0 })!;
    expect(a.headingDeg).toBe(30);
    const b = freeRunwayFromDrag({ x: 10, y: 10 }, { x: 10 + dir.x * 60 + 0.7, y: 10 + dir.y * 60 }, { gridSnap: 'off', angleSnapDeg: 0, lengthSnapM: 0 })!;
    expect(b.headingDeg).not.toBe(30);
    expect(b.start).toEqual({ x: 10, y: 10 });
  });
  it('長さ 0 は null', () => {
    expect(freeRunwayFromDrag({ x: 5, y: 5 }, { x: 5, y: 5 }, SNAP)).toBeNull();
  });
  it('数値: 始点基準と中点基準（中点基準は中点がクリック位置）', () => {
    const a = freeRunwayFromNumeric({ x: 30, y: 30 }, 45, 1500, 'start', 'tile');
    expect(a.start).toEqual({ x: 30, y: 30 });
    const m = freeRunwayFromNumeric({ x: 30, y: 30 }, 90, 1000, 'mid', 'tile');
    expect(m.start.x).toBeCloseTo(10, 12);
    expect(m.start.y).toBeCloseTo(30, 12);
    expect(freeRunwayFromNumeric({ x: 30, y: 30 }, 450, 1000, 'start', 'tile').headingDeg).toBe(90);
  });
});

function freeRunway(headingDeg: number, lengthM = 1500): RunwayFree {
  const l = must(placeFreeRunway(emptyLayout(200, 200), { start: { x: 50, y: 50 }, headingDeg, lengthM }));
  return l.layout.runways[l.created[0]!] as RunwayFree;
}

describe('自由形ツール: ハンドル', () => {
  it('端をカーソルの向きへ: 中点と長さを保って回転する', () => {
    const r = freeRunway(90);
    const before = runwayAxis(r);
    const mid0 = { x: (before.start.x + before.end.x) / 2, y: (before.start.y + before.end.y) / 2 };
    // 東向きの終点側をつかんで、中点の真南東（135°）へ
    const g = freeHandleGeometry(r, 'end', { x: mid0.x + 10, y: mid0.y + 10 }, false, { angleSnapDeg: 1, lengthSnapM: 0 })!;
    expect(g.pivot).toBe('mid');
    expect(g.patch.headingDeg).toBe(135);
    expect(g.patch.lengthM).toBeUndefined();
  });
  it('始点側をつかむと、反対向きの方位になる（始点が中点から見てカーソルの向き）', () => {
    const r = freeRunway(90);
    const a = runwayAxis(r);
    const mid = { x: (a.start.x + a.end.x) / 2, y: (a.start.y + a.end.y) / 2 };
    // 始点（西側）を北（中点の真上）へ → 終点は南 → 方位 180
    const g = freeHandleGeometry(r, 'start', { x: mid.x, y: mid.y - 20 }, false, { angleSnapDeg: 1, lengthSnapM: 0 })!;
    expect(g.patch.headingDeg).toBe(180);
  });
  it('Shift（反対の端を固定）: 方位と長さが変わる', () => {
    const r = freeRunway(90, 1000);
    const a = runwayAxis(r);
    const g = freeHandleGeometry(r, 'end', { x: a.start.x, y: a.start.y + 40 }, true, { angleSnapDeg: 1, lengthSnapM: 10 })!;
    expect(g.pivot).toBe('start');
    expect(g.patch.headingDeg).toBe(180);
    expect(g.patch.lengthM).toBe(1000);
    const g2 = freeHandleGeometry(r, 'start', { x: a.end.x - 20, y: a.end.y }, true, { angleSnapDeg: 1, lengthSnapM: 10 })!;
    expect(g2.pivot).toBe('end');
    expect(g2.patch.headingDeg).toBe(90);
    expect(g2.patch.lengthM).toBe(500);
  });
  it('端の当たり判定は自由形の選択中だけ', () => {
    const l = must(placeFreeRunway(emptyLayout(200, 200), { start: { x: 50, y: 50 }, headingDeg: 90, lengthM: 1500 }));
    const id = l.created[0]!;
    expect(handleAt(l.layout, id, { x: 50.2, y: 50 }, 0.5)).toBe('start');
    expect(handleAt(l.layout, id, { x: 110, y: 50.1 }, 0.5)).toBe('end');
    expect(handleAt(l.layout, id, { x: 80, y: 50 }, 0.5)).toBeNull();
    expect(handleAt(l.layout, null, { x: 50, y: 50 }, 0.5)).toBeNull();
    const g = must(placeRunway(emptyLayout(200, 200), { x: 50, y: 50 }, 90, 10));
    expect(handleAt(g.layout, g.created[0]!, { x: 50, y: 50 }, 0.5)).toBeNull();
  });
});

describe('誘導路の中心線への吸着', () => {
  it('8 方向の線が自由形の中心線と交わる点（実数）を次の点にする', () => {
    // 北東向き 30° の滑走路。始点 (50, 80) から北へ引く線は、滑走路の中心線と実数の点で交わる
    const l = must(placeFreeRunway(emptyLayout(200, 200), { start: { x: 40, y: 90 }, headingDeg: 30, lengthM: 2500 })).layout;
    const ax = runwayAxis(Object.values(l.runways)[0] as RunwayFree);
    // x = 50 の垂線との交点
    const t = (50 - ax.start.x) / ax.dir.x;
    const hit = { x: 50, y: ax.start.y + ax.dir.y * t };
    const cursor = { x: 50, y: Math.round(hit.y) };
    const p = nextTaxiPoint(l, [{ x: 50, y: 100 }], cursor);
    expect(p.x).toBeCloseTo(50, 9);
    expect(p.y).toBeCloseTo(hit.y, 9);
    expect(Number.isInteger(p.y)).toBe(false);
    // カーソルが遠ければ吸着しない
    const far = nextTaxiPoint(l, [{ x: 50, y: 100 }], { x: 50, y: Math.round(hit.y) + Math.ceil(CENTERLINE_SNAP_TILES) + 2 });
    expect(Number.isInteger(far.y)).toBe(true);
  });
  it('従来形だけなら従来どおり（整数）', () => {
    const l = must(placeRunway(emptyLayout(200, 200), { x: 40, y: 90 }, 45, 30)).layout;
    expect(nextTaxiPoint(l, [{ x: 50, y: 100 }], { x: 50, y: 85 })).toEqual({ x: 50, y: 85 });
  });
});

describe('入力（ストア経由）', () => {
  const CAM = { x: 0, y: 0, zoom: 10 };
  // 画面座標 = (World + 0.5 - cam) × zoom
  const px = (wx: number, wy: number) => ({ x: (wx + 0.5 - CAM.x) * CAM.zoom, y: (wy + 0.5 - CAM.y) * CAM.zoom });

  beforeEach(() => {
    editorStore.setState({
      history: createHistory(emptyLayout(200, 200)),
      camera: CAM,
      viewSize: { w: 2000, h: 2000 },
      selection: null,
      draft: null,
      mode: 'build',
      tool: 'select',
      charges: { past: [], future: [] },
    });
    actions.setOption('runwayAlignment', 'free');
    actions.setOption('gridSnap', 'tile');
    actions.setOption('angleSnapDeg', 1);
    actions.setOption('lengthSnapM', 10);
    actions.setOption('freeInput', 'drag');
  });
  const runways = () => Object.values(editorStore.getState().history.present.runways);

  it('ドラッグで自由形を置く（始点→終点、30° 方向）', () => {
    actions.setTool('runway');
    const dir = bearingToDir(30);
    const a = px(20, 100);
    const b = px(20 + dir.x * 60, 100 + dir.y * 60);
    onPointerMove(a);
    onPointerDown(a, 0);
    onPointerMove(b);
    onPointerUp(b, 0);
    expect(runways()).toHaveLength(1);
    const r = runways()[0]!;
    expect(isFreeRunway(r)).toBe(true);
    if (!isFreeRunway(r)) return;
    expect(r.headingDeg).toBe(30);
    expect(r.start).toEqual({ x: 20, y: 100 });
    expect(r.lengthM).toBeGreaterThan(1450);
    expect(editorStore.getState().draft).toBeNull();
    expect(editorStore.getState().selection).toBe(r.id);
  });

  it('既定（グリッド 8 方向）では従来形が置かれる', () => {
    actions.setOption('runwayAlignment', 'grid8');
    actions.setTool('runway');
    const a = px(20, 100);
    const b = px(50, 100);
    onPointerMove(a);
    onPointerDown(a, 0);
    onPointerMove(b);
    onPointerUp(b, 0);
    const r = runways()[0]!;
    expect(isFreeRunway(r)).toBe(false);
  });

  it('数値入力: 方位 37°・長さ 1800 m・中点基準でクリックした位置に置く', () => {
    actions.setOption('freeInput', 'numeric');
    actions.setOption('freeHeadingDeg', 37);
    actions.setOption('freeLengthM', 1800);
    actions.setOption('freeAnchor', 'mid');
    actions.setTool('runway');
    const p = px(100, 100);
    onPointerMove(p);
    onPointerDown(p, 0);
    const r = runways()[0] as RunwayFree;
    expect(r.headingDeg).toBe(37);
    expect(r.lengthM).toBe(1800);
    const ax = runwayAxis(r);
    expect((ax.start.x + ax.end.x) / 2).toBeCloseTo(100, 9);
    expect((ax.start.y + ax.end.y) / 2).toBeCloseTo(100, 9);
    expect(designatorsOf(r, editorStore.getState().history.present).text[0]).toBe('04');
  });

  it('クリックだけでは確定せず、2 点目のクリックで確定する', () => {
    actions.setTool('runway');
    const a = px(20, 100);
    const b = px(60, 100);
    onPointerMove(a);
    onPointerDown(a, 0);
    onPointerUp(a, 0);
    expect(runways()).toHaveLength(0);
    expect(editorStore.getState().draft?.kind).toBe('freeRunway');
    onPointerMove(b);
    onPointerDown(b, 0);
    onPointerUp(b, 0);
    expect(runways()).toHaveLength(1);
  });

  it('選択した自由形の端をドラッグすると中点まわりに回る（Undo で戻る）', () => {
    const l = must(placeFreeRunway(editorStore.getState().history.present, { start: { x: 60, y: 100 }, headingDeg: 90, lengthM: 1000 }));
    editorStore.setState({ history: createHistory(l.layout), selection: l.created[0]! });
    const id = l.created[0]!;
    // 終点 (100, 100) → 中点 (80, 100) から見て真南（半径 20）へ引く → 方位 180
    const from = px(100, 100);
    const to = px(80, 120);
    onPointerMove(from);
    onPointerDown(from, 0);
    expect(editorStore.getState().draft?.kind).toBe('rwyHandle');
    onPointerMove(to);
    onPointerUp(to, 0);
    const r = editorStore.getState().history.present.runways[id] as RunwayFree;
    expect(r.headingDeg).toBe(180);
    expect(r.lengthM).toBe(1000);
    const ax = runwayAxis(r);
    expect((ax.start.x + ax.end.x) / 2).toBeCloseTo(80, 9);
    actions.undo();
    expect((editorStore.getState().history.present.runways[id] as RunwayFree).headingDeg).toBe(90);
  });

  it('R キー: 自由形は angleSnapDeg ずつ、0 のときは 15°。従来形は 45°', () => {
    const l = must(placeFreeRunway(editorStore.getState().history.present, { start: { x: 60, y: 100 }, headingDeg: 90, lengthM: 1000 }));
    editorStore.setState({ history: createHistory(l.layout), selection: l.created[0]! });
    const id = l.created[0]!;
    actions.setOption('angleSnapDeg', 5);
    onKeyDown({ key: 'r', ctrl: false, shift: false });
    expect((editorStore.getState().history.present.runways[id] as RunwayFree).headingDeg).toBe(95);
    actions.setOption('angleSnapDeg', 0);
    onKeyDown({ key: 'r', ctrl: false, shift: false });
    expect((editorStore.getState().history.present.runways[id] as RunwayFree).headingDeg).toBe(110);
    const g = must(placeRunway(emptyLayout(200, 200), { x: 60, y: 100 }, 90, 20));
    editorStore.setState({ history: createHistory(g.layout), selection: g.created[0]! });
    onKeyDown({ key: 'r', ctrl: false, shift: false });
    expect(editorStore.getState().history.present.runways[g.created[0]!]).toMatchObject({ heading: 135 });
  });
});
