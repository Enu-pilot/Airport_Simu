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
  AtcMovementCrossing,
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

/** 各ノードまでの経路累積距離（m）。cum[k] = 先頭ノードから nodeIds[k] までの距離 */
export function routeCumulativeM(network: AirsideNetwork, nodeIds: string[]): number[] {
  const cum: number[] = [0];
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    cum.push(cum[i]! + segmentLengthM(network, nodeIds[i]!, nodeIds[i + 1]!));
  }
  return cum;
}

/**
 * 横断要求の決定的ID（§3.4.1 の冪等生成パターンに合わせ、内容から生成する）。
 * 同じ機体・同じ移動種別・同じ滑走路・同じ停止ノードの横断は常に同じIDになり、
 * 再計画・保存復元・再評価で重複生成されない。
 */
export function crossingRequestId(
  aircraftId: string,
  kind: AtcRequestKind,
  runwayId: string,
  holdNodeId: string,
): string {
  return `xng_${aircraftId}_${kind}_${runwayId}_${holdNodeId}`;
}

export interface AtcCrossingSpan {
  runwayId: string;
  holdNodeId: string;
  stopAtM: number;
}

/**
 * 経路が滑走路を横断する区間を検出する。
 * 滑走路 R のノード列（runwayIds に R を含むノードの連続ラン）のうち、
 * 前後に R でないノードがある「内部ラン」だけを横断とみなす。
 * - 経路先頭のランは着陸滑走路からの離脱（taxiIn）であり横断ではない。
 * - 経路末尾のランは目標滑走路の停止位置への到達（taxiOut）であり横断ではない。
 * - 一度離脱した滑走路へ再び入る内部ランは横断として扱う。
 */
export function detectCrossings(network: AirsideNetwork, nodeIds: string[]): AtcCrossingSpan[] {
  const cum = routeCumulativeM(network, nodeIds);
  const runwayIds = new Set<string>();
  for (const id of nodeIds) {
    for (const r of network.nodes[id]?.runwayIds ?? []) runwayIds.add(r);
  }
  const spans: AtcCrossingSpan[] = [];
  for (const runwayId of [...runwayIds].sort()) {
    let i = 0;
    while (i < nodeIds.length) {
      if (!network.nodes[nodeIds[i]!]!.runwayIds.includes(runwayId)) {
        i += 1;
        continue;
      }
      let j = i;
      while (
        j + 1 < nodeIds.length &&
        network.nodes[nodeIds[j + 1]!]!.runwayIds.includes(runwayId)
      ) {
        j += 1;
      }
      if (i > 0 && j < nodeIds.length - 1) {
        spans.push({ runwayId, holdNodeId: nodeIds[i - 1]!, stopAtM: cum[i - 1]! });
      }
      i = j + 1;
    }
  }
  spans.sort((a, b) => a.stopAtM - b.stopAtM || (a.runwayId < b.runwayId ? -1 : 1));
  return spans;
}

/** 経路に対する横断ゲート列を作る（全て waiting。要求レコードの生成は assignments 側） */
export function crossingsForRoute(
  network: AirsideNetwork,
  aircraft: AtcAircraft,
  kind: AtcRequestKind,
  nodeIds: string[],
): AtcMovementCrossing[] {
  return detectCrossings(network, nodeIds).map((span) => ({
    requestId: crossingRequestId(aircraft.id, kind, span.runwayId, span.holdNodeId),
    runwayId: span.runwayId,
    holdNodeId: span.holdNodeId,
    stopAtM: span.stopAtM,
    status: 'waiting' as const,
  }));
}

/** 移動が停止中か（管制官の hold、または未承認の横断ゲートに到達している） */
export function isMovementBlocked(movement: AtcMovement): boolean {
  if (movement.held) return true;
  return (movement.crossings ?? []).some(
    (c) => c.status === 'waiting' && c.stopAtM <= movement.traveledM + 1e-6,
  );
}

/**
 * 決定的 Dijkstra（同コスト時はノードID順で安定）。
 * 他スポットの接続エッジ・スポットノードは、自分のスポット発着以外では通らない。
 */
export function findAtcRoute(
  network: AirsideNetwork,
  input: {
    from: string;
    targets: ReadonlySet<string>;
    size: SizeClass;
    ownStandId: string;
    /** 経路変更で回避するノード（始点と目標は回避対象にできない） */
    avoidNodeIds?: ReadonlySet<string>;
  },
): string[] | null {
  const { from, targets, size, ownStandId, avoidNodeIds } = input;
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
      if (avoidNodeIds?.has(next) && !targets.has(next)) continue;
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
 * runwayCrossing 自体は独立した移動を持たず、地上走行（taxiIn/taxiOut 等）の
 * 経路上の横断ゲートとして扱うため、ここでは対象外（null）。
 */
export function planRouteNodeIds(
  network: AirsideNetwork,
  aircraft: AtcAircraft,
  kind: AtcRequestKind,
  avoidNodeIds?: ReadonlySet<string>,
): string[] | null {
  const standNode = standNodeId(aircraft.standId);
  const linkNode = network.standLinks[aircraft.standId];
  const current = aircraft.position?.nodeId ?? null;
  const runwayNodes = network.runwayNodes[aircraft.runwayId] ?? [];
  const route = (from: string, targets: ReadonlySet<string>) =>
    findAtcRoute(network, {
      from,
      targets,
      size: aircraft.size,
      ownStandId: aircraft.standId,
      avoidNodeIds,
    });

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

/**
 * 経路と所要時間から移動状態を作る。経路長 0 の場合は null。
 * 経路変更で走行前に差し替えられた経路（plannedRoute）が種別一致で
 * 現在位置から始まる場合はそちらを使う。経路上の滑走路横断は
 * 横断ゲートとして付け、要求レコードはエンジンが生成する。
 */
export function createMovement(
  network: AirsideNetwork,
  aircraft: AtcAircraft,
  kind: AtcRequestKind,
  durationSec: number,
): AtcMovement | null {
  const planned = aircraft.plannedRoute ?? null;
  const plannedUsable =
    planned !== null &&
    planned.kind === kind &&
    planned.nodeIds.length > 0 &&
    (aircraft.position === null || planned.nodeIds[0] === aircraft.position.nodeId);
  const nodeIds = plannedUsable ? [...planned.nodeIds] : planRouteNodeIds(network, aircraft, kind);
  if (!nodeIds || nodeIds.length === 0) return null;
  const totalLengthM = routeLengthM(network, nodeIds);
  if (totalLengthM <= 0) return null;
  return {
    kind,
    nodeIds,
    totalLengthM,
    traveledM: 0,
    speedMps: totalLengthM / Math.max(1, durationSec),
    crossings: crossingsForRoute(network, aircraft, kind, nodeIds),
    held: false,
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

/**
 * 1秒分だけ移動を前進させ、航空機の位置を更新する。到達したら true。
 * 停止指示（held）中は進まない。未承認の横断ゲートがある場合は
 * その停止距離（stopAtM）を超えて進まず、滑走路へは進入しない。
 */
export function advanceMovement(
  network: AirsideNetwork,
  aircraft: AtcAircraft,
  dtSec: number,
): boolean {
  const movement = aircraft.movement;
  if (!movement) return false;
  if (movement.traveledM >= movement.totalLengthM) return true;
  if (!movement.held) {
    let cap = movement.totalLengthM;
    for (const crossing of movement.crossings ?? []) {
      if (crossing.status !== 'waiting') continue;
      // 既に通過した停止点は対象外。到達済み・到達直前のゲートでは進めない
      if (crossing.stopAtM > movement.traveledM - 1e-6) {
        cap = Math.min(cap, Math.max(crossing.stopAtM, movement.traveledM));
      }
    }
    movement.traveledM = Math.min(cap, movement.traveledM + movement.speedMps * dtSec);
    const pos = positionAlongRoute(network, movement, movement.traveledM);
    if (pos) aircraft.position = pos;
    // 横断ゲートで停止した場合は停止ノードへ位置を確定する
    for (const crossing of movement.crossings ?? []) {
      if (crossing.status === 'waiting' && Math.abs(movement.traveledM - crossing.stopAtM) < 1e-6) {
        const holdPos = nodePosition(network, crossing.holdNodeId);
        if (holdPos) aircraft.position = holdPos;
      }
    }
  }
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
