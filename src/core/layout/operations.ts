import { runwayDimsProblem } from '../model/runwayReference';
import { AGT_SEGMENT_DETOUR, DEFAULT_PROPS, FACILITY_SPECS, FREE_RUNWAY_MAX_M, FREE_RUNWAY_MIN_M, PROP_SCHEMAS, TAXI_BLOCK_MAX_AIRCRAFT, TAXI_BLOCK_TILES_DEFAULT, TAXI_BLOCK_TILES_MAX, TAXI_BLOCK_TILES_MIN, TERMINAL_AREA_SPECS, TILE_M, type PbbBridgeType, type PbbDeck } from '../model/catalog';
import { PBB_ENTRY_RANGE, explicitPbbForGate, pbbDeckOf } from '../model/boardingBridge';
import { gateMode } from '../model/gates';
import { agtParamProblem, agtStationSystemId } from '../model/agt';
import { agtStationConnectedAreas, agtStationMapLevel } from '../terminal/agt';
import { baseTerrainAt, createSite, inSite, isBuildable, terrainAt } from '../model/site';
import {
  BUILD_STATES,
  HEADINGS,
  SCHEMA_VERSION,
  entityTypeOf,
  isFreeRunway,
  type AgtSystem,
  type AirportLayout,
  type BuildState,
  type Facility,
  type FacilityKind,
  type Heading,
  type PropValue,
  type RoadClass,
  type RoadEdge,
  type Rotation,
  type RunwayDims,
  type RunwayFree,
  type RunwayGrid8,
  type RunwaySuffix,
  type SizeClass,
  type Site,
  type Stand,
  type PaxZone,
  type TerminalArea,
  type TerminalAreaKind,
  type TerminalTransitKind,
  type CrossingMaxCode,
  Terrain,
} from '../model/types';
import { add, distance, sameTile, tileKey, type Tile } from '../geometry/vec';
import { bearingToDir, dirToBearing, normalizeDeg } from '../geometry/angle';
import type { WorldPoint } from '../geometry/frames';
import { sortedValues } from '../model/ids';
import { collectFootprints, facilityDims, facilityTiles, originAfterRotation, standDims, standEntry, type FootprintPart } from './footprint';
import {
  addPath,
  allocId,
  edgesOfNode,
  ensureNodeAt,
  findNodeAt,
  netEdges,
  netNodes,
  removeEdge,
  removeNode,
  taxiwayRouteEdges,
  type NetKind,
} from './network';
import { headingVector, runwayAxis, runwayEnd, runwayMidpoint } from './runway';
import { floorRangeInUse, terminalFloorRange, terminalFloorRangeOf, undergroundFacilityProblem } from './levelRules';
import { DEFAULT_LEVEL_HEIGHT_M, facilityLevel, roadEdgeLevelValid } from '../model/levels';
import { orthogonalPolygonTiles, validateOrthogonalPolygon } from '../geometry/polygon';
import { DEFAULT_TERMINAL_LINK_CLEARANCE_M, DEFAULT_TERMINAL_LINK_ELEVATION_M, DEFAULT_TERMINAL_LINK_WIDTH_M } from '../terminal/model';
import { connectionSegmentLevel, deriveConnectionStepFree } from '../terminal/connectionFacility';
import { deckElevationForCode, requiredAircraftClearanceM, requiredClearanceForCode } from '../sim/aircraftTypes';

/**
 * 編集操作。すべて純粋関数で、入力レイアウトを変更せず新しいレイアウトを返す。
 * 失敗時は理由コードを返し、レイアウトは変化しない（Undo 履歴にも積まれない）。
 */

export type OpFailure =
  | 'NOT_FOUND'
  | 'NOT_SUPPORTED'
  | 'INVALID_VALUE'
  | 'NODE_EXISTS'
  | 'EMPTY_PATH'
  | 'NO_CHANGE'
  | 'LAND_NOT_ADJACENT'
  | 'LEVEL_MISMATCH'
  | 'INVALID_CONNECTOR'
  /** 自由形をグリッドに合わせたとき、長さが従来形の最大（MAX_RUNWAY_LENGTH ステップ）を超える */
  | 'TOO_LONG_FOR_GRID';

export type OpResult =
  | { ok: true; layout: AirportLayout; created: string[] }
  | { ok: false; reason: OpFailure };

const fail = (reason: OpFailure): OpResult => ({ ok: false, reason });
const ok = (layout: AirportLayout, created: string[] = []): OpResult => ({ ok: true, layout, created });

const SIZES: readonly SizeClass[] = ['S', 'M', 'L'];
const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
const RUNWAY_WIDTHS = [30, 45, 60] as const;
export const MAX_RUNWAY_LENGTH = 200;

export function createEmptyLayout(site: Site = createSite(), name = '新しい空港'): AirportLayout {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    site,
    counters: {},
    runways: {},
    taxiNodes: {},
    taxiways: {},
    roadNodes: {},
    roads: {},
    stands: {},
    facilities: {},
    terminalAreas: {},
  };
}

/** 敷地（大きな地形配列）は不変として共有し、それ以外を深いコピーする */
export function cloneLayout(layout: AirportLayout): AirportLayout {
  const { site, ...rest } = layout;
  return { ...structuredClone(rest), site };
}

/**
 * 全操作の後処理。
 * - スポット入口が誘導路エッジの途中にあれば分割してノードを作る（スポットの接続点）
 * - 削除済みスポットを参照するゲートの紐付けを解除する
 */
function finalize(d: AirportLayout): AirportLayout {
  for (const s of sortedValues(d.stands)) ensureNodeAt(d, 'taxi', standEntry(s), false);
  for (const f of Object.values(d.facilities)) {
    if (f.kind === 'gate' && typeof f.props.standId === 'string' && !d.stands[f.props.standId]) {
      f.props.standId = null;
    }
    // 削除済み（またはターミナルでなくなった）施設を指す connectedTo はキーごと消す（従来のゲートはキーがないので不変）
    if (f.kind === 'gate' && f.props.connectedTo !== undefined && f.props.connectedTo !== null) {
      const t = d.facilities[String(f.props.connectedTo)];
      if (!t || t.kind !== 'terminal') delete f.props.connectedTo;
    }
  }
  for (const s of Object.values(d.stands)) {
    // 削除済み（またはターミナルでなくなった）施設を指す terminalId もキーごと消す（旧データはキーがないので不変）
    if (s.terminalId !== undefined && d.facilities[s.terminalId]?.kind !== 'terminal') delete s.terminalId;
    if (s.busGateId && (d.facilities[s.busGateId]?.kind !== 'gate' || d.facilities[s.busGateId]?.props.boardingMode !== 'bus')) s.busGateId = null;
  }
  for (const [id, link] of Object.entries(d.terminalLinks ?? {})) {
    if (!d.terminalAreas[link.fromAreaId] || !d.terminalAreas[link.toAreaId]) delete d.terminalLinks![id];
  }
  for (const [id, portal] of Object.entries(d.portals ?? {})) {
    if (!d.facilities[portal.facilityId] || !d.terminalAreas[portal.areaId]) delete d.portals![id];
  }
  // AGT（機能I）: 系統・駅が消えたセグメントは記録ごと落とす（リンク・ポータルの従来扱いに合わせる）
  for (const [id, seg] of Object.entries(d.agtSegments ?? {})) {
    const from = d.facilities[seg.fromStationId];
    const to = d.facilities[seg.toStationId];
    if (!d.agtSystems?.[seg.systemId] || from?.kind !== 'agtStation' || to?.kind !== 'agtStation') delete d.agtSegments![id];
  }
  for (const [id, cf] of Object.entries(d.connectionFacilities ?? {})) {
    // 通路段（リンク / AGT セグメント）が消えた複合連絡施設は記録ごと落とす（リンク・ポータルの従来扱いに合わせる）
    if (cf.segment.kind === 'link' && !d.terminalLinks?.[cf.segment.linkId]) {
      delete d.connectionFacilities![id];
      continue;
    }
    if (cf.segment.kind === 'agt' && !d.agtSegments?.[cf.segment.segmentId]) {
      delete d.connectionFacilities![id];
      continue;
    }
    // 削除された垂直エリアは束ねから外す（残りの不整合は検証 CONNECTION_FACILITY_* が扱う）
    cf.aVerticalAreaIds = cf.aVerticalAreaIds.filter((a) => d.terminalAreas[a]);
    cf.bVerticalAreaIds = cf.bVerticalAreaIds.filter((a) => d.terminalAreas[a]);
  }
  return d;
}

// ---------------------------------------------------------------- 配置

export interface PlaceFacilityOptions {
  rotation?: Rotation;
  w?: number;
  h?: number;
  buildState?: BuildState;
  name?: string;
  mapLevel?: number;
  parentFacilityId?: string;
  floorIndex?: number;
  props?: Record<string, PropValue>;
}

export function placeFacility(
  layout: AirportLayout,
  kind: FacilityKind,
  origin: Tile,
  opts: PlaceFacilityOptions = {},
): OpResult {
  const spec = FACILITY_SPECS[kind];
  const w = spec.resizable ? (opts.w ?? spec.defaultW) : spec.defaultW;
  const h = spec.resizable ? (opts.h ?? spec.defaultH) : spec.defaultH;
  if (w < spec.minW || h < spec.minH) return fail('INVALID_VALUE');
  if (opts.mapLevel !== undefined && (!Number.isInteger(opts.mapLevel) || opts.mapLevel < -5 || opts.mapLevel > 10)) return fail('INVALID_VALUE');
  if (undergroundFacilityProblem(kind, opts.mapLevel, !!opts.parentFacilityId)) return fail('INVALID_VALUE');
  const parent = opts.parentFacilityId ? layout.facilities[opts.parentFacilityId] : undefined;
  if (opts.parentFacilityId && (!parent || parent.parentFacilityId || FACILITY_SPECS[parent.kind].layer !== 'building' || parent.kind === 'gate')) return fail('INVALID_VALUE');
  const floorIndex = opts.parentFacilityId ? (opts.floorIndex ?? 0) : undefined;
  if (floorIndex !== undefined && (!Number.isInteger(floorIndex) || floorIndex < -5 || floorIndex >= Number(parent?.props.levels ?? 1))) return fail('INVALID_VALUE');
  if (!opts.parentFacilityId && opts.floorIndex !== undefined) return fail('INVALID_VALUE');
  if (parent && opts.mapLevel !== undefined && opts.mapLevel !== facilityLevel(parent)) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  const id = allocId(d, 'fac');
  d.facilities[id] = {
    id,
    kind,
    name: opts.name ?? '',
    origin: { ...origin },
    w,
    h,
    rotation: opts.rotation ?? 0,
    buildState: opts.buildState ?? 'operational',
    ...(opts.mapLevel === undefined ? (parent ? { mapLevel: facilityLevel(parent) } : {}) : { mapLevel: opts.mapLevel }),
    ...(parent ? { parentFacilityId: parent.id, floorIndex: floorIndex! } : {}),
    props: { ...DEFAULT_PROPS[kind], ...opts.props },
  };
  if (parent) {
    const parentTiles = new Set(facilityTiles(parent).map((tile) => tileKey(tile.x, tile.y)));
    if (!facilityTiles(d.facilities[id]!).every((tile) => parentTiles.has(tileKey(tile.x, tile.y)))) return fail('INVALID_VALUE');
  }
  if (kind === 'gate' && d.facilities[id]!.props.standId == null) {
    d.facilities[id]!.props.standId = nearestStandForGate(d, d.facilities[id]!);
  }
  return ok(finalize(d), [id]);
}

/** ゲート配置時に、最も近いスポット（距離が許容範囲内）を自動で紐付ける */
function nearestStandForGate(d: AirportLayout, gate: Facility): string | null {
  let best: { id: string; dist: number } | null = null;
  for (const s of sortedValues(d.stands)) {
    const dims = standDims(s);
    const dx = Math.max(s.origin.x - gate.origin.x, 0, gate.origin.x - (s.origin.x + dims.w - 1));
    const dy = Math.max(s.origin.y - gate.origin.y, 0, gate.origin.y - (s.origin.y + dims.h - 1));
    const dist = Math.max(dx, dy);
    const taken = Object.values(d.facilities).some((f) => f.kind === 'gate' && f.props.standId === s.id);
    if (dist <= 3 && !taken && (!best || dist < best.dist)) best = { id: s.id, dist };
  }
  return best?.id ?? null;
}

/**
 * PBB の占有帯（地上 3〜6m）と重なる既存占有のあるタイルの集合。
 * 従来の pbbTileBlocked 相当の判定（セル占有 × 垂直区間の交差、apron とは両立、
 * 多角形（自由形）の部分は対象外）を、候補タイルごとに全 parts を走査せず
 * 一度だけ計算する。実セーブ規模では collectFootprints と並んで一括付与の
 * 主コストのため、bulk 側で使い回す（判定そのものは不変）。
 */
function pbbBlockedTiles(parts: readonly FootprintPart[]): Set<string> {
  const blocked = new Set<string>();
  const minBand = 3;
  const maxBand = 6;
  for (const p of parts) {
    if (p.poly || p.layer === 'apron') continue;
    const cells = p.occupancy ?? p.tiles.flatMap((t) =>
      (p.levels ?? [p.level ?? 0]).map((level) => ({
        tile: t,
        minM: p.vertical?.minM ?? level * DEFAULT_LEVEL_HEIGHT_M,
        maxM: p.vertical?.maxM ?? level * DEFAULT_LEVEL_HEIGHT_M + 0.4,
      })),
    );
    for (const c of cells) {
      if (c.minM < maxBand && minBand < c.maxM) blocked.add(tileKey(c.tile.x, c.tile.y));
    }
  }
  return blocked;
}

export interface PlaceBoardingBridgeOptions {
  bridgeType?: PbbBridgeType;
  deck?: PbbDeck;
  buildState?: BuildState;
  /**
   * 占有判定に使うブロック済みタイル集合（省略時は collectFootprints から計算）。
   * bulkPlaceBoardingBridges が使い回すための内部フック。呼び出し側は配置のたびに
   * 新設 PBB のタイル（1×1・地上 3〜6m 帯の占有）を追加すること（追加のみの
   * 変更のため再計算と等価）。
   */
  blockedTiles?: ReadonlySet<string>;
}

/**
 * 搭乗橋（PBB、機能H）をゲート×スポットの組に配置する。置き場所はスポット入口
 * （standEntry）の近傍から自動で選ぶ（入口に近い輪 → 入口タイル → 外側の輪の順、
 * 輪の中はゲートに近い順に試し、占有と重ならない最初のタイル）。検証
 * （PBB_NOT_ADJACENT / OVERLAP）と同じ範囲・基準で選ぶため、この操作で置いた
 * PBB は配置エラーにならない。向きは入口（機体側）を向ける。
 */
export function placeBoardingBridge(
  layout: AirportLayout,
  gateId: string,
  standId: string,
  opts: PlaceBoardingBridgeOptions = {},
): OpResult {
  const gate = layout.facilities[gateId];
  const stand = layout.stands[standId];
  if (!gate || gate.kind !== 'gate' || !stand) return fail('NOT_FOUND');
  if (gate.props.standId !== standId) return fail('INVALID_VALUE');
  const deck: PbbDeck = opts.deck ?? 'main';
  const duplicated = Object.values(layout.facilities).some(
    (f) => f.kind === 'boardingBridge' && f.props.gateId === gateId && pbbDeckOf(f) === deck,
  );
  if (duplicated) return fail('INVALID_VALUE');
  const entry = standEntry(stand);
  const dist2 = (t: Tile) => (t.x - gate.origin.x) ** 2 + (t.y - gate.origin.y) ** 2;
  const ring = (r: number): Tile[] => {
    const out: Tile[] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) out.push({ x: entry.x + dx, y: entry.y + dy });
      }
    }
    return out.sort((a, b) => dist2(a) - dist2(b));
  };
  const candidates = [...ring(1), entry, ...(PBB_ENTRY_RANGE >= 2 ? ring(2) : [])];
  const blocked = opts.blockedTiles ?? pbbBlockedTiles(collectFootprints(layout));
  for (const tile of candidates) {
    if (!inSite(layout.site, tile.x, tile.y) || !isBuildable(layout.site, tile.x, tile.y) || blocked.has(tileKey(tile.x, tile.y))) continue;
    const dx = entry.x - tile.x;
    const dy = entry.y - tile.y;
    const rotation: Rotation =
      dx === 0 && dy === 0 ? stand.rotation
        : Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 90 : 270)
          : dy > 0 ? 180 : 0;
    const placed = placeFacility(layout, 'boardingBridge', tile, {
      rotation,
      buildState: opts.buildState ?? 'operational',
      props: { gateId, standId, bridgeType: opts.bridgeType ?? 'tunnel1', deck },
    });
    if (placed.ok) return placed;
  }
  return fail('INVALID_VALUE');
}

/** 全コンタクトゲートへの PBB 一括付与で、付けなかったゲートの理由 */
export type BulkBoardingBridgeSkipReason =
  /** 明示の main デッキ PBB 済み（2本目を作らない） */
  | 'alreadyAttached'
  /** バスゲート（橋を使わない） */
  | 'bus'
  /** スポット紐付けなし */
  | 'noStand'
  /** jetBridge 無効（合成の橋が無いゲート。費用中立の対象外のため付けない） */
  | 'noJetBridge'
  /** 配置場所が見つからない等（placeBoardingBridge が失敗） */
  | 'placementFailed';

export interface BulkBoardingBridgeSkip {
  gateId: string;
  reason: BulkBoardingBridgeSkipReason;
}

export interface BulkBoardingBridgeResult {
  layout: AirportLayout;
  /** 明示 tunnel1（main / operational）を付けたゲート ID（ID 順） */
  attachedGateIds: string[];
  /** 新しく作った PBB 施設 ID（attachedGateIds と同じ順） */
  created: string[];
  /** 付けなかったゲートとその理由（ID 順） */
  skipped: BulkBoardingBridgeSkip[];
}

/**
 * 全コンタクトゲートに搭乗橋（PBB）を一括で付ける（実データ化）。
 * コンタクトゲートを ID 順に走査し、合成のみのゲート（jetBridge 有効・明示 main
 * デッキ PBB なし）に既存の placeBoardingBridge（tunnel1 / main / operational）
 * で明示の橋を付ける。ゲート側の jetBridge 設定は変えない（明示 PBB を消せば
 * 合成に戻る。残った jetBridge は PBB_LEGACY_OVERRIDDEN（info）で知らせる）。
 * 費用は中立のはず: ゲート側の jetBridge 上乗せ 150,000cr が外れ、tunnel1
 * 建設費 150,000cr が PBB 側に移る（constructionCost の差分 0）。
 * 占有（ブロック済みタイル）は一度だけ集計し、配置のたびに新設 PBB のタイルだけ
 * 追加する（追加のみの変更のため再計算と等価）。実セーブ規模では
 * collectFootprints が 1 回 ~0.4s あり、112 回呼ぶと数十秒になるため。
 */
export function bulkPlaceBoardingBridges(layout: AirportLayout): BulkBoardingBridgeResult {
  let current = layout;
  const attachedGateIds: string[] = [];
  const created: string[] = [];
  const skipped: BulkBoardingBridgeSkip[] = [];
  const blocked = pbbBlockedTiles(collectFootprints(layout));
  for (const gate of sortedValues(layout.facilities)) {
    if (gate.kind !== 'gate') continue;
    if (gateMode(gate) === 'bus') {
      skipped.push({ gateId: gate.id, reason: 'bus' });
      continue;
    }
    if (explicitPbbForGate(current, gate.id).some((u) => u.deck === 'main')) {
      skipped.push({ gateId: gate.id, reason: 'alreadyAttached' });
      continue;
    }
    const standId = typeof gate.props.standId === 'string' ? gate.props.standId : null;
    if (!standId || !current.stands[standId]) {
      skipped.push({ gateId: gate.id, reason: 'noStand' });
      continue;
    }
    if (!gate.props.jetBridge) {
      skipped.push({ gateId: gate.id, reason: 'noJetBridge' });
      continue;
    }
    const placed = placeBoardingBridge(current, gate.id, standId, { bridgeType: 'tunnel1', deck: 'main', buildState: 'operational', blockedTiles: blocked });
    if (!placed.ok) {
      skipped.push({ gateId: gate.id, reason: 'placementFailed' });
      continue;
    }
    current = placed.layout;
    attachedGateIds.push(gate.id);
    created.push(...placed.created);
    // 新設 PBB は 1×1・地上 3〜6m 帯の占有なので、そのタイルを blocked へ追加する
    for (const id of placed.created) {
      const f = current.facilities[id];
      if (f) blocked.add(tileKey(f.origin.x, f.origin.y));
    }
  }
  return { layout: current, attachedGateIds, created, skipped };
}

export function placeStand(
  layout: AirportLayout,
  origin: Tile,
  size: SizeClass,
  rotation: Rotation = 0,
  buildState: BuildState = 'operational',
  name = '',
): OpResult {
  const d = cloneLayout(layout);
  const id = allocId(d, 'std');
  d.stands[id] = { id, name, origin: { ...origin }, size, rotation, buildState };
  return ok(finalize(d), [id]);
}

export interface PlaceRunwayOptions {
  surfaceWidthM?: 30 | 45 | 60;
  buildState?: BuildState;
  name?: string;
}

export function placeRunway(
  layout: AirportLayout,
  start: Tile,
  heading: Heading,
  length: number,
  opts: PlaceRunwayOptions = {},
): OpResult {
  if (!Number.isInteger(length) || length < 1 || length > MAX_RUNWAY_LENGTH) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  const id = allocId(d, 'rwy');
  d.runways[id] = {
    id,
    name: opts.name ?? '',
    start: { ...start },
    heading,
    length,
    surfaceWidthM: opts.surfaceWidthM ?? 45,
    buildState: opts.buildState ?? 'operational',
  };
  return ok(finalize(d), [id]);
}

export interface PlaceFreeRunwayOptions extends PlaceRunwayOptions {
  dims?: RunwayDims;
  designatorSuffix?: RunwaySuffix;
}

const finitePoint = (p: WorldPoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * 自由形の滑走路を配置する（始点・真方位・実長）。`dims` と `designatorSuffix` は指定したときだけ保存する。
 * 検証: 始点は有限、方位は有限（normalizeDeg で [0, 360)）、長さは [FREE_RUNWAY_MIN_M, FREE_RUNWAY_MAX_M]、dims は有限で ≥ 0。
 */
export function placeFreeRunway(
  layout: AirportLayout,
  g: { start: WorldPoint; headingDeg: number; lengthM: number },
  opts: PlaceFreeRunwayOptions = {},
): OpResult {
  if (!finitePoint(g.start) || !Number.isFinite(g.headingDeg)) return fail('INVALID_VALUE');
  if (!Number.isFinite(g.lengthM) || g.lengthM < FREE_RUNWAY_MIN_M || g.lengthM > FREE_RUNWAY_MAX_M) return fail('INVALID_VALUE');
  if (opts.surfaceWidthM !== undefined && !RUNWAY_WIDTHS.includes(opts.surfaceWidthM)) return fail('INVALID_VALUE');
  if (opts.designatorSuffix !== undefined && !isSuffix(opts.designatorSuffix)) return fail('INVALID_VALUE');
  const dims = opts.dims === undefined ? undefined : sanitizeDims(opts.dims);
  if (dims === null) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  const id = allocId(d, 'rwy');
  const r: RunwayFree = {
    id,
    name: opts.name ?? '',
    alignment: 'free',
    start: { x: g.start.x, y: g.start.y },
    headingDeg: normalizeDeg(g.headingDeg),
    lengthM: g.lengthM,
    surfaceWidthM: opts.surfaceWidthM ?? 45,
    buildState: opts.buildState ?? 'operational',
  };
  if (dims && Object.keys(dims).length > 0) r.dims = dims;
  if (opts.designatorSuffix !== undefined) r.designatorSuffix = opts.designatorSuffix;
  d.runways[id] = r;
  return ok(finalize(d), [id]);
}

/** 始点 a・終点 b から自由形の滑走路を配置する（方位 = a → b の真方位、長さ = |b − a| × TILE_M） */
export function placeFreeRunwayByEnds(layout: AirportLayout, a: WorldPoint, b: WorldPoint, opts: PlaceFreeRunwayOptions = {}): OpResult {
  if (!finitePoint(a) || !finitePoint(b)) return fail('INVALID_VALUE');
  return placeFreeRunway(layout, { start: a, headingDeg: dirToBearing(b.x - a.x, b.y - a.y), lengthM: distance(a, b) * TILE_M }, opts);
}

/**
 * 自由形の滑走路の幾何を変える。
 * - `end` だけ: 始点を固定して終点を動かす（方位・長さが決まる）。`start` だけ: 終点を固定して始点を動かす。両方: 両端を指定。
 * - `headingDeg` / `lengthM`（端点の指定とは併用できない）: `pivot`（中点・始点・終点）を固定して方位・長さを変える。
 * 従来形は NOT_SUPPORTED（先に `convertRunwayToFree`）。変化がなければ NO_CHANGE。
 */
export function setFreeRunwayGeometry(
  layout: AirportLayout,
  id: string,
  patch: { headingDeg?: number; lengthM?: number; start?: WorldPoint; end?: WorldPoint },
  pivot: FreePivot = 'mid',
): OpResult {
  const d = cloneLayout(layout);
  const r = d.runways[id];
  if (!r) return fail('NOT_FOUND');
  if (!isFreeRunway(r)) return fail('NOT_SUPPORTED');
  const byEnds = patch.start !== undefined || patch.end !== undefined;
  if (byEnds) {
    if (patch.headingDeg !== undefined || patch.lengthM !== undefined) return fail('INVALID_VALUE');
    const cur = runwayAxis(r);
    const a = patch.start ?? cur.start;
    const b = patch.end ?? cur.end;
    if (!finitePoint(a) || !finitePoint(b)) return fail('INVALID_VALUE');
    const len = distance(a, b) * TILE_M;
    if (!Number.isFinite(len) || len < FREE_RUNWAY_MIN_M || len > FREE_RUNWAY_MAX_M) return fail('INVALID_VALUE');
    const h = normalizeDeg(dirToBearing(b.x - a.x, b.y - a.y));
    if (a.x === r.start.x && a.y === r.start.y && h === r.headingDeg && len === r.lengthM) return fail('NO_CHANGE');
    r.start = { x: a.x, y: a.y };
    r.headingDeg = h;
    r.lengthM = len;
    return ok(finalize(d));
  }
  const f = applyFreeGeometry(r, patch, pivot);
  if (f) return fail(f);
  return ok(finalize(d));
}

/**
 * 従来形 → 自由形（プレイヤーの明示操作）。始点・方位はそのまま、長さは丸めない実長（斜めは n√2·25 m）。
 * dims は書かない（既定値）。ID・名前・幅・建設状態・番号の接尾辞は保つ。自由形には NO_CHANGE。
 */
export function convertRunwayToFree(layout: AirportLayout, id: string): OpResult {
  const d = cloneLayout(layout);
  const r = d.runways[id];
  if (!r) return fail('NOT_FOUND');
  if (isFreeRunway(r)) return fail('NO_CHANGE');
  const axis = runwayAxis(r);
  const f: RunwayFree = {
    id: r.id,
    name: r.name,
    alignment: 'free',
    start: { x: r.start.x, y: r.start.y },
    headingDeg: r.heading,
    lengthM: axis.lengthT * TILE_M,
    surfaceWidthM: r.surfaceWidthM,
    buildState: r.buildState,
  };
  if (r.designatorSuffix !== undefined) f.designatorSuffix = r.designatorSuffix;
  d.runways[id] = f;
  return ok(finalize(d));
}

/**
 * 自由形 → 従来形（「グリッドに合わせる」。プレイヤーの明示操作）。方位を 45° の倍数に、始点を整数タイルに、
 * 長さをステップ数（1〜MAX_RUNWAY_LENGTH）に丸める。dims は捨てる。丸めが恒等なら位置は変わらない。従来形には NO_CHANGE。
 */
export function snapRunwayToGrid(layout: AirportLayout, id: string): OpResult {
  const d = cloneLayout(layout);
  const r = d.runways[id];
  if (!r) return fail('NOT_FOUND');
  if (!isFreeRunway(r)) return fail('NO_CHANGE');
  const heading = ((Math.round(r.headingDeg / 45) * 45) % 360) as Heading;
  const stepT = heading % 90 === 0 ? 1 : Math.SQRT2;
  const steps = Math.round(r.lengthM / TILE_M / stepT);
  // 従来形の最大を超える長さは黙って短くしない（自由形のまま）
  if (steps > MAX_RUNWAY_LENGTH) return fail('TOO_LONG_FOR_GRID');
  const length = Math.max(1, steps);
  const g: RunwayGrid8 = {
    id: r.id,
    name: r.name,
    start: { x: Math.round(r.start.x), y: Math.round(r.start.y) },
    heading,
    length,
    surfaceWidthM: r.surfaceWidthM,
    buildState: r.buildState,
  };
  if (r.designatorSuffix !== undefined) g.designatorSuffix = r.designatorSuffix;
  d.runways[id] = g;
  return ok(finalize(d));
}

/**
 * 空港の設定（磁気偏角・ルール）。指定した項目だけ変える。既定値（偏角 0・classic）は項目を書かない（従来データのバイト列を保つ）。
 * `magneticVariationDeg` は東偏差が正の [-180, 180]、`null` で解除。
 */
export function updateLayoutSettings(
  layout: AirportLayout,
  s: { magneticVariationDeg?: number | null; ruleSet?: 'classic' | 'realistic'; taxiMode?: 'full' | 'block'; taxiBlockTiles?: number; accessCapacityModel?: 'segment' | null },
): OpResult {
  const d = cloneLayout(layout);
  let changed = false;
  if (s.magneticVariationDeg !== undefined) {
    const v = s.magneticVariationDeg;
    if (v !== null && (!Number.isFinite(v) || v < -180 || v > 180)) return fail('INVALID_VALUE');
    const before = d.magneticVariationDeg ?? 0;
    const next = v ?? 0;
    if (next !== before) changed = true;
    if (next === 0) delete d.magneticVariationDeg;
    else d.magneticVariationDeg = next;
  }
  if (s.ruleSet !== undefined) {
    if (s.ruleSet !== 'classic' && s.ruleSet !== 'realistic') return fail('INVALID_VALUE');
    if ((d.ruleSet ?? 'classic') !== s.ruleSet) changed = true;
    if (s.ruleSet === 'classic') delete d.ruleSet;
    else d.ruleSet = s.ruleSet;
  }
  // 地上走行の方式（フェーズ 2）。'full'（従来の全区間確保）はキーを書かない。区間の長さ 10 タイル（既定）もキーを書かない
  if (s.taxiMode !== undefined) {
    if (s.taxiMode !== 'full' && s.taxiMode !== 'block') return fail('INVALID_VALUE');
    if ((d.taxiMode ?? 'full') !== s.taxiMode) changed = true;
    if (s.taxiMode === 'full') delete d.taxiMode;
    else d.taxiMode = s.taxiMode;
  }
  // アクセスの区間能力モデル（フェーズ 4）。集約モデル（既定）はキーを書かない
  if (s.accessCapacityModel !== undefined) {
    if (s.accessCapacityModel !== 'segment' && s.accessCapacityModel !== null) return fail('INVALID_VALUE');
    if ((d.accessCapacityModel ?? null) !== s.accessCapacityModel) changed = true;
    if (s.accessCapacityModel === null) delete d.accessCapacityModel;
    else d.accessCapacityModel = s.accessCapacityModel;
  }
  if (s.taxiBlockTiles !== undefined) {
    const t = s.taxiBlockTiles;
    if (!Number.isInteger(t) || t < TAXI_BLOCK_TILES_MIN || t > TAXI_BLOCK_TILES_MAX) return fail('INVALID_VALUE');
    if ((d.taxiBlockTiles ?? TAXI_BLOCK_TILES_DEFAULT) !== t) changed = true;
    if (t === TAXI_BLOCK_TILES_DEFAULT) delete d.taxiBlockTiles;
    else d.taxiBlockTiles = t;
  }
  if (!changed) return fail('NO_CHANGE');
  return ok(finalize(d));
}

export interface PlaceAreaOptions {
  w?: number;
  h?: number;
  name?: string;
  zone?: PaxZone;
  props?: Record<string, PropValue>;
}

/** ターミナル内部のエリアを配置する（level は 0 = 1F） */
export function placeTerminalArea(
  layout: AirportLayout,
  terminalId: string,
  level: number,
  kind: TerminalAreaKind,
  origin: Tile,
  opts: PlaceAreaOptions = {},
): OpResult {
  const t = layout.facilities[terminalId];
  if (!t || t.kind !== 'terminal') return fail('NOT_FOUND');
  const spec = TERMINAL_AREA_SPECS[kind];
  const range = terminalFloorRange(layout, terminalId);
  const w = opts.w ?? spec.defaultW;
  const h = opts.h ?? spec.defaultH;
  if (!isInt(level, range.min, range.max) || w < spec.minW || h < spec.minH) return fail('INVALID_VALUE');
  if (opts.zone && !spec.zoneEditable && opts.zone !== spec.zone) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  const id = allocId(d, 'ta');
  d.terminalAreas[id] = {
    id,
    terminalId,
    level,
    kind,
    name: opts.name ?? '',
    origin: { ...origin },
    w,
    h,
    zone: opts.zone ?? spec.zone,
    props: { ...spec.defaults, ...opts.props },
  };
  return ok(finalize(d), [id]);
}

export interface TerminalTransitOptions {
  name?: string;
  kind: TerminalTransitKind;
  fromAreaId: string;
  toAreaId: string;
  distanceM: number;
  travelSec: number;
  widthM?: number;
  capacityPerHour?: number;
  elevationM?: number;
  aircraftClearanceM?: number;
  /** 下を通る最大の航空機コードの宣言（J-1。指定時は宣言基準で判定し、既定値も宣言から導く） */
  crossingMaxCode?: CrossingMaxCode;
  bidirectional?: boolean;
  buildState?: BuildState;
  allowedZones: PaxZone[];
}

/** Add an explicit, zone-restricted passenger link between areas in different terminals. */
export function addTerminalTransitLink(layout: AirportLayout, opts: TerminalTransitOptions): OpResult {
  const from = layout.terminalAreas[opts.fromAreaId];
  const to = layout.terminalAreas[opts.toAreaId];
  if (!from || !to) return fail('NOT_FOUND');
  if (from.terminalId === to.terminalId) return fail('INVALID_VALUE');
  if (!['walkway', 'movingWalkway', 'elevatedWalkway', 'escalator', 'elevator'].includes(opts.kind)) return fail('INVALID_VALUE');
  if (opts.crossingMaxCode !== undefined && !['C', 'E', 'F'].includes(opts.crossingMaxCode)) return fail('INVALID_VALUE');
  if (!Number.isFinite(opts.distanceM) || opts.distanceM <= 0 || !Number.isFinite(opts.travelSec) || opts.travelSec <= 0) return fail('INVALID_VALUE');
  const widthM = opts.widthM ?? DEFAULT_TERMINAL_LINK_WIDTH_M;
  // J-1: 下を通る最大コードの宣言がある場合は、全体基準ではなく宣言基準で判定し、
  // 既定値（クリアランス = 宣言の必要値、標高 = それを満たす最小の層の床高）も宣言から導く。
  // 宣言が無い場合は従来の全体基準・既定値と完全一致させる。
  const required = opts.crossingMaxCode ? requiredClearanceForCode(opts.crossingMaxCode) : requiredAircraftClearanceM();
  const elevationM = opts.elevationM ?? (opts.crossingMaxCode ? deckElevationForCode(opts.crossingMaxCode) : DEFAULT_TERMINAL_LINK_ELEVATION_M);
  const aircraftClearanceM = opts.aircraftClearanceM ?? (opts.crossingMaxCode ? required : DEFAULT_TERMINAL_LINK_CLEARANCE_M);
  if (!Number.isFinite(widthM) || widthM <= 0 || !Number.isFinite(elevationM) || elevationM <= 0) return fail('INVALID_VALUE');
  if (!Number.isFinite(aircraftClearanceM) || aircraftClearanceM < required || elevationM < aircraftClearanceM) return fail('INVALID_VALUE');
  // 宣言がある場合、標高は手入力でも宣言のデッキ床高（最小の層）未満にはできない
  if (opts.crossingMaxCode && elevationM < deckElevationForCode(opts.crossingMaxCode)) return fail('INVALID_VALUE');
  if (opts.capacityPerHour !== undefined && (!Number.isFinite(opts.capacityPerHour) || opts.capacityPerHour <= 0)) return fail('INVALID_VALUE');
  const zones = [...new Set(opts.allowedZones)];
  if (!zones.length || zones.some((zone) => zone !== from.zone || zone !== to.zone)) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  d.terminalLinks ??= {};
  const id = allocId(d, 'tlk');
  d.terminalLinks[id] = {
    id,
    name: opts.name ?? '',
    kind: opts.kind,
    fromAreaId: from.id,
    toAreaId: to.id,
    distanceM: opts.distanceM,
    travelSec: opts.travelSec,
    widthM,
    elevationM,
    aircraftClearanceM,
    ...(opts.crossingMaxCode === undefined ? {} : { crossingMaxCode: opts.crossingMaxCode }),
    ...(opts.capacityPerHour === undefined ? {} : { capacityPerHour: opts.capacityPerHour }),
    bidirectional: opts.bidirectional ?? true,
    buildState: opts.buildState ?? 'operational',
    allowedZones: zones,
  };
  return ok(finalize(d), [id]);
}

export function deleteTerminalTransitLink(layout: AirportLayout, id: string): OpResult {
  if (!layout.terminalLinks?.[id]) return fail('NOT_FOUND');
  const d = cloneLayout(layout);
  delete d.terminalLinks![id];
  return ok(finalize(d));
}

// ---------------------------------------------------------------- 複合連絡施設（J-2）

/** 複合連絡施設の垂直ノードとして生成できるエリア種別 */
export type ConnectionVerticalKind = 'stairs' | 'escalator' | 'elevator';

export interface CreateConnectionFacilityOptions {
  name?: string;
  /** 端点エリア（入口側）。リンクの fromAreaId になる */
  fromAreaId: string;
  /** 端点エリア（出口側）。リンクの toAreaId になる */
  toAreaId: string;
  /** 通路段（リンク）の生成パラメータ。addTerminalTransitLink と同じ検証を受ける */
  link: {
    kind: TerminalTransitKind;
    distanceM: number;
    travelSec: number;
    widthM?: number;
    capacityPerHour?: number;
    elevationM?: number;
    aircraftClearanceM?: number;
    crossingMaxCode?: CrossingMaxCode;
    bidirectional?: boolean;
    buildState?: BuildState;
    name?: string;
  };
  /** 両端の垂直ノード種別。null/省略 = その側は生成しない */
  aVerticalKind?: ConnectionVerticalKind | null;
  bVerticalKind?: ConnectionVerticalKind | null;
  /** 垂直エリアの設置位置。省略時は端点エリアと同じ平面位置（origin）に積む */
  aVerticalOrigin?: Tile;
  bVerticalOrigin?: Tile;
  /** 段差なしの申告。省略時は種別と階移動の有無から導出する */
  stepFree?: boolean;
}

/** 端点階から通路段の階へ届くために垂直エリアを置く階（端点自身の階は端点エリアが占有するため除く） */
function connectionShaftLevels(endpointLevel: number, segmentLevel: number): number[] {
  const levels: number[] = [];
  if (segmentLevel > endpointLevel) for (let l = endpointLevel + 1; l <= segmentLevel; l++) levels.push(l);
  else if (segmentLevel < endpointLevel) for (let l = segmentLevel; l < endpointLevel; l++) levels.push(l);
  return levels;
}

/** 同じターミナル・同じ階の既存エリアと矩形が重なるか（生成エリア同士の重なり判定にも使う） */
function areaRectOverlaps(
  rects: readonly { terminalId: string; level: number; origin: Tile; w: number; h: number }[],
  terminalId: string,
  level: number,
  origin: Tile,
  w: number,
  h: number,
): boolean {
  return rects.some(
    (a) =>
      a.terminalId === terminalId &&
      a.level === level &&
      origin.x < a.origin.x + a.w &&
      a.origin.x < origin.x + w &&
      origin.y < a.origin.y + a.h &&
      a.origin.y < origin.y + h,
  );
}

/**
 * 複合連絡施設を原子的に生成する（J-2 JT3）。
 * 両端の垂直エリア群＋通路段（リンク）＋グルーピング記録を1つの操作で作り、
 * 途中の検証に失敗したら全体が失敗する（部分生成は残らない。Undo も1回で戻せる）。
 * 垂直エリアは端点エリアと同じ平面位置に、端点階から通路段の階までの各階へ積む。
 * 通路段の階は connectionSegmentLevel の定義（高層通路は導出デッキ階、それ以外は端点階）に従うため、
 * 高層通路以外では垂直エリアは生成されない（階移動が無い）。
 */
export function createConnectionFacility(layout: AirportLayout, opts: CreateConnectionFacilityOptions): OpResult {
  const from = layout.terminalAreas[opts.fromAreaId];
  const to = layout.terminalAreas[opts.toAreaId];
  if (!from || !to) return fail('NOT_FOUND');
  if (!layout.facilities[from.terminalId] || !layout.facilities[to.terminalId]) return fail('NOT_FOUND');
  if (from.terminalId === to.terminalId) return fail('INVALID_VALUE');
  const aSegLevel = connectionSegmentLevel(opts.link, from.level, facilityLevel(layout.facilities[from.terminalId]!));
  const bSegLevel = connectionSegmentLevel(opts.link, to.level, facilityLevel(layout.facilities[to.terminalId]!));

  interface ShaftPlan {
    side: 'a' | 'b';
    terminalId: string;
    level: number;
    kind: ConnectionVerticalKind;
    origin: Tile;
    zone: PaxZone;
  }
  const plans: ShaftPlan[] = [];
  const plannedRects: { terminalId: string; level: number; origin: Tile; w: number; h: number }[] = [];
  const existingRects = Object.values(layout.terminalAreas);
  const planSide = (
    side: 'a' | 'b',
    endpoint: TerminalArea,
    segLevel: number,
    kind: ConnectionVerticalKind | null | undefined,
    originOpt: Tile | undefined,
  ): OpFailure | null => {
    if (!kind) return null;
    const spec = TERMINAL_AREA_SPECS[kind];
    const origin = originOpt ?? endpoint.origin;
    for (const level of connectionShaftLevels(endpoint.level, segLevel)) {
      const range = terminalFloorRange(layout, endpoint.terminalId);
      if (!isInt(level, range.min, range.max)) return 'INVALID_VALUE';
      if (
        areaRectOverlaps(existingRects, endpoint.terminalId, level, origin, spec.defaultW, spec.defaultH) ||
        areaRectOverlaps(plannedRects, endpoint.terminalId, level, origin, spec.defaultW, spec.defaultH)
      ) {
        return 'INVALID_VALUE';
      }
      plans.push({ side, terminalId: endpoint.terminalId, level, kind, origin, zone: endpoint.zone });
      plannedRects.push({ terminalId: endpoint.terminalId, level, origin, w: spec.defaultW, h: spec.defaultH });
    }
    return null;
  };
  const planError =
    planSide('a', from, aSegLevel, opts.aVerticalKind, opts.aVerticalOrigin) ??
    planSide('b', to, bSegLevel, opts.bVerticalKind, opts.bVerticalOrigin);
  if (planError) return fail(planError);

  // 部品の生成は既存の単体操作を合成する（どれか失敗したら全体が失敗し、入力は無変更）
  let cur = layout;
  const aIds: string[] = [];
  const bIds: string[] = [];
  for (const p of plans) {
    const r = placeTerminalArea(cur, p.terminalId, p.level, p.kind, p.origin, {
      zone: p.zone,
      ...(opts.name ? { name: opts.name } : {}),
    });
    if (!r.ok) return r;
    cur = r.layout;
    (p.side === 'a' ? aIds : bIds).push(r.created[0]!);
  }
  const linkRes = addTerminalTransitLink(cur, {
    ...opts.link,
    fromAreaId: from.id,
    toAreaId: to.id,
    allowedZones: [from.zone],
    name: opts.link.name ?? opts.name ?? '',
  });
  if (!linkRes.ok) return linkRes;
  cur = linkRes.layout;
  const linkId = linkRes.created[0]!;

  const d = cloneLayout(cur);
  d.connectionFacilities ??= {};
  const id = allocId(d, 'cf');
  const stepFree =
    opts.stepFree ??
    deriveConnectionStepFree(
      aIds.map((x) => d.terminalAreas[x]!),
      bIds.map((x) => d.terminalAreas[x]!),
      aSegLevel !== from.level,
      bSegLevel !== to.level,
    );
  d.connectionFacilities[id] = {
    id,
    name: opts.name ?? '',
    segment: { kind: 'link', linkId },
    aVerticalAreaIds: aIds,
    bVerticalAreaIds: bIds,
    stepFree,
  };
  return ok(finalize(d), [id, linkId, ...aIds, ...bIds]);
}

export interface GroupConnectionFacilityOptions {
  name?: string;
  /** 束ねる既存の通路段（リンク） */
  linkId: string;
  /** 入口側（リンクの fromAreaId 側ターミナル）の既存の垂直エリア */
  aVerticalAreaIds?: string[];
  /** 出口側（リンクの toAreaId 側ターミナル）の既存の垂直エリア */
  bVerticalAreaIds?: string[];
  /** 段差なしの申告。省略時は既存エリアの種別と階移動の有無から導出する */
  stepFree?: boolean;
}

/**
 * 既存のリンクと垂直エリアを複合連絡施設として束ねる（J-2）。
 * 部品は生成せず、グルーピング記録だけを作る。既存セーブの連絡設備を
 * 後から1施設として扱うための操作。
 */
export function groupConnectionFacility(layout: AirportLayout, opts: GroupConnectionFacilityOptions): OpResult {
  const link = layout.terminalLinks?.[opts.linkId];
  if (!link) return fail('NOT_FOUND');
  const from = layout.terminalAreas[link.fromAreaId];
  const to = layout.terminalAreas[link.toAreaId];
  if (!from || !to) return fail('NOT_FOUND');
  if (!layout.facilities[from.terminalId] || !layout.facilities[to.terminalId]) return fail('NOT_FOUND');
  const aIds = [...new Set(opts.aVerticalAreaIds ?? [])];
  const bIds = [...new Set(opts.bVerticalAreaIds ?? [])];
  if (aIds.some((x) => bIds.includes(x))) return fail('INVALID_VALUE');
  for (const [ids, terminalId] of [[aIds, from.terminalId], [bIds, to.terminalId]] as const) {
    for (const areaId of ids) {
      const a = layout.terminalAreas[areaId];
      if (!a) return fail('NOT_FOUND');
      if (a.terminalId !== terminalId) return fail('INVALID_VALUE');
    }
  }
  const d = cloneLayout(layout);
  d.connectionFacilities ??= {};
  const id = allocId(d, 'cf');
  const stepFree =
    opts.stepFree ??
    deriveConnectionStepFree(
      aIds.map((x) => d.terminalAreas[x]!),
      bIds.map((x) => d.terminalAreas[x]!),
      connectionSegmentLevel(link, from.level, facilityLevel(layout.facilities[from.terminalId]!)) !== from.level,
      connectionSegmentLevel(link, to.level, facilityLevel(layout.facilities[to.terminalId]!)) !== to.level,
    );
  d.connectionFacilities[id] = {
    id,
    name: opts.name ?? '',
    segment: { kind: 'link', linkId: link.id },
    aVerticalAreaIds: aIds,
    bVerticalAreaIds: bIds,
    stepFree,
  };
  return ok(finalize(d), [id]);
}

/**
 * 複合連絡施設を1施設単位で削除する（J-2）。
 * グルーピング記録・通路段（リンク）・両端の垂直エリアをまとめて取り除く。
 * 端点エリアはターミナル側の部品なので残す。同じリンクを指す他の記録があれば、
 * finalize がその記録も落とす（通路段はこの施設が所有する部品として扱う）。
 */
export function deleteConnectionFacility(layout: AirportLayout, id: string): OpResult {
  const cf = layout.connectionFacilities?.[id];
  if (!cf) return fail('NOT_FOUND');
  const d = cloneLayout(layout);
  delete d.connectionFacilities![id];
  if (cf.segment.kind === 'link' && d.terminalLinks) delete d.terminalLinks[cf.segment.linkId];
  if (cf.segment.kind === 'agt' && d.agtSegments) delete d.agtSegments[cf.segment.segmentId];
  for (const areaId of [...cf.aVerticalAreaIds, ...cf.bVerticalAreaIds]) delete d.terminalAreas[areaId];
  return ok(finalize(d));
}

/** 複合連絡施設の改名・段差なし申告の変更（J-2） */
export function updateConnectionFacility(
  layout: AirportLayout,
  id: string,
  patch: { name?: string; stepFree?: boolean },
): OpResult {
  if (!layout.connectionFacilities?.[id]) return fail('NOT_FOUND');
  const d = cloneLayout(layout);
  const next = d.connectionFacilities![id]!;
  let changed = false;
  if (patch.name !== undefined && patch.name !== next.name) {
    next.name = patch.name;
    changed = true;
  }
  if (patch.stepFree !== undefined && patch.stepFree !== next.stepFree) {
    next.stepFree = patch.stepFree;
    changed = true;
  }
  if (!changed) return fail('NO_CHANGE');
  return ok(finalize(d));
}

/**
 * 複合連絡施設の垂直エリア群を1施設単位で移動する（J-2）。
 * 通路段（リンク）は論理接続で幾何を持たないため動かさず、端点エリアも
 * ターミナル側の部品として残す。垂直エリアが無い施設は移動できない。
 */
export function moveConnectionFacility(layout: AirportLayout, id: string, delta: Tile): OpResult {
  const cf = layout.connectionFacilities?.[id];
  if (!cf) return fail('NOT_FOUND');
  if (delta.x === 0 && delta.y === 0) return fail('NO_CHANGE');
  let cur = layout;
  let moved = 0;
  for (const areaId of [...cf.aVerticalAreaIds, ...cf.bVerticalAreaIds]) {
    if (!cur.terminalAreas[areaId]) continue;
    const r = moveEntity(cur, areaId, delta);
    if (!r.ok) return r;
    cur = r.layout;
    moved++;
  }
  if (moved === 0) return fail('NO_CHANGE');
  return ok(cur);
}

/** ポータルで接続できる交通施設の種別（5-16 T2） */
export const PORTAL_FACILITY_KINDS: readonly Facility['kind'][] = ['railStation', 'busTerminal', 'busStop', 'taxiStand', 'parking', 'agtStation'];

/** ポータル接続の健全性上限（タイル）。歩行時間のモデルではなく、無関係な遠隔接続を拒否するための上限 */
export const PORTAL_MAX_DISTANCE_TILES = 64;

export interface PortalOptions {
  facilityId: string;
  areaId: string;
  name?: string;
  /** 省略時は接続先エリアの階を使う。指定時はエリアの階と一致しなければ拒否 */
  floorIndex?: number;
  /** 省略時は交通施設の地図階層を使う。指定時は施設の階層と一致しなければ拒否 */
  mapLevel?: number;
  buildState?: BuildState;
}

/**
 * 歩行ポータルを追加する（5-16 T2）。交通施設とターミナル内エリアを明示接続する。
 * 参照切れ・対象外の施設種別・階の不一致・遠隔すぎる接続は拒否する。
 */
export function addPortal(layout: AirportLayout, opts: PortalOptions): OpResult {
  const facility = layout.facilities[opts.facilityId];
  const area = layout.terminalAreas[opts.areaId];
  if (!facility || !area) return fail('NOT_FOUND');
  if (!PORTAL_FACILITY_KINDS.includes(facility.kind)) return fail('INVALID_VALUE');
  const floorIndex = opts.floorIndex ?? area.level;
  if (floorIndex !== area.level) return fail('INVALID_VALUE');
  const mapLevel = opts.mapLevel ?? facilityLevel(facility);
  if (mapLevel !== facilityLevel(facility)) return fail('INVALID_VALUE');
  const terminal = layout.facilities[area.terminalId];
  if (!terminal) return fail('NOT_FOUND');
  const fTiles = facilityTiles(facility);
  const tTiles = facilityTiles(terminal);
  let minDist = Number.POSITIVE_INFINITY;
  for (const a of fTiles) for (const b of tTiles) minDist = Math.min(minDist, Math.abs(a.x - b.x) + Math.abs(a.y - b.y));
  if (minDist > PORTAL_MAX_DISTANCE_TILES) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  d.portals ??= {};
  const id = allocId(d, 'por');
  d.portals[id] = {
    id, name: opts.name ?? '', facilityId: facility.id, areaId: area.id,
    floorIndex, mapLevel, buildState: opts.buildState ?? 'operational',
  };
  return ok(finalize(d), [id]);
}

export function deletePortal(layout: AirportLayout, id: string): OpResult {
  if (!layout.portals?.[id]) return fail('NOT_FOUND');
  const d = cloneLayout(layout);
  delete d.portals![id];
  return ok(finalize(d));
}

// ---------------------------------------------------------------- AGT（機能I）

export interface AgtSystemOptions {
  name?: string;
  vehicleCapacity: number;
  headwaySec: number;
  dwellSec: number;
  speedMps: number;
  buildState?: BuildState;
}

/**
 * AGT 系統を作成する（機能I）。パラメータ範囲（AGT_PARAM_RANGES）外は INVALID_VALUE。
 * 駅は施設 'agtStation' を配置し、props.systemId でこの系統へ所属させる。
 */
export function addAgtSystem(layout: AirportLayout, opts: AgtSystemOptions): OpResult {
  if (agtParamProblem(opts)) return fail('INVALID_VALUE');
  if (opts.buildState !== undefined && !BUILD_STATES.includes(opts.buildState)) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  d.agtSystems ??= {};
  const id = allocId(d, 'ags');
  d.agtSystems[id] = {
    id,
    name: opts.name ?? '',
    vehicleCapacity: opts.vehicleCapacity,
    headwaySec: opts.headwaySec,
    dwellSec: opts.dwellSec,
    speedMps: opts.speedMps,
    buildState: opts.buildState ?? 'operational',
  };
  return ok(finalize(d), [id]);
}

/** AGT 系統の改名・パラメータ・状態の変更（機能I）。範囲外のパラメータは INVALID_VALUE */
export function updateAgtSystem(
  layout: AirportLayout,
  id: string,
  patch: Partial<Pick<AgtSystem, 'name' | 'vehicleCapacity' | 'headwaySec' | 'dwellSec' | 'speedMps' | 'buildState'>>,
): OpResult {
  const cur = layout.agtSystems?.[id];
  if (!cur) return fail('NOT_FOUND');
  const next: AgtSystem = { ...cur, ...patch };
  if (patch.name !== undefined && typeof patch.name !== 'string') return fail('INVALID_VALUE');
  if (patch.buildState !== undefined && !BUILD_STATES.includes(patch.buildState)) return fail('INVALID_VALUE');
  if (agtParamProblem(next)) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  d.agtSystems![id] = next;
  return ok(finalize(d));
}

/**
 * AGT 系統を削除する（機能I）。所属する駅・セグメントが残っている系統は削除できない
 * （先に駅の所属変更・セグメント削除を行うこと）。
 */
export function deleteAgtSystem(layout: AirportLayout, id: string): OpResult {
  if (!layout.agtSystems?.[id]) return fail('NOT_FOUND');
  if (Object.values(layout.agtSegments ?? {}).some((s) => s.systemId === id)) return fail('INVALID_VALUE');
  if (Object.values(layout.facilities).some((f) => f.kind === 'agtStation' && agtStationSystemId(f) === id)) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  delete d.agtSystems![id];
  return ok(finalize(d));
}

export interface AgtSegmentOptions {
  fromStationId: string;
  toStationId: string;
  /** 軌道の地図階層。省略時は両駅の実効階層が一致すればその階、食い違えば INVALID_VALUE */
  level?: number;
  /** 下を通る最大の航空機コードの宣言（J-1 の宣言方式）。高架では宣言のデッキ床高を満たす階が必要 */
  crossingMaxCode?: CrossingMaxCode;
  buildState?: BuildState;
}

/**
 * AGT セグメントを作成する（機能I）。距離は駅中心間の直線 × TILE_M × AGT_SEGMENT_DETOUR で
 * 導出して記録に固定する（terminalLinks の distanceM が保存値であるのと同じ扱い）。
 * 両駅が同じ系統に所属していない・重複セグメントは INVALID_VALUE。
 */
export function addAgtSegment(layout: AirportLayout, opts: AgtSegmentOptions): OpResult {
  const from = layout.facilities[opts.fromStationId];
  const to = layout.facilities[opts.toStationId];
  if (!from || !to) return fail('NOT_FOUND');
  if (from.kind !== 'agtStation' || to.kind !== 'agtStation' || from.id === to.id) return fail('INVALID_VALUE');
  const systemId = agtStationSystemId(from);
  if (!systemId || systemId !== agtStationSystemId(to)) return fail('INVALID_VALUE');
  if (!layout.agtSystems?.[systemId]) return fail('NOT_FOUND');
  if (opts.buildState !== undefined && !BUILD_STATES.includes(opts.buildState)) return fail('INVALID_VALUE');
  const dup = Object.values(layout.agtSegments ?? {}).some(
    (s) =>
      s.systemId === systemId &&
      ((s.fromStationId === from.id && s.toStationId === to.id) || (s.fromStationId === to.id && s.toStationId === from.id)),
  );
  if (dup) return fail('INVALID_VALUE');
  const fromLevel = agtStationMapLevel(layout, from);
  const toLevel = agtStationMapLevel(layout, to);
  let level: number;
  if (opts.level !== undefined) {
    if (!Number.isInteger(opts.level) || opts.level < -5 || opts.level > 10) return fail('INVALID_VALUE');
    level = opts.level;
  } else if (fromLevel === toLevel) {
    level = fromLevel;
  } else {
    return fail('INVALID_VALUE');
  }
  if (opts.crossingMaxCode !== undefined && !['C', 'E', 'F'].includes(opts.crossingMaxCode)) return fail('INVALID_VALUE');
  // 高架セグメントで宣言がある場合は、J-1 の導出デッキ床高を満たす階でなければならない（検証 AGT_CLEARANCE と同じ判定）
  if (level > 0 && opts.crossingMaxCode && level * DEFAULT_LEVEL_HEIGHT_M < deckElevationForCode(opts.crossingMaxCode)) {
    return fail('INVALID_VALUE');
  }
  const center = (f: Facility) => ({ x: f.origin.x + f.w / 2, y: f.origin.y + f.h / 2 });
  const cf = center(from);
  const ct = center(to);
  const distanceM = Math.max(1, Math.round(Math.hypot(cf.x - ct.x, cf.y - ct.y) * TILE_M * AGT_SEGMENT_DETOUR));
  const d = cloneLayout(layout);
  d.agtSegments ??= {};
  const id = allocId(d, 'agseg');
  d.agtSegments[id] = {
    id,
    systemId,
    fromStationId: from.id,
    toStationId: to.id,
    distanceM,
    level,
    ...(opts.crossingMaxCode ? { crossingMaxCode: opts.crossingMaxCode } : {}),
    buildState: opts.buildState ?? 'operational',
  };
  return ok(finalize(d), [id]);
}

/** AGT セグメントの階層・状態・宣言の変更（機能I） */
export function updateAgtSegment(layout: AirportLayout, id: string, patch: { level?: number; buildState?: BuildState; crossingMaxCode?: CrossingMaxCode | null }): OpResult {
  const cur = layout.agtSegments?.[id];
  if (!cur) return fail('NOT_FOUND');
  if (patch.level !== undefined && (!Number.isInteger(patch.level) || patch.level < -5 || patch.level > 10)) return fail('INVALID_VALUE');
  if (patch.buildState !== undefined && !BUILD_STATES.includes(patch.buildState)) return fail('INVALID_VALUE');
  if (patch.crossingMaxCode !== undefined && patch.crossingMaxCode !== null && !['C', 'E', 'F'].includes(patch.crossingMaxCode)) return fail('INVALID_VALUE');
  const level = patch.level ?? cur.level;
  const code = patch.crossingMaxCode === null ? undefined : (patch.crossingMaxCode ?? cur.crossingMaxCode);
  if (level > 0 && code && level * DEFAULT_LEVEL_HEIGHT_M < deckElevationForCode(code)) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  const next = d.agtSegments![id]!;
  if (patch.level !== undefined) next.level = patch.level;
  if (patch.buildState !== undefined) next.buildState = patch.buildState;
  if (patch.crossingMaxCode !== undefined) {
    if (patch.crossingMaxCode === null) delete next.crossingMaxCode;
    else next.crossingMaxCode = patch.crossingMaxCode;
  }
  return ok(finalize(d));
}

export function deleteAgtSegment(layout: AirportLayout, id: string): OpResult {
  if (!layout.agtSegments?.[id]) return fail('NOT_FOUND');
  const d = cloneLayout(layout);
  delete d.agtSegments![id];
  return ok(finalize(d));
}

export interface GroupAgtConnectionFacilityOptions {
  name?: string;
  /** 束ねる既存の AGT セグメント */
  segmentId: string;
  /** 入口側（セグメントの fromStationId 側ターミナル）の既存の垂直エリア */
  aVerticalAreaIds?: string[];
  /** 出口側（セグメントの toStationId 側ターミナル）の既存の垂直エリア */
  bVerticalAreaIds?: string[];
  /** 段差なしの申告。省略時は既存エリアの種別と階移動の有無から導出する */
  stepFree?: boolean;
}

/** AGT セグメントの端点ターミナル（建物内の駅は親ターミナル、単独駅は接続エリアのターミナル） */
function agtEndpointTerminalId(layout: AirportLayout, station: Facility): string | null {
  if (station.parentFacilityId) {
    const parent = layout.facilities[station.parentFacilityId];
    return parent && parent.kind === 'terminal' ? parent.id : null;
  }
  for (const portal of Object.values(layout.portals ?? {})) {
    if (portal.facilityId !== station.id) continue;
    const area = layout.terminalAreas[portal.areaId];
    if (area) return area.terminalId;
  }
  return null;
}

/**
 * 既存の AGT セグメントと垂直エリアを複合連絡施設として束ねる（機能I / J-2 の接続点）。
 * 部品は生成せず、グルーピング記録だけを作る（groupConnectionFacility の AGT 版）。
 */
export function groupAgtConnectionFacility(layout: AirportLayout, opts: GroupAgtConnectionFacilityOptions): OpResult {
  const seg = layout.agtSegments?.[opts.segmentId];
  if (!seg) return fail('NOT_FOUND');
  const from = layout.facilities[seg.fromStationId];
  const to = layout.facilities[seg.toStationId];
  if (!from || !to || from.kind !== 'agtStation' || to.kind !== 'agtStation') return fail('NOT_FOUND');
  const termA = agtEndpointTerminalId(layout, from);
  const termB = agtEndpointTerminalId(layout, to);
  if (!termA || !termB) return fail('INVALID_VALUE');
  const aIds = [...new Set(opts.aVerticalAreaIds ?? [])];
  const bIds = [...new Set(opts.bVerticalAreaIds ?? [])];
  if (aIds.some((x) => bIds.includes(x))) return fail('INVALID_VALUE');
  for (const [ids, terminalId] of [[aIds, termA], [bIds, termB]] as const) {
    for (const areaId of ids) {
      const a = layout.terminalAreas[areaId];
      if (!a) return fail('NOT_FOUND');
      if (a.terminalId !== terminalId) return fail('INVALID_VALUE');
    }
  }
  const d = cloneLayout(layout);
  d.connectionFacilities ??= {};
  const id = allocId(d, 'cf');
  // 段差なしの導出: セグメントの階（端点ターミナルの建物内階に換算）と、駅が接続する
  // エリアの階が食い違う側は階移動が必要とみなす
  const segFloor = (terminalId: string) => seg.level - facilityLevel(layout.facilities[terminalId]!);
  const firstAreaLevel = (station: Facility): number | null => {
    const connected = agtStationConnectedAreas(layout, station);
    const area = connected.length ? layout.terminalAreas[connected[0]!] : undefined;
    return area ? area.level : null;
  };
  const aLevel = firstAreaLevel(from);
  const bLevel = firstAreaLevel(to);
  const stepFree =
    opts.stepFree ??
    deriveConnectionStepFree(
      aIds.map((x) => d.terminalAreas[x]!),
      bIds.map((x) => d.terminalAreas[x]!),
      aLevel !== null && segFloor(termA) !== aLevel,
      bLevel !== null && segFloor(termB) !== bLevel,
    );
  d.connectionFacilities[id] = {
    id,
    name: opts.name ?? '',
    segment: { kind: 'agt', segmentId: seg.id },
    aVerticalAreaIds: aIds,
    bVerticalAreaIds: bIds,
    stepFree,
  };
  return ok(finalize(d), [id]);
}

/** ターミナルに属するエリア（ID 順） */
export function areasOf(layout: AirportLayout, terminalId: string): TerminalArea[] {
  return sortedValues(layout.terminalAreas).filter((a) => a.terminalId === terminalId);
}

export interface TaxiwayOptions {
  widthClass?: SizeClass;
  oneWay?: boolean;
  buildState?: BuildState;
  name?: string;
}

export function addTaxiwayPath(layout: AirportLayout, points: readonly Tile[], opts: TaxiwayOptions = {}): OpResult {
  if (points.length < 2) return fail('EMPTY_PATH');
  const d = cloneLayout(layout);
  const { edgeIds } = addPath(d, 'taxi', points, {
    name: opts.name ?? '',
    widthClass: opts.widthClass ?? 'M',
    oneWay: opts.oneWay ?? false,
    buildState: opts.buildState ?? 'operational',
  });
  if (edgeIds.length === 0) return fail('NO_CHANGE');
  return ok(finalize(d), edgeIds);
}

export interface RoadOptions {
  roadClass?: RoadClass;
  oneWay?: boolean;
  buildState?: BuildState;
  name?: string;
  level?: number;
  capacityPerHour?: number;
}

export function addRoadPath(layout: AirportLayout, points: readonly Tile[], opts: RoadOptions = {}): OpResult {
  if (points.length < 2) return fail('EMPTY_PATH');
  const level = opts.level ?? 0;
  if (!Number.isInteger(level) || level < -5 || level > 10) return fail('INVALID_VALUE');
  if (opts.capacityPerHour !== undefined && (!Number.isFinite(opts.capacityPerHour) || opts.capacityPerHour <= 0)) return fail('INVALID_VALUE');
  const d = cloneLayout(layout);
  const { edgeIds } = addPath(d, 'road', points, {
    name: opts.name ?? '',
    roadClass: opts.roadClass ?? 'public',
    oneWay: opts.oneWay ?? false,
    buildState: opts.buildState ?? 'operational',
    ...(Number.isFinite(opts.capacityPerHour) && opts.capacityPerHour! > 0 ? { capacityPerHour: opts.capacityPerHour } : {}),
  }, level);
  if (edgeIds.length === 0) return fail('NO_CHANGE');
  return ok(finalize(d), edgeIds);
}

export interface RoadConnectorOptions {
  roadClass: RoadClass;
  connectorKind: import('../model/types').RoadConnectorKind;
  capacityPerHour?: number;
  travelSec?: number;
  buildState?: BuildState;
}

/** 異なる階層の道路ノードを、種別に合った明示的な接続設備で結ぶ。 */
export function connectRoadLevels(layout: AirportLayout, from: string, to: string, opts: RoadConnectorOptions): OpResult {
  const a = layout.roadNodes[from];
  const b = layout.roadNodes[to];
  if (!a || !b || from === to) return fail('NOT_FOUND');
  const la = a.level ?? 0;
  const lb = b.level ?? 0;
  if (la === lb) return fail('LEVEL_MISMATCH');
  if ((opts.capacityPerHour !== undefined && (!Number.isFinite(opts.capacityPerHour) || opts.capacityPerHour <= 0)) || (opts.travelSec !== undefined && (!Number.isFinite(opts.travelSec) || opts.travelSec <= 0))) return fail('INVALID_VALUE');
  const candidate: RoadEdge = { id: 'preview', from, to, name: '', roadClass: opts.roadClass, oneWay: false, buildState: opts.buildState ?? 'operational', connectorKind: opts.connectorKind };
  if (!roadEdgeLevelValid(candidate, a, b)) return fail('INVALID_CONNECTOR');
  if (Object.values(layout.roads).some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return fail('NO_CHANGE');
  const d = cloneLayout(layout);
  const id = allocId(d, 'rd');
  d.roads[id] = {
    id, from, to, name: opts.connectorKind, roadClass: opts.roadClass, oneWay: false,
    buildState: opts.buildState ?? 'operational', connectorKind: opts.connectorKind,
    ...(Number.isFinite(opts.capacityPerHour) && opts.capacityPerHour! > 0 ? { capacityPerHour: opts.capacityPerHour } : {}),
    ...(Number.isFinite(opts.travelSec) && opts.travelSec! > 0 ? { travelSec: opts.travelSec } : {}),
  };
  return ok(finalize(d), [id]);
}

// ---------------------------------------------------------------- 土地

/** 矩形内の未取得地のタイル（地図の範囲内） */
export function offsiteTilesIn(layout: AirportLayout, a: Tile, b: Tile): Tile[] {
  const out: Tile[] = [];
  for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
      if (inSite(layout.site, x, y) && terrainAt(layout.site, x, y) === Terrain.offsite) out.push({ x, y });
    }
  }
  return out;
}

/**
 * 土地を購入する: 矩形内の未取得地を元の地形（草地・森・水域など）に戻し、購入タイル数を記録する。
 * 取得済みの敷地に隣接していない土地は買えない。売却は未対応。費用は economy/construction.ts。
 */
export function purchaseLand(layout: AirportLayout, a: Tile, b: Tile): OpResult {
  const tiles = offsiteTilesIn(layout, a, b);
  if (tiles.length === 0) return fail('NO_CHANGE');
  const site = layout.site;
  const inRect = new Set(tiles.map((t) => `${t.x},${t.y}`));
  const adjacent = tiles.some((t) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const x = t.x + dx!;
      const y = t.y + dy!;
      return inSite(site, x, y) && !inRect.has(`${x},${y}`) && terrainAt(site, x, y) !== Terrain.offsite;
    }),
  );
  if (!adjacent) return fail('LAND_NOT_ADJACENT');
  const terrain = [...site.terrain];
  for (const t of tiles) terrain[t.y * site.width + t.x] = baseTerrainAt(site, t.x, t.y);
  const d = cloneLayout(layout);
  d.site = { ...site, terrain, purchased: (site.purchased ?? 0) + tiles.length };
  return ok(d);
}

// ---------------------------------------------------------------- 移動・回転・複製・削除

const netOfNode = (id: string): NetKind | null =>
  entityTypeOf(id) === 'taxiNode' ? 'taxi' : entityTypeOf(id) === 'roadNode' ? 'road' : null;
const netOfEdge = (id: string): NetKind | null =>
  entityTypeOf(id) === 'taxiway' ? 'taxi' : entityTypeOf(id) === 'road' ? 'road' : null;

function moveNodes(d: AirportLayout, net: NetKind, ids: readonly string[], delta: Tile): OpFailure | null {
  const nodes = netNodes(d, net);
  const moving = new Set(ids);
  for (const id of ids) {
    const n = nodes[id];
    if (!n) return 'NOT_FOUND';
    const target = add(n.pos, delta);
    const clash = Object.values(nodes).find((m) => !moving.has(m.id) && (m.level ?? 0) === (n.level ?? 0) && sameTile(m.pos, target));
    if (clash) return 'NODE_EXISTS';
  }
  for (const id of ids) nodes[id]!.pos = add(nodes[id]!.pos, delta);
  return null;
}

/** エンティティを delta タイルだけ平行移動する。エッジは両端ノードを移動する */
export function moveEntity(layout: AirportLayout, id: string, delta: Tile): OpResult {
  if (delta.x === 0 && delta.y === 0) return fail('NO_CHANGE');
  const d = cloneLayout(layout);
  const type = entityTypeOf(id);
  switch (type) {
    case 'runway': {
      const r = d.runways[id];
      if (!r) return fail('NOT_FOUND');
      r.start = add(r.start, delta);
      break;
    }
    case 'stand': {
      const s = d.stands[id];
      if (!s) return fail('NOT_FOUND');
      s.origin = add(s.origin, delta);
      break;
    }
    case 'facility': {
      const f = d.facilities[id];
      if (!f) return fail('NOT_FOUND');
      f.origin = add(f.origin, delta);
      for (const child of Object.values(d.facilities)) {
        if (child.parentFacilityId === id) child.origin = add(child.origin, delta);
      }
      // ターミナル内部のエリアも一緒に動かす
      for (const a of areasOf(d, id)) a.origin = add(a.origin, delta);
      break;
    }
    case 'terminalArea': {
      const a = d.terminalAreas[id];
      if (!a) return fail('NOT_FOUND');
      a.origin = add(a.origin, delta);
      break;
    }
    case 'taxiNode':
    case 'roadNode': {
      const err = moveNodes(d, netOfNode(id)!, [id], delta);
      if (err) return fail(err);
      break;
    }
    case 'taxiway':
    case 'road': {
      const net = netOfEdge(id)!;
      const e = netEdges(d, net)[id];
      if (!e) return fail('NOT_FOUND');
      const err = moveNodes(d, net, [e.from, e.to], delta);
      if (err) return fail(err);
      break;
    }
    default:
      return fail('NOT_FOUND');
  }
  return ok(finalize(d));
}

/**
 * 回転: 建物・スポットは中心を保って時計回り90度、従来形の滑走路は中点を保って時計回り45度（`stepDeg` は無視）、
 * 自由形の滑走路は中点を保って時計回りに `stepDeg`（既定 15°）。
 */
export function rotateEntity(layout: AirportLayout, id: string, stepDeg = 15): OpResult {
  const d = cloneLayout(layout);
  const type = entityTypeOf(id);
  if (type === 'facility') {
    const f = d.facilities[id];
    if (!f) return fail('NOT_FOUND');
    const old = facilityDims(f);
    const oldOrigin = f.origin;
    f.rotation = ((f.rotation + 90) % 360) as Rotation;
    f.origin = originAfterRotation(f.origin, old, facilityDims(f), f.rotation);
    for (const child of Object.values(d.facilities)) {
      if (child.parentFacilityId !== id) continue;
      const childDims = facilityDims(child);
      const rx = child.origin.x - oldOrigin.x;
      const ry = child.origin.y - oldOrigin.y;
      child.origin = { x: f.origin.x + old.h - (ry + childDims.h), y: f.origin.y + rx };
      child.rotation = ((child.rotation + 90) % 360) as Rotation;
      child.mapLevel = facilityLevel(f);
    }
    // 内部のエリアをターミナルと一緒に時計回りに回す（相対位置 (x, y) → (H − y − h, x)）
    for (const a of areasOf(d, id)) {
      const rx = a.origin.x - oldOrigin.x;
      const ry = a.origin.y - oldOrigin.y;
      a.origin = { x: f.origin.x + old.h - (ry + a.h), y: f.origin.y + rx };
      [a.w, a.h] = [a.h, a.w];
    }
  } else if (type === 'terminalArea') {
    const a = d.terminalAreas[id];
    if (!a) return fail('NOT_FOUND');
    const o = originAfterRotation(a.origin, { w: a.w, h: a.h }, { w: a.h, h: a.w }, a.w > a.h ? 90 : 0);
    [a.w, a.h] = [a.h, a.w];
    a.origin = o;
  } else if (type === 'stand') {
    const s = d.stands[id];
    if (!s) return fail('NOT_FOUND');
    const old = standDims(s);
    s.rotation = ((s.rotation + 90) % 360) as Rotation;
    s.origin = originAfterRotation(s.origin, old, standDims(s), s.rotation);
  } else if (type === 'runway') {
    const r = d.runways[id];
    if (!r) return fail('NOT_FOUND');
    if (isFreeRunway(r)) {
      if (!Number.isFinite(stepDeg)) return fail('INVALID_VALUE');
      const f = applyFreeGeometry(r, { headingDeg: r.headingDeg + stepDeg }, 'mid');
      if (f) return fail(f);
      return ok(finalize(d));
    }
    setRunwayHeadingAroundMid(r, ((r.heading + 45) % 360) as Heading);
  } else {
    return fail(layout.taxiNodes[id] || layout.roadNodes[id] || layout.taxiways[id] || layout.roads[id] ? 'NOT_SUPPORTED' : 'NOT_FOUND');
  }
  return ok(finalize(d));
}

function setRunwayHeadingAroundMid(r: RunwayGrid8, heading: Heading): void {
  const mid = runwayMidpoint(r);
  const v = headingVector(heading);
  r.heading = heading;
  r.start = { x: Math.round(mid.x - (v.x * r.length) / 2), y: Math.round(mid.y - (v.y * r.length) / 2) };
}

/** 複製の既定オフセット（元の施設の隣、重ならない位置） */
export function defaultDuplicateOffset(layout: AirportLayout, id: string): Tile {
  const f = layout.facilities[id];
  if (f) return { x: facilityDims(f).w + 1, y: 0 };
  const a = layout.terminalAreas[id];
  if (a) return { x: a.w, y: 0 };
  const s = layout.stands[id];
  if (s) return { x: standDims(s).w + 1, y: 0 };
  const r = layout.runways[id];
  if (r) {
    if (isFreeRunway(r)) {
      // 進行方向に直交（右手）へ 12 タイル。整数に丸める
      const d = bearingToDir(r.headingDeg + 90);
      return { x: Math.round(d.x * 12), y: Math.round(d.y * 12) };
    }
    const v = headingVector(r.heading);
    return { x: -v.y * 12, y: v.x * 12 };
  }
  return { x: 2, y: 2 };
}

/** 複製（新しいIDを発行）。ゲートのスポット紐付けは複製しない */
export function duplicateEntity(layout: AirportLayout, id: string, offset?: Tile): OpResult {
  const off = offset ?? defaultDuplicateOffset(layout, id);
  const d = cloneLayout(layout);
  const type = entityTypeOf(id);
  let newId: string;
  if (type === 'facility') {
    const f = d.facilities[id];
    if (!f) return fail('NOT_FOUND');
    newId = allocId(d, 'fac');
    const props = { ...f.props };
    if (f.kind === 'gate') props.standId = null;
    d.facilities[newId] = { ...f, id: newId, origin: add(f.origin, off), props, name: f.name ? `${f.name} copy` : '' };
    for (const a of areasOf(d, id)) {
      const aid = allocId(d, 'ta');
      d.terminalAreas[aid] = { ...structuredClone(a), id: aid, terminalId: newId, origin: add(a.origin, off) };
    }
  } else if (type === 'terminalArea') {
    const a = d.terminalAreas[id];
    if (!a) return fail('NOT_FOUND');
    newId = allocId(d, 'ta');
    d.terminalAreas[newId] = { ...structuredClone(a), id: newId, origin: add(a.origin, off), name: a.name ? `${a.name} copy` : '' };
  } else if (type === 'stand') {
    const s = d.stands[id];
    if (!s) return fail('NOT_FOUND');
    newId = allocId(d, 'std');
    d.stands[newId] = { ...s, id: newId, origin: add(s.origin, off), name: s.name ? `${s.name} copy` : '' };
  } else if (type === 'runway') {
    const r = d.runways[id];
    if (!r) return fail('NOT_FOUND');
    newId = allocId(d, 'rwy');
    d.runways[newId] = { ...r, id: newId, start: add(r.start, off), name: r.name ? `${r.name} copy` : '' };
  } else {
    return fail(layout.taxiNodes[id] || layout.roadNodes[id] || layout.taxiways[id] || layout.roads[id] ? 'NOT_SUPPORTED' : 'NOT_FOUND');
  }
  return ok(finalize(d), [newId]);
}

export function deleteEntity(layout: AirportLayout, id: string): OpResult {
  const d = cloneLayout(layout);
  switch (entityTypeOf(id)) {
    case 'runway':
      if (!d.runways[id]) return fail('NOT_FOUND');
      delete d.runways[id];
      break;
    case 'stand':
      if (!d.stands[id]) return fail('NOT_FOUND');
      delete d.stands[id];
      // PBB（機能H）: そのスポットに紐付く搭乗橋は、橋だけ残しても意味を持たないため一緒に落とす
      for (const f of Object.values(d.facilities)) {
        if (f.kind === 'boardingBridge' && f.props.standId === id) delete d.facilities[f.id];
      }
      break;
    case 'facility': {
      if (!d.facilities[id]) return fail('NOT_FOUND');
      const deletedIds = new Set<string>([id]);
      delete d.facilities[id];
      for (const child of Object.values(d.facilities)) {
        if (child.parentFacilityId === id) {
          delete d.facilities[child.id];
          deletedIds.add(child.id);
        }
      }
      // PBB（機能H）: ゲートとの紐付けは PBB 側の props.gateId だけで、parentFacilityId の
      // 連動削除では消えないため、削除されたゲート（ターミナル配下の子ゲートを含む）に
      // 紐付く搭乗橋を一緒に落とす
      for (const f of Object.values(d.facilities)) {
        if (f.kind === 'boardingBridge' && typeof f.props.gateId === 'string' && deletedIds.has(f.props.gateId)) {
          delete d.facilities[f.id];
        }
      }
      for (const a of areasOf(d, id)) delete d.terminalAreas[a.id];
      break;
    }
    case 'terminalArea':
      if (!d.terminalAreas[id]) return fail('NOT_FOUND');
      delete d.terminalAreas[id];
      break;
    case 'taxiNode':
    case 'roadNode': {
      const net = netOfNode(id)!;
      if (!netNodes(d, net)[id]) return fail('NOT_FOUND');
      removeNode(d, net, id);
      break;
    }
    case 'taxiway':
    case 'road': {
      const net = netOfEdge(id)!;
      if (!netEdges(d, net)[id]) return fail('NOT_FOUND');
      removeEdge(d, net, id);
      break;
    }
    default:
      return fail('NOT_FOUND');
  }
  return ok(finalize(d));
}

/** 一方通行エッジの向きを反転する */
export function reverseEdge(layout: AirportLayout, id: string): OpResult {
  const net = netOfEdge(id);
  if (!net) return fail('NOT_FOUND');
  const d = cloneLayout(layout);
  const e = netEdges(d, net)[id];
  if (!e) return fail('NOT_FOUND');
  [e.from, e.to] = [e.to, e.from];
  return ok(finalize(d));
}

/**
 * 誘導路の経路全体（taxiwayRouteEdges: 分岐で止まる連結）の幅を一括で変更する。
 * 変更するのは widthClass だけで、codeF には単一区間の更新（updateEntity）と同じく
 * 一切触らない（L から下げても codeF の保存値は残る。プロパティパネルでは L のときだけ
 * チェックボックスが出るが、値自体は保持されるのが従来の挙動）。
 * 経路内の1区間でも変われば成功し、全区間が既に同じ幅なら NO_CHANGE。
 */
export function setTaxiwayRouteWidth(layout: AirportLayout, edgeId: string, widthClass: SizeClass): OpResult {
  if (!SIZES.includes(widthClass)) return fail('INVALID_VALUE');
  if (!layout.taxiways[edgeId]) return fail('NOT_FOUND');
  const route = taxiwayRouteEdges(layout, edgeId);
  const d = cloneLayout(layout);
  let changed = 0;
  for (const id of route) {
    const e = d.taxiways[id];
    if (e && e.widthClass !== widthClass) {
      e.widthClass = widthClass;
      changed++;
    }
  }
  if (changed === 0) return fail('NO_CHANGE');
  return ok(finalize(d));
}

// ---------------------------------------------------------------- プロパティ編集

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isBuildState = (v: unknown): v is BuildState => BUILD_STATES.includes(v as BuildState);

const isSuffix = (v: unknown): boolean => v === 'L' || v === 'C' || v === 'R' || v === 'none';

/** dims の検証（runwayDimsProblem）。既知のキーの有限な数だけを残す。不正なら null（undefined の値は捨てる） */
function sanitizeDims(v: unknown): RunwayDims | null {
  if (runwayDimsProblem(v) !== null) return null;
  const out: RunwayDims = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x !== undefined) out[k as keyof RunwayDims] = x as number;
  }
  return out;
}

/** 自由形の幾何の変更の基準点（中点・始点・終点を固定） */
export type FreePivot = 'mid' | 'start' | 'end';

/**
 * 自由形の方位・長さを変える（`r` を直接書き換える。呼び出し側が複製済みのレイアウトに対して使う）。
 * 基準点（pivot）は変更の前後で動かさない。方位は normalizeDeg、長さは [FREE_RUNWAY_MIN_M, FREE_RUNWAY_MAX_M]。
 * 戻り値: 成功 null、失敗は理由（変化なしは 'NO_CHANGE'）。
 */
function applyFreeGeometry(r: RunwayFree, g: { headingDeg?: number; lengthM?: number }, pivot: FreePivot): OpFailure | null {
  const h = g.headingDeg === undefined ? r.headingDeg : g.headingDeg;
  const len = g.lengthM === undefined ? r.lengthM : g.lengthM;
  if (!Number.isFinite(h) || !Number.isFinite(len) || len < FREE_RUNWAY_MIN_M || len > FREE_RUNWAY_MAX_M) return 'INVALID_VALUE';
  const nh = normalizeDeg(h);
  if (nh === r.headingDeg && len === r.lengthM) return 'NO_CHANGE';
  const cur = runwayAxis(r);
  const dir = bearingToDir(nh);
  const lenT = len / TILE_M;
  let start: Tile;
  if (pivot === 'start') start = { x: r.start.x, y: r.start.y };
  else if (pivot === 'end') start = { x: cur.end.x - dir.x * lenT, y: cur.end.y - dir.y * lenT };
  else {
    const mid = { x: cur.start.x + (cur.dir.x * cur.lengthT) / 2, y: cur.start.y + (cur.dir.y * cur.lengthT) / 2 };
    start = { x: mid.x - (dir.x * lenT) / 2, y: mid.y - (dir.y * lenT) / 2 };
  }
  r.start = start;
  r.headingDeg = nh;
  r.lengthM = len;
  return null;
}

/**
 * プロパティを変更する。値は種別ごとに検証し、不正な値・未知のキーは拒否する。
 */
export function updateEntity(layout: AirportLayout, id: string, patch: Record<string, unknown>): OpResult {
  const d = cloneLayout(layout);
  const type = entityTypeOf(id);
  const entries = Object.entries(patch);
  if (entries.length === 0) return fail('NO_CHANGE');

  const apply = <T extends object>(target: T | undefined, validators: Record<string, (v: unknown) => boolean>, only: Record<string, unknown> = patch): OpFailure | null => {
    if (!target) return 'NOT_FOUND';
    for (const [k, v] of Object.entries(only)) {
      const check = validators[k];
      if (!check || !check(v)) return 'INVALID_VALUE';
    }
    Object.assign(target, only);
    return null;
  };
  const str = (v: unknown) => typeof v === 'string' && v.length <= 40;
  const bool = (v: unknown) => typeof v === 'boolean';
  const size = (v: unknown) => SIZES.includes(v as SizeClass);

  let err: OpFailure | null;
  switch (type) {
    case 'runway': {
      const r = d.runways[id];
      // 接尾辞の上書きの解除（null = 自動に戻す。キーを書かない）
      if (r && patch.designatorSuffix === null) {
        const { designatorSuffix: _s, ...rest } = patch;
        void _s;
        const had = r.designatorSuffix !== undefined;
        delete r.designatorSuffix;
        if (Object.keys(rest).length === 0) return had ? ok(finalize(d)) : fail('NO_CHANGE');
        return updateEntity(d, id, rest);
      }
      // 方位変更は中点を保つ
      if (r && isFreeRunway(r)) {
        // 自由形: 方位・長さの変更は中点を保つ（heading / length は従来形の項目なので INVALID_VALUE）
        const { headingDeg, lengthM, dims, ...rest } = patch;
        let changed = false;
        if ('headingDeg' in patch || 'lengthM' in patch) {
          const g: { headingDeg?: number; lengthM?: number } = {};
          if ('headingDeg' in patch) g.headingDeg = headingDeg as number;
          if ('lengthM' in patch) g.lengthM = lengthM as number;
          const f = applyFreeGeometry(r, g, 'mid');
          if (f === null) changed = true;
          else if (f !== 'NO_CHANGE') return fail(f);
        }
        if ('dims' in patch) {
          const nd = sanitizeDims(dims);
          if (nd === null) return fail('INVALID_VALUE');
          if (Object.keys(nd).length === 0) delete r.dims;
          else r.dims = nd;
          changed = true;
        }
        if (Object.keys(rest).length > 0) {
          const e = apply(r, { name: str, surfaceWidthM: (v) => RUNWAY_WIDTHS.includes(v as 30 | 45 | 60), buildState: isBuildState, designatorSuffix: isSuffix }, rest);
          if (e) return fail(e);
          changed = true;
        }
        if (!changed) return fail('NO_CHANGE');
        return ok(finalize(d));
      }
      if (r && 'heading' in patch && HEADINGS.includes(patch.heading as Heading)) {
        const { heading, ...rest } = patch;
        setRunwayHeadingAroundMid(r, heading as Heading);
        if (Object.keys(rest).length === 0) return ok(finalize(d));
        return updateEntity(d, id, rest);
      }
      err = apply(r, {
        name: str,
        length: (v) => isInt(v, 1, MAX_RUNWAY_LENGTH),
        surfaceWidthM: (v) => RUNWAY_WIDTHS.includes(v as 30 | 45 | 60),
        buildState: isBuildState,
        designatorSuffix: isSuffix,
      });
      break;
    }
    case 'taxiNode':
    case 'roadNode':
      err = apply(netNodes(d, netOfNode(id)!)[id], { name: str, holdShort: bool });
      break;
    case 'taxiway': {
      // blockMaxAircraft（区間ごとの走行の進入可能機数の上限。null = 解除＝キーを消す）
      if (d.taxiways[id] && patch.blockMaxAircraft === null) {
        const { blockMaxAircraft: _b, ...rest } = patch;
        void _b;
        const had = d.taxiways[id].blockMaxAircraft !== undefined;
        delete d.taxiways[id].blockMaxAircraft;
        if (Object.keys(rest).length === 0) return had ? ok(finalize(d)) : fail('NO_CHANGE');
        return updateEntity(d, id, rest);
      }
      // 実寸設計データ（5-17。任意項目で、null = 解除＝キーを消す。通行判定には使わない表示・設計用データ）
      const DESIGN_KEYS = ['pavementWidthM', 'shoulderWidthM', 'designProfile', 'designGroup', 'role'] as const;
      if (d.taxiways[id] && DESIGN_KEYS.some((k) => k in patch)) {
        const e = d.taxiways[id];
        const rest: Record<string, unknown> = {};
        for (const [k, v] of entries) if (!(DESIGN_KEYS as readonly string[]).includes(k)) rest[k] = v;
        let changed = false;
        for (const k of DESIGN_KEYS) {
          if (!(k in patch)) continue;
          const v = patch[k];
          if (v === null) {
            if (e[k] !== undefined) {
              delete e[k];
              changed = true;
            }
            continue;
          }
          const valid =
            k === 'pavementWidthM'
              ? typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100
              : k === 'shoulderWidthM'
                ? typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
                : k === 'designProfile'
                  ? v === 'faa-tdg' || v === 'easa-omgws' || v === 'legacy-game'
                  : k === 'designGroup'
                    ? typeof v === 'string' && v.length >= 1 && v.length <= 8
                    : v === 'normal' || v === 'rapidExit';
          if (!valid) return fail('INVALID_VALUE');
          if (e[k] !== v) {
            (e as unknown as Record<string, unknown>)[k] = v;
            changed = true;
          }
        }
        if (Object.keys(rest).length === 0) return changed ? ok(finalize(d)) : fail('NO_CHANGE');
        // 残りの項目は通常の検証へ（失敗すれば設計データの変更ごと破棄され、操作は原子的に失敗する）
        return updateEntity(d, id, rest);
      }
      err = apply(d.taxiways[id], { name: str, widthClass: size, oneWay: bool, buildState: isBuildState, codeF: bool, blockMaxAircraft: (v) => isInt(v, 1, TAXI_BLOCK_MAX_AIRCRAFT) });
      break;
    }
    case 'road':
      err = apply(d.roads[id], {
        name: str,
        roadClass: (v) => v === 'public' || v === 'service' || v === 'rail' || v === 'walkway' || v === 'fuel',
        oneWay: bool,
        buildState: isBuildState,
        connectorKind: (v) => v === 'stairs' || v === 'escalator' || v === 'elevator' || v === 'ramp' || v === 'railRamp' || v === 'pipeRiser',
        capacityPerHour: (v) => Number.isFinite(v) && Number(v) > 0,
        travelSec: (v) => Number.isFinite(v) && Number(v) > 0,
        // フェーズ 4: 区間能力の既定値に使う車線数・線路数
        lanes: (v) => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 8,
        tracks: (v) => v === 1 || v === 2 || v === 4,
      });
      break;
    case 'stand': {
      const s = d.stands[id];
      if (s && 'rotation' in patch && ROTATIONS.includes(patch.rotation as Rotation)) {
        const old = standDims(s);
        s.rotation = patch.rotation as Rotation;
        s.origin = originAfterRotation(s.origin, old, standDims(s), s.rotation);
        const { rotation: _r, ...rest } = patch;
        if (Object.keys(rest).length === 0) return ok(finalize(d));
        return updateEntity(d, id, rest);
      }
      // K-1 / Z-1: リモートスポットの運用（remoteBoarding・busGateId）と所属ターミナル（terminalId。null = 自動に戻す＝キーを消す）
      const isBusGate = (v: unknown) => v === null || (typeof v === 'string' && d.facilities[v]?.kind === 'gate' && d.facilities[v]?.props.boardingMode === 'bus');
      const isTerminal = (v: unknown) => v === null || (typeof v === 'string' && d.facilities[v]?.kind === 'terminal');
      err = apply<Stand>(s, {
        name: str,
        size,
        buildState: isBuildState,
        codeF: bool,
        remoteBoarding: (v) => v === 'auto' || v === 'bus' || v === 'none',
        busGateId: isBusGate,
        terminalId: isTerminal,
      });
      if (!err && s && patch.terminalId === null) delete s.terminalId;
      break;
    }
    case 'terminalArea': {
      const a = d.terminalAreas[id];
      if (!a) return fail('NOT_FOUND');
      const spec = TERMINAL_AREA_SPECS[a.kind];
      const areaRange = terminalFloorRange(d, a.terminalId);
      for (const [k, v] of entries) {
        if (k === 'name') {
          if (!str(v)) return fail('INVALID_VALUE');
        } else if (k === 'w' || k === 'h') {
          if (!isInt(v, k === 'w' ? spec.minW : spec.minH, 150)) return fail('INVALID_VALUE');
        } else if (k === 'level') {
          if (!isInt(v, areaRange.min, areaRange.max)) return fail('INVALID_VALUE');
        } else if (k === 'zone') {
          if (!spec.zoneEditable || !['landside', 'departure', 'arrival'].includes(v as string)) return fail('INVALID_VALUE');
        } else if (k === 'props') {
          if (typeof v !== 'object' || v === null) return fail('INVALID_VALUE');
          for (const [pk, pv] of Object.entries(v)) {
            const def = spec.props.find((p) => p.key === pk);
            if (!def || def.type !== 'int' || !isInt(pv, def.min, def.max)) return fail('INVALID_VALUE');
          }
        } else {
          return fail('INVALID_VALUE');
        }
      }
      const { props, ...rest } = patch as { props?: Record<string, PropValue> } & Partial<TerminalArea>;
      Object.assign(a, rest);
      if (props) a.props = { ...a.props, ...props };
      err = null;
      break;
    }
    case 'facility': {
      const f = d.facilities[id];
      if (!f) return fail('NOT_FOUND');
      const spec = FACILITY_SPECS[f.kind];
      const schema = PROP_SCHEMAS[f.kind];
      for (const [k, v] of entries) {
        if (k === 'name') {
          if (!str(v)) return fail('INVALID_VALUE');
        } else if (k === 'w' || k === 'h') {
          if (!spec.resizable || !isInt(v, k === 'w' ? spec.minW : spec.minH, 150)) return fail('INVALID_VALUE');
        } else if (k === 'rotation') {
          if (!ROTATIONS.includes(v as Rotation)) return fail('INVALID_VALUE');
        } else if (k === 'buildState') {
          if (!isBuildState(v)) return fail('INVALID_VALUE');
        } else if (k === 'mapLevel') {
          if (!isInt(v, -5, 10)) return fail('INVALID_VALUE');
          if (undergroundFacilityProblem(f.kind, v as number, !!f.parentFacilityId)) return fail('INVALID_VALUE');
        } else if (k === 'floorIndex') {
          if (!isInt(v, -5, 10)) return fail('INVALID_VALUE');
        } else if (k === 'parentFacilityId') {
          if (typeof v !== 'string' || FACILITY_SPECS[d.facilities[v]?.kind ?? 'gate'].layer !== 'building') return fail('INVALID_VALUE');
        } else if (k === 'props') {
          if (typeof v !== 'object' || v === null) return fail('INVALID_VALUE');
          for (const [pk, pv] of Object.entries(v)) {
            const def = schema.find((p) => p.key === pk);
            if (!def) return fail('INVALID_VALUE');
            const valid =
              def.type === 'int'
                ? isInt(pv, def.min, def.max)
                : def.type === 'bool'
                  ? typeof pv === 'boolean'
                  : def.type === 'enum'
                    ? def.options.includes(pv as string)
                    : def.type === 'facilityRef'
                      ? pv === null || (typeof pv === 'string' && d.facilities[pv]?.kind === def.of)
                      : def.type === 'agtSystemRef'
                        ? pv === null || (typeof pv === 'string' && !!d.agtSystems?.[pv])
                        : pv === null || (typeof pv === 'string' && !!d.stands[pv]);
            if (!valid) return fail('INVALID_VALUE');
          }
        } else {
          return fail('INVALID_VALUE');
        }
      }
      const old = facilityDims(f);
      const { props, ...rest } = patch as { props?: Record<string, PropValue> } & Partial<Facility>;
      Object.assign(f, rest);
      if (props) f.props = { ...f.props, ...props };
      if ('rotation' in patch) f.origin = originAfterRotation(f.origin, old, facilityDims(f), f.rotation);
      if (f.parentFacilityId) {
        const parent = d.facilities[f.parentFacilityId];
        if (
          !parent ||
          parent.parentFacilityId ||
          parent.kind === 'gate' ||
          (f.floorIndex ?? 0) < -5 ||
          (f.floorIndex ?? 0) >= Number(parent.props.levels ?? 1) ||
          facilityLevel(f) !== facilityLevel(parent)
        ) return fail('INVALID_VALUE');
        const parentTiles = new Set(facilityTiles(parent).map((tile) => tileKey(tile.x, tile.y)));
        if (!facilityTiles(f).every((tile) => parentTiles.has(tileKey(tile.x, tile.y)))) return fail('INVALID_VALUE');
      }
      if ('mapLevel' in patch) {
        for (const child of Object.values(d.facilities)) if (child.parentFacilityId === id) child.mapLevel = facilityLevel(f);
      }
      if ('props' in patch && 'levels' in (patch.props as Record<string, unknown>)) {
        const levels = Number(f.props.levels ?? 1);
        if (Object.values(d.facilities).some((child) => child.parentFacilityId === id && (child.floorIndex ?? 0) >= levels)) return fail('INVALID_VALUE');
      }
      // 機能G: エリアの置ける階範囲（floorRange）の変更は、範囲の整合と既存エリアの収まりを満たすときだけ許可する
      if (f.kind === 'terminal' && 'props' in patch && ('floorRangeMin' in (patch.props as Record<string, unknown>) || 'floorRangeMax' in (patch.props as Record<string, unknown>))) {
        const levels = Number(f.props.levels ?? 1);
        const range = terminalFloorRangeOf(f.props, levels);
        const rawMin = f.props.floorRangeMin;
        const rawMax = f.props.floorRangeMax;
        if (
          (typeof rawMin === 'number' && rawMin !== range.min) ||
          (typeof rawMax === 'number' && rawMax !== range.max) ||
          floorRangeInUse(d, id, range.min, range.max)
        ) return fail('INVALID_VALUE');
      }
      err = null;
      break;
    }
    default:
      return fail('NOT_FOUND');
  }
  if (err) return fail(err);
  return ok(finalize(d));
}

/** 建設状態を一括変更する（ids 省略で全エンティティ） */
export function setBuildState(layout: AirportLayout, state: BuildState, ids?: readonly string[]): OpResult {
  const d = cloneLayout(layout);
  const all = [d.runways, d.taxiways, d.roads, d.stands, d.facilities] as Record<string, { buildState: BuildState }>[];
  let changed = 0;
  for (const rec of all) {
    for (const [id, e] of Object.entries(rec)) {
      if ((!ids || ids.includes(id)) && e.buildState !== state) {
        e.buildState = state;
        changed++;
      }
    }
  }
  if (changed === 0) return fail('NO_CHANGE');
  return ok(finalize(d));
}

/** ノードの位置にあるネットワークのノードID（UI のスナップ表示用） */
export function nodeAt(layout: AirportLayout, net: NetKind, tile: Tile): string | undefined {
  return findNodeAt(netNodes(layout, net), tile);
}

/** ノードの次数 */
export function nodeDegree(layout: AirportLayout, id: string): number {
  const net = netOfNode(id);
  if (!net) return 0;
  return edgesOfNode(netEdges(layout, net), id).length;
}

export { runwayEnd };

/**
 * 施設の外形（footprint）を直交ポリゴンへ変更する（5-15 T2/T3 の編集プリミティブ）。
 * points が null のときは矩形へ戻す。origin/w/h は外接矩形へ同期する。
 * ポリゴンが不正・敷地外・占有タイルなしの場合は変更しない。
 */
export function setFacilityFootprint(
  layout: AirportLayout,
  facilityId: string,
  points: readonly Tile[] | null,
): OpResult {
  const d = cloneLayout(layout);
  const f = d.facilities[facilityId];
  if (!f) return fail('NOT_FOUND');
  if (points === null) {
    if (!f.footprint) return fail('NO_CHANGE');
    delete f.footprint;
    return ok(finalize(d));
  }
  if (validateOrthogonalPolygon(points).length > 0) return fail('INVALID_VALUE');
  const tiles = orthogonalPolygonTiles(points);
  if (tiles.length === 0) return fail('INVALID_VALUE');
  const { width, height } = d.site;
  if (tiles.some((t) => t.x < 0 || t.y < 0 || t.x >= width || t.y >= height)) return fail('INVALID_VALUE');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of points) {
    minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
    minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
  }
  f.footprint = points.map((pt) => ({ x: pt.x, y: pt.y }));
  f.origin = { x: minX, y: minY };
  f.w = maxX - minX;
  f.h = maxY - minY;
  return ok(finalize(d));
}
