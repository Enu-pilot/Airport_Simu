import { FACILITY_SPECS, GATE_MAX_STAND_DISTANCE, type FootprintLayer } from '../model/catalog';
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
import { collectFootprints, facilityTiles, standTiles, type FootprintPart } from '../layout/footprint';
import { edgesOfNode, type AnyEdge } from '../layout/network';
import { positionOnRunway, runwayAxis, runwayEnd, runwayMaxSize } from '../layout/runway';
import { designatorsOf } from '../layout/designators';
import { holdWalkLimitM, walkToClear, type HoldRunway } from '../layout/holdShort';
import { resolveRunwayDims } from '../layout/runwayAreas';
import { classifySegmentIntersection } from '../geometry/segment';
import { satOverlapConvex } from '../geometry/polygon';
import { TILE_M } from '../model/catalog';
import type { NetNode, TerminalAreaKind } from '../model/types';
import { areaRectTiles, buildTerminalModel, type TerminalModel } from '../terminal/model';
import { findPaxRoute } from '../terminal/route';
import { ACCESS_MAX_WALK_TILES, buildLandsideNetwork, distanceToTerminal, touchesTiles } from '../access/landside';

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
  | 'STAND_NO_RUNWAY_ROUTE'
  | 'STAND_ROUTE_SIZE_LIMITED'
  | 'STAND_ONE_WAY_TRAP'
  | 'STAND_REMOTE'
  | 'STAND_MULTIPLE_GATES'
  | 'GATE_NOT_AT_TERMINAL'
  | 'GATE_NO_STAND'
  | 'GATE_STAND_TOO_FAR'
  // 施設・道路
  | 'NO_AIRSIDE_ACCESS'
  | 'TERMINAL_NO_ROAD'
  | 'TERMINAL_NO_GATE'
  | 'PARKING_NO_ROAD'
  | 'ROAD_NO_ENTRANCE'
  | 'ROAD_CROSSING_NO_JUNCTION'
  // 空港アクセス
  | 'ACCESS_NOT_CONNECTED'
  | 'STATION_NO_RAIL'
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
  | 'GATE_NO_BOARDING_ACCESS'
  | 'GATE_NO_ARRIVAL_ACCESS'
  | 'GATE_UNREACHABLE'
  | 'GATE_ARRIVAL_NO_EXIT'
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
  STAND_MULTIPLE_GATES: 'warning',
  GATE_NOT_AT_TERMINAL: 'error',
  GATE_NO_STAND: 'warning',
  GATE_STAND_TOO_FAR: 'error',
  NO_AIRSIDE_ACCESS: 'warning',
  TERMINAL_NO_ROAD: 'warning',
  TERMINAL_NO_GATE: 'info',
  PARKING_NO_ROAD: 'warning',
  ROAD_NO_ENTRANCE: 'warning',
  ROAD_CROSSING_NO_JUNCTION: 'warning',
  ACCESS_NOT_CONNECTED: 'warning',
  STATION_NO_RAIL: 'warning',
  ACCESS_FAR_FROM_TERMINAL: 'warning',
  TERMINAL_AREA_OUTSIDE: 'error',
  TERMINAL_AREA_OVERLAP: 'error',
  TERMINAL_NO_ENTRANCE: 'warning',
  TERMINAL_NO_EXIT: 'warning',
  TERMINAL_NO_CHECKIN: 'warning',
  TERMINAL_NO_SECURITY: 'warning',
  TERMINAL_NO_BAGGAGE_CLAIM: 'warning',
  SECURITY_NOT_CONNECTED: 'warning',
  GATE_NO_BOARDING_ACCESS: 'warning',
  GATE_NO_ARRIVAL_ACCESS: 'warning',
  GATE_UNREACHABLE: 'warning',
  GATE_ARRIVAL_NO_EXIT: 'warning',
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
  const occ = new Map<string, { ownerId: string; layer: FootprintLayer }[]>();
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
    for (const t of p.tiles) {
      const k = tileKey(t.x, t.y);
      let list = occ.get(k);
      if (!list) occ.set(k, (list = []));
      list.push({ ownerId: p.ownerId, layer: p.layer });
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

  /** 2 つの占有の組を判定する（real = 自由形の多角形による判定） */
  const judge = (
    a: { ownerId: string; layer: FootprintLayer },
    b: { ownerId: string; layer: FootprintLayer },
    at: Tile,
    real: boolean,
  ): void => {
    if (a.ownerId === b.ownerId) return;
    if (COMPATIBLE.has(`${a.layer}|${b.layer}`)) return;
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
    const [x, y] = k.split(',').map(Number) as [number, number];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) judge(list[i]!, list[j]!, { x, y }, false);
    }
  }

  // 自由形（多角形）の判定: 従来の占有（タイルの正方形）と、別の自由形の多角形。従来形だけなら空ループ
  const polys = parts.filter((p) => p.poly);
  for (const p of polys) {
    for (const t of p.tiles) {
      for (const o of occ.get(tileKey(t.x, t.y)) ?? []) judge({ ownerId: p.ownerId, layer: p.layer }, o, t, true);
    }
  }
  const boxes = polys.map((p) => polyBBox(p.poly!));
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      const A = polys[i]!;
      const B = polys[j]!;
      if (A.ownerId === B.ownerId) continue;
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
    const off = standTiles(s).find((t) => !(occ.get(tileKey(t.x, t.y)) ?? []).some((o) => o.layer === 'apron'));
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
    const k = tileKey(n.pos.x, n.pos.y);
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
  for (const f of facilities) {
    const tiles = facilityTiles(f);
    const spec = FACILITY_SPECS[f.kind];
    if (spec.needsAirsideAccess && !touches(tiles, airsideAccess)) sink.add('NO_AIRSIDE_ACCESS', [f.id], {}, f.origin);
    if (f.kind === 'terminal') {
      if (!touches(tiles, publicRoad)) sink.add('TERMINAL_NO_ROAD', [f.id], {}, f.origin);
      const own = new Set(tiles.map((t) => tileKey(t.x, t.y)));
      const hasGate = facilities.some(
        (g) => g.kind === 'gate' && neighborTiles(facilityTiles(g)).some((t) => own.has(tileKey(t.x, t.y))),
      );
      if (!hasGate) sink.add('TERMINAL_NO_GATE', [f.id], {}, f.origin);
    }
    if (f.kind === 'parking' && !touches(tiles, anyRoad, true)) sink.add('PARKING_NO_ROAD', [f.id], {}, f.origin);
    if (f.kind === 'gate') {
      if (!touches(tiles, terminalTiles)) sink.add('GATE_NOT_AT_TERMINAL', [f.id], {}, f.origin);
      const standId = typeof f.props.standId === 'string' ? f.props.standId : null;
      const stand = standId ? layout.stands[standId] : undefined;
      if (!stand) {
        sink.add('GATE_NO_STAND', [f.id], {}, f.origin);
      } else {
        gatesByStand.set(stand.id, [...(gatesByStand.get(stand.id) ?? []), f.id]);
        const dist = chebyshevDistance(tiles, standTiles(stand));
        if (dist > GATE_MAX_STAND_DISTANCE) sink.add('GATE_STAND_TOO_FAR', [f.id], { distance: dist }, f.origin, [stand.id]);
      }
    }
  }
  for (const s of sortedValues(layout.stands)) {
    const gates = gatesByStand.get(s.id) ?? [];
    if (gates.length === 0) sink.add('STAND_REMOTE', [s.id], {}, s.origin);
    if (gates.length > 1) sink.add('STAND_MULTIPLE_GATES', [s.id, ...gates], {}, s.origin);
  }
}

function checkRoads(layout: AirportLayout, parts: FootprintPart[], sink: IssueSink): void {
  const uf = new UnionFind();
  for (const e of Object.values(layout.roads)) if (e.roadClass !== 'rail') uf.union(e.from, e.to);
  const comps = new Map<string, string[]>();
  for (const e of sortedValues(layout.roads)) {
    if (e.roadClass !== 'public') continue;
    const root = uf.find(e.from);
    comps.set(root, [...(comps.get(root) ?? []), e.id]);
  }
  for (const ids of comps.values()) {
    const reachesEdge = parts
      .filter((p) => p.layer === 'roadPublic' && ids.includes(p.ownerId))
      .some((p) => p.tiles.some((t) => isSiteEdge(layout.site, t.x, t.y)));
    // 同じ連結成分のサービス道路が出口に届いていても可
    const viaService = Object.values(layout.roads)
      .filter((e) => e.roadClass !== 'rail' && uf.find(e.from) === uf.find(layout.roads[ids[0]!]!.from))
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

/** 空港アクセスの施設: 外部とつながる道路・鉄道、ターミナルまでの距離 */
function checkAccess(layout: AirportLayout, sink: IssueSink): void {
  const kinds = ['taxiStand', 'busStop', 'railStation', 'staffParking', 'hotel'];
  const facilities = sortedValues(layout.facilities).filter((f) => kinds.includes(f.kind));
  if (facilities.length === 0) return;
  const net = buildLandsideNetwork(layout);
  for (const f of facilities) {
    if (f.kind === 'railStation') {
      if (!touchesTiles(f, net.railTiles)) sink.add('STATION_NO_RAIL', [f.id], {}, f.origin);
    } else if (!touchesTiles(f, f.kind === 'staffParking' ? net.anyRoadTiles : net.publicTiles)) {
      sink.add('ACCESS_NOT_CONNECTED', [f.id], {}, f.origin);
    }
    if (f.kind !== 'staffParking') {
      const d = distanceToTerminal(layout, f);
      if (d > ACCESS_MAX_WALK_TILES) sink.add('ACCESS_FAR_FROM_TERMINAL', [f.id], { distance: Number.isFinite(d) ? d : -1 }, f.origin);
    }
  }
}

// ---------------------------------------------------------------- ターミナル内部

function checkTerminals(layout: AirportLayout, model: TerminalModel, sink: IssueSink): void {
  // 配置: ターミナルの敷地・階の範囲内、同じ階で重ならない
  const areas = sortedValues(layout.terminalAreas);
  for (const a of areas) {
    const t = layout.facilities[a.terminalId];
    const inside =
      !!t &&
      t.kind === 'terminal' &&
      a.level >= 0 &&
      a.level < Number(t.props.levels ?? 1) &&
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
  for (const t of terminals) {
    const kinds = new Set((model.byTerminal[t.id] ?? []).map((id) => model.areas[id]!.kind));
    for (const [kind, code] of required) if (!kinds.has(kind)) sink.add(code, [t.id], {}, t.origin);
  }

  // 保安検査場は一般区域と出発区域の両方に接している
  for (const a of Object.values(model.areas)) {
    if (a.kind !== 'security') continue;
    const near = (model.links[a.id] ?? []).map((l) => model.areas[l.to]!);
    if (!near.some((n) => n.zone === 'landside') || !near.some((n) => n.zone === 'departure' && n.kind !== 'security')) {
      sink.add('SECURITY_NOT_CONNECTED', [a.id], {}, { x: a.x, y: a.y });
    }
  }

  // ゲート: 搭乗口・降機口があり、入口から保安検査を経て到達でき、降機口から出口へ出られる
  for (const g of sortedValues(layout.facilities).filter((f) => f.kind === 'gate')) {
    const access = model.gates[g.id];
    if (!access?.terminalId) continue;
    const ids = model.byTerminal[access.terminalId] ?? [];
    const ofKind = (k: TerminalAreaKind) => ids.filter((id) => model.areas[id]!.kind === k);
    if (!access.boarding) {
      sink.add('GATE_NO_BOARDING_ACCESS', [g.id], {}, g.origin);
    } else {
      const securities = ofKind('security');
      const reachable = ofKind('entrance').some((e) =>
        securities.some(
          (sec) =>
            findPaxRoute(model, { from: e, goals: new Map([[sec, 0]]) }) &&
            findPaxRoute(model, { from: sec, goals: new Map([[access.boarding!, 0]]) }),
        ),
      );
      if (!reachable) sink.add('GATE_UNREACHABLE', [g.id], {}, g.origin);
    }
    if (!access.deplane) {
      sink.add('GATE_NO_ARRIVAL_ACCESS', [g.id], {}, g.origin);
    } else {
      const exits = new Map(ofKind('exit').map((id) => [id, 0] as const));
      if (!findPaxRoute(model, { from: access.deplane, goals: exits })) sink.add('GATE_ARRIVAL_NO_EXIT', [g.id], {}, g.origin);
    }
  }
}

// ---------------------------------------------------------------- 全体

export function analyzeLayout(layout: AirportLayout): LayoutAnalysis {
  const sink = new IssueSink();
  const parts = collectFootprints(layout);
  const network = buildAirsideNetwork(layout);
  const terminal = buildTerminalModel(layout);
  const isolatedEdges = new Set<string>();

  if (Object.keys(layout.runways).length === 0) sink.add('NO_RUNWAY', []);
  const has = (k: string) => Object.values(layout.facilities).some((f) => f.kind === k);
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
  checkAirside(layout, network, sink, isolatedEdges);
  checkRunwayRules(layout, sink);
  checkHoldShort(layout, network, sink);
  checkFacilities(layout, parts, sink);
  checkRoads(layout, parts, sink);
  checkAccess(layout, sink);
  checkTerminals(layout, terminal, sink);

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
