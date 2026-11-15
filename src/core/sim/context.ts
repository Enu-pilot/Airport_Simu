import { buildAirsideNetwork, type AirsideNetwork } from '../airside/network';
import { TILE_M } from '../model/catalog';
import { compareIds, sortedValues } from '../model/ids';
import { apronBusesOf, gateMode } from '../model/gates';
import { buildTerminalModel, type TerminalModel } from '../terminal/model';
import type { AirportLayout, SizeClass } from '../model/types';
import { AIRCRAFT_TYPES, resolveType, type AircraftType, type AircraftTypeId, type TypeTable } from './aircraftTypes';
import { canOperate } from '../aircraft/compat';
import { distance, type Vec2 } from '../geometry/vec';
import { mapToWorld } from '../geometry/frames';
import { runwayAxis, runwayMaxSize } from '../layout/runway';
import { resolveRunwayDims } from '../layout/runwayAreas';
import { isFreeRunway } from '../model/types';
import type { RunwayConfig, UnitKind } from './types';
import { rotatedDims } from '../layout/footprint';
import { hydrantConnectedStands } from '../layout/fuelHydrants';
import { HOLD_SHORT_M } from './rules';

/**
 * シミュレーションが参照する、レイアウトから導出した不変の情報。
 * 運航中はレイアウトの編集を禁止するため、開始時に1度だけ作る。
 */
export interface RunwayInfo {
  id: string;
  maxSize: SizeClass | null;
  operational: boolean;
  /** 始点側から順の滑走路上ノードと、始点からの距離（m） */
  nodes: string[];
  distFromStart: number[];
  lengthM: number;
}

export interface StandInfo {
  id: string;
  size: SizeClass;
  operational: boolean;
  /** ゲートが紐付いている（ボーディングブリッジで搭乗できる） */
  contact: boolean;
  remoteBoarding?: 'auto' | 'bus' | 'none';
  busGateId?: string | null;
  /** ネットワーク上のスポットノード（`${id}:P`）と入口ノード */
  node: string;
  entry: string | null;
  /** 駐機中の機首方位（度） */
  heading: number;
}

/** 滑走路どうしの交差（自由形が関与するものだけ。従来形だけのレイアウトでは空） */
export interface RunwayCrossing {
  /** 組の ID（`${a}:X:${b}`） */
  id: string;
  a: string;
  b: string;
  /** 交差点のネットワークノード */
  nodeId: string;
  /** 各滑走路の始点から交差点までの距離（m） */
  distA: number;
  distB: number;
}

/** 自由形の滑走路の停止位置の計算用（自由形だけ） */
export interface FreeRunwayInfo {
  dir: Vec2;
  /** 停止位置（中心線からの垂直距離、m） */
  holdingM: number;
  /** 中心線の端点（タイル）。停止位置を経路に沿って求めるのに使う */
  a: Vec2;
  b: Vec2;
}

export interface SimContext {
  layout: AirportLayout;
  network: AirsideNetwork;
  runways: Record<string, RunwayInfo>;
  stands: Record<string, StandInfo>;
  terminal: TerminalModel;
  /** スポット → 紐付けゲート（バスゲートは含めない） */
  standGate: Record<string, string>;
  /** 運用中でバス搭乗（boardingMode 'bus'）のゲート（ID 順）。1 つもなければ [] で、運航にバスの状態（state.bus）を作らない */
  busGates: string[];
  /** 出発旅客が来るターミナル（入口のある最初のターミナル） */
  paxTerminal: string | null;
  /** 作業員・車両の基地（GSE基地・整備施設）。位置はタイル番号空間 */
  bases: { id: string; x: number; y: number; units: Partial<Record<UnitKind, number>> }[];
  /** 手荷物仕分け場 */
  sorters: { id: string; x: number; y: number; capacityPerMin: number }[];
  /** 運用中の燃料施設があるか（給油の前提） */
  hasFuelFarm: boolean;
  /** 地下配管で給油施設へ接続されたスポット（配管がない既存レイアウトは空）。 */
  hydrantStands: Set<string>;
  /** 滑走路どうしの交差。自由形が関与するものだけ（従来形だけなら []） */
  crossings: RunwayCrossing[];
  crossingsByRunway: Record<string, RunwayCrossing[]>;
  /** 交差点または保護範囲内の滑走路ノード → 横断で予約する滑走路（ID 順） */
  crossingNodeRunways: Record<string, string[]>;
  /** 自由形の滑走路 ID → 停止位置の情報（従来形だけなら空） */
  freeRunways: Record<string, FreeRunwayInfo>;
  /** 機種テーブル（現在のカタログ、または保存時の機種データのスナップショット） */
  types: TypeTable;
}

export function createContext(layout: AirportLayout, opts: { types?: TypeTable } = {}): SimContext {
  const network = buildAirsideNetwork(layout);
  const runways: Record<string, RunwayInfo> = {};
  for (const r of sortedValues(layout.runways)) {
    const nodes = network.runwayNodes[r.id] ?? [];
    const start = network.nodes[nodes[0]!]?.pos;
    const distFromStart = nodes.map((n) => (start ? distance(start, network.nodes[n]!.pos) * TILE_M : 0));
    runways[r.id] = {
      id: r.id,
      maxSize: runwayMaxSize(r),
      operational: r.buildState === 'operational',
      nodes,
      distFromStart,
      lengthM: distFromStart[distFromStart.length - 1] ?? 0,
    };
  }
  const freeRunways: Record<string, FreeRunwayInfo> = {};
  for (const r of sortedValues(layout.runways)) {
    if (isFreeRunway(r)) {
      const ax = runwayAxis(r);
      freeRunways[r.id] = { dir: ax.dir, holdingM: resolveRunwayDims(r).holdingPositionM, a: ax.start, b: ax.end };
    }
  }
  const crossings: RunwayCrossing[] = [];
  const crossingsByRunway: Record<string, RunwayCrossing[]> = {};
  const crossingNodeRunways: Record<string, string[]> = {};
  const distAt = (rid: string, node: string): number => {
    const info = runways[rid]!;
    const i = info.nodes.indexOf(node);
    return i >= 0 ? info.distFromStart[i]! : 0;
  };
  for (const c of network.crossings ?? []) {
    if (!runways[c.a] || !runways[c.b]) continue;
    const x: RunwayCrossing = { id: c.id, a: c.a, b: c.b, nodeId: c.nodeId, distA: distAt(c.a, c.nodeId), distB: distAt(c.b, c.nodeId) };
    crossings.push(x);
    (crossingsByRunway[c.a] ??= []).push(x);
    (crossingsByRunway[c.b] ??= []).push(x);
    const set = new Set([...(crossingNodeRunways[c.nodeId] ?? []), c.a, c.b]);
    crossingNodeRunways[c.nodeId] = [...set].sort(compareIds);
  }
  for (const c of crossings) {
    const intersection = network.nodes[c.nodeId];
    if (!intersection) continue;
    const protectedM = Math.max(HOLD_SHORT_M, freeRunways[c.a]?.holdingM ?? 0, freeRunways[c.b]?.holdingM ?? 0);
    for (const node of Object.values(network.nodes)) {
      if (node.id === c.nodeId || !node.runwayIds.some((id) => id === c.a || id === c.b)) continue;
      if (distance(node.pos, intersection.pos) * TILE_M > protectedM) continue;
      const set = new Set([...(crossingNodeRunways[node.id] ?? []), c.a, c.b]);
      crossingNodeRunways[node.id] = [...set].sort(compareIds);
    }
  }
  const contactStands = new Set(
    Object.values(layout.facilities)
      .filter((f) => f.kind === 'gate' && gateMode(f) !== 'bus' && typeof f.props.standId === 'string')
      .map((f) => f.props.standId as string),
  );
  const stands: Record<string, StandInfo> = {};
  for (const s of sortedValues(layout.stands)) {
    stands[s.id] = {
      id: s.id,
      size: s.size,
      operational: s.buildState === 'operational',
      contact: contactStands.has(s.id),
      ...(s.remoteBoarding !== undefined ? { remoteBoarding: s.remoteBoarding } : {}),
      ...(s.busGateId !== undefined ? { busGateId: s.busGateId } : {}),
      node: `${s.id}:P`,
      entry: network.standLinks[s.id] ?? null,
      heading: s.rotation,
    };
  }
  const terminal = buildTerminalModel(layout);
  const standGate: Record<string, string> = {};
  for (const f of sortedValues(layout.facilities)) {
    if (f.kind === 'gate' && gateMode(f) !== 'bus' && typeof f.props.standId === 'string' && !standGate[f.props.standId]) standGate[f.props.standId] = f.id;
  }
  const busGates = sortedValues(layout.facilities)
    .filter((f) => f.kind === 'gate' && gateMode(f) === 'bus' && f.buildState === 'operational')
    .map((f) => f.id);
  const paxTerminal =
    Object.keys(terminal.byTerminal)
      .sort(compareIds)
      .find((t) => terminal.byTerminal[t]!.some((id) => terminal.areas[id]!.kind === 'entrance')) ?? null;
  const center = (f: (typeof layout.facilities)[string]) => {
    const d = rotatedDims(f.w, f.h, f.rotation);
    return mapToWorld({ x: f.origin.x + d.w / 2, y: f.origin.y + d.h / 2 });
  };
  // Interior facilities have no equipment-to-apron/service network yet; do not
  // expose their capacity until an explicit operational connection exists.
  const operational = sortedValues(layout.facilities).filter((f) => f.buildState === 'operational' && !f.parentFacilityId);
  const n = (f: (typeof layout.facilities)[string], k: string) => Math.max(0, Number(f.props[k] ?? 0));
  const bases = operational
    .filter((f) => f.kind === 'gseBase' || f.kind === 'maintenance')
    .map((f) => ({
      id: f.id,
      ...center(f),
      units:
        f.kind === 'gseBase'
          ? {
              staff: n(f, 'staff'),
              tug: n(f, 'tugs'),
              beltLoader: n(f, 'beltLoaders'),
              baggageTractor: n(f, 'baggageTractors'),
              fuelTruck: n(f, 'fuelTrucks'),
              cateringTruck: n(f, 'cateringTrucks'),
              cleaningVan: n(f, 'cleaningVans'),
              // ランプバスは台数があるときだけキーを作る（従来の基地の units と同一にする）
              ...(apronBusesOf(f) > 0 ? { apronBus: apronBusesOf(f) } : {}),
            }
          : { engineer: n(f, 'engineers') },
    }));
  const sorters = operational.filter((f) => f.kind === 'baggageSort').map((f) => ({ id: f.id, ...center(f), capacityPerMin: n(f, 'capacityPerMin') }));
  const hasFuelFarm = operational.some((f) => f.kind === 'fuelFarm');
  const hydrantStands = hydrantConnectedStands(layout);
  return { layout, network, runways, stands, terminal, standGate, busGates, paxTerminal, bases, sorters, hasFuelFarm, hydrantStands, crossings, crossingsByRunway, crossingNodeRunways, freeRunways, types: opts.types ?? AIRCRAFT_TYPES };
}

/** 運用方向に並べた滑走路上ノードと、進入端からの距離 */
export function orderedRunway(info: RunwayInfo, cfg: RunwayConfig): { nodes: string[]; dist: number[] } {
  if (cfg.direction === 'forward') return { nodes: info.nodes, dist: info.distFromStart };
  return {
    nodes: [...info.nodes].reverse(),
    dist: [...info.distFromStart].reverse().map((d) => info.lengthM - d),
  };
}

/**
 * 空港で運航可能な機種: 適合する滑走路と、そこから機体が通れる誘導路で到達できる適合スポットがある機種
 * （判定は aircraft/compat.ts。地上支援の不足は運航可・遅延として扱う）
 */
export function operableTypes(ctx: SimContext): AircraftTypeId[] {
  return Object.keys(ctx.types).filter((id) => canOperate(ctx.types[id]!, ctx.layout, ctx.network));
}

/** 機種を引く（未解決の ID は代替の値。aircraftTypes.ts の resolveType） */
export const typeIn = (ctx: SimContext, id: AircraftTypeId): AircraftType => resolveType(ctx.types, id);
