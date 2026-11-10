import { buildAirsideNetwork, type AirsideNetwork } from '../airside/network';
import { TILE_M } from '../model/catalog';
import { compareIds, sortedValues } from '../model/ids';
import { buildTerminalModel, type TerminalModel } from '../terminal/model';
import type { AirportLayout, SizeClass } from '../model/types';
import { AIRCRAFT_TYPES, resolveType, type AircraftType, type AircraftTypeId, type TypeTable } from './aircraftTypes';
import { canOperate } from '../aircraft/compat';
import { distance } from '../geometry/vec';
import { runwayMaxSize } from '../layout/runway';
import type { RunwayConfig, UnitKind } from './types';
import { rotatedDims } from '../layout/footprint';

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
  /** ネットワーク上のスポットノード（`${id}:P`）と入口ノード */
  node: string;
  entry: string | null;
  /** 駐機中の機首方位（度） */
  heading: number;
}

export interface SimContext {
  layout: AirportLayout;
  network: AirsideNetwork;
  runways: Record<string, RunwayInfo>;
  stands: Record<string, StandInfo>;
  terminal: TerminalModel;
  /** スポット → 紐付けゲート */
  standGate: Record<string, string>;
  /** 出発旅客が来るターミナル（入口のある最初のターミナル） */
  paxTerminal: string | null;
  /** 作業員・車両の基地（GSE基地・整備施設）。位置はタイル番号空間 */
  bases: { id: string; x: number; y: number; units: Partial<Record<UnitKind, number>> }[];
  /** 手荷物仕分け場 */
  sorters: { id: string; x: number; y: number; capacityPerMin: number }[];
  /** 運用中の燃料施設があるか（給油の前提） */
  hasFuelFarm: boolean;
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
  const contactStands = new Set(
    Object.values(layout.facilities)
      .filter((f) => f.kind === 'gate' && typeof f.props.standId === 'string')
      .map((f) => f.props.standId as string),
  );
  const stands: Record<string, StandInfo> = {};
  for (const s of sortedValues(layout.stands)) {
    stands[s.id] = {
      id: s.id,
      size: s.size,
      operational: s.buildState === 'operational',
      contact: contactStands.has(s.id),
      node: `${s.id}:P`,
      entry: network.standLinks[s.id] ?? null,
      heading: s.rotation,
    };
  }
  const terminal = buildTerminalModel(layout);
  const standGate: Record<string, string> = {};
  for (const f of sortedValues(layout.facilities)) {
    if (f.kind === 'gate' && typeof f.props.standId === 'string' && !standGate[f.props.standId]) standGate[f.props.standId] = f.id;
  }
  const paxTerminal =
    Object.keys(terminal.byTerminal)
      .sort(compareIds)
      .find((t) => terminal.byTerminal[t]!.some((id) => terminal.areas[id]!.kind === 'entrance')) ?? null;
  const center = (f: (typeof layout.facilities)[string]) => {
    const d = rotatedDims(f.w, f.h, f.rotation);
    return { x: f.origin.x + d.w / 2 - 0.5, y: f.origin.y + d.h / 2 - 0.5 };
  };
  const operational = sortedValues(layout.facilities).filter((f) => f.buildState === 'operational');
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
            }
          : { engineer: n(f, 'engineers') },
    }));
  const sorters = operational.filter((f) => f.kind === 'baggageSort').map((f) => ({ id: f.id, ...center(f), capacityPerMin: n(f, 'capacityPerMin') }));
  const hasFuelFarm = operational.some((f) => f.kind === 'fuelFarm');
  return { layout, network, runways, stands, terminal, standGate, paxTerminal, bases, sorters, hasFuelFarm, types: opts.types ?? AIRCRAFT_TYPES };
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
