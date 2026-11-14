import { panBy, screenToTile, screenToWorld, zoomAt } from '../core/geometry/camera';
import { mapToWorld, worldToMap, type WorldPoint } from '../core/geometry/frames';
import { normalizeDeg } from '../core/geometry/angle';
import { sameTile, type Tile, type Vec2 } from '../core/geometry/vec';
import { FACILITY_SPECS } from '../core/model/catalog';
import { entityTypeOf, type AirportLayout } from '../core/model/types';
import { entityTiles } from '../core/layout/footprint';
import {
  addRoadPath,
  addTaxiwayPath,
  deleteEntity,
  duplicateEntity,
  moveEntity,
  rotateEntity,
} from '../core/layout/operations';
import { pickAt } from '../core/layout/pick';
import { actions, applyOp, editorStore, type EditorState } from './store';
import { areaKindOf, computePreview, facilityKindOf, handleAt, nextPathPoint, nextTaxiPoint, snapPointW } from './tools';
import { pickTerminalArea } from '../core/layout/pick';
import { aircraftAt } from '../core/sim/query';
import { SPEED_LEVELS } from '../core/sim/clock';
import { ops } from './simRunner';

/**
 * マップ上のマウス・キーボード操作を編集操作に変換する。DOM には依存せず、
 * 画面座標とボタン・キーの情報だけを受け取る。
 */

const get = editorStore.getState;

let pan: { last: Vec2; moved: boolean; button: number } | null = null;
let spaceHeld = false;
/** 自由形のドラッグを始めた画面位置（クリックとドラッグの区別） */
let downScreen: Vec2 | null = null;

/** ハンドルをつかめる距離（画面のピクセル） */
const HANDLE_PX = 10;
/** これ以上動かして離したら「ドラッグ」とみなす（ピクセル） */
const DRAG_PX = 6;

function tileAt(s: EditorState, screen: Vec2): Tile {
  return screenToTile(s.camera, screen);
}

/** カーソルの World 座標（丸めない） */
function worldAt(s: EditorState, screen: Vec2): WorldPoint {
  return mapToWorld(screenToWorld(s.camera, screen));
}

/** カーソルの World 座標を精密に持つ必要があるか（自由形の配置・ハンドル操作中・自由形の選択中） */
function needsPrecise(s: EditorState): boolean {
  if (s.draft?.kind === 'rwyHandle' || s.draft?.kind === 'freeRunway') return true;
  if (s.tool === 'runway' && s.options.runwayAlignment === 'free') return true;
  return false;
}

/** カーソル移動を状態に反映する */
function updateHover(s: EditorState, screen: Vec2): void {
  const tile = tileAt(s, screen);
  actions.setHover(tile, needsPrecise(s) ? worldAt(s, screen) : undefined);
}

/** 現在のプレビュー（カーソル位置を tile・World 座標として）を確定する */
function commitPreview(tile: Tile, world: WorldPoint, opts: { select?: boolean } = {}): boolean {
  const s = get();
  const preview = computePreview({ ...s, hover: tile, hoverW: world });
  if (!preview) return false;
  return applyOp(preview.result, opts);
}

export function finishPath(): void {
  const s = get();
  if (s.mode === 'operate') return;
  if (s.draft?.kind !== 'path') return;
  const pts = s.draft.points;
  if (pts.length >= 2) {
    const o = s.options;
    applyOp(
      s.tool === 'road'
        ? addRoadPath(s.history.present, pts, { roadClass: o.roadClass, oneWay: o.oneWay, buildState: o.buildState, level: o.roadLevel, capacityPerHour: o.roadCapacityPerHour })
        : addTaxiwayPath(s.history.present, pts, { widthClass: o.taxiWidth, oneWay: o.oneWay, buildState: o.buildState }),
      { quietNoChange: true },
    );
  }
  actions.setDraft(null);
}

export function onPointerDown(screen: Vec2, button: number, mods: { shift?: boolean } = {}): void {
  const s = get();
  if (button === 1 || button === 2 || spaceHeld) {
    pan = { last: screen, moved: false, button };
    return;
  }
  if (button !== 0) return;
  const tile = tileAt(s, screen);
  const wp = worldAt(s, screen);
  actions.setHover(tile, needsPrecise(s) || (s.tool === 'select' && !!s.selection) ? wp : undefined);

  // 運航モード: 機体を優先して選択（レイアウトは表示のみ）
  if (s.mode === 'operate' && s.ops) {
    const world = screenToWorld(s.camera, screen);
    const ac = aircraftAt(s.ops.sim.state, world);
    ops.selectAircraft(ac);
    if (!ac) actions.select((s.overlays.interior ? pickTerminalArea(s.history.present, world, s.interiorLevel) : null) ?? pickAt(s.history.present, world));
    return;
  }

  switch (s.tool) {
    case 'select': {
      const world = screenToWorld(s.camera, screen);
      // 選択中の自由形の端のハンドル: 端をつかんで回転（Shift = 反対の端を固定）
      const handle = handleAt(s.history.present, s.selection, wp, HANDLE_PX / s.camera.zoom);
      if (handle && s.selection) {
        actions.setHover(tile, wp);
        actions.setDraft({ kind: 'rwyHandle', id: s.selection, which: handle, fixOpposite: !!mods.shift });
        return;
      }
      // 内部表示中は、表示している階のエリアを優先して選ぶ
      const id = (s.overlays.interior ? pickTerminalArea(s.history.present, world, s.interiorLevel) : null) ?? pickAt(s.history.present, world);
      actions.select(id);
      if (id) actions.setDraft({ kind: 'move', id, start: tile });
      return;
    }
    case 'runway':
      if (s.options.runwayAlignment === 'free') {
        if (s.options.freeInput === 'numeric') {
          commitPreview(tile, wp, { select: true });
        } else if (s.draft?.kind === 'freeRunway') {
          if (commitPreview(tile, wp, { select: true })) actions.setDraft(null);
        } else {
          downScreen = screen;
          actions.setDraft({ kind: 'freeRunway', start: snapPointW(wp, s.options.gridSnap) });
        }
        return;
      }
      if (s.draft?.kind === 'runway') {
        if (commitPreview(tile, wp, { select: true })) actions.setDraft(null);
      } else {
        actions.setDraft({ kind: 'runway', start: tile });
      }
      return;
    case 'taxiway':
    case 'road': {
      const points = s.draft?.kind === 'path' ? s.draft.points : [];
      const next = s.tool === 'taxiway' ? nextTaxiPoint(s.history.present, points, tile) : nextPathPoint(points, tile);
      if (points.length > 0 && sameTile(points[points.length - 1]!, next)) {
        finishPath();
      } else {
        actions.setDraft({ kind: 'path', points: [...points, next] });
      }
      return;
    }
    case 'land':
      actions.setDraft({ kind: 'rect', start: tile });
      return;
    default: {
      const kind = facilityKindOf(s.tool);
      if (areaKindOf(s.tool)) {
        actions.setDraft({ kind: 'rect', start: tile });
      } else if (kind && FACILITY_SPECS[kind].dragPlace) {
        actions.setDraft({ kind: 'rect', start: tile });
      } else {
        commitPreview(tile, wp);
      }
    }
  }
}

export function onPointerMove(screen: Vec2): void {
  const s = get();
  if (pan) {
    const dx = screen.x - pan.last.x;
    const dy = screen.y - pan.last.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      pan.moved = pan.moved || Math.abs(dx) + Math.abs(dy) > 2;
      actions.setCamera(panBy(s.camera, dx, dy));
      pan.last = screen;
    }
    return;
  }
  updateHover(s, screen);
}

export function onPointerUp(screen: Vec2, button: number): void {
  const s = get();
  if (s.mode === 'operate' && !pan) return;
  if (pan) {
    const wasClick = !pan.moved && pan.button === 2;
    pan = null;
    if (wasClick) {
      // 右クリック: 経路の確定、または進行中の操作の取り消し
      if (s.draft?.kind === 'path' && s.draft.points.length >= 2) finishPath();
      else actions.setDraft(null);
    }
    return;
  }
  if (button !== 0) return;
  const tile = tileAt(s, screen);
  const wp = worldAt(s, screen);
  const d = s.draft;
  if (d?.kind === 'rwyHandle') {
    // 離した位置のプレビューを確定する（ハンドルを動かさなければ何もしない）
    const preview = computePreview({ ...s, hover: tile, hoverW: wp });
    if (preview) applyOp(preview.result, { quietNoChange: true });
    actions.setDraft(null);
  } else if (d?.kind === 'freeRunway') {
    // ドラッグで引いた場合はその場で確定（クリックの場合は2点目のクリックを待つ）
    const dragged = downScreen !== null && Math.hypot(screen.x - downScreen.x, screen.y - downScreen.y) >= DRAG_PX;
    if (dragged && commitPreview(tile, wp, { select: true })) actions.setDraft(null);
  } else if (d?.kind === 'move') {
    if (!sameTile(tile, d.start)) {
      applyOp(moveEntity(s.history.present, d.id, { x: tile.x - d.start.x, y: tile.y - d.start.y }), { quietNoChange: true });
    }
    actions.setDraft(null);
  } else if (d?.kind === 'runway') {
    // ドラッグで引いた場合はその場で確定（クリックの場合は2点目のクリックを待つ）
    if (!sameTile(tile, d.start) && commitPreview(tile, wp, { select: true })) actions.setDraft(null);
  } else if (d?.kind === 'rect') {
    commitPreview(tile, wp, { select: true });
    actions.setDraft(null);
  }
}

export function onDoubleClick(): void {
  finishPath();
}

export function onWheel(screen: Vec2, deltaY: number): void {
  const s = get();
  const factor = Math.exp(-deltaY * 0.0015);
  actions.setCamera(zoomAt(s.camera, screen, s.camera.zoom * factor));
}

export function onPointerLeave(): void {
  if (!pan) actions.setHover(null);
}

export interface KeyInfo {
  key: string;
  ctrl: boolean;
  shift: boolean;
}

/** キー操作。処理した場合 true */
export function onKeyDown(k: KeyInfo): boolean {
  const s = get();
  const key = k.key.toLowerCase();
  const layout = s.history.present;
  if (s.mode === 'operate') return onOperateKey(k);
  if (key === ' ') {
    spaceHeld = true;
    return true;
  }
  if (k.ctrl && key === 'z') {
    if (k.shift) actions.redo();
    else actions.undo();
    return true;
  }
  if (k.ctrl && key === 'y') {
    actions.redo();
    return true;
  }
  if (k.ctrl && key === 'd') {
    if (s.selection) applyOp(duplicateEntity(layout, s.selection), { select: true });
    return true;
  }
  if (k.ctrl) return false;
  switch (key) {
    case 'escape':
      if (s.draft) actions.setDraft(null);
      else if (s.tool !== 'select') actions.setTool('select');
      else actions.select(null);
      return true;
    case 'enter':
      finishPath();
      return true;
    case 'delete':
    case 'backspace':
      if (s.selection) applyOp(deleteEntity(layout, s.selection));
      return true;
    case 'r': {
      // 自由形は angleSnapDeg（0 = 吸着なしのときは 15°）ずつ回す。従来形の滑走路は 45°、そのほかは 90°
      const step = s.options.angleSnapDeg > 0 ? s.options.angleSnapDeg : 15;
      if (s.tool === 'select' && s.selection) applyOp(rotateEntity(layout, s.selection, step));
      else if (s.tool === 'runway' && s.options.runwayAlignment === 'free') actions.setOption('freeHeadingDeg', normalizeDeg(s.options.freeHeadingDeg + step));
      else actions.rotateTool();
      return true;
    }
    case 'v':
      actions.setTool('select');
      return true;
    case 'arrowup':
    case 'arrowdown':
    case 'arrowleft':
    case 'arrowright': {
      const step = k.shift ? 10 : 1;
      const delta = {
        x: key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0,
        y: key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0,
      };
      if (s.selection) applyOp(moveEntity(layout, s.selection, delta));
      else actions.setCamera({ ...s.camera, x: s.camera.x + delta.x * 4, y: s.camera.y + delta.y * 4 });
      return true;
    }
    default:
      return false;
  }
}

/** 運航モードのキー操作: Space 一時停止、1〜5 時間倍率、Esc 選択解除、矢印 パン */
function onOperateKey(k: KeyInfo): boolean {
  const s = get();
  const key = k.key.toLowerCase();
  if (k.ctrl) return false;
  if (key === ' ') {
    ops.togglePause();
    return true;
  }
  const level = Number(key);
  if (Number.isInteger(level) && level >= 1 && level < SPEED_LEVELS.length) {
    ops.setSpeed(SPEED_LEVELS[level]!.speed);
    return true;
  }
  if (key === 'escape') {
    ops.selectAircraft(null);
    actions.select(null);
    return true;
  }
  if (key.startsWith('arrow')) {
    const d = 4 * (k.shift ? 10 : 1);
    actions.setCamera({
      ...s.camera,
      x: s.camera.x + (key === 'arrowleft' ? -d : key === 'arrowright' ? d : 0) / 4,
      y: s.camera.y + (key === 'arrowup' ? -d : key === 'arrowdown' ? d : 0) / 4,
    });
    return true;
  }
  return false;
}

export function onKeyUp(k: KeyInfo): void {
  if (k.key === ' ') spaceHeld = false;
}

/** エンティティの中心（世界座標）。カメラのフォーカスに使う */
export function entityCenter(layout: AirportLayout, id: string): Vec2 | null {
  const type = entityTypeOf(id);
  if (type === 'taxiNode' || type === 'roadNode') {
    const n = layout.taxiNodes[id] ?? layout.roadNodes[id];
    return n ? worldToMap(n.pos) : null;
  }
  const tiles = entityTiles(layout, id);
  if (tiles.length === 0) return null;
  const xs = tiles.map((t) => t.x);
  const ys = tiles.map((t) => t.y);
  return { x: (Math.min(...xs) + Math.max(...xs) + 1) / 2, y: (Math.min(...ys) + Math.max(...ys) + 1) / 2 };
}

export function focusEntity(id: string): void {
  const c = entityCenter(get().history.present, id);
  if (c) actions.focus(c, id);
  else actions.select(id);
}
