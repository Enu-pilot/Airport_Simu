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
import { interiorPlacementProblem, terminalAreaLevelProblem, type PlacementProblem } from '../core/layout/levelRules';
import { facilityLevel } from '../core/model/levels';
import { validateOrthogonalPolygon } from '../core/geometry/polygon';
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

/** 確定しようとした操作の結果（失敗も含む）。失敗の理由を画面に出すために使う */
export interface OpAttempt {
  result: OpResult;
  /** プレビュー中の（新規・移動中の）エンティティのうち、created 以外 */
  extra: string[];
  /** 失敗したとき、エディタ側で導いた配置できない理由（コアの失敗コードは変えない。1-04） */
  problem?: PlacementProblem;
}

type PreviewState = Pick<EditorState, 'tool' | 'options' | 'hover' | 'hoverW' | 'draft' | 'history' | 'interiorLevel'>;

/** 現在のツール状態でのプレビュー。表示すべきものが無ければ（失敗のときも）null */
export function computePreview(s: PreviewState): Preview | null {
  const a = computeOp(s);
  return a && a.result.ok ? { result: a.result, ghostIds: [...a.result.created, ...a.extra] } : null;
}

/** 現在のツール状態で確定したときの操作。失敗の結果も返す（何もする対象が無ければ null） */
export function computeOp(s: PreviewState): OpAttempt | null {
  const layout: AirportLayout = s.history.present;
  const { hover, draft, options, tool } = s;
  const wrap = (result: OpResult, extra: string[] = [], problem?: PlacementProblem | null): OpAttempt | null => ({ result, extra, ...(!result.ok && problem ? { problem } : {}) });

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
      if (options.runwayAlignment === 'free') {
        const p = computeFreeRunwayPreview(s, layout);
        return p && p.result.ok ? { result: p.result, extra: p.ghostIds.filter((id) => !(p.result.ok && p.result.created.includes(id))) } : null;
      }
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
        : wrap(addRoadPath(layout, points, { roadClass: options.roadClass, oneWay: options.oneWay, buildState: options.buildState, level: options.roadLevel, ...(options.roadCapacityPerHour > 0 ? { capacityPerHour: options.roadCapacityPerHour } : {}) }));
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
        // 表示中の階は絶対階層なので、対象ターミナルの建物内階（表示階 − ターミナルの地図階層）に変換して渡す
        const areaLevel = s.interiorLevel - facilityLevel(layout.facilities[terminal]!);
        return wrap(
          placeTerminalArea(layout, terminal, areaLevel, areaKind, r.origin, { w: Math.max(r.w, spec.minW), h: Math.max(r.h, spec.minH) }),
          [],
          terminalAreaLevelProblem(layout, terminal, areaLevel),
        );
      }
      const kind = facilityKindOf(tool);
      if (!kind) return null;
      const spec = FACILITY_SPECS[kind];
      if (spec.dragPlace && draft?.kind === 'rect') {
        const r = rectFromDrag(draft.start, hover);
        const w = Math.max(r.w, spec.minW);
        const h = Math.max(r.h, spec.minH);
        return wrap(
          placeFacility(layout, kind, r.origin, {
            w,
            h,
            buildState: options.buildState,
            mapLevel: options.roadLevel,
            ...(options.interiorParentId ? { parentFacilityId: options.interiorParentId, floorIndex: options.interiorFloorIndex } : {}),
            ...(kind === 'railStation' ? { props: { level: options.roadLevel } } : {}),
          }),
          [],
          interiorProblem(layout, options, r.origin, w, h),
        );
      }
      const dims = rotatedDims(spec.defaultW, spec.defaultH, options.rotation);
      const origin = centeredOrigin(hover, dims.w, dims.h);
      return wrap(
        placeFacility(layout, kind, origin, {
          rotation: options.rotation,
          buildState: options.buildState,
          mapLevel: options.roadLevel,
          ...(options.interiorParentId ? { parentFacilityId: options.interiorParentId, floorIndex: options.interiorFloorIndex } : {}),
          ...(kind === 'railStation' ? { props: { level: options.roadLevel } } : {}),
        }),
        [],
        interiorProblem(layout, options, origin, dims.w, dims.h),
      );
    }
  }
}

// ---------------------------------------------------------------- 外形（フットプリント）編集（5-15 T3）
// 頂点はタイル角の座標（Map フレーム）。以下の純関数が編集操作の正本で、
// 確定は core/layout/operations の setFacilityFootprint を通す（検証はそちらと validateOrthogonalPolygon）。

/** 座標（Map フレーム）から tol 以内にある頂点の番号。なければ -1 */
export function footprintVertexAt(points: readonly Tile[], mp: { x: number; y: number }, tol: number): number {
  let best = -1;
  let bd = Infinity;
  points.forEach((p, i) => {
    const d = Math.hypot(mp.x - p.x, mp.y - p.y);
    if (d <= tol && d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/**
 * 頂点を角（タイル角へ吸着した座標）へ動かす。隣接頂点は、共有している座標（縦辺なら x、
 * 横辺なら y）だけを追随させるため、辺の直交は保たれる。自己交差などの不正は確定時の検証で弾く。
 */
export function moveFootprintVertex(points: readonly Tile[], index: number, corner: Tile): Tile[] {
  const n = points.length;
  const out = points.map((p) => ({ ...p }));
  const old = points[index];
  if (!old) return out;
  out[index] = { x: corner.x, y: corner.y };
  const prev = (index + n - 1) % n;
  const next = (index + 1) % n;
  if (prev !== index && points[prev]) {
    if (points[prev]!.x === old.x) out[prev] = { ...out[prev]!, x: corner.x };
    else if (points[prev]!.y === old.y) out[prev] = { ...out[prev]!, y: corner.y };
  }
  if (next !== index && next !== prev && points[next]) {
    if (points[next]!.x === old.x) out[next] = { ...out[next]!, x: corner.x };
    else if (points[next]!.y === old.y) out[next] = { ...out[next]!, y: corner.y };
  }
  return out;
}

/** 辺の近くを指したときの頂点挿入（挿入先の配列位置と、辺上に吸着した点）。端点そのもの・tol 外は null */
export function footprintEdgeInsert(points: readonly Tile[], mp: { x: number; y: number }, tol: number): { index: number; point: Tile } | null {
  let best: { index: number; point: Tile; d: number } | null = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    let point: Tile;
    let d: number;
    if (a.x === b.x && a.y !== b.y) {
      const y = Math.round(mp.y);
      if (y <= Math.min(a.y, b.y) || y >= Math.max(a.y, b.y)) continue;
      point = { x: a.x, y };
      d = Math.abs(mp.x - a.x);
    } else if (a.y === b.y && a.x !== b.x) {
      const x = Math.round(mp.x);
      if (x <= Math.min(a.x, b.x) || x >= Math.max(a.x, b.x)) continue;
      point = { x, y: a.y };
      d = Math.abs(mp.y - a.y);
    } else continue;
    if (d <= tol && (!best || d < best.d)) best = { index: i + 1, point, d };
  }
  return best;
}

/**
 * 頂点を削除する。削除後に直交ポリゴンとして成立しない場合は、隣接頂点をつなぐ
 * エルボー点への置き換えを試し、それでも成立しなければ null（削除できない）。
 */
export function deleteFootprintVertex(points: readonly Tile[], index: number): Tile[] | null {
  if (points.length <= 4) return null;
  const n = points.length;
  const a = points[(index + n - 1) % n]!;
  const b = points[(index + 1) % n]!;
  const without = points.filter((_, i) => i !== index);
  if (validateOrthogonalPolygon(without).length === 0) return without;
  for (const elbow of [{ x: b.x, y: a.y }, { x: a.x, y: b.y }]) {
    if (points.some((p, i) => i !== index && p.x === elbow.x && p.y === elbow.y)) continue;
    const cand = points.map((p, i) => (i === index ? { ...elbow } : { ...p }));
    if (validateOrthogonalPolygon(cand).length === 0) return cand;
  }
  return null;
}

/** 建物内に置くとき、その階・範囲で置けない理由（1-04）。独立施設なら null */
function interiorProblem(layout: AirportLayout, options: ToolOptions, origin: Tile, w: number, h: number): PlacementProblem | null {
  if (!options.interiorParentId) return null;
  const tiles: Tile[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) tiles.push({ x: origin.x + dx, y: origin.y + dy });
  return interiorPlacementProblem(layout, options.interiorParentId, options.interiorFloorIndex, tiles);
}
