import { runwayDimsProblem } from '../model/runwayReference';
import { DEFAULT_PROPS, FACILITY_SPECS, FREE_RUNWAY_MAX_M, FREE_RUNWAY_MIN_M, PROP_SCHEMAS, TERMINAL_AREA_SPECS, TILE_M } from '../model/catalog';
import { baseTerrainAt, createSite, inSite, terrainAt } from '../model/site';
import {
  BUILD_STATES,
  HEADINGS,
  SCHEMA_VERSION,
  entityTypeOf,
  isFreeRunway,
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
  Terrain,
} from '../model/types';
import { add, distance, sameTile, type Tile } from '../geometry/vec';
import { bearingToDir, dirToBearing, normalizeDeg } from '../geometry/angle';
import type { WorldPoint } from '../geometry/frames';
import { sortedValues } from '../model/ids';
import { facilityDims, originAfterRotation, standDims, standEntry } from './footprint';
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
  type NetKind,
} from './network';
import { headingVector, runwayAxis, runwayEnd, runwayMidpoint } from './runway';
import { roadEdgeLevelValid } from '../model/levels';

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
    if (s.busGateId && (d.facilities[s.busGateId]?.kind !== 'gate' || d.facilities[s.busGateId]?.props.boardingMode !== 'bus')) s.busGateId = null;
  }
  for (const [id, link] of Object.entries(d.terminalLinks ?? {})) {
    if (!d.terminalAreas[link.fromAreaId] || !d.terminalAreas[link.toAreaId]) delete d.terminalLinks![id];
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
    props: { ...DEFAULT_PROPS[kind], ...opts.props },
  };
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
  s: { magneticVariationDeg?: number | null; ruleSet?: 'classic' | 'realistic' },
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
  const levels = Number(t.props.levels ?? 1);
  const w = opts.w ?? spec.defaultW;
  const h = opts.h ?? spec.defaultH;
  if (!isInt(level, 0, levels - 1) || w < spec.minW || h < spec.minH) return fail('INVALID_VALUE');
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
  capacityPerHour?: number;
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
  if (opts.kind !== 'walkway' && opts.kind !== 'movingWalkway') return fail('INVALID_VALUE');
  if (!Number.isFinite(opts.distanceM) || opts.distanceM <= 0 || !Number.isFinite(opts.travelSec) || opts.travelSec <= 0) return fail('INVALID_VALUE');
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
      break;
    case 'facility':
      if (!d.facilities[id]) return fail('NOT_FOUND');
      delete d.facilities[id];
      for (const a of areasOf(d, id)) delete d.terminalAreas[a.id];
      break;
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
    case 'taxiway':
      err = apply(d.taxiways[id], { name: str, widthClass: size, oneWay: bool, buildState: isBuildState, codeF: bool });
      break;
    case 'road':
      err = apply(d.roads[id], {
        name: str,
        roadClass: (v) => v === 'public' || v === 'service' || v === 'rail' || v === 'walkway' || v === 'fuel',
        oneWay: bool,
        buildState: isBuildState,
        connectorKind: (v) => v === 'stairs' || v === 'escalator' || v === 'elevator' || v === 'ramp' || v === 'railRamp' || v === 'pipeRiser',
        capacityPerHour: (v) => Number.isFinite(v) && Number(v) > 0,
        travelSec: (v) => Number.isFinite(v) && Number(v) > 0,
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
      err = apply<Stand>(s, { name: str, size, buildState: isBuildState, codeF: bool });
      break;
    }
    case 'terminalArea': {
      const a = d.terminalAreas[id];
      if (!a) return fail('NOT_FOUND');
      const spec = TERMINAL_AREA_SPECS[a.kind];
      const levels = Number(d.facilities[a.terminalId]?.props.levels ?? 1);
      for (const [k, v] of entries) {
        if (k === 'name') {
          if (!str(v)) return fail('INVALID_VALUE');
        } else if (k === 'w' || k === 'h') {
          if (!isInt(v, k === 'w' ? spec.minW : spec.minH, 150)) return fail('INVALID_VALUE');
        } else if (k === 'level') {
          if (!isInt(v, 0, levels - 1)) return fail('INVALID_VALUE');
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
