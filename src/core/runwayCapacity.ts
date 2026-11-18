import type { AirportLayout, Runway } from './model/types';
import { runwayEnd } from './layout/runway';
import { TILE_M } from './model/catalog';

/**
 * 滑走路の能力を構成から算出する（5-01。従来は「本数 × 30」の一律計算だった）。
 *
 * 規則（ゲーム用の単純化。実務の容量算定ではない）:
 * - 1 本の滑走路の混合運用（離着陸混在）の基準は 30 回/時（フェーズ 2 の 2-03 実測の離陸間隔と整合する水準）。
 * - 平行滑走路は中心線間隔 760 m 以上で独立（能力は合算）。760 m 未満は依存平行として 1 本あたり半分だけ増える。
 * - 交差する滑走路は交点を共有するため、増設しても能力は 1 本分（系として 30 回/時）。
 * - 依存関係でつながる滑走路群を 1 つの「系」とし、系ごとの能力を合計する。
 */
export const RUNWAY_BASE_PER_HOUR = 30;
/** 独立平行とみなす中心線間隔（m） */
export const PARALLEL_INDEPENDENT_M = 760;

export interface RunwaySystemCapacity {
  perHour: number;
  systems: number;
  runways: number;
  basis: string;
}

interface Seg { ax: number; ay: number; bx: number; by: number }

const segOf = (r: Runway): Seg => {
  const e = runwayEnd(r);
  return { ax: r.start.x * TILE_M, ay: r.start.y * TILE_M, bx: e.x * TILE_M, by: e.y * TILE_M };
};

const dirOf = (s: Seg): { x: number; y: number } => {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
};

const segmentsCross = (a: Seg, b: Seg): boolean => {
  const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(b.ax, b.ay, b.bx, b.by, a.ax, a.ay);
  const d2 = cross(b.ax, b.ay, b.bx, b.by, a.bx, a.by);
  const d3 = cross(a.ax, a.ay, a.bx, a.by, b.ax, b.ay);
  const d4 = cross(a.ax, a.ay, a.bx, a.by, b.bx, b.by);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

/** 2 本の関係: 'independent'（独立平行）/ 'dependent'（依存平行）/ 'crossing'（交差）/ 'separate'（無関係） */
export function runwayRelation(a: Runway, b: Runway): 'independent' | 'dependent' | 'crossing' | 'separate' {
  const sa = segOf(a);
  const sb = segOf(b);
  if (segmentsCross(sa, sb)) return 'crossing';
  const da = dirOf(sa);
  const db = dirOf(sb);
  const crossMag = Math.abs(da.x * db.y - da.y * db.x);
  if (crossMag > 0.05) return 'separate'; // 平行でなく交わりもしない
  // 平行: 中心線間隔（a の始点から b の直線への距離）
  const dist = Math.abs((sa.ax - sb.ax) * db.y - (sa.ay - sb.ay) * db.x);
  return dist >= PARALLEL_INDEPENDENT_M ? 'independent' : 'dependent';
}

export function runwaySystemCapacity(layout: AirportLayout, include: (r: Runway) => boolean = (r) => r.buildState === 'operational'): RunwaySystemCapacity {
  const runways = Object.values(layout.runways).filter(include);
  if (runways.length === 0) return { perHour: 0, systems: 0, runways: 0, basis: '稼働滑走路なし' };
  // 依存・交差でつながる滑走路を 1 つの系にまとめる
  const parent = runways.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const relations = new Map<string, string>();
  for (let i = 0; i < runways.length; i++) {
    for (let j = i + 1; j < runways.length; j++) {
      const rel = runwayRelation(runways[i]!, runways[j]!);
      relations.set(`${i}:${j}`, rel);
      if (rel === 'dependent' || rel === 'crossing') parent[find(i)] = find(j);
    }
  }
  const systems = new Map<number, number[]>();
  runways.forEach((_, i) => {
    const root = find(i);
    systems.set(root, [...(systems.get(root) ?? []), i]);
  });
  let perHour = 0;
  const parts: string[] = [];
  for (const members of systems.values()) {
    if (members.length === 1) {
      perHour += RUNWAY_BASE_PER_HOUR;
      parts.push('単独 30');
      continue;
    }
    let hasCrossing = false;
    for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) {
      const key = `${Math.min(members[x]!, members[y]!)}:${Math.max(members[x]!, members[y]!)}`;
      if (relations.get(key) === 'crossing') hasCrossing = true;
    }
    if (hasCrossing) {
      perHour += RUNWAY_BASE_PER_HOUR;
      parts.push(`交差する ${members.length} 本で 30`);
    } else {
      const cap = Math.round(RUNWAY_BASE_PER_HOUR * (1 + 0.5 * (members.length - 1)));
      perHour += cap;
      parts.push(`依存平行 ${members.length} 本で ${cap}`);
    }
  }
  return { perHour, systems: systems.size, runways: runways.length, basis: parts.join('、') };
}
