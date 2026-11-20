import { FACILITY_SPECS, GATE_CONNECTOR_MAX_TILES, GATE_MAX_STAND_DISTANCE, type FootprintLayer } from '../model/catalog';
import type { CompanyState } from '../economy/company';
import { compareIds, sortedValues } from '../model/ids';
import { inSite, isBuildable, isSiteEdge } from '../model/site';
import { isFreeRunway, sizeAtLeast, type AirportLayout, type SizeClass } from '../model/types';
import {
  chebyshevDistance,
  cross,
  dot,
  roundPoint,
  segmentIntersection,
  sub,
  tileKey,
  type Tile,
  type Vec2,
} from '../geometry/vec';
import { buildAirsideNetwork, reachableNodes, type AirsideNetwork } from '../airside/network';
import { collectFootprints, facilityTiles, standEntry, standTiles, type FootprintPart } from '../layout/footprint';
import { edgesOfNode, type AnyEdge } from '../layout/network';
import { terminalFloorRange, undergroundFacilityProblem } from '../layout/levelRules';
import { positionOnRunway, runwayAxis, runwayEnd, runwayMaxSize } from '../layout/runway';
import { designatorsOf } from '../layout/designators';
import { holdWalkLimitM, walkToClear, type HoldRunway } from '../layout/holdShort';
import { resolveRunwayDims } from '../layout/runwayAreas';
import { classifySegmentIntersection } from '../geometry/segment';
import { rasterizeSegment } from '../geometry/vec';
import { satOverlapConvex } from '../geometry/polygon';
import { TILE_M } from '../model/catalog';
import type { NetNode, TerminalArea, TerminalAreaKind } from '../model/types';
import { CONNECTOR_DETOUR, DEFAULT_TERMINAL_LINK_CLEARANCE_M, DEFAULT_TERMINAL_LINK_ELEVATION_M, areaRectTiles, buildTerminalModel, type TerminalModel } from '../terminal/model';
import { verifyPortalAccess } from '../terminal/networkGraph';
import { terminalServiceComplexes } from '../terminal/serviceComplex';
import { deckElevationForCode, requiredAircraftClearanceM, requiredClearanceForCode } from '../sim/aircraftTypes';
import { apronBusesOf, connectedTerminal, gateMode } from '../model/gates';
import { DOOR_SILL_M, DOOR_SILL_UPPER_M, PBB_TYPES, type PbbDeck } from '../model/catalog';
import { PBB_ENTRY_RANGE, hasExplicitPbb, pbbDeckOf, pbbGateIdOf, pbbStandIdOf, pbbTypeOf } from '../model/boardingBridge';
import { findPaxRoute } from '../terminal/route';
import { ACCESS_MAX_WALK_TILES, PARKING_MAX_WALK_TILES, buildLandsideNetwork, distanceToTerminal, touchesTilesAtLevel } from '../access/landside';
import { connectorFits, facilityLevel, floorDisplayLabel, roadEdgeLevelValid, DEFAULT_LEVEL_HEIGHT_M } from '../model/levels';
import { findStationTerminalAccess } from '../access/verticalWalk';
import { busGateStatus } from '../terminal/busGateAssignment';
import { featureOn } from '../economy/unlocks';

/**
 * 配置エラー・接続エラーの検出と、各エンティティの運用可否の判定。
 * 結果はコードとパラメータで返し、表示文言は UI 側で組み立てる。
 */

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  // 配置
  | 'OUT_OF_BOUNDS'
  | 'UNBUILDABLE_TERRAIN'
  | 'OVERLAP'
  | 'IN_RUNWAY_STRIP'
  | 'IN_RUNWAY_RESA'
  | 'STAND_NOT_ON_APRON'
  // 滑走路
  | 'RUNWAY_TOO_SHORT'
  | 'RUNWAY_NO_TAXIWAY'
  | 'RUNWAY_PARALLEL_TOO_CLOSE'
  | 'RUNWAY_PARALLEL_DEPENDENT'
  | 'RUNWAY_DESIGNATOR_CONFLICT'
  | 'HOLD_SHORT_TOO_CLOSE'
  // 誘導路
  | 'TAXIWAY_ON_RUNWAY'
  | 'TAXIWAY_CROSSES_RUNWAY_NO_ENTRY'
  | 'TAXIWAY_CROSSING_NO_JUNCTION'
  | 'TAXIWAY_OVERLAP'
  | 'TAXIWAY_ISOLATED'
  | 'TAXIWAY_DEAD_END'
  | 'DUPLICATE_NODE'
  | 'DUPLICATE_EDGE'
  // スポット・ゲート
  | 'STAND_NOT_CONNECTED'
  | 'OVERNIGHT_STAND_REMOVED'
  | 'STAND_NO_RUNWAY_ROUTE'
  | 'STAND_ROUTE_SIZE_LIMITED'
  | 'STAND_ONE_WAY_TRAP'
  | 'STAND_REMOTE'
  | 'STAND_MULTIPLE_GATES'
  | 'GATE_NOT_AT_TERMINAL'
  | 'GATE_TERMINAL_AMBIGUOUS'
  | 'GATE_NO_STAND'
  | 'GATE_STAND_TOO_FAR'
  | 'GATE_CONNECTION_INVALID'
  | 'GATE_CONNECTOR_LONG'
  | 'GATE_CONNECTOR_CROSSES_RUNWAY'
  | 'GATE_BUS_HAS_STAND'
  | 'GATE_BUS_NO_VEHICLES'
  | 'BUS_GATE_NO_REMOTE_STAND'
  | 'STAND_BUS_GATE_INVALID'
  | 'STAND_BUS_NO_GATE'
  | 'STAND_BUS_NO_VEHICLES'
  | 'STAND_TERMINAL_INVALID'
  | 'STAND_TERMINAL_NO_BUS_GATE'
  | 'STAND_TERMINAL_MISMATCH'
  | 'STAND_TERMINAL_IGNORED'
  // 施設・道路
  | 'NO_AIRSIDE_ACCESS'
  | 'TERMINAL_NO_ROAD'
  | 'TERMINAL_NO_GATE'
  | 'PARKING_NO_ROAD'
  | 'ROAD_NO_ENTRANCE'
  | 'ROAD_CROSSING_NO_JUNCTION'
  | 'ROAD_LAYER_CONNECTION_INVALID'
  // 空港アクセス
  | 'ACCESS_NOT_CONNECTED'
  | 'STATION_NO_RAIL'
  | 'ACCESS_ROUTE_UNREACHABLE'
  | 'ACCESS_FAR_FROM_TERMINAL'
  // ターミナル内部
  | 'TERMINAL_AREA_OUTSIDE'
  | 'TERMINAL_AREA_OVERLAP'
  | 'TERMINAL_NO_ENTRANCE'
  | 'TERMINAL_NO_EXIT'
  | 'TERMINAL_NO_CHECKIN'
  | 'TERMINAL_NO_SECURITY'
  | 'TERMINAL_NO_BAGGAGE_CLAIM'
  | 'SECURITY_NOT_CONNECTED'
  | 'INTL_EMIGRATION_UNLINKED'
  | 'INTL_IMMIGRATION_UNLINKED'
  | 'INTL_CUSTOMS_UNLINKED'
  | 'INTL_GATE_ZONE'
  | 'SWING_GATE_ZONE'
  | 'INTL_LOCKED'
  | 'GATE_NO_BOARDING_ACCESS'
  | 'GATE_NO_ARRIVAL_ACCESS'
  | 'GATE_UNREACHABLE'
  | 'GATE_ARRIVAL_NO_EXIT'
  | 'TERMINAL_DEPARTURE_ROUTE'
  | 'GATE_ARRIVAL_NO_BAGGAGE_ROUTE'
  | 'TERMINAL_DEPARTURE_ROUTE_PENDING'
  | 'GATE_ROUTE_PENDING'
  | 'FACILITY_INTERIOR_INVALID'
  | 'FACILITY_INTERIOR_OUTSIDE'
  | 'FACILITY_UNDERGROUND_KIND'
  | 'TERMINAL_UNDERGROUND_ISOLATED'
  | 'GATE_UNDERGROUND_BRIDGE'
  // 搭乗橋（PBB、機能H）
  | 'PBB_GATE_MISMATCH'
  | 'PBB_NOT_ADJACENT'
  | 'PBB_DECK_DUPLICATE'
  | 'PBB_SILL_RANGE'
  | 'PBB_LEGACY_OVERRIDDEN'
  | 'INTERIOR_FACILITY_UNLINKED'
  | 'TERMINAL_LINK_CLEARANCE'
  | 'PORTAL_LEVEL_MISMATCH'
  | 'PORTAL_CONNECTION_PENDING'
  | 'PORTAL_UNREACHABLE'
  // 空港全体
  | 'NO_RUNWAY'
  | 'NO_TOWER'
  | 'NO_GSE_BASE'
  | 'NO_FUEL_FARM'
  | 'NO_MAINTENANCE'
  | 'NO_BAGGAGE_SORT';

export const ISSUE_SEVERITY: Record<IssueCode, Severity> = {
  OUT_OF_BOUNDS: 'error',
  UNBUILDABLE_TERRAIN: 'error',
  OVERLAP: 'error',
  IN_RUNWAY_STRIP: 'error',
  IN_RUNWAY_RESA: 'error',
  STAND_NOT_ON_APRON: 'error',
  RUNWAY_TOO_SHORT: 'error',
  RUNWAY_NO_TAXIWAY: 'error',
  RUNWAY_PARALLEL_TOO_CLOSE: 'warning',
  RUNWAY_PARALLEL_DEPENDENT: 'info',
  RUNWAY_DESIGNATOR_CONFLICT: 'warning',
  HOLD_SHORT_TOO_CLOSE: 'warning',
  TAXIWAY_ON_RUNWAY: 'error',
  TAXIWAY_CROSSES_RUNWAY_NO_ENTRY: 'error',
  TAXIWAY_CROSSING_NO_JUNCTION: 'error',
  TAXIWAY_OVERLAP: 'error',
  TAXIWAY_ISOLATED: 'warning',
  TAXIWAY_DEAD_END: 'info',
  DUPLICATE_NODE: 'error',
  DUPLICATE_EDGE: 'warning',
  STAND_NOT_CONNECTED: 'error',
  STAND_NO_RUNWAY_ROUTE: 'error',
  STAND_ROUTE_SIZE_LIMITED: 'warning',
  STAND_ONE_WAY_TRAP: 'warning',
  STAND_REMOTE: 'info',
  OVERNIGHT_STAND_REMOVED: 'warning',
  STAND_MULTIPLE_GATES: 'warning',
  GATE_NOT_AT_TERMINAL: 'error',
  GATE_TERMINAL_AMBIGUOUS: 'error',
  GATE_NO_STAND: 'warning',
  GATE_STAND_TOO_FAR: 'error',
  GATE_CONNECTION_INVALID: 'error',
  GATE_CONNECTOR_LONG: 'warning',
  GATE_CONNECTOR_CROSSES_RUNWAY: 'warning',
  GATE_BUS_HAS_STAND: 'info',
  GATE_BUS_NO_VEHICLES: 'warning',
  BUS_GATE_NO_REMOTE_STAND: 'info',
  STAND_BUS_GATE_INVALID: 'error',
  STAND_BUS_NO_GATE: 'error',
  STAND_BUS_NO_VEHICLES: 'warning',
  STAND_TERMINAL_INVALID: 'error',
  STAND_TERMINAL_NO_BUS_GATE: 'error',
  STAND_TERMINAL_MISMATCH: 'error',
  STAND_TERMINAL_IGNORED: 'info',
  NO_AIRSIDE_ACCESS: 'warning',
  TERMINAL_NO_ROAD: 'warning',
  TERMINAL_NO_GATE: 'info',
  PARKING_NO_ROAD: 'warning',
  ROAD_NO_ENTRANCE: 'warning',
  ROAD_CROSSING_NO_JUNCTION: 'warning',
  ROAD_LAYER_CONNECTION_INVALID: 'error',
  ACCESS_NOT_CONNECTED: 'warning',
  STATION_NO_RAIL: 'warning',
  ACCESS_ROUTE_UNREACHABLE: 'warning',
  ACCESS_FAR_FROM_TERMINAL: 'warning',
  TERMINAL_AREA_OUTSIDE: 'error',
  TERMINAL_AREA_OVERLAP: 'error',
  TERMINAL_NO_ENTRANCE: 'warning',
  TERMINAL_NO_EXIT: 'warning',
  TERMINAL_NO_CHECKIN: 'warning',
  TERMINAL_NO_SECURITY: 'warning',
  TERMINAL_NO_BAGGAGE_CLAIM: 'warning',
  SECURITY_NOT_CONNECTED: 'warning',
  INTL_EMIGRATION_UNLINKED: 'warning',
  INTL_IMMIGRATION_UNLINKED: 'warning',
  INTL_CUSTOMS_UNLINKED: 'warning',
  INTL_GATE_ZONE: 'warning',
  SWING_GATE_ZONE: 'warning',
  INTL_LOCKED: 'warning',
  GATE_NO_BOARDING_ACCESS: 'warning',
  GATE_NO_ARRIVAL_ACCESS: 'warning',
  GATE_UNREACHABLE: 'warning',
  GATE_ARRIVAL_NO_EXIT: 'warning',
  TERMINAL_DEPARTURE_ROUTE: 'warning',
  GATE_ARRIVAL_NO_BAGGAGE_ROUTE: 'warning',
  TERMINAL_DEPARTURE_ROUTE_PENDING: 'info',
  GATE_ROUTE_PENDING: 'info',
  FACILITY_INTERIOR_INVALID: 'error',
  FACILITY_INTERIOR_OUTSIDE: 'error',
  FACILITY_UNDERGROUND_KIND: 'warning',
  TERMINAL_UNDERGROUND_ISOLATED: 'warning',
  GATE_UNDERGROUND_BRIDGE: 'warning',
  PBB_GATE_MISMATCH: 'error',
  PBB_NOT_ADJACENT: 'error',
  PBB_DECK_DUPLICATE: 'error',
  PBB_SILL_RANGE: 'warning',
  PBB_LEGACY_OVERRIDDEN: 'info',
  INTERIOR_FACILITY_UNLINKED: 'info',
  TERMINAL_LINK_CLEARANCE: 'error',
  PORTAL_LEVEL_MISMATCH: 'warning',
  PORTAL_CONNECTION_PENDING: 'info',
  PORTAL_UNREACHABLE: 'warning',
  NO_RUNWAY: 'warning',
  NO_TOWER: 'warning',
  NO_GSE_BASE: 'warning',
  NO_FUEL_FARM: 'warning',
  NO_MAINTENANCE: 'warning',
  NO_BAGGAGE_SORT: 'warning',
};

export interface Issue {
  /** 決定的なキー（UI のリスト表示用） */
  key: string;
  code: IssueCode;
  severity: Severity;
  /** 問題のあるエンティティID（先頭が主対象）。表示上の強調・運用可否の判定に使う */
  targets: string[];
  /** 文中で参照するだけのエンティティ（例: 保護区域を侵された滑走路）。強調しない */
  related: string[];
  params: Record<string, string | number>;
  /** 問題箇所（マップ上のマーカー位置、タイル） */
  at?: Tile;
}

export type OperabilityReason = 'NOT_COMPLETED' | 'HAS_ERRORS' | 'NO_OPERATIONAL_ROUTE' | 'ISOLATED';

export interface Operability {
  operable: boolean;
  reasons: OperabilityReason[];
}

export interface LayoutAnalysis {
  network: AirsideNetwork;
  terminal: TerminalModel;
  issues: Issue[];
  byTarget: Record<string, Issue[]>;
  operability: Record<string, Operability>;
  counts: Record<Severity, number>;
}

class IssueSink {
  readonly issues: Issue[] = [];
  private readonly seen = new Set<string>();

  add(
    code: IssueCode,
    targets: string[],
    params: Record<string, string | number> = {},
    at?: Tile,
    related: string[] = [],
  ): void {
    const key = `${code}|${targets.join(',')}|${related.join(',')}|${Object.values(params).join(',')}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.issues.push({ key, code, severity: ISSUE_SEVERITY[code], targets, related, params, ...(at ? { at } : {}) });
  }
}

// ---------------------------------------------------------------- 重なり

/** 同じタイルを共有してよいレイヤーの組（順不同） */
const COMPATIBLE = new Set<string>(
  [
    ['taxiway', 'taxiway'],
    ['taxiway', 'apron'],
    ['taxiway', 'strip'],
    ['taxiway', 'roadService'],
    ['apron', 'stand'],
    ['apron', 'gate'],
    ['apron', 'roadService'],
    ['area', 'roadService'],
    ['area', 'roadPublic'],
    ['roadPublic', 'roadPublic'],
    ['roadPublic', 'roadService'],
    ['roadService', 'roadService'],
    ['rail', 'rail'],
    ['rail', 'roadPublic'],
    ['rail', 'roadService'],
    ['strip', 'strip'],
    // 自由形の RESA は着陸帯と同じ扱い（誘導路・着陸帯・RESA と両立）
    ['taxiway', 'resa'],
    ['strip', 'resa'],
    ['resa', 'resa'],
  ].flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]),
);

function edgeTouchesRunway(layout: AirportLayout, edge: AnyEdge, runwayId: string): boolean {
  const r = layout.runways[runwayId];
  const a = layout.taxiNodes[edge.from];
  const b = layout.taxiNodes[edge.to];
  if (!r || !a || !b) return false;
  if (positionOnRunway(r, a.pos) !== null || positionOnRunway(r, b.pos) !== null) return true;
  if (isFreeRunway(r)) {
    const ax = runwayAxis(r);
    return classifySegmentIntersection(a.pos, b.pos, ax.start, ax.end).kind === 'point';
  }
  return segmentIntersection(a.pos, b.pos, r.start, runwayEnd(r)) !== null;
}

/** 交差点ノードを持つ滑走路の組（`${a}|${b}`、a < b）。この組の間の滑走路・着陸帯・RESA の重なりは許す */
const pairKey = (a: string, b: string): string => (compareIds(a, b) <= 0 ? `${a}|${b}` : `${b}|${a}`);

function polyBBox(poly: readonly Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

function checkPlacement(layout: AirportLayout, parts: FootprintPart[], sink: IssueSink, net: AirsideNetwork): void {
  const occ = new Map<string, { ownerId: string; layer: FootprintLayer; minM: number; maxM: number }[]>();
  for (const p of parts) {
    if (p.layer !== 'strip' && p.layer !== 'resa') {
      let outside = 0;
      let unbuildable = 0;
      let firstBad: Tile | undefined;
      for (const t of p.tiles) {
        if (!inSite(layout.site, t.x, t.y)) {
          outside++;
          firstBad ??= t;
        } else if (!isBuildable(layout.site, t.x, t.y)) {
          unbuildable++;
          firstBad ??= t;
        }
      }
      if (outside > 0) sink.add('OUT_OF_BOUNDS', [p.ownerId], { tiles: outside }, firstBad);
      else if (unbuildable > 0) sink.add('UNBUILDABLE_TERRAIN', [p.ownerId], { tiles: unbuildable }, firstBad);
    }
    // 多角形で判定する部分（自由形）は下の多角形の判定で扱う
    if (p.poly) continue;
    const cells = p.occupancy ?? p.tiles.flatMap((tile) =>
      (p.levels ?? [p.level ?? 0]).map((level) => ({
        tile,
        minM: p.vertical?.minM ?? level * DEFAULT_LEVEL_HEIGHT_M,
        maxM: p.vertical?.maxM ?? level * DEFAULT_LEVEL_HEIGHT_M + 0.4,
      })),
    );
    for (const cell of cells) {
      const k = `${p.spaceId ?? 'map'}|${tileKey(cell.tile.x, cell.tile.y)}`;
      const list = occ.get(k) ?? [];
      list.push({ ownerId: p.ownerId, layer: p.layer, minM: cell.minM, maxM: cell.maxM });
      occ.set(k, list);
    }
  }

  const touchCache = new Map<string, boolean>();
  const touches = (edgeId: string, runwayId: string) => {
    const k = `${edgeId}|${runwayId}`;
    let v = touchCache.get(k);
    if (v === undefined) {
      const e = layout.taxiways[edgeId];
      v = !!e && edgeTouchesRunway(layout, e, runwayId);
      touchCache.set(k, v);
    }
    return v;
  };

  // 交差点ノードがある滑走路の組（自由形が関与する組だけ。従来形だけなら空）
  const crossingPairs = new Set((net.crossings ?? []).map((c) => pairKey(c.a, c.b)));
  const RUNWAYISH = new Set<FootprintLayer>(['runway', 'strip', 'resa']);

  /**
   * 階層接続設備の端点（1-02）: 同じノードを共有する道路の辺どうしで、少なくとも一方が接続設備（connectorKind あり、
   * または両端の階が異なる）、かつ重なりがそのノードのタイルであるときは、接続の継ぎ目なので重なりとして扱わない。
   */
  const roadJunction = (aId: string, bId: string, at: Tile): boolean => {
    const a = layout.roads[aId];
    const b = layout.roads[bId];
    if (!a || !b) return false;
    const isConnector = (e: typeof a): boolean =>
      !!e.connectorKind || (layout.roadNodes[e.from]?.level ?? 0) !== (layout.roadNodes[e.to]?.level ?? 0);
    if (!isConnector(a) && !isConnector(b)) return false;
    for (const n of [a.from, a.to]) {
      if (n !== b.from && n !== b.to) continue;
      const node = layout.roadNodes[n];
      if (!node) continue;
      const [t] = rasterizeSegment(node.pos, node.pos);
      if (t && t.x === at.x && t.y === at.y) return true;
    }
    return false;
  };

  /** 2 つの占有の組を判定する（real = 自由形の多角形による判定） */
  const judge = (
    a: { ownerId: string; layer: FootprintLayer },
    b: { ownerId: string; layer: FootprintLayer },
    at: Tile,
    real: boolean,
  ): void => {
    if (a.ownerId === b.ownerId) return;
    if (COMPATIBLE.has(`${a.layer}|${b.layer}`)) return;
    if (roadJunction(a.ownerId, b.ownerId, at)) return;
    if (a.layer === 'taxiway' && b.layer === 'runway' && touches(a.ownerId, b.ownerId)) return;
    if (b.layer === 'taxiway' && a.layer === 'runway' && touches(b.ownerId, a.ownerId)) return;
    if (
      crossingPairs.size > 0 &&
      RUNWAYISH.has(a.layer) &&
      RUNWAYISH.has(b.layer) &&
      crossingPairs.has(pairKey(a.ownerId, b.ownerId))
    ) {
      return;
    }
    const params: Record<string, string | number> = real ? { criterion: 'real' } : {};
    if (a.layer === 'strip' || b.layer === 'strip' || a.layer === 'resa' || b.layer === 'resa') {
      const [strip, other] = a.layer === 'strip' || a.layer === 'resa' ? [a, b] : [b, a];
      sink.add(strip.layer === 'resa' ? 'IN_RUNWAY_RESA' : 'IN_RUNWAY_STRIP', [other.ownerId], params, at, [strip.ownerId]);
      return;
    }
    const [p, q] = compareIds(a.ownerId, b.ownerId) <= 0 ? [a, b] : [b, a];
    sink.add('OVERLAP', [p.ownerId, q.ownerId], params, at);
  };

  for (const [k, list] of occ) {
    if (list.length < 2) continue;
    const [x, y] = k.slice(k.lastIndexOf('|') + 1).split(',').map(Number) as [number, number];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.maxM <= b.minM || b.maxM <= a.minM) continue;
        // A connector only occupies the vertical span recorded for this tile, not its full path on both floors.
        judge(a, b, { x, y }, false);
      }
    }
  }

  // 自由形（多角形）の判定: 従来の占有（タイルの正方形）と、別の自由形の多角形。従来形だけなら空ループ
  const polys = parts.filter((p) => p.poly);
  for (const p of polys) {
    for (const t of p.tiles) {
      for (const level of p.levels ?? [p.level ?? 0]) {
        const minM = p.vertical?.minM ?? level * DEFAULT_LEVEL_HEIGHT_M;
        const maxM = p.vertical?.maxM ?? level * DEFAULT_LEVEL_HEIGHT_M + 0.4;
        for (const o of occ.get(`${p.spaceId ?? 'map'}|${tileKey(t.x, t.y)}`) ?? []) {
          if (maxM <= o.minM || o.maxM <= minM) continue;
          judge({ ownerId: p.ownerId, layer: p.layer }, o, t, true);
        }
      }
    }
  }
  const boxes = polys.map((p) => polyBBox(p.poly!));
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      const A = polys[i]!;
      const B = polys[j]!;
      if (A.ownerId === B.ownerId) continue;
      const az = A.vertical ?? { minM: (A.level ?? 0) * DEFAULT_LEVEL_HEIGHT_M, maxM: (A.level ?? 0) * DEFAULT_LEVEL_HEIGHT_M + 0.4 };
      const bz = B.vertical ?? { minM: (B.level ?? 0) * DEFAULT_LEVEL_HEIGHT_M, maxM: (B.level ?? 0) * DEFAULT_LEVEL_HEIGHT_M + 0.4 };
      if (az.maxM <= bz.minM || bz.maxM <= az.minM) continue;
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0) continue;
      if (!satOverlapConvex(A.poly!, B.poly!)) continue;
      const at = roundPoint({
        x: (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2,
        y: (Math.max(a.y0, b.y0) + Math.min(a.y1, b.y1)) / 2,
      });
      judge({ ownerId: A.ownerId, layer: A.layer }, { ownerId: B.ownerId, layer: B.layer }, at, true);
    }
  }

  // スポットはエプロン上に置く
  for (const s of sortedValues(layout.stands)) {
    const off = standTiles(s).find((t) => !(occ.get(`map|${tileKey(t.x, t.y)}`) ?? []).some((o) => o.layer === 'apron' && o.minM < 0.4 && o.maxM > 0));
    if (off) sink.add('STAND_NOT_ON_APRON', [s.id], {}, off);
  }
}

// ---------------------------------------------------------------- ネットワーク

function checkNetworkGeometry(
  nodes: Record<string, NetNode>,
  edges: Record<string, AnyEdge>,
  crossingCode: 'TAXIWAY_CROSSING_NO_JUNCTION' | 'ROAD_CROSSING_NO_JUNCTION',
  sink: IssueSink,
): void {
  const list = sortedValues(edges);
  // 同位置のノード
  const byPos = new Map<string, string[]>();
  for (const n of sortedValues(nodes)) {
    const k = `${n.level ?? 0}|${tileKey(n.pos.x, n.pos.y)}`;
    byPos.set(k, [...(byPos.get(k) ?? []), n.id]);
  }
  for (const ids of byPos.values()) {
    if (ids.length > 1) sink.add('DUPLICATE_NODE', ids, {}, nodes[ids[0]!]!.pos);
  }
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    const a = nodes[e.from]?.pos;
    const b = nodes[e.to]?.pos;
    if (!a || !b) continue;
    for (let j = i + 1; j < list.length; j++) {
      const f = list[j]!;
      const c = nodes[f.from]?.pos;
      const d = nodes[f.to]?.pos;
      if (!c || !d) continue;
      const eLevels = [nodes[e.from]?.level ?? 0, nodes[e.to]?.level ?? 0];
      const fLevels = [nodes[f.from]?.level ?? 0, nodes[f.to]?.level ?? 0];
      if (!eLevels.some((level) => fLevels.includes(level))) continue;
      const shared = [e.from, e.to].filter((n) => n === f.from || n === f.to).length;
      if (shared === 2) {
        sink.add('DUPLICATE_EDGE', [e.id, f.id], {}, a);
        continue;
      }
      const hit = segmentIntersection(a, b, c, d);
      if (hit) {
        sink.add(crossingCode, [e.id, f.id], {}, { x: Math.round(hit.point.x), y: Math.round(hit.point.y) });
        continue;
      }
      if (crossingCode === 'TAXIWAY_CROSSING_NO_JUNCTION' && collinearOverlap(a, b, c, d)) {
        sink.add('TAXIWAY_OVERLAP', [e.id, f.id], {}, a);
      }
    }
  }
}

/** 2線分が同一直線上で正の長さだけ重なるか */
function collinearOverlap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const ab = sub(b, a);
  if (Math.abs(cross(ab, sub(c, a))) > 1e-9 || Math.abs(cross(ab, sub(d, a))) > 1e-9) return false;
  const len2 = dot(ab, ab);
  const t1 = dot(sub(c, a), ab) / len2;
  const t2 = dot(sub(d, a), ab) / len2;
  const lo = Math.max(0, Math.min(t1, t2));
  const hi = Math.min(1, Math.max(t1, t2));
  return hi - lo > 1e-9;
}

// ---------------------------------------------------------------- 滑走路どうしの関係（Phase 12）

/** 平行とみなす方位差（度。ゲーム値） */
const PARALLEL_MAX_DIFF_DEG = 1;
/** 同時使用する平行滑走路の中心線間隔の最小（m）。参考: EASA CS B.050（非計器・コード 3〜4）の 210 m */
export const PARALLEL_MIN_SPACING_M = 210;
/** 独立した平行進入の中心線間隔（m）。参考: EASA CS B.055 の 1035 m（従属 915 m、独立出発 760 m。FAA 3.9.3 は 975 m） */
export const PARALLEL_INDEPENDENT_SPACING_M = 1035;

/**
 * 平行間隔・番号の重複（自由形が関与する組、または ruleSet が realistic のときだけ。従来形だけの既定では何もしない）。
 * 値はすべてゲームの判定（参考値は RUNWAY_REFERENCE）。
 */
function checkRunwayRules(layout: AirportLayout, sink: IssueSink): void {
  const realistic = layout.ruleSet === 'realistic';
  const rs = sortedValues(layout.runways);
  const involved = (a: (typeof rs)[number], b: (typeof rs)[number]): boolean => realistic || isFreeRunway(a) || isFreeRunway(b);
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i]!;
      const b = rs[j]!;
      if (!involved(a, b)) continue;
      const xa = runwayAxis(a);
      const xb = runwayAxis(b);
      let dh = Math.abs(xa.trueHeadingDeg - xb.trueHeadingDeg) % 180;
      if (dh > 90) dh = 180 - dh;
      if (dh > PARALLEL_MAX_DIFF_DEG) continue;
      // 長さ方向に重なるか（a の軸への射影）
      const proj = (p: Vec2): number => (p.x - xa.start.x) * xa.dir.x + (p.y - xa.start.y) * xa.dir.y;
      const [b0, b1] = [proj(xb.start), proj(xb.end)].sort((x, y) => x - y) as [number, number];
      if (Math.min(xa.lengthT, b1) - Math.max(0, b0) <= 0) continue;
      const mb = { x: (xb.start.x + xb.end.x) / 2, y: (xb.start.y + xb.end.y) / 2 };
      const spacingM = Math.abs((mb.x - xa.start.x) * xa.dir.y - (mb.y - xa.start.y) * xa.dir.x) * TILE_M;
      const at = roundPoint({ x: (xa.start.x + xa.end.x + xb.start.x + xb.end.x) / 4, y: (xa.start.y + xa.end.y + xb.start.y + xb.end.y) / 4 });
      if (spacingM < PARALLEL_MIN_SPACING_M) {
        sink.add('RUNWAY_PARALLEL_TOO_CLOSE', [a.id, b.id], { distanceM: Math.round(spacingM), refM: PARALLEL_MIN_SPACING_M }, at);
      } else if (realistic && spacingM < PARALLEL_INDEPENDENT_SPACING_M) {
        sink.add('RUNWAY_PARALLEL_DEPENDENT', [a.id, b.id], { distanceM: Math.round(spacingM), refM: PARALLEL_INDEPENDENT_SPACING_M }, at);
      }
    }
  }
  // 番号（接尾辞を含む）の重複
  const byText = new Map<string, string[]>();
  for (const r of rs) {
    for (const t of designatorsOf(r, layout).text) byText.set(t, [...(byText.get(t) ?? []), r.id]);
  }
  for (const [text, ids] of [...byText].sort((x, y) => compareIds(x[0], y[0]))) {
    const uniq = [...new Set(ids)];
    if (uniq.length < 2) continue;
    // 自由形が 1 本も関与しない組は realistic のときだけ
    if (!realistic && !uniq.some((id) => isFreeRunway(layout.runways[id]!))) continue;
    sink.add('RUNWAY_DESIGNATOR_CONFLICT', uniq, { designator: text }, roundPoint(runwayAxis(layout.runways[uniq[0]!]!).start));
  }
}

/**
 * 自由形の滑走路の停止位置（Phase 12 M1）。滑走路の各ノードから誘導路を経路に沿って外へたどり、
 * 滑走路の中心線（線分）からの距離が H（実寸の停止位置）以上になる点に届かない枝があれば警告する。
 * 届かない例: 浅い角度で入る誘導路、短い連絡誘導路、別の滑走路の保護区域の中に停止位置がある（連続横断の幾何）。
 * 探索は他の滑走路ノード・行き止まり・上限 max(3H, 300 m) で止める。従来形の滑走路は対象外。
 */
function checkHoldShort(layout: AirportLayout, net: AirsideNetwork, sink: IssueSink): void {
  const frees = sortedValues(layout.runways).filter(isFreeRunway);
  if (frees.length === 0) return;
  const zones: HoldRunway[] = frees.map((r) => {
    const ax = runwayAxis(r);
    return { a: ax.start, b: ax.end, holdM: resolveRunwayDims(r).holdingPositionM };
  });
  for (const r of frees) {
    const holdM = resolveRunwayDims(r).holdingPositionM;
    const limit = holdWalkLimitM(holdM);
    for (const nodeId of net.runwayNodes[r.id] ?? []) {
      const start = net.nodes[nodeId]!;
      const nextEdges = (id: string, from: string): { edge: string; to: string }[] =>
        [...(net.outgoing[id] ?? []), ...(net.incoming[id] ?? [])]
          .map((eid) => net.edges[eid]!)
          .filter((e) => e.kind === 'taxiway')
          .map((e) => ({ edge: e.id, to: e.from === id ? e.to : e.from }))
          .filter((x) => x.to !== from)
          .sort((p, q) => compareIds(p.edge, q.edge));
      if (nextEdges(nodeId, '').length === 0) continue; // 誘導路が接続していないノードは停止位置の対象ではない
      let worst: number | null = null;
      const related: string[] = [];
      // Dijkstra 風: 各ノードは最短距離の経路で 1 度だけ展開する（経路は最短路で、ノードを再訪しないので、
      // 到達済みの停止位置は届く／届かないを 1 度だけ判定すればよい）。届いた枝は打ち切る。
      type Item = { id: string; from: string; pts: Vec2[]; dist: number; fe: string };
      const settled = new Set<string>([nodeId]);
      const best = new Map<string, Item>();
      const consider = (id: string, it: Item): void => {
        const cur = best.get(id);
        if (!cur || it.dist < cur.dist - 1e-9) best.set(id, it);
      };
      const expand = (it: Item): void => {
        for (const n of nextEdges(it.id, it.from)) {
          if (settled.has(n.to)) continue;
          const nn = net.nodes[n.to]!;
          const p = it.pts[it.pts.length - 1]!;
          const seg = Math.hypot(nn.pos.x - p.x, nn.pos.y - p.y) * TILE_M;
          consider(n.to, { id: n.to, from: it.id, pts: [...it.pts, nn.pos], dist: it.dist + seg, fe: it.fe || n.edge });
        }
      };
      expand({ id: nodeId, from: '', pts: [start.pos], dist: 0, fe: '' });
      while (best.size > 0) {
        let pick: Item | null = null;
        for (const it of best.values()) {
          if (!pick || it.dist < pick.dist - 1e-9 || (Math.abs(it.dist - pick.dist) <= 1e-9 && compareIds(it.id, pick.id) < 0)) pick = it;
        }
        const it = pick!;
        best.delete(it.id);
        settled.add(it.id);
        const w = walkToClear(it.pts, zones, Math.min(limit, it.dist));
        if (w.clearM !== null) continue; // 届いた: この先は調べない
        const nn = net.nodes[it.id]!;
        const deadEnd = nextEdges(it.id, it.from).length === 0;
        if (nn.runwayIds.length > 0 || it.dist >= limit || deadEnd) {
          const achieved = holdM + w.bestSlackM;
          worst = worst === null ? achieved : Math.min(worst, achieved);
          const src = net.edges[it.fe]?.sourceId;
          if (src && !related.includes(src)) related.push(src);
        } else expand(it);
      }
      if (worst !== null) {
        sink.add('HOLD_SHORT_TOO_CLOSE', [r.id], { runwayId: r.id, achievedM: Math.max(0, Math.round(worst)), requiredM: Math.round(holdM) }, roundPoint(start.pos), related);
      }
    }
  }
}

/** 素集合（連結成分の計算用） */
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(compareIds(ra, rb) < 0 ? rb : ra, compareIds(ra, rb) < 0 ? ra : rb);
  }
}

function checkAirside(layout: AirportLayout, net: AirsideNetwork, sink: IssueSink, isolatedEdges: Set<string>): void {
  // 滑走路
  for (const r of sortedValues(layout.runways)) {
    if (runwayMaxSize(r) === null) sink.add('RUNWAY_TOO_SHORT', [r.id], {}, isFreeRunway(r) ? roundPoint(r.start) : r.start);
    const entries = (net.runwayNodes[r.id] ?? []).filter((n) =>
      (net.outgoing[n] ?? []).some((eid) => net.edges[eid]!.kind === 'taxiway') ||
      (net.incoming[n] ?? []).some((eid) => net.edges[eid]!.kind === 'taxiway'),
    );
    if (entries.length === 0) sink.add('RUNWAY_NO_TAXIWAY', [r.id], {}, isFreeRunway(r) ? roundPoint(r.start) : r.start);
  }

  // 誘導路と滑走路の関係
  for (const e of sortedValues(layout.taxiways)) {
    const a = layout.taxiNodes[e.from];
    const b = layout.taxiNodes[e.to];
    if (!a || !b) continue;
    for (const r of sortedValues(layout.runways)) {
      const ta = positionOnRunway(r, a.pos);
      const tb = positionOnRunway(r, b.pos);
      if (ta !== null && tb !== null) {
        sink.add('TAXIWAY_ON_RUNWAY', [e.id], {}, a.pos, [r.id]);
        continue;
      }
      if (isFreeRunway(r)) {
        // 自由形: 両方の内部で 1 点で交わる（端点が中心線上・端での接触は除く）
        const ax = runwayAxis(r);
        const c = classifySegmentIntersection(a.pos, b.pos, ax.start, ax.end);
        if (c.kind === 'point' && !c.atEndA && !c.atEndB) {
          sink.add('TAXIWAY_CROSSES_RUNWAY_NO_ENTRY', [e.id], {}, roundPoint(c.p), [r.id]);
        }
        continue;
      }
      const hit = segmentIntersection(a.pos, b.pos, r.start, runwayEnd(r));
      if (hit) {
        const at = { x: Math.round(hit.point.x), y: Math.round(hit.point.y) };
        sink.add('TAXIWAY_CROSSES_RUNWAY_NO_ENTRY', [e.id], {}, at, [r.id]);
      }
    }
  }

  // 連結成分: 滑走路に繋がらない誘導路のまとまり
  const uf = new UnionFind();
  for (const e of Object.values(net.edges)) if (e.kind !== 'standLink') uf.union(e.from, e.to);
  const runwayRoots = new Set<string>();
  for (const ids of Object.values(net.runwayNodes)) for (const n of ids) runwayRoots.add(uf.find(n));
  const isolated = new Map<string, string[]>();
  for (const e of sortedValues(layout.taxiways)) {
    const root = uf.find(e.from);
    if (!runwayRoots.has(root)) isolated.set(root, [...(isolated.get(root) ?? []), e.id]);
  }
  for (const ids of isolated.values()) {
    ids.forEach((id) => isolatedEdges.add(id));
    sink.add('TAXIWAY_ISOLATED', ids, { count: ids.length }, layout.taxiNodes[layout.taxiways[ids[0]!]!.from]?.pos);
  }

  // 行き止まり
  for (const n of sortedValues(layout.taxiNodes)) {
    const node = net.nodes[n.id]!;
    if (edgesOfNode(layout.taxiways, n.id).length === 1 && node.kind !== 'runwayEntry' && node.standIds.length === 0) {
      sink.add('TAXIWAY_DEAD_END', [n.id], {}, n.pos);
    }
  }

  // スポットから滑走路への経路（出発 = 順方向、到着 = 逆方向）
  for (const s of sortedValues(layout.stands)) {
    if (!net.standLinks[s.id]) {
      sink.add('STAND_NOT_CONNECTED', [s.id], {}, s.origin);
      continue;
    }
    const dep = standReachesRunway(layout, net, s.id, s.size, 'forward', false);
    const arr = standReachesRunway(layout, net, s.id, s.size, 'reverse', false);
    if (!dep && !arr) {
      const anySize =
        standReachesRunway(layout, net, s.id, null, 'forward', false) ||
        standReachesRunway(layout, net, s.id, null, 'reverse', false);
      if (anySize) sink.add('STAND_ROUTE_SIZE_LIMITED', [s.id], { size: s.size }, s.origin);
      else sink.add('STAND_NO_RUNWAY_ROUTE', [s.id], {}, s.origin);
    } else if (!dep || !arr) {
      sink.add('STAND_ONE_WAY_TRAP', [s.id], { direction: dep ? 'arrival' : 'departure' }, s.origin);
    }
  }
}

/**
 * スポットから（または スポットへ）、その機体区分が使える滑走路まで到達できるか。
 * size = null の場合は機体区分を無視する。
 */
/**
 * フェーズ 4 §3.3: 夜間滞泊の記録（company.carryOver）にある機体のスポットが、
 * 撤去・閉鎖・未完成になっている場合の警告。レイアウトだけでは決まらないので analyzeLayout とは別に返す。
 */
export function overnightStandIssues(layout: AirportLayout, company: CompanyState | null | undefined): Issue[] {
  const records = company?.carryOver?.aircraft ?? [];
  if (records.length === 0) return [];
  const byStand = new Map<string, number>();
  for (const r of records) byStand.set(r.standId, (byStand.get(r.standId) ?? 0) + 1);
  const issues: Issue[] = [];
  for (const [standId, count] of byStand) {
    const stand = layout.stands[standId];
    if (stand && stand.buildState === 'operational') continue;
    issues.push({
      key: `OVERNIGHT_STAND_REMOVED:${standId}`,
      code: 'OVERNIGHT_STAND_REMOVED',
      severity: ISSUE_SEVERITY.OVERNIGHT_STAND_REMOVED,
      targets: [standId],
      related: [],
      params: { count },
      ...(stand ? { at: stand.origin } : {}),
    });
  }
  return issues;
}

/**
 * フェーズ 4 §4.2: 国際のエリアや国際・兼用ゲートがあるのに、国際機能が解放・有効化されていない場合の警告。
 * 会社側の状態が要るので analyzeLayout とは別に返す（overnightStandIssues と同じ扱い）。
 */
export function intlLockedIssues(layout: AirportLayout, company: CompanyState | null | undefined): Issue[] {
  if (!company || featureOn(company, 'international')) return [];
  const targets: string[] = [
    ...Object.values(layout.terminalAreas)
      .filter((a) => a.kind === 'emigration' || a.kind === 'immigration' || a.kind === 'customs' || a.kind === 'transferSecurity')
      .map((a) => a.id),
    ...Object.values(layout.facilities)
      .filter((f) => f.kind === 'gate' && (f.props.routeType === 'international' || f.props.routeType === 'swing'))
      .map((f) => f.id),
  ];
  if (targets.length === 0) return [];
  return [{
    key: 'INTL_LOCKED',
    code: 'INTL_LOCKED',
    severity: ISSUE_SEVERITY.INTL_LOCKED,
    targets,
    related: [],
    params: {},
  }];
}

export function standReachesRunway(
  layout: AirportLayout,
  net: AirsideNetwork,
  standId: string,
  size: SizeClass | null,
  direction: 'forward' | 'reverse',
  operationalOnly: boolean,
): boolean {
  const reach = reachableNodes(net, `${standId}:P`, size, direction, { operationalOnly });
  for (const r of Object.values(layout.runways)) {
    const max = runwayMaxSize(r);
    if (!max || (size && !sizeAtLeast(max, size))) continue;
    if (operationalOnly && r.buildState !== 'operational') continue;
    if ((net.runwayNodes[r.id] ?? []).some((n) => reach.has(n))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 施設

function neighborTiles(tiles: readonly Tile[]): Tile[] {
  const own = new Set(tiles.map((t) => tileKey(t.x, t.y)));
  const out = new Map<string, Tile>();
  for (const t of tiles) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = tileKey(t.x + dx, t.y + dy);
      if (!own.has(k)) out.set(k, { x: t.x + dx, y: t.y + dy });
    }
  }
  return [...out.values()];
}

function checkFacilities(layout: AirportLayout, parts: FootprintPart[], sink: IssueSink): void {
  const layerTiles = (pred: (p: FootprintPart) => boolean) =>
    new Set(parts.filter(pred).flatMap((p) => p.tiles.map((t) => tileKey(t.x, t.y))));
  const airsideAccess = layerTiles(
    (p) =>
      p.layer === 'apron' ||
      p.layer === 'taxiway' ||
      p.layer === 'roadService' ||
      (p.layer === 'area' && layout.facilities[p.ownerId]?.kind === 'serviceArea'),
  );
  const publicRoad = layerTiles((p) => p.layer === 'roadPublic');
  const anyRoad = layerTiles((p) => p.layer === 'roadPublic' || p.layer === 'roadService');
  const terminalTiles = layerTiles((p) => layout.facilities[p.ownerId]?.kind === 'terminal');
  const touches = (tiles: Tile[], set: Set<string>, includeOwn = false) =>
    neighborTiles(tiles).some((t) => set.has(tileKey(t.x, t.y))) ||
    (includeOwn && tiles.some((t) => set.has(tileKey(t.x, t.y))));

  const gatesByStand = new Map<string, string[]>();
  const facilities = sortedValues(layout.facilities);
  const roadComplexes = terminalServiceComplexes(layout);
  const areasByTerminal = new Map<string, TerminalArea[]>();
  for (const a of Object.values(layout.terminalAreas)) {
    (areasByTerminal.get(a.terminalId) ?? areasByTerminal.set(a.terminalId, []).get(a.terminalId)!).push(a);
  }
  const portalAreaIds = new Set(Object.values(layout.portals ?? {}).map((p) => p.areaId));
  for (const f of facilities) {
    const tiles = facilityTiles(f);
    const spec = FACILITY_SPECS[f.kind];
    // 建物内の設備は親の接し方で判定する（5-09 / W-3）。内部設備そのものへの接地警告は出さない
    if (!f.parentFacilityId && spec.needsAirsideAccess && !touches(tiles, airsideAccess)) sink.add('NO_AIRSIDE_ACCESS', [f.id], {}, f.origin);
    // 地下に置けない種類（5-09 / W-7）。配置は operations で止めるが、既存データ向けに警告も出す
    if (undergroundFacilityProblem(f.kind, f.mapLevel, !!f.parentFacilityId)) sink.add('FACILITY_UNDERGROUND_KIND', [f.id], {}, f.origin);
    // 建物内の地上サービス設備は接続モデルがない間は能力に数えない（docs/34）。その旨を知らせる（5-09 / W-3）
    if (f.parentFacilityId && (f.kind === 'gseBase' || f.kind === 'baggageSort' || f.kind === 'fuelFarm' || f.kind === 'maintenance')) sink.add('INTERIOR_FACILITY_UNLINKED', [f.id], {}, f.origin);
    if (f.kind === 'terminal') {
      // 道路への接地もリンク複合体で判定する（サテライト対応）: 複合体のどれかが
      // 一般道路に接していれば、旅客は本体側から出入りできるため警告しない
      const complexTouchesRoad = (roadComplexes.get(f.id) ?? [f.id])
        .some((tid) => layout.facilities[tid] && touches(facilityTiles(layout.facilities[tid]!), publicRoad));
      if (!complexTouchesRoad) sink.add('TERMINAL_NO_ROAD', [f.id], {}, f.origin);
      const own = new Set(tiles.map((t) => tileKey(t.x, t.y)));
      const hasGate = facilities.some(
        (g) => g.kind === 'gate' && (neighborTiles(facilityTiles(g)).some((t) => own.has(tileKey(t.x, t.y))) || connectedTerminal(g, layout) === f.id),
      );
      if (!hasGate) sink.add('TERMINAL_NO_GATE', [f.id], {}, f.origin);
      // 機能G: 地下棟が地上階（実効地図階層 >= 0）のエリアを持たず、サービス複合体も単独で、
      // ランドサイド入口（入口/出口エリア、またはポータル接続）も無い場合は到達不能として警告する。
      // ランドサイド接続の必須化はしない（警告のみ。G-U1）
      // 「地下棟」の判定は基底階だけでなく、基底が地上でも全エリアが地下にしか無い棟も含む。
      // エリアの無い地上の空棟は対象にしない（通常の未接続ターミナルの扱いに任せる）
      const ownAreas = areasByTerminal.get(f.id) ?? [];
      const hasGroundArea = ownAreas.some((a) => facilityLevel(f) + a.level >= 0);
      const isUndergroundBuilding = facilityLevel(f) < 0 || (ownAreas.length > 0 && !hasGroundArea);
      if (isUndergroundBuilding && !hasGroundArea) {
        const complex = roadComplexes.get(f.id) ?? [f.id];
        if (complex.length === 1) {
          const complexAreas = complex.flatMap((tid) => areasByTerminal.get(tid) ?? []);
          const hasLandsideEntry =
            complexAreas.some((a) => a.kind === 'entrance' || a.kind === 'exit') ||
            complexAreas.some((a) => portalAreaIds.has(a.id));
          if (!hasLandsideEntry) sink.add('TERMINAL_UNDERGROUND_ISOLATED', [f.id], {}, f.origin);
        }
      }
    }
    if (f.kind === 'parking' && !touches(tiles, anyRoad, true)) sink.add('PARKING_NO_ROAD', [f.id], {}, f.origin);
    if (f.kind === 'gate') {
      // 機能G/H: 地下の搭乗口はバスゲート扱いが原則。実効地図階層 < 0 のゲートで
      // ブリッジ（従来の jetBridge、または明示の搭乗橋 PBB）が有効な場合は警告する。
      // sim 側は boardingProfile が橋なし（タラップ値）に確定させる（G-U4 は機能Hで解消）
      const gateParent = f.parentFacilityId ? layout.facilities[f.parentFacilityId] : undefined;
      const gateLevel = gateParent ? facilityLevel(gateParent) + (f.floorIndex ?? 0) : facilityLevel(f);
      if (gateLevel < 0 && gateMode(f) !== 'bus' && (f.props.jetBridge || hasExplicitPbb(layout, f.id))) sink.add('GATE_UNDERGROUND_BRIDGE', [f.id], {}, f.origin);
      const connected = connectedTerminal(f, layout);
      if (typeof f.props.connectedTo === 'string' && !connected) sink.add('GATE_CONNECTION_INVALID', [f.id], {}, f.origin);
      if (!connected && !touches(tiles, terminalTiles)) sink.add('GATE_NOT_AT_TERMINAL', [f.id], {}, f.origin);
      const standId = typeof f.props.standId === 'string' ? f.props.standId : null;
      const stand = standId ? layout.stands[standId] : undefined;
      if (gateMode(f) === 'bus') {
        // バスゲートはスポットに固定しない（リモートスポットの便をランプバスで運ぶ）。standId は無視される
        if (standId) sink.add('GATE_BUS_HAS_STAND', [f.id], {}, f.origin);
      } else if (!stand) {
        sink.add('GATE_NO_STAND', [f.id], {}, f.origin);
      } else {
        gatesByStand.set(stand.id, [...(gatesByStand.get(stand.id) ?? []), f.id]);
        const dist = chebyshevDistance(tiles, standTiles(stand));
        if (dist > GATE_MAX_STAND_DISTANCE) sink.add('GATE_STAND_TOO_FAR', [f.id], { distance: dist }, f.origin, [stand.id]);
      }
    }
  }
  const busGates = facilities.filter((f) => f.kind === 'gate' && gateMode(f) === 'bus' && f.buildState === 'operational');
  let remote = 0;
  for (const s of sortedValues(layout.stands)) {
    const gates = gatesByStand.get(s.id) ?? [];
    if (gates.length === 0) {
      remote++;
      sink.add('STAND_REMOTE', [s.id], busGates.length > 0 ? { bus: 1 } : {}, s.origin);
    }
    if (gates.length > 1) sink.add('STAND_MULTIPLE_GATES', [s.id, ...gates], {}, s.origin);
  }
  if (busGates.length > 0) {
    const buses = facilities.filter((f) => f.kind === 'gseBase' && f.buildState === 'operational' && !f.parentFacilityId).reduce((n, f) => n + apronBusesOf(f), 0);
    if (buses === 0) for (const g of busGates) sink.add('GATE_BUS_NO_VEHICLES', [g.id], {}, g.origin);
    if (remote === 0) sink.add('BUS_GATE_NO_REMOTE_STAND', [busGates[0]!.id], {}, busGates[0]!.origin);
  }
}

/**
 * 搭乗橋（PBB、機能H）の検証。読み取り・速度の正は core/model/boardingBridge。
 * ここでは「配置と紐付けの正しさ」だけを見る（シル高の範囲外は警告: 1本でも
 * 大型機は運用でき、速度ペナルティで表すため。design-GHIJ-detail.md §H.3）。
 */
function checkBoardingBridges(layout: AirportLayout, sink: IssueSink): void {
  const pbbs = sortedValues(layout.facilities).filter((f) => f.kind === 'boardingBridge');
  if (pbbs.length === 0) return;
  const decksByGate = new Map<string, Map<PbbDeck, string[]>>();
  const gatesWithPbb = new Set<string>();
  for (const f of pbbs) {
    const gateId = pbbGateIdOf(f);
    const standId = pbbStandIdOf(f);
    const gate = gateId ? layout.facilities[gateId] : undefined;
    const stand = standId ? layout.stands[standId] : undefined;
    // 紐付けの検証: ゲート・スポットが存在し、ゲートの standId と一致すること
    const gateStandId = gate && typeof gate.props.standId === 'string' ? gate.props.standId : null;
    if (!gate || gate.kind !== 'gate' || !stand || gateStandId !== standId) {
      sink.add('PBB_GATE_MISMATCH', [f.id], {}, f.origin);
    }
    // 配置の検証: 紐付くスポットの入口（standEntry）の近傍にあること
    if (stand) {
      const d = chebyshevDistance([f.origin], [standEntry(stand)]);
      if (d > PBB_ENTRY_RANGE) sink.add('PBB_NOT_ADJACENT', [f.id], { distance: d }, f.origin, [stand.id]);
    }
    if (gate && gate.kind === 'gate') {
      gatesWithPbb.add(gate.id);
      const byDeck = decksByGate.get(gate.id) ?? new Map<PbbDeck, string[]>();
      const list = byDeck.get(pbbDeckOf(f)) ?? [];
      list.push(f.id);
      byDeck.set(pbbDeckOf(f), list);
      decksByGate.set(gate.id, byDeck);
    }
    // シル高の警告: 紐付くスポットに就航しうる最大区分（= スポットの size）の
    // ドアシル高（ゲーム値）が型式の適合範囲を超える場合
    if (stand) {
      const spec = PBB_TYPES[pbbTypeOf(f)];
      if (pbbDeckOf(f) === 'main' && DOOR_SILL_M[stand.size] > spec.sillMain.max) {
        sink.add('PBB_SILL_RANGE', [f.id], { size: stand.size }, f.origin, [stand.id]);
      }
      if (pbbDeckOf(f) === 'upper' && (!spec.sillUpper || DOOR_SILL_UPPER_M < spec.sillUpper.min || DOOR_SILL_UPPER_M > spec.sillUpper.max)) {
        sink.add('PBB_SILL_RANGE', [f.id], { deck: 'upper' }, f.origin, [stand.id]);
      }
    }
  }
  for (const [gateId, byDeck] of decksByGate) {
    for (const [deck, ids] of byDeck) {
      if (ids.length > 1) sink.add('PBB_DECK_DUPLICATE', [gateId, ...ids], { deck }, layout.facilities[gateId]?.origin);
    }
  }
  // 明示 PBB があるのに従来の jetBridge が残っている（読み取りでは無視される）
  for (const gateId of gatesWithPbb) {
    const gate = layout.facilities[gateId];
    if (gate && gate.props.jetBridge) sink.add('PBB_LEGACY_OVERRIDDEN', [gateId], {}, gate.origin);
  }
}

function checkRoads(layout: AirportLayout, parts: FootprintPart[], sink: IssueSink): void {
  // 連結の扱いは buildLandsideNetwork（旅客ルート判定）と一致させる:
  // 運用中の区間だけ、階層接続が有効な区間だけを数える（工事中・ランプ無しの階層跳びは接続扱いしない）。
  // 敷地外周への到達は階層を問わない（地下トンネル状の出入口も可）点もランドサイド側と共通。
  const usableRoad = (e: (typeof layout.roads)[string]): boolean =>
    e.buildState === 'operational' && roadEdgeLevelValid(e, layout.roadNodes[e.from], layout.roadNodes[e.to]);
  const uf = new UnionFind();
  for (const e of Object.values(layout.roads)) if ((e.roadClass === 'public' || e.roadClass === 'service') && usableRoad(e)) uf.union(e.from, e.to);
  const comps = new Map<string, string[]>();
  for (const e of sortedValues(layout.roads)) {
    if (e.roadClass !== 'public' || !usableRoad(e)) continue;
    const root = uf.find(e.from);
    comps.set(root, [...(comps.get(root) ?? []), e.id]);
  }
  for (const ids of comps.values()) {
    const reachesEdge = parts
      .filter((p) => p.layer === 'roadPublic' && ids.includes(p.ownerId))
      .some((p) => p.tiles.some((t) => isSiteEdge(layout.site, t.x, t.y)));
    // 同じ連結成分のサービス道路が出口に届いていても可
    const viaService = Object.values(layout.roads)
      .filter((e) => (e.roadClass === 'public' || e.roadClass === 'service') && usableRoad(e) && uf.find(e.from) === uf.find(layout.roads[ids[0]!]!.from))
      .some((e) => {
        const a = layout.roadNodes[e.from]?.pos;
        const b = layout.roadNodes[e.to]?.pos;
        return (a && isSiteEdge(layout.site, a.x, a.y)) || (b && isSiteEdge(layout.site, b.x, b.y));
      });
    if (!reachesEdge && !viaService) {
      sink.add('ROAD_NO_ENTRANCE', ids, { count: ids.length }, layout.roadNodes[layout.roads[ids[0]!]!.from]?.pos);
    }
  }
}

function checkRoadLayers(layout: AirportLayout, sink: IssueSink): void {
  for (const n of Object.values(layout.roadNodes)) {
    if (n.level !== undefined && (!Number.isInteger(n.level) || n.level < -5 || n.level > 10)) sink.add('ROAD_LAYER_CONNECTION_INVALID', [n.id], { reason: '階層値が範囲外' }, n.pos);
    if (n.elevationM !== undefined && !Number.isFinite(n.elevationM)) sink.add('ROAD_LAYER_CONNECTION_INVALID', [n.id], { reason: '標高が不正' }, n.pos);
  }
  for (const e of sortedValues(layout.roads)) {
    const a = layout.roadNodes[e.from];
    const b = layout.roadNodes[e.to];
    if (!a || !b) continue;
    const la = a.level ?? 0;
    const lb = b.level ?? 0;
    const at = { x: Math.round((a.pos.x + b.pos.x) / 2), y: Math.round((a.pos.y + b.pos.y) / 2) };
    const invalid = !roadEdgeLevelValid(e, a, b);
    if (invalid) {
      const reason = la === lb
        ? '同じ階層の区間に階層接続設備が設定されているか、端点標高が一致していません'
        : !connectorFits(e.roadClass, e.connectorKind)
          ? '階層差に合う階段・昇降機・ランプ・配管接続がありません'
          : '勾配または垂直接続設備の配置距離が条件を満たしません';
      sink.add('ROAD_LAYER_CONNECTION_INVALID', [e.id], { reason }, at);
      continue;
    }
    if (e.capacityPerHour !== undefined && (!Number.isFinite(e.capacityPerHour) || e.capacityPerHour <= 0)) {
      sink.add('ROAD_LAYER_CONNECTION_INVALID', [e.id], { reason: '能力値は正の有限値が必要' }, at);
      continue;
    }
  }
}

/** 空港アクセスの施設: 外部とつながる道路・鉄道、ターミナルまでの距離。
 *  analyzeAccess（旅客ルート判定）の usable() と対象・条件を一致させる:
 *  駐車場も対象（従来は欠落していて、未接続でも警告が出なかった）。 */
function checkAccess(layout: AirportLayout, sink: IssueSink): void {
  const kinds = ['parking', 'taxiStand', 'busStop', 'busTerminal', 'railStation', 'staffParking', 'hotel'];
  const facilities = sortedValues(layout.facilities).filter((f) => kinds.includes(f.kind));
  if (facilities.length === 0) return;
  const net = buildLandsideNetwork(layout);
  for (const f of facilities) {
    if (f.kind === 'railStation') {
      if (!touchesTilesAtLevel(f, net.railTilesByLevel, facilityLevel(f))) sink.add('STATION_NO_RAIL', [f.id], {}, f.origin);
      else {
        // 駅からターミナルへの到達は analyzeAccess と同じ共有判定（連絡通路／同一階層の隣接／従来ルール）
        const terminals = sortedValues(layout.facilities).filter((x) => x.kind === 'terminal' && x.buildState === 'operational' && !x.parentFacilityId);
        if (!findStationTerminalAccess(layout, f, terminals)) sink.add('ACCESS_ROUTE_UNREACHABLE', [f.id], { mode: 'rail' }, f.origin);
      }
    } else if (!touchesTilesAtLevel(f, f.kind === 'staffParking' ? net.anyRoadTilesByLevel : net.publicTilesByLevel, facilityLevel(f))) {
      sink.add('ACCESS_NOT_CONNECTED', [f.id], {}, f.origin);
    }
    if (f.kind !== 'staffParking') {
      // 距離の上限は analyzeAccess と同じにする（駐車場は 24 タイルまで使える）
      const maxWalk = f.kind === 'parking' ? PARKING_MAX_WALK_TILES : ACCESS_MAX_WALK_TILES;
      const d = distanceToTerminal(layout, f);
      if (d > maxWalk) sink.add('ACCESS_FAR_FROM_TERMINAL', [f.id], { distance: Number.isFinite(d) ? d : -1 }, f.origin);
    }
  }
}

// ---------------------------------------------------------------- ターミナル内部

function checkTerminals(layout: AirportLayout, model: TerminalModel, sink: IssueSink, futureModel?: TerminalModel): void {
  // 配置: ターミナルの敷地・階の範囲内、同じ階で重ならない
  const areas = sortedValues(layout.terminalAreas);
  for (const a of areas) {
    const t = layout.facilities[a.terminalId];
    const range = t && t.kind === 'terminal' ? terminalFloorRange(layout, a.terminalId) : null;
    const inside =
      !!t &&
      t.kind === 'terminal' &&
      range !== null &&
      a.level >= range.min &&
      a.level <= range.max &&
      (() => {
        const own = new Set(facilityTiles(t).map((p) => tileKey(p.x, p.y)));
        return areaRectTiles(a).every((p) => own.has(tileKey(p.x, p.y)));
      })();
    if (!inside) sink.add('TERMINAL_AREA_OUTSIDE', [a.id], {}, a.origin);
  }
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      const a = areas[i]!;
      const b = areas[j]!;
      if (a.terminalId !== b.terminalId || a.level !== b.level) continue;
      const ox = Math.min(a.origin.x + a.w, b.origin.x + b.w) - Math.max(a.origin.x, b.origin.x);
      const oy = Math.min(a.origin.y + a.h, b.origin.y + b.h) - Math.max(a.origin.y, b.origin.y);
      if (ox > 0 && oy > 0) sink.add('TERMINAL_AREA_OVERLAP', [a.id, b.id], {}, { x: Math.max(a.origin.x, b.origin.x), y: Math.max(a.origin.y, b.origin.y) });
    }
  }

  // ターミナルごとの必須施設
  const terminals = sortedValues(layout.facilities).filter((f) => f.kind === 'terminal');
  const required: [TerminalAreaKind, IssueCode][] = [
    ['entrance', 'TERMINAL_NO_ENTRANCE'],
    ['exit', 'TERMINAL_NO_EXIT'],
    ['checkIn', 'TERMINAL_NO_CHECKIN'],
    ['security', 'TERMINAL_NO_SECURITY'],
    ['baggageClaim', 'TERMINAL_NO_BAGGAGE_CLAIM'],
  ];
  // 必須設備はリンク複合体（サテライト対応）で判定する: 運用中ターミナルリンクで結ばれた
  // 本体が設備を持っていれば、衛星棟単体に無くても充足とする（旅客フローの解決と一致）。
  // 実際に届くかはゲート単位の経路検査（GATE_UNREACHABLE 等）が別に担保する
  const complexes = terminalServiceComplexes(layout);
  const futureComplexes = terminalServiceComplexes(layout, { includeUnderConstruction: true });
  for (const t of terminals) {
    const kinds = new Set(
      (complexes.get(t.id) ?? [t.id]).flatMap((tid) => (model.byTerminal[tid] ?? []).map((id) => model.areas[id]!.kind)),
    );
    for (const [kind, code] of required) if (!kinds.has(kind)) sink.add(code, [t.id], {}, t.origin);

    // 施設の個数ではなく、旅客が実際に使えるサービスと経路の連鎖を検査する。
    const ids = model.byTerminal[t.id] ?? [];
    const usable = (id: string) => {
      const a = layout.terminalAreas[id]!;
      const configured = Number(a.props.counters ?? a.props.lanes ?? a.props.fixtures ?? a.props.capacity ?? 0);
      return a.kind !== 'checkIn' && a.kind !== 'security' || configured > 0;
    };
    const entrances = ids.filter((id) => model.areas[id]!.kind === 'entrance');
    const checkIns = ids.filter((id) => model.areas[id]!.kind === 'checkIn' && usable(id));
    const securities = ids.filter((id) => model.areas[id]!.kind === 'security' && usable(id));
    const departureRouteIn = (m: TerminalModel) => entrances.some((entry) => checkIns.some((ci) =>
      !!findPaxRoute(m, { from: entry, goals: new Map([[ci, 0]]) }) && securities.some((sec) =>
        !!findPaxRoute(m, { from: ci, goals: new Map([[sec, 0]]), uncleared: true }),
      ),
    ));
    if (entrances.length > 0 && checkIns.length > 0 && securities.length > 0 && !departureRouteIn(model)) {
      // 5-13 T6: 建設中リンクを含めた将来モデルで成立するなら「完成待ち」として区別する
      if (futureModel && departureRouteIn(futureModel)) sink.add('TERMINAL_DEPARTURE_ROUTE_PENDING', [t.id], {}, t.origin);
      else sink.add('TERMINAL_DEPARTURE_ROUTE', [t.id], {}, t.origin);
    }
  }

  // 保安検査場は一般区域と出発区域の両方に接している
  for (const a of Object.values(model.areas)) {
    if (a.kind !== 'security') continue;
    const near = (model.links[a.id] ?? []).map((l) => model.areas[l.to]!);
    if (!near.some((n) => n.zone === 'landside') || !near.some((n) => n.zone === 'departure' && n.kind !== 'security')) {
      sink.add('SECURITY_NOT_CONNECTED', [a.id], {}, { x: a.x, y: a.y });
    }
  }

  // 国際の境界エリアは両側の区域に接していること（フェーズ 4 §4.2）
  for (const a of Object.values(model.areas)) {
    const nearZones = new Set((model.links[a.id] ?? []).map((l) => model.areas[l.to]!.zone));
    if (a.kind === 'emigration' && (!nearZones.has('departure') || !nearZones.has('departureIntl'))) {
      sink.add('INTL_EMIGRATION_UNLINKED', [a.id], {}, { x: a.x, y: a.y });
    }
    if (a.kind === 'immigration' && (!nearZones.has('arrivalIntl') || !nearZones.has('arrival'))) {
      sink.add('INTL_IMMIGRATION_UNLINKED', [a.id], {}, { x: a.x, y: a.y });
    }
    if (a.kind === 'customs' && (!nearZones.has('arrival') || !nearZones.has('landside'))) {
      sink.add('INTL_CUSTOMS_UNLINKED', [a.id], {}, { x: a.x, y: a.y });
    }
  }

  // 国際・兼用ゲートは国際側の搭乗口・降機口の両方に接していること（フェーズ 4 §4.2）
  for (const g of sortedValues(layout.facilities).filter((f) => f.kind === 'gate')) {
    const rt = g.props.routeType;
    if (rt !== 'international' && rt !== 'swing') continue;
    const access = model.gates[g.id];
    if (!access?.boardingIntl || !access?.deplaneIntl) {
      sink.add(rt === 'international' ? 'INTL_GATE_ZONE' : 'SWING_GATE_ZONE', [g.id], {}, g.origin);
    }
  }

  // 独立ゲートの連絡通路が長すぎる（1.5 km 超）
  for (const c of model.connectors ?? []) {
    const tiles = c.lengthM / CONNECTOR_DETOUR / TILE_M;
    if (tiles > GATE_CONNECTOR_MAX_TILES) sink.add('GATE_CONNECTOR_LONG', [c.gateId, c.terminalId], { tiles: Math.round(tiles) }, layout.facilities[c.gateId]?.origin);
  }

  for (const link of Object.values(layout.terminalLinks ?? {})) {
    if (link.kind !== 'elevatedWalkway') continue;
    // J-1: 下を通る最大コードの宣言があるリンクは全体基準ではなく宣言基準で判定する。
    // 宣言なしリンクの required・既定値・条件は従来と完全一致。
    const declared = link.crossingMaxCode !== undefined ? link.crossingMaxCode : undefined;
    const required = declared ? requiredClearanceForCode(declared) : requiredAircraftClearanceM();
    const clearance = link.aircraftClearanceM ?? (declared ? required : DEFAULT_TERMINAL_LINK_CLEARANCE_M);
    const elevation = link.elevationM ?? (declared ? deckElevationForCode(declared) : DEFAULT_TERMINAL_LINK_ELEVATION_M);
    if (clearance < required || elevation < clearance || (declared !== undefined && elevation < deckElevationForCode(declared))) {
      const area = layout.terminalAreas[link.fromAreaId];
      sink.add('TERMINAL_LINK_CLEARANCE', [link.id], { clearance, required, elevation }, area?.origin);
    }
  }

  // 歩行ポータル（5-16）: 階・階層が相手と食い違うポータルは接続として機能しない
  for (const portal of Object.values(layout.portals ?? {})) {
    const facility = layout.facilities[portal.facilityId];
    const area = layout.terminalAreas[portal.areaId];
    if (!facility || !area) continue;
    if (portal.floorIndex !== area.level || portal.mapLevel !== facilityLevel(facility)) {
      // J-1: 階の併記ラベル（エリア側ターミナルを基点にした実効階）も渡し、メッセージで統一表記にする
      const areaBase = layout.facilities[area.terminalId] ? facilityLevel(layout.facilities[area.terminalId]!) : 0;
      sink.add('PORTAL_LEVEL_MISMATCH', [portal.id], {
        floorIndex: portal.floorIndex,
        areaLevel: area.level,
        portalFloorLabel: floorDisplayLabel(areaBase + portal.floorIndex),
        areaFloorLabel: floorDisplayLabel(areaBase + area.level),
      }, facility.origin);
    }
  }

  // 歩行ポータル（5-16 T4）: ポータル施設から入口/出口への接続状態を複合グラフで診断する。
  // 運用中なら何も出さない。建設中でのみ届く方向は「完成待ち」、完成後も届かない方向は未接続とする
  for (const st of verifyPortalAccess(layout)) {
    const facility = layout.facilities[st.facilityId];
    if (!facility) continue;
    if (st.toEntrance === 'underConstruction' || st.fromExit === 'underConstruction') {
      sink.add('PORTAL_CONNECTION_PENDING', [st.facilityId], { toEntrance: st.toEntrance, fromExit: st.fromExit }, facility.origin);
    }
    if (st.toEntrance === 'unreachable' || st.fromExit === 'unreachable') {
      sink.add('PORTAL_UNREACHABLE', [st.facilityId], { toEntrance: st.toEntrance, fromExit: st.fromExit }, facility.origin);
    }
  }

  // ゲート: 搭乗口・降機口があり、入口から保安検査を経て到達でき、降機口から出口へ出られる
  for (const g of sortedValues(layout.facilities).filter((f) => f.kind === 'gate')) {
    const access = model.gates[g.id];
    // 2 つ以上のターミナルに接し、接続先（connectedTo）の指定もないゲートは所属を決めない（1-10 / T-1）。対象はゲート、関連はターミナル群
    if (access?.ambiguousTerminalIds && access.ambiguousTerminalIds.length > 1) {
      sink.add('GATE_TERMINAL_AMBIGUOUS', [g.id], {}, g.origin, access.ambiguousTerminalIds);
      continue;
    }
    if (!access?.terminalId) continue;
    // 入口・保安・出口・受取の候補はリンク複合体（サテライト対応）から取る。
    // 現在モデルは運用中リンクの複合体、将来モデルは建設中リンクも含めた複合体で判定し、
    // 旅客フロー（passengers.ts のサービス解決）と結論を一致させる。実際の到達可否は
    // ここでも findPaxRoute（ゾーン・方向・工事状態を反映したグラフ）で確認する
    const complexNow = complexes.get(access.terminalId) ?? [access.terminalId];
    const complexFuture = futureComplexes.get(access.terminalId) ?? [access.terminalId];
    const idsFor = (m: TerminalModel) => (m === futureModel ? complexFuture : complexNow).flatMap((t) => m.byTerminal[t] ?? []);
    const ofKindIn = (m: TerminalModel, k: TerminalAreaKind) => idsFor(m).filter((id) => m.areas[id]!.kind === k);
    if (!access.boarding) {
      sink.add('GATE_NO_BOARDING_ACCESS', [g.id], {}, g.origin);
    } else {
      const reachableIn = (m: TerminalModel) => ofKindIn(m, 'entrance').some((e) =>
        ofKindIn(m, 'security').some(
          (sec) =>
            findPaxRoute(m, { from: e, goals: new Map([[sec, 0]]) }) &&
            findPaxRoute(m, { from: sec, goals: new Map([[access.boarding!, 0]]) }),
        ),
      );
      if (!reachableIn(model)) {
        // 5-13 T6: 将来モデルで到達できるなら「完成待ち」
        if (futureModel && reachableIn(futureModel)) sink.add('GATE_ROUTE_PENDING', [g.id], {}, g.origin);
        else sink.add('GATE_UNREACHABLE', [g.id], {}, g.origin);
      }
    }

    if (!access.deplane) {
      sink.add('GATE_NO_ARRIVAL_ACCESS', [g.id], {}, g.origin);
    } else {
      const exitsOf = (m: TerminalModel) => new Map(ofKindIn(m, 'exit').map((id) => [id, 0] as const));
      const exits = exitsOf(model);
      if (!findPaxRoute(model, { from: access.deplane, goals: exits })) {
        if (futureModel && findPaxRoute(futureModel, { from: access.deplane, goals: exitsOf(futureModel) })) sink.add('GATE_ROUTE_PENDING', [g.id], {}, g.origin);
        else sink.add('GATE_ARRIVAL_NO_EXIT', [g.id], {}, g.origin);
      }
      const baggageRouteIn = (m: TerminalModel) => {
        const claims = ofKindIn(m, 'baggageClaim').filter((id) => Number(layout.terminalAreas[id]!.props.belts ?? 0) > 0);
        const mExits = exitsOf(m);
        return claims.some((claim) =>
          !!findPaxRoute(m, { from: access.deplane!, goals: new Map([[claim, 0]]) }) &&
          !!findPaxRoute(m, { from: claim, goals: mExits }),
        );
      };
      const claimsNow = ofKindIn(model, 'baggageClaim').filter((id) => Number(layout.terminalAreas[id]!.props.belts ?? 0) > 0);
      if (claimsNow.length > 0 && !baggageRouteIn(model)) {
        if (futureModel && baggageRouteIn(futureModel)) sink.add('GATE_ROUTE_PENDING', [g.id], {}, g.origin);
        else sink.add('GATE_ARRIVAL_NO_BAGGAGE_ROUTE', [g.id], {}, g.origin);
      }
    }
  }

  // A remote stand's configured terminal is the bus gate's terminal. Check
  // assignments against the same two-direction access rule used at runtime.
  const busGateIds = sortedValues(layout.facilities)
    .filter((f) => f.kind === 'gate' && gateMode(f) === 'bus')
    .map((f) => f.id);
  const usableBusGateIds = busGateIds.filter((id) => busGateStatus(layout, model, id).usable);
  const remoteStands = sortedValues(layout.stands).filter((stand) =>
    !sortedValues(layout.facilities).some((gate) => gate.kind === 'gate' && gateMode(gate) !== 'bus' && gate.props.standId === stand.id),
  );
  const hasRampBuses = sortedValues(layout.facilities)
    .filter((f) => f.kind === 'gseBase' && f.buildState === 'operational' && !f.parentFacilityId)
    .some((base) => apronBusesOf(base) > 0);
  // 所属ターミナル（Stand.terminalId。1-11 / K-1）: 決定規則は resolveBusGateForStand（運航・計画・画面と共通）が唯一の仕様
  const remoteIds = new Set(remoteStands.map((st) => st.id));
  for (const stand of sortedValues(layout.stands)) {
    if (stand.terminalId === undefined) continue;
    const terminal = layout.facilities[stand.terminalId];
    if (terminal?.kind !== 'terminal') {
      sink.add('STAND_TERMINAL_INVALID', [stand.id], {}, stand.origin);
    } else if (!remoteIds.has(stand.id)) {
      sink.add('STAND_TERMINAL_IGNORED', [stand.id], { reason: 'fixed' }, stand.origin, [terminal.id]);
    } else if (stand.remoteBoarding === 'none') {
      sink.add('STAND_TERMINAL_IGNORED', [stand.id], { reason: 'none' }, stand.origin, [terminal.id]);
    }
  }
  for (const stand of remoteStands) {
    if (stand.remoteBoarding === 'none') continue;
    const explicitlyConfigured = stand.remoteBoarding === 'bus';
    const pinned = stand.terminalId !== undefined && layout.facilities[stand.terminalId]?.kind === 'terminal' ? stand.terminalId : null;
    const mustResolve = explicitlyConfigured || stand.remoteBoarding === 'auto' || terminals.length > 1 || pinned !== null;
    // 所属ターミナルを指定したスポットは、そのターミナルのゲートだけを候補にする（別のターミナルへは移さない）
    const candidateGateIds = pinned === null ? usableBusGateIds : usableBusGateIds.filter((id) => busGateStatus(layout, model, id).terminalId === pinned);
    if (explicitlyConfigured) {
      const status = busGateStatus(layout, model, stand.busGateId);
      if (!status.usable) {
        const targets = [stand.id, ...(stand.busGateId && layout.facilities[stand.busGateId] ? [stand.busGateId] : [])];
        sink.add('STAND_BUS_GATE_INVALID', targets, { problem: status.problem ?? 'missing', gateId: stand.busGateId ?? '' }, stand.origin);
        continue;
      }
      if (pinned !== null && status.terminalId !== pinned) {
        sink.add('STAND_TERMINAL_MISMATCH', [stand.id, stand.busGateId!], {}, stand.origin, [pinned]);
        continue;
      }
    } else if (mustResolve && candidateGateIds.length === 0) {
      if (pinned !== null) sink.add('STAND_TERMINAL_NO_BUS_GATE', [stand.id], {}, stand.origin, [pinned]);
      else sink.add('STAND_BUS_NO_GATE', [stand.id], {}, stand.origin);
      continue;
    }
    if (mustResolve && !hasRampBuses && candidateGateIds.length > 0) {
      const gateId = explicitlyConfigured ? stand.busGateId! : candidateGateIds[0]!;
      sink.add('STAND_BUS_NO_VEHICLES', [stand.id, gateId], {}, stand.origin);
    }
  }
}

/** 独立ゲートの連絡通路（ゲートの中心 → 接続先のエリアの中心の直線）が滑走路の本体・着陸帯を横切る */
function checkConnectorRunways(layout: AirportLayout, parts: FootprintPart[], model: TerminalModel, sink: IssueSink): void {
  if (!model.connectors) return;
  const runwayTiles = new Map<string, Set<string>>();
  for (const p of parts) {
    if (p.layer !== 'runway' && p.layer !== 'strip') continue;
    let set = runwayTiles.get(p.ownerId);
    if (!set) runwayTiles.set(p.ownerId, (set = new Set()));
    for (const t of p.tiles) set.add(tileKey(t.x, t.y));
  }
  if (runwayTiles.size === 0) return;
  const runwayIds = [...runwayTiles.keys()].sort(compareIds);
  for (const c of model.connectors) {
    const g = layout.facilities[c.gateId];
    const anchor = model.areas[(c.depAnchor ?? c.arrAnchor) ?? ''];
    if (!g || !anchor) continue;
    const seg = rasterizeSegment({ x: g.origin.x + 0.5, y: g.origin.y + 0.5 }, anchor.center);
    for (const rid of runwayIds) {
      const set = runwayTiles.get(rid)!;
      const hit = seg.find((t) => set.has(tileKey(t.x, t.y)));
      if (hit) sink.add('GATE_CONNECTOR_CROSSES_RUNWAY', [c.gateId, rid], {}, hit);
    }
  }
}

// ---------------------------------------------------------------- 全体

function checkFacilityHierarchy(layout: AirportLayout, sink: IssueSink): void {
  for (const facility of Object.values(layout.facilities)) {
    if (!facility.parentFacilityId) continue;
    const parent = layout.facilities[facility.parentFacilityId];
    if (!parent || parent.id === facility.id || parent.parentFacilityId || parent.kind === 'gate' || FACILITY_SPECS[parent.kind].layer !== 'building') {
      sink.add('FACILITY_INTERIOR_INVALID', [facility.id, facility.parentFacilityId], {}, facility.origin);
      continue;
    }
    const floor = facility.floorIndex ?? 0;
    if (floor < -5 || floor >= Number(parent.props.levels ?? 1) || facilityLevel(facility) !== facilityLevel(parent)) {
      sink.add('FACILITY_INTERIOR_INVALID', [facility.id, parent.id], { floor, floorLabel: floorDisplayLabel(facilityLevel(parent) + floor) }, facility.origin);
      continue;
    }
    const parentTiles = new Set(facilityTiles(parent).map((tile) => tileKey(tile.x, tile.y)));
    if (!facilityTiles(facility).every((tile) => parentTiles.has(tileKey(tile.x, tile.y)))) {
      sink.add('FACILITY_INTERIOR_OUTSIDE', [facility.id, parent.id], {}, facility.origin);
    }
  }
}

export function analyzeLayout(layout: AirportLayout): LayoutAnalysis {
  const sink = new IssueSink();
  const parts = collectFootprints(layout);
  const network = buildAirsideNetwork(layout);
  const terminal = buildTerminalModel(layout);
  const isolatedEdges = new Set<string>();

  if (Object.keys(layout.runways).length === 0) sink.add('NO_RUNWAY', []);
  const has = (k: string) => Object.values(layout.facilities).some((f) => f.kind === k && !f.parentFacilityId);
  if (!has('tower')) sink.add('NO_TOWER', []);
  // 地上支援の基地: スポットがあるのに無いと折り返し作業ができない
  if (Object.keys(layout.stands).length > 0) {
    if (!has('gseBase')) sink.add('NO_GSE_BASE', []);
    if (!has('fuelFarm')) sink.add('NO_FUEL_FARM', []);
    if (!has('maintenance')) sink.add('NO_MAINTENANCE', []);
    if (Object.values(layout.terminalAreas).some((a) => a.kind === 'checkIn') && !has('baggageSort')) sink.add('NO_BAGGAGE_SORT', []);
  }

  checkPlacement(layout, parts, sink, network);
  checkNetworkGeometry(layout.taxiNodes, layout.taxiways, 'TAXIWAY_CROSSING_NO_JUNCTION', sink);
  checkNetworkGeometry(layout.roadNodes, layout.roads, 'ROAD_CROSSING_NO_JUNCTION', sink);
  checkRoadLayers(layout, sink);
  checkAirside(layout, network, sink, isolatedEdges);
  checkRunwayRules(layout, sink);
  checkHoldShort(layout, network, sink);
  checkFacilities(layout, parts, sink);
  checkBoardingBridges(layout, sink);
  checkFacilityHierarchy(layout, sink);
  checkRoads(layout, parts, sink);
  checkAccess(layout, sink);
  // 5-13 T6: 建設中リンクがある場合だけ将来モデルも作り、経路診断で「完成待ち」を区別する
  const hasPendingLink = Object.values(layout.terminalLinks ?? {}).some((l) => l.buildState === 'underConstruction');
  checkTerminals(layout, terminal, sink, hasPendingLink ? buildTerminalModel(layout, { includeUnderConstruction: true }) : undefined);
  checkConnectorRunways(layout, parts, terminal, sink);

  const issues = sink.issues;
  const byTarget: Record<string, Issue[]> = {};
  for (const iss of issues) for (const t of iss.targets) (byTarget[t] ??= []).push(iss);
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const iss of issues) counts[iss.severity]++;

  // 運用可否
  const operability: Record<string, Operability> = {};
  const hasError = (id: string) => (byTarget[id] ?? []).some((i) => i.severity === 'error');
  const judge = (id: string, completed: boolean, extra: OperabilityReason[] = []) => {
    const reasons: OperabilityReason[] = [];
    if (!completed) reasons.push('NOT_COMPLETED');
    if (hasError(id)) reasons.push('HAS_ERRORS');
    reasons.push(...extra);
    operability[id] = { operable: reasons.length === 0, reasons };
  };
  for (const r of Object.values(layout.runways)) {
    const hasOperationalEntry = (network.runwayNodes[r.id] ?? []).some((n) =>
      [...(network.outgoing[n] ?? []), ...(network.incoming[n] ?? [])].some((eid) => {
        const e = network.edges[eid]!;
        return e.kind === 'taxiway' && e.operational;
      }),
    );
    judge(r.id, r.buildState === 'operational', hasOperationalEntry ? [] : ['NO_OPERATIONAL_ROUTE']);
  }
  for (const e of Object.values(layout.taxiways)) {
    judge(e.id, e.buildState === 'operational', isolatedEdges.has(e.id) ? ['ISOLATED'] : []);
  }
  for (const e of Object.values(layout.roads)) judge(e.id, e.buildState === 'operational');
  for (const s of Object.values(layout.stands)) {
    const routeOk =
      standReachesRunway(layout, network, s.id, s.size, 'forward', true) &&
      standReachesRunway(layout, network, s.id, s.size, 'reverse', true);
    judge(s.id, s.buildState === 'operational', routeOk ? [] : ['NO_OPERATIONAL_ROUTE']);
  }
  for (const f of Object.values(layout.facilities)) judge(f.id, f.buildState === 'operational');
  for (const n of Object.values(layout.taxiNodes)) {
    judge(n.id, network.nodes[n.id]?.operational ?? false);
  }
  for (const n of Object.values(layout.roadNodes)) {
    judge(n.id, edgesOfNode(layout.roads, n.id).some((e) => e.buildState === 'operational'));
  }

  for (const a of Object.values(layout.terminalAreas)) judge(a.id, true);

  return { network, terminal, issues, byTarget, operability, counts };
}
