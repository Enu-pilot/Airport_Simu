import {
  buildAirsideNetwork,
  canAircraftUse,
  otherEnd,
  type AirsideNetwork,
} from '../airside/network';
import { TILE_M } from '../model/catalog';
import type { SizeClass } from '../model/types';
import type {
  AtcAircraft,
  AtcAircraftPosition,
  AtcAirportSnapshot,
  AtcMovement,
  AtcRequestKind,
} from './types';

/**
 * ATC-06/07 物理移動の基礎（ATCセッション内で閉じた表現）。
 *
 * - 経路は airside/network.ts の純粋ネットワーク（経営プロジェクトの
 *   レイアウトスナップショットから決定的に生成）上のノード列とする。
 * - 経路探索は本モジュール内の決定的 Dijkstra とする。経営側
 *   sim/pathfinding.ts は sim/rules 等の経営ドメインへ依存するため、
 *   ATC の独立境界（atcCore の import 独立性テスト）上 import しない。
 *   ATC-04 で共通カーネルが抽出されたら、本探索は AtcSafetyProvider と
 *   同じく差し替え点として寄せる（計画 §11 の設計メモ参照）。
 * - 移動は「実行中（executing）」の指示に対してだけ生成・前進する。
 *   許可がない機体には移動自体が存在しない（無許可移動の構造的防止）。
 * - 移動速度は「経路長 ÷ 指示の実行所要時間」で決定的に決まる。所要時間は
 *   engine の ATC_STEP_DURATION_SEC（根拠を明示したゲーム値）を使う。
 */

const networkCache = new WeakMap<AtcAirportSnapshot, AirsideNetwork>();

/** スナップショットからネットワークを決定的に生成（キャッシュ付き） */
export function getAtcNetwork(airport: AtcAirportSnapshot): AirsideNetwork {
  let net = networkCache.get(airport);
  if (!net) {
    net = buildAirsideNetwork(airport.layout);
    networkCache.set(airport, net);
  }
  return net;
}

export function standNodeId(standId: string): string {
  return `${standId}:P`;
}

export function nodePosition(network: AirsideNetwork, nodeId: string): AtcAircraftPosition | null {
  const node = network.nodes[nodeId];
  if (!node) return null;
  return { nodeId, x: node.pos.x, y: node.pos.y };
}

function segmentLengthM(network: AirsideNetwork, a: string, b: string): number {
  const pa = network.nodes[a]?.pos;
  const pb = network.nodes[b]?.pos;
  if (!pa || !pb) return 0;
  return Math.hypot(pb.x - pa.x, pb.y - pa.y) * TILE_M;
}

export function routeLengthM(network: AirsideNetwork, nodeIds: string[]): number {
  let total = 0;
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    total += segmentLengthM(network, nodeIds[i]!, nodeIds[i + 1]!);
  }
  return total;
}

/**
 * 決定的 Dijkstra（同コスト時はノードID順で安定）。
 * 他スポットの接続エッジ・スポットノードは、自分のスポット発着以外では通らない。
 */
export function findAtcRoute(
  network: AirsideNetwork,
  input: { from: string; targets: ReadonlySet<string>; size: SizeClass; ownStandId: string },
): string[] | null {
  const { from, targets, size, ownStandId } = input;
  if (!network.nodes[from]) return null;
  if (targets.has(from)) return [from];
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const settled = new Set<string>();
  for (;;) {
    let current: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (settled.has(id)) continue;
      if (d < best || (d === best && current !== null && id < current)) {
        best = d;
        current = id;
      }
    }
    if (current === null) return null;
    if (targets.has(current)) {
      const path = [current];
      let cursor = current;
      while (cursor !== from) {
        cursor = prev.get(cursor)!;
        path.unshift(cursor);
      }
      return path;
    }
    settled.add(current);
    for (const edgeId of network.outgoing[current] ?? []) {
      const edge = network.edges[edgeId]!;
      if (!canAircraftUse(edge, size, { operationalOnly: true })) continue;
      // 他スポットの接続エッジは通らない（自分のスポット発着のみ許可）
      if (edge.kind === 'standLink' && edge.sourceId !== ownStandId) continue;
      const next = otherEnd(edge, current);
      const node = network.nodes[next];
      if (!node) continue;
      // 他スポットのノード自体も通らない
      if (node.kind === 'stand' && next !== standNodeId(ownStandId) && !targets.has(next)) continue;
      const nd = best + edge.lengthM;
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        prev.set(next, current);
      }
    }
  }
}

function holdShortNodesFor(network: AirsideNetwork, runwayId: string): Set<string> {
  const out = new Set<string>();
  for (const edge of Object.values(network.edges)) {
    if (edge.holdShortAt?.runwayId === runwayId) out.add(edge.holdShortAt.nodeId);
  }
  return out;
}

/**
 * 指示種別ごとに、現在の位置から目的地までの経路ノード列を計画する。
 * 計画できない場合は null（エンジン側は時間のみの実行へフォールバックし、
 * 警告イベントを残す。黙って瞬間移動はしない）。
 * runwayCrossing は現行フローで要求が生成されないため対象外（null）。
 */
export function planRouteNodeIds(
  network: AirsideNetwork,
  aircraft: AtcAircraft,
  kind: AtcRequestKind,
): string[] | null {
  const standNode = standNodeId(aircraft.standId);
  const linkNode = network.standLinks[aircraft.standId];
  const current = aircraft.position?.nodeId ?? null;
  const runwayNodes = network.runwayNodes[aircraft.runwayId] ?? [];
  const route = (from: string, targets: ReadonlySet<string>) =>
    findAtcRoute(network, { from, targets, size: aircraft.size, ownStandId: aircraft.standId });

  switch (kind) {
    case 'pushback': {
      if (!linkNode) return null;
      const from = current ?? standNode;
      if (from === linkNode) return [linkNode];
      return route(from, new Set([linkNode]));
    }
    case 'taxiOut': {
      if (!current) return null;
      const targets = holdShortNodesFor(network, aircraft.runwayId);
      if (targets.size === 0) return null;
      return route(current, targets);
    }
    case 'lineUp': {
      if (!current) return null;
      for (const edge of Object.values(network.edges)) {
        if (edge.holdShortAt?.runwayId === aircraft.runwayId && edge.holdShortAt.nodeId === current) {
          const entry = otherEnd(edge, current);
          return [current, entry];
        }
      }
      const first = runwayNodes[0];
      if (!first || first === current) return null;
      return route(current, new Set([first]));
    }
    case 'takeoff': {
      if (runwayNodes.length < 2) return null;
      if (!current) return [...runwayNodes];
      const idx = runwayNodes.indexOf(current);
      if (idx >= 0) {
        const nodes = runwayNodes.slice(idx);
        return nodes.length >= 2 ? nodes : null;
      }
      const approach = route(current, new Set([runwayNodes[0]!]));
      if (!approach) return null;
      return [...approach, ...runwayNodes.slice(1)].filter(
        (v, i, a) => i === 0 || v !== a[i - 1],
      );
    }
    case 'landing': {
      if (runwayNodes.length < 2) return null;
      return [...runwayNodes];
    }
    case 'taxiIn': {
      if (!current) return null;
      return route(current, new Set([standNode]));
    }
    case 'runwayCrossing':
      return null;
    default:
      return null;
  }
}

/** 経路と所要時間から移動状態を作る。経路長 0 の場合は null */
export function createMovement(
  network: AirsideNetwork,
  aircraft: AtcAircraft,
  kind: AtcRequestKind,
  durationSec: number,
): AtcMovement | null {
  const nodeIds = planRouteNodeIds(network, aircraft, kind);
  if (!nodeIds || nodeIds.length === 0) return null;
  const totalLengthM = routeLengthM(network, nodeIds);
  if (totalLengthM <= 0) return null;
  return {
    kind,
    nodeIds,
    totalLengthM,
    traveledM: 0,
    speedMps: totalLengthM / Math.max(1, durationSec),
  };
}

/** 経路上の traveledM 地点の位置（最後に通過したノード＋補間座標） */
export function positionAlongRoute(
  network: AirsideNetwork,
  movement: AtcMovement,
  traveledM: number,
): AtcAircraftPosition | null {
  const { nodeIds } = movement;
  const first = nodePosition(network, nodeIds[0]!);
  if (!first) return null;
  let remaining = Math.max(0, traveledM);
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    const a = network.nodes[nodeIds[i]!]!.pos;
    const b = network.nodes[nodeIds[i + 1]!]!.pos;
    const len = segmentLengthM(network, nodeIds[i]!, nodeIds[i + 1]!);
    if (remaining <= len || i + 2 === nodeIds.length) {
      const t = len > 0 ? Math.min(1, remaining / len) : 0;
      return {
        nodeId: nodeIds[i]!,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      };
    }
    remaining -= len;
  }
  return nodePosition(network, nodeIds[nodeIds.length - 1]!);
}

/** 1秒分だけ移動を前進させ、航空機の位置を更新する。到達したら true */
export function advanceMovement(
  network: AirsideNetwork,
  aircraft: AtcAircraft,
  dtSec: number,
): boolean {
  const movement = aircraft.movement;
  if (!movement) return false;
  movement.traveledM = Math.min(movement.totalLengthM, movement.traveledM + movement.speedMps * dtSec);
  const pos = positionAlongRoute(network, movement, movement.traveledM);
  if (pos) aircraft.position = pos;
  return movement.traveledM >= movement.totalLengthM;
}

/** 移動を完了状態にし、最終ノードへ位置を確定する */
export function finishMovement(network: AirsideNetwork, aircraft: AtcAircraft): void {
  const movement = aircraft.movement;
  if (!movement) return;
  movement.traveledM = movement.totalLengthM;
  const pos = positionAlongRoute(network, movement, movement.totalLengthM);
  if (pos) {
    aircraft.position = {
      nodeId: movement.nodeIds[movement.nodeIds.length - 1]!,
      x: pos.x,
      y: pos.y,
    };
  }
  aircraft.movement = null;
}
