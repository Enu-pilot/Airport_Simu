import { TILE_M } from '../model/catalog';
import { distance } from '../geometry/vec';
import type { SizeClass } from '../model/types';
import { canAircraftUse, otherEnd, type AirsideNetwork } from './network';

/**
 * 滑走路入口の幾何情報（派生データ）。
 *
 * 離陸滑走は滑走路端固定ではなく、整列した入口ノードから運用方向へ滑走する
 * （経営 sim の `startTakeoff`）。そのため入口ごとに「その方向へあと何 m 使えるか」が
 * 離陸可否を左右する。本モジュールは入口位置ベース制限（2 段構え）の第 1 段として、
 * 検証（`validation/validate.ts` の診断）が使う幾何量を純関数で提供する。
 * 運航の判定には使わない（運航側の入口候補は `sim/simulation.ts` の `entryCandidates`）。
 */

export interface RunwayEntryInfo {
  runwayId: string;
  nodeId: string;
  /** 始点ノード（runwayNodes の先頭）からの距離 m。`sim/context.ts` の distFromStart と同じ定義（始点位置からの直線距離） */
  distFromStartM: number;
  /** 滑走路ノード列の全長 m（先頭ノードから末尾ノードまでの距離） */
  lengthM: number;
  /** forward（始点→終点）方向へ滑走する場合の残り長さ m */
  remainingForwardM: number;
  /** reverse（終点→始点）方向へ滑走する場合の残り長さ m */
  remainingReverseM: number;
  /** 誘導路エッジが接続しているか（`validate.ts` の checkAirside の「入口」と同じ定義） */
  hasTaxiwayLink: boolean;
}

/** 滑走路の全ノードについて、始点からの距離と方向別の残り長さを返す（runwayNodes の順） */
export function runwayEntryInfos(net: AirsideNetwork, runwayId: string): RunwayEntryInfo[] {
  const nodes = net.runwayNodes[runwayId] ?? [];
  if (nodes.length === 0) return [];
  const start = net.nodes[nodes[0]!]!.pos;
  const dists = nodes.map((n) => distance(start, net.nodes[n]!.pos) * TILE_M);
  const lengthM = dists[dists.length - 1]!;
  return nodes.map((nodeId, i) => ({
    runwayId,
    nodeId,
    distFromStartM: dists[i]!,
    lengthM,
    remainingForwardM: lengthM - dists[i]!,
    remainingReverseM: dists[i]!,
    hasTaxiwayLink: [...(net.outgoing[nodeId] ?? []), ...(net.incoming[nodeId] ?? [])].some(
      (eid) => net.edges[eid]!.kind === 'taxiway',
    ),
  }));
}

/**
 * スポットから出発経路で到達できる滑走路ノードの集合。
 *
 * 経営 sim の `findPath` と同じ通行規則にする: 滑走路エッジは辿らない（滑走路ノードへは
 * 誘導路エッジからのみ入る。滑走路ノードから別の誘導路へ抜ける横断は可）、他スポットの
 * 接続エッジは通らない、機体区分・コード F で通れるエッジだけを使う。
 * 運用状態（建設中かどうか）では絞らない。検証の構造判定であり、`checkAirside` の
 * スポット判定（`standReachesRunway` の operationalOnly = false）と流儀をそろえる。
 */
export function departureReachableRunwayNodes(
  net: AirsideNetwork,
  standId: string,
  size: SizeClass,
  codeF: boolean,
): Set<string> {
  const out = new Set<string>();
  const start = net.standLinks[standId];
  if (!start) return out;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if ((net.nodes[cur]?.runwayIds.length ?? 0) > 0) out.add(cur);
    for (const eid of net.outgoing[cur] ?? []) {
      const e = net.edges[eid]!;
      if (e.kind === 'runway' || e.kind === 'standLink') continue;
      if (!canAircraftUse(e, size, { codeF })) continue;
      const next = otherEnd(e, cur);
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return out;
}
