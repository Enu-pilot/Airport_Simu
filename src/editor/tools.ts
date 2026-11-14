import { FACILITY_SPECS, STAND_DIMS, TERMINAL_AREA_SPECS } from '../core/model/catalog';
import type { AirportLayout, FacilityKind, Heading, TerminalAreaKind } from '../core/model/types';
import { snapToOctant, sameTile, distance, type Tile } from '../core/geometry/vec';
import type { WorldPoint } from '../core/geometry/frames';
import { bearingToDir, dirToBearing, normalizeDeg } from '../core/geometry/angle';
import { classifySegmentIntersection } from '../core/geometry/segment';
import { FREE_RUNWAY_MAX_M, FREE_RUNWAY_MIN_M, TILE_M } from '../core/model/catalog';
import { isFreeRunway, type RunwayFree } from '../core/model/types';
import { runwayAxis } from '../core/layout/runway';
import { rotatedDims } from '../core/layout/footprint';
import {
  addRoadPath,
  addTaxiwayPath,
  moveEntity,
  placeFacility,
  placeFreeRunway,
  placeRunway,
  placeStand,
  setFreeRunwayGeometry,
  placeTerminalArea,
  purchaseLand,
  type OpResult,
} from '../core/layout/operations';
import type { EditorState, ToolId, ToolOptions } from './store';

/**
 * ツールの状態（選択中のツール・オプション・カーソル位置・進行中の操作）から、
 * 「確定したらどうなるか」のプレビュー操作を作る。描画はこの結果をそのまま表示し、
 * 確定時は同じ操作を履歴に積む（プレビューと確定結果が食い違わない）。
 */

export const areaKindOf = (tool: ToolId): TerminalAreaKind | null =>
  tool.startsWith('area:') ? (tool.slice('area:'.length) as TerminalAreaKind) : null;

/** 指定タイルを含むターミナル */
export function terminalAt(layout: AirportLayout, tile: Tile): string | null {
  for (const f of Object.values(layout.facilities)) {
    if (f.kind !== 'terminal') continue;
    const d = rotatedDims(f.w, f.h, f.rotation);
    if (tile.x >= f.origin.x && tile.x < f.origin.x + d.w && tile.y >= f.origin.y && tile.y < f.origin.y + d.h) return f.id;
  }
  return null;
}

export const facilityKindOf = (tool: ToolId): FacilityKind | null =>
  tool.startsWith('facility:') ? (tool.slice('facility:'.length) as FacilityKind) : null;

const HEADING_BY_DIR: Record<string, Heading> = {
  '0,-1': 0,
  '1,-1': 45,
  '1,0': 90,
  '1,1': 135,
  '0,1': 180,
  '-1,1': 225,
  '-1,0': 270,
  '-1,-1': 315,
};

/** 始点とカーソルから滑走路の向きと長さを決める（8方向スナップ） */
export function runwayFromDrag(start: Tile, cursor: Tile): { heading: Heading; length: number } | null {
  const end = snapToOctant(start, cursor);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(Math.abs(dx), Math.abs(dy));
  if (length === 0) return null;
  const heading = HEADING_BY_DIR[`${Math.sign(dx)},${Math.sign(dy)}`]!;
  return { heading, length };
}

// ---------------------------------------------------------------- 自由形の滑走路（Phase 12 S9）

export interface FreeSnapOptions {
  gridSnap: ToolOptions['gridSnap'];
  angleSnapDeg: number;
  lengthSnapM: number;
}

/** 点を格子に吸着する（タイル = 整数、半タイル = 0.5 刻み、なし = そのまま） */
export function snapPointW(p: WorldPoint, mode: FreeSnapOptions['gridSnap']): WorldPoint {
  if (mode === 'off') return { x: p.x, y: p.y };
  const k = mode === 'half' ? 2 : 1;
  // -0 を作らない
  return { x: Math.round(p.x * k) / k + 0, y: Math.round(p.y * k) / k + 0 };
}

/** 方位（度）を stepDeg の倍数に吸着する。stepDeg = 0 は吸着なし。結果は [0, 360) */
export function snapAngleDeg(deg: number, stepDeg: number): number {
  const d = normalizeDeg(deg);
  if (!(stepDeg > 0)) return d;
  return normalizeDeg(Math.round(d / stepDeg) * stepDeg);
}

/** 長さ（m）を stepM の倍数に吸着する（最小 1 ステップ）。stepM = 0 は吸着なし */
export function snapLengthM(m: number, stepM: number): number {
  if (!(stepM > 0)) return m;
  return Math.max(stepM, Math.round(m / stepM) * stepM);
}

/**
 * 始点とカーソル（どちらも World 座標）から自由形の滑走路の始点・真方位・実長を決める。
 * 始点は格子に、方位は angleSnapDeg に、長さは lengthSnapM に吸着する。長さが 0 なら null。
 */
export function freeRunwayFromDrag(
  startW: WorldPoint,
  cursorW: WorldPoint,
  opts: FreeSnapOptions,
): { start: WorldPoint; headingDeg: number; lengthM: number } | null {
  const start = snapPointW(startW, opts.gridSnap);
  const dx = cursorW.x - start.x;
  const dy = cursorW.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 0)) return null;
  const headingDeg = snapAngleDeg(dirToBearing(dx, dy), opts.angleSnapDeg);
  const lengthM = snapLengthM(dist * TILE_M, opts.lengthSnapM);
  if (!(lengthM > 0)) return null;
  return { start, headingDeg, lengthM };
}

/**
 * 数値入力での配置（方位・長さ・基準点）。クリックした点（格子に吸着）が始点または中点。
 */
export function freeRunwayFromNumeric(
  clickW: WorldPoint,
  headingDeg: number,
  lengthM: number,
  anchor: 'start' | 'mid',
  gridSnap: FreeSnapOptions['gridSnap'],
): { start: WorldPoint; headingDeg: number; lengthM: number } {
  const p = snapPointW(clickW, gridSnap);
  const h = normalizeDeg(headingDeg);
  if (anchor === 'start') return { start: p, headingDeg: h, lengthM };
  const dir = bearingToDir(h);
  const half = lengthM / TILE_M / 2;
  return { start: { x: p.x - dir.x * half, y: p.y - dir.y * half }, headingDeg: h, lengthM };
}

/** ハンドル（端）のドラッグから、setFreeRunwayGeometry に渡す変更と基準点を決める */
export function freeHandleGeometry(
  r: RunwayFree,
  which: 'start' | 'end',
  cursorW: WorldPoint,
  fixOpposite: boolean,
  opts: Pick<FreeSnapOptions, 'angleSnapDeg' | 'lengthSnapM'>,
): { patch: { headingDeg?: number; lengthM?: number; start?: WorldPoint; end?: WorldPoint }; pivot: 'mid' | 'start' | 'end' } | null {
  const axis = runwayAxis(r);
  if (fixOpposite) {
    // 反対の端を固定。つかんだ端はカーソルへ（方位・長さの吸着後の位置）
    const fixed = which === 'end' ? axis.start : axis.end;
    const dx = cursorW.x - fixed.x;
    const dy = cursorW.y - fixed.y;
    if (!(Math.hypot(dx, dy) > 0)) return null;
    const away = dirToBearing(dx, dy);
    const lengthM = Math.min(FREE_RUNWAY_MAX_M, Math.max(FREE_RUNWAY_MIN_M, snapLengthM(Math.hypot(dx, dy) * TILE_M, opts.lengthSnapM)));
    const h = snapAngleDeg(away, opts.angleSnapDeg);
    // 始点側をつかんでいるときは、固定した終点から見た方位が（始点→終点）の逆
    const headingDeg = which === 'end' ? h : normalizeDeg(h + 180);
    return { patch: { headingDeg, lengthM }, pivot: which === 'end' ? 'start' : 'end' };
  }
  // 中点まわりに回転（長さは保つ）。つかんだ端が中点から見てカーソルの向きになる
  const mid = { x: axis.start.x + (axis.dir.x * axis.lengthT) / 2, y: axis.start.y + (axis.dir.y * axis.lengthT) / 2 };
  const dx = cursorW.x - mid.x;
  const dy = cursorW.y - mid.y;
  if (!(Math.hypot(dx, dy) > 0)) return null;
  const h = snapAngleDeg(dirToBearing(dx, dy), opts.angleSnapDeg);
  return { patch: { headingDeg: which === 'end' ? h : normalizeDeg(h + 180) }, pivot: 'mid' };
}

/** 選択中の滑走路（自由形）の端にカーソルが近いか。px = 許容（タイル単位） */
export function handleAt(layout: AirportLayout, selection: string | null, w: WorldPoint, tolTiles: number): 'start' | 'end' | null {
  const r = selection ? layout.runways[selection] : undefined;
  if (!r || !isFreeRunway(r)) return null;
  const a = runwayAxis(r);
  const ds = distance(w, a.start);
  const de = distance(w, a.end);
  if (Math.min(ds, de) > tolTiles) return null;
  return de <= ds ? 'end' : 'start';
}

/** 2点からなる矩形（両端を含む） */
export function rectFromDrag(a: Tile, b: Tile): { origin: Tile; w: number; h: number } {
  return {
    origin: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    w: Math.abs(a.x - b.x) + 1,
    h: Math.abs(a.y - b.y) + 1,
  };
}

/** クリック配置の原点（カーソルが施設の中央に来るように） */
export function centeredOrigin(cursor: Tile, w: number, h: number): Tile {
  return { x: cursor.x - Math.floor((w - 1) / 2), y: cursor.y - Math.floor((h - 1) / 2) };
}

/** 経路ツールの次の点（直前の点から8方向にスナップ） */
export function nextPathPoint(points: readonly Tile[], cursor: Tile): Tile {
  const last = points[points.length - 1];
  return last ? snapToOctant(last, cursor) : cursor;
}

/** 誘導路の吸着の許容（タイル）。ゲーム値。斜めの線ではタイル中心どうしが √2 離れるので 0.5 では届かない */
export const CENTERLINE_SNAP_TILES = 0.75;

/**
 * 誘導路ツールの次の点。8 方向に吸着した線が自由形の滑走路の中心線とカーソルの近く（CENTERLINE_SNAP_TILES 以内）で
 * 交わるなら、その交点（実数）にする。誘導路を 8 方向に保ったまま、斜めの滑走路上に入口を作れる。
 * 自由形が無い・交わらないときは `nextPathPoint` と同じ。
 */
export function nextTaxiPoint(layout: AirportLayout, points: readonly Tile[], cursor: Tile): Tile {
  const base = nextPathPoint(points, cursor);
  const last = points[points.length - 1];
  if (!last || sameTile(last, base)) return base;
  let best: { p: WorldPoint; d: number } | null = null;
  for (const r of Object.values(layout.runways)) {
    if (!isFreeRunway(r)) continue;
    const ax = runwayAxis(r);
    const u = { x: Math.sign(base.x - last.x), y: Math.sign(base.y - last.y) };
    const far = { x: last.x + u.x * 4096, y: last.y + u.y * 4096 };
    const hit = classifySegmentIntersection(last, far, ax.start, ax.end);
    if (hit.kind !== 'point') continue;
    const d = distance(hit.p, base);
    if (d <= CENTERLINE_SNAP_TILES && (!best || d < best.d)) best = { p: hit.p, d };
  }
  return best ? { x: best.p.x, y: best.p.y } : base;
}

/** 自由形ツールのプレビュー（ドラッグ中の始点→カーソル、数値入力ならカーソル位置に置いた結果） */
function computeFreeRunwayPreview(s: Pick<EditorState, 'options' | 'hoverW' | 'draft'>, layout: AirportLayout): Preview | null {
  const { options, hoverW, draft } = s;
  if (!hoverW) return null;
  const place = { surfaceWidthM: options.runwayWidth, buildState: options.buildState };
  let g: { start: WorldPoint; headingDeg: number; lengthM: number } | null;
  if (options.freeInput === 'numeric') {
    g = freeRunwayFromNumeric(hoverW, options.freeHeadingDeg, options.freeLengthM, options.freeAnchor, options.gridSnap);
  } else {
    if (draft?.kind !== 'freeRunway') return null;
    g = freeRunwayFromDrag(draft.start, hoverW, options);
  }
  if (!g) return null;
  const result = placeFreeRunway(layout, g, place);
  return result.ok ? { result, ghostIds: [...result.created] } : null;
}

export interface Preview {
  result: OpResult;
  /** プレビュー中の（新規・移動中の）エンティティ */
  ghostIds: string[];
}

/** 現在のツール状態でのプレビュー。表示すべきものが無ければ null */
export function computePreview(s: Pick<EditorState, 'tool' | 'options' | 'hover' | 'hoverW' | 'draft' | 'history' | 'interiorLevel'>): Preview | null {
  const layout: AirportLayout = s.history.present;
  const { hover, draft, options, tool } = s;
  const wrap = (result: OpResult, extra: string[] = []): Preview | null =>
    result.ok ? { result, ghostIds: [...result.created, ...extra] } : null;

  if (draft?.kind === 'rwyHandle') {
    const r = layout.runways[draft.id];
    if (!r || !isFreeRunway(r) || !s.hoverW) return null;
    const g = freeHandleGeometry(r, draft.which, s.hoverW, draft.fixOpposite, options);
    if (!g) return null;
    return wrap(setFreeRunwayGeometry(layout, draft.id, g.patch, g.pivot), [draft.id]);
  }
  if (draft?.kind === 'move') {
    if (!hover) return null;
    const delta = { x: hover.x - draft.start.x, y: hover.y - draft.start.y };
    if (delta.x === 0 && delta.y === 0) return null;
    return wrap(moveEntity(layout, draft.id, delta), [draft.id]);
  }
  if (!hover) return null;

  switch (tool) {
    case 'runway': {
      if (options.runwayAlignment === 'free') return computeFreeRunwayPreview(s, layout);
      if (draft?.kind !== 'runway') return null;
      const rw = runwayFromDrag(draft.start, hover);
      if (!rw) return null;
      return wrap(placeRunway(layout, draft.start, rw.heading, rw.length, { surfaceWidthM: options.runwayWidth, buildState: options.buildState }));
    }
    case 'taxiway':
    case 'road': {
      const points = draft?.kind === 'path' ? [...draft.points] : [];
      const next = tool === 'taxiway' ? nextTaxiPoint(layout, points, hover) : nextPathPoint(points, hover);
      if (points.length === 0 || sameTile(points[points.length - 1]!, next)) return null;
      points.push(next);
      return tool === 'taxiway'
        ? wrap(addTaxiwayPath(layout, points, { widthClass: options.taxiWidth, oneWay: options.oneWay, buildState: options.buildState }))
        : wrap(addRoadPath(layout, points, { roadClass: options.roadClass, oneWay: options.oneWay, buildState: options.buildState, level: options.roadLevel, capacityPerHour: options.roadCapacityPerHour }));
    }
    case 'land': {
      // 土地購入: ドラッグした矩形（クリックは1タイル）の未取得地
      const start = draft?.kind === 'rect' ? draft.start : hover;
      return wrap(purchaseLand(layout, start, hover));
    }
    case 'stand': {
      const { w, d } = STAND_DIMS[options.standSize];
      const dims = rotatedDims(w, d, options.rotation);
      return wrap(placeStand(layout, centeredOrigin(hover, dims.w, dims.h), options.standSize, options.rotation, options.buildState));
    }
    default: {
      const areaKind = areaKindOf(tool);
      if (areaKind) {
        // 内部エリア: ターミナル内でドラッグ（クリックは既定サイズ）
        const start = draft?.kind === 'rect' ? draft.start : hover;
        const terminal = terminalAt(layout, start);
        if (!terminal) return null;
        const spec = TERMINAL_AREA_SPECS[areaKind];
        const r = draft?.kind === 'rect' ? rectFromDrag(draft.start, hover) : { origin: hover, w: spec.defaultW, h: spec.defaultH };
        return wrap(placeTerminalArea(layout, terminal, s.interiorLevel, areaKind, r.origin, { w: Math.max(r.w, spec.minW), h: Math.max(r.h, spec.minH) }));
      }
      const kind = facilityKindOf(tool);
      if (!kind) return null;
      const spec = FACILITY_SPECS[kind];
      if (spec.dragPlace && draft?.kind === 'rect') {
        const r = rectFromDrag(draft.start, hover);
        return wrap(
          placeFacility(layout, kind, r.origin, {
            w: Math.max(r.w, spec.minW),
            h: Math.max(r.h, spec.minH),
            buildState: options.buildState,
            mapLevel: options.roadLevel,
            ...(options.interiorParentId ? { parentFacilityId: options.interiorParentId, floorIndex: options.interiorFloorIndex } : {}),
            ...(kind === 'railStation' ? { props: { level: options.roadLevel } } : {}),
          }),
        );
      }
      const dims = rotatedDims(spec.defaultW, spec.defaultH, options.rotation);
      return wrap(
        placeFacility(layout, kind, centeredOrigin(hover, dims.w, dims.h), {
          rotation: options.rotation,
          buildState: options.buildState,
          mapLevel: options.roadLevel,
          ...(options.interiorParentId ? { parentFacilityId: options.interiorParentId, floorIndex: options.interiorFloorIndex } : {}),
          ...(kind === 'railStation' ? { props: { level: options.roadLevel } } : {}),
        }),
      );
    }
  }
}
