import { buildAirsideNetwork, type AirsideNetwork } from '../airside/network';
import { TILE_M } from '../model/catalog';
import { compareIds, sortedValues } from '../model/ids';
import { buildTerminalModel, type TerminalModel } from '../terminal/model';
import type { AirportLayout, SizeClass } from '../model/types';
import { distance } from '../geometry/vec';
import { runwayMaxSize } from '../layout/runway';
import type { RunwayConfig } from './types';

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
}

export function createContext(layout: AirportLayout): SimContext {
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
  return { layout, network, runways, stands, terminal, standGate, paxTerminal };
}

/** 運用方向に並べた滑走路上ノードと、進入端からの距離 */
export function orderedRunway(info: RunwayInfo, cfg: RunwayConfig): { nodes: string[]; dist: number[] } {
  if (cfg.direction === 'forward') return { nodes: info.nodes, dist: info.distFromStart };
  return {
    nodes: [...info.nodes].reverse(),
    dist: [...info.distFromStart].reverse().map((d) => info.lengthM - d),
  };
}
