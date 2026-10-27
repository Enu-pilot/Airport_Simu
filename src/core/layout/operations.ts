import { DEFAULT_PROPS, FACILITY_SPECS, PROP_SCHEMAS, TERMINAL_AREA_SPECS } from '../model/catalog';
import { createSite } from '../model/site';
import {
  BUILD_STATES,
  HEADINGS,
  SCHEMA_VERSION,
  entityTypeOf,
  type AirportLayout,
  type BuildState,
  type Facility,
  type FacilityKind,
  type Heading,
  type PropValue,
  type RoadClass,
  type Rotation,
  type Runway,
  type SizeClass,
  type Site,
  type Stand,
  type PaxZone,
  type TerminalArea,
  type TerminalAreaKind,
} from '../model/types';
import { add, sameTile, type Tile } from '../geometry/vec';
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
import { headingVector, runwayEnd, runwayMidpoint } from './runway';

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
  | 'NO_CHANGE';

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
}

export function addRoadPath(layout: AirportLayout, points: readonly Tile[], opts: RoadOptions = {}): OpResult {
  if (points.length < 2) return fail('EMPTY_PATH');
  const d = cloneLayout(layout);
  const { edgeIds } = addPath(d, 'road', points, {
    name: opts.name ?? '',
    roadClass: opts.roadClass ?? 'public',
    oneWay: opts.oneWay ?? false,
    buildState: opts.buildState ?? 'operational',
  });
  if (edgeIds.length === 0) return fail('NO_CHANGE');
  return ok(finalize(d), edgeIds);
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
    const clash = Object.values(nodes).find((m) => !moving.has(m.id) && sameTile(m.pos, target));
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

/** 回転: 建物・スポットは中心を保って時計回り90度、滑走路は中点を保って時計回り45度 */
export function rotateEntity(layout: AirportLayout, id: string): OpResult {
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
    setRunwayHeadingAroundMid(r, ((r.heading + 45) % 360) as Heading);
  } else {
    return fail(layout.taxiNodes[id] || layout.roadNodes[id] || layout.taxiways[id] || layout.roads[id] ? 'NOT_SUPPORTED' : 'NOT_FOUND');
  }
  return ok(finalize(d));
}

function setRunwayHeadingAroundMid(r: Runway, heading: Heading): void {
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

/**
 * プロパティを変更する。値は種別ごとに検証し、不正な値・未知のキーは拒否する。
 */
export function updateEntity(layout: AirportLayout, id: string, patch: Record<string, unknown>): OpResult {
  const d = cloneLayout(layout);
  const type = entityTypeOf(id);
  const entries = Object.entries(patch);
  if (entries.length === 0) return fail('NO_CHANGE');

  const apply = <T extends object>(target: T | undefined, validators: Record<string, (v: unknown) => boolean>): OpFailure | null => {
    if (!target) return 'NOT_FOUND';
    for (const [k, v] of entries) {
      const check = validators[k];
      if (!check || !check(v)) return 'INVALID_VALUE';
    }
    Object.assign(target, patch);
    return null;
  };
  const str = (v: unknown) => typeof v === 'string' && v.length <= 40;
  const bool = (v: unknown) => typeof v === 'boolean';
  const size = (v: unknown) => SIZES.includes(v as SizeClass);

  let err: OpFailure | null;
  switch (type) {
    case 'runway': {
      const r = d.runways[id];
      // 方位変更は中点を保つ
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
      });
      break;
    }
    case 'taxiNode':
    case 'roadNode':
      err = apply(netNodes(d, netOfNode(id)!)[id], { name: str, holdShort: bool });
      break;
    case 'taxiway':
      err = apply(d.taxiways[id], { name: str, widthClass: size, oneWay: bool, buildState: isBuildState });
      break;
    case 'road':
      err = apply(d.roads[id], {
        name: str,
        roadClass: (v) => v === 'public' || v === 'service',
        oneWay: bool,
        buildState: isBuildState,
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
      err = apply<Stand>(s, { name: str, size, buildState: isBuildState });
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
