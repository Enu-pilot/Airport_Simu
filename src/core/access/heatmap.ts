import { buildLandsideNetwork } from './landside';
import { analyzeSegments } from './segments';
import { cargoTrucksAtHour, type AccessRuntime } from './runtime';
import type { AirportLayout } from '../model/types';
import type { DailyReport } from '../economy/company';

/**
 * UI改善 案2（地図上のボトルネック表示）用の純関数群。すべて表示のみで、
 * sim の計算・判定・乱数には一切触れない。
 *
 * - heatBand: 使用率 → 3段階の帯（MapRenderer の heat 色分けと定義を共有する）
 * - staticBottlenecks (2a): 区間モデルの静的ボトルネック辺（解析済み AccessSegments の読み取り）
 * - segmentEdgeLoads (2b): 運航中の区間別交通量。交通量は access runtime が経路選択のために
 *   既に `hourly['seg:<辺>:<時>']` へ記録しているものを読み取るだけで、新たな集計は追加しない
 * - processAreaHeat (2c): 直近日報の工程ピーク使用率 → ターミナルエリアへの対応付け
 *   （ターミナル別があればそちらを優先し、空港全体と二重に数えない。案1と同じ原則）
 */

export type HeatBand = 0 | 1 | 2;

/** 使用率の帯の閾値（正本。地図の凡例文言もこの値から組み立てる） */
export const HEAT_BAND_MID_MIN = 0.4;
export const HEAT_BAND_HIGH_MIN = 0.7;

/** 使用率の帯: 0 = 40%未満 / 1 = 40%以上 70%未満 / 2 = 70%以上 */
export function heatBand(v: number): HeatBand {
  return v < HEAT_BAND_MID_MIN ? 0 : v < HEAT_BAND_HIGH_MIN ? 1 : 2;
}

// ---------------------------------------------------------------- 2a 静的ボトルネック

export interface StaticBottleneck {
  edgeId: string;
  /** その辺が律速する経路のボトルネック容量（台/時） */
  capacityPerHour: number;
  /** 道路の車線数（未設定なら null） */
  lanes: number | null;
  /** 全経路の中で最も細い辺か */
  global: boolean;
}

const bottleneckCache = new WeakMap<AirportLayout, StaticBottleneck[]>();

/**
 * 区間モデル（accessCapacityModel === 'segment'）のときだけ、経路ごとのボトルネック辺を返す。
 * 集約モデルでは根拠がないため空（表示しない）。結果はレイアウト単位でキャッシュする。
 */
export function staticBottlenecks(layout: AirportLayout): StaticBottleneck[] {
  const cached = bottleneckCache.get(layout);
  if (cached) return cached;
  const result = computeStaticBottlenecks(layout);
  bottleneckCache.set(layout, result);
  return result;
}

function computeStaticBottlenecks(layout: AirportLayout): StaticBottleneck[] {
  if (layout.accessCapacityModel !== 'segment') return [];
  const segs = analyzeSegments(layout, buildLandsideNetwork(layout));
  const byEdge = new Map<string, number>();
  for (const paths of [segs.paths, segs.parkingPaths, segs.cargoPaths]) {
    for (const p of Object.values(paths)) {
      const cur = byEdge.get(p.bottleneckEdgeId);
      if (cur === undefined || p.bottleneck < cur) byEdge.set(p.bottleneckEdgeId, p.bottleneck);
    }
  }
  return [...byEdge.entries()]
    .map(([edgeId, capacityPerHour]) => ({
      edgeId,
      capacityPerHour,
      lanes: layout.roads[edgeId]?.lanes ?? null,
      global: edgeId === segs.bottleneckEdgeId,
    }))
    .sort((a, b) => a.capacityPerHour - b.capacityPerHour || a.edgeId.localeCompare(b.edgeId));
}

// ---------------------------------------------------------------- 2b 区間別ライブ交通量

export interface SegmentEdgeLoad {
  edgeId: string;
  /** 台/時（旅客車両の記録 + 貨物トラック背景交通。segmentTraverse の比率計算と同じ定義） */
  volume: number;
  capacity: number;
  ratio: number;
}

/**
 * 指定した時間帯の区間別 volume / capacity。区間モデルでない runtime では空。
 * 交通量が記録されていない辺は出さない（0% の辺を全面に塗らない）。
 */
export function segmentEdgeLoads(acc: AccessRuntime, hour: number): SegmentEdgeLoad[] {
  const segs = acc.segments;
  if (!segs) return [];
  // 貨物トラックの背景交通: segmentTraverse と同じく、貨物経路の辺にだけ往復 ×2 を重ねる
  const truckBg = cargoTrucksAtHour(acc, hour) * 2;
  const cargoEdges = new Set<string>();
  if (truckBg > 0) for (const p of Object.values(segs.cargoPaths)) for (const e of p.edges) cargoEdges.add(e);
  const out: SegmentEdgeLoad[] = [];
  for (const [edgeId, info] of Object.entries(segs.edges)) {
    if (info.capacity <= 0) continue;
    const volume = (acc.hourly[`seg:${edgeId}:${hour}`] ?? 0) + (cargoEdges.has(edgeId) ? truckBg : 0);
    if (volume <= 0) continue;
    out.push({ edgeId, volume, capacity: info.capacity, ratio: volume / info.capacity });
  }
  return out.sort((a, b) => b.ratio - a.ratio || a.edgeId.localeCompare(b.edgeId));
}

// ---------------------------------------------------------------- 2c 工程使用率のエリア対応

export interface ProcessAreaHeat {
  areaId: string;
  step: string;
  utilization: number;
}

/**
 * 日報の工程ピーク使用率をターミナルエリアへ対応付ける。
 * processPeakByTerminal がある場合は (terminalId, step) で引き、processPeak にはフォールバックしない。
 * 使用率が未算出（null）の工程は出さない。
 */
export function processAreaHeat(
  report: DailyReport | null | undefined,
  areas: readonly { id: string; kind: string; terminalId: string }[],
): ProcessAreaHeat[] {
  if (!report) return [];
  const byTerminal = report.processPeakByTerminal ?? [];
  const out: ProcessAreaHeat[] = [];
  if (byTerminal.length > 0) {
    const map = new Map(
      byTerminal.filter((p) => p.utilization !== null).map((p) => [`${p.terminalId}:${p.step}`, p.utilization!]),
    );
    for (const a of areas) {
      const u = map.get(`${a.terminalId}:${a.kind}`);
      if (u !== undefined) out.push({ areaId: a.id, step: a.kind, utilization: u });
    }
    return out;
  }
  const map = new Map(
    (report.processPeak ?? []).filter((p) => p.utilization !== null).map((p) => [p.step, p.utilization!]),
  );
  for (const a of areas) {
    const u = map.get(a.kind);
    if (u !== undefined) out.push({ areaId: a.id, step: a.kind, utilization: u });
  }
  return out;
}
