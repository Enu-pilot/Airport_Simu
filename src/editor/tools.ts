import { FACILITY_SPECS, STAND_DIMS } from '../core/model/catalog';
import type { AirportLayout, FacilityKind, Heading } from '../core/model/types';
import { snapToOctant, sameTile, type Tile } from '../core/geometry/vec';
import { rotatedDims } from '../core/layout/footprint';
import {
  addRoadPath,
  addTaxiwayPath,
  moveEntity,
  placeFacility,
  placeRunway,
  placeStand,
  type OpResult,
} from '../core/layout/operations';
import type { EditorState, ToolId } from './store';

/**
 * ツールの状態（選択中のツール・オプション・カーソル位置・進行中の操作）から、
 * 「確定したらどうなるか」のプレビュー操作を作る。描画はこの結果をそのまま表示し、
 * 確定時は同じ操作を履歴に積む（プレビューと確定結果が食い違わない）。
 */

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

export interface Preview {
  result: OpResult;
  /** プレビュー中の（新規・移動中の）エンティティ */
  ghostIds: string[];
}

/** 現在のツール状態でのプレビュー。表示すべきものが無ければ null */
export function computePreview(s: Pick<EditorState, 'tool' | 'options' | 'hover' | 'draft' | 'history'>): Preview | null {
  const layout: AirportLayout = s.history.present;
  const { hover, draft, options, tool } = s;
  const wrap = (result: OpResult, extra: string[] = []): Preview | null =>
    result.ok ? { result, ghostIds: [...result.created, ...extra] } : null;

  if (draft?.kind === 'move') {
    if (!hover) return null;
    const delta = { x: hover.x - draft.start.x, y: hover.y - draft.start.y };
    if (delta.x === 0 && delta.y === 0) return null;
    return wrap(moveEntity(layout, draft.id, delta), [draft.id]);
  }
  if (!hover) return null;

  switch (tool) {
    case 'runway': {
      if (draft?.kind !== 'runway') return null;
      const rw = runwayFromDrag(draft.start, hover);
      if (!rw) return null;
      return wrap(placeRunway(layout, draft.start, rw.heading, rw.length, { surfaceWidthM: options.runwayWidth, buildState: options.buildState }));
    }
    case 'taxiway':
    case 'road': {
      const points = draft?.kind === 'path' ? [...draft.points] : [];
      const next = nextPathPoint(points, hover);
      if (points.length === 0 || sameTile(points[points.length - 1]!, next)) return null;
      points.push(next);
      return tool === 'taxiway'
        ? wrap(addTaxiwayPath(layout, points, { widthClass: options.taxiWidth, oneWay: options.oneWay, buildState: options.buildState }))
        : wrap(addRoadPath(layout, points, { roadClass: options.roadClass, oneWay: options.oneWay, buildState: options.buildState }));
    }
    case 'stand': {
      const { w, d } = STAND_DIMS[options.standSize];
      const dims = rotatedDims(w, d, options.rotation);
      return wrap(placeStand(layout, centeredOrigin(hover, dims.w, dims.h), options.standSize, options.rotation, options.buildState));
    }
    default: {
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
          }),
        );
      }
      const dims = rotatedDims(spec.defaultW, spec.defaultH, options.rotation);
      return wrap(
        placeFacility(layout, kind, centeredOrigin(hover, dims.w, dims.h), {
          rotation: options.rotation,
          buildState: options.buildState,
        }),
      );
    }
  }
}
