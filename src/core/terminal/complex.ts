import type { AirportLayout } from '../model/types';
import { facilityTiles } from '../layout/footprint';
import { facilityLevel } from '../model/levels';
import { tileKey } from '../geometry/vec';
import { sortedValues } from '../model/ids';

/**
 * ターミナル複合体の導出（5-15 T4）。派生データであり、保存はしない。
 *
 * 複数の物理ターミナル建物（Facility kind=terminal）を、次を満たすときに同じ複合体とする:
 *   1. 同じ地図階層で、フットプリントのタイルが辺を共有して接する（4 近傍で隣接。
 *      角だけの接触は接続とみなさない）。
 *   2. 両建物に属するエリア同士を結ぶ operational な elevatedWalkway（高層連絡通路）がある。
 * planned / underConstruction の連絡設備は現在の複合体に含めない。
 *
 * 複合体 ID は構成要素の最小の施設 ID（決定的）。同一複合体であることは旅客が
 * 通行できることと同一視しない（経路はエリアグラフと明示リンクが決める）。
 */
export interface TerminalComplex {
  /** 複合体 ID（構成要素の最小施設 ID） */
  id: string;
  /** 構成する物理ターミナル建物の ID（ソート済み） */
  buildingIds: string[];
}

export function deriveTerminalComplexes(layout: AirportLayout): TerminalComplex[] {
  const buildings = sortedValues(layout.facilities).filter((f) => f.kind === 'terminal' && !f.parentFacilityId);
  const parent = new Map<string, string>(buildings.map((b) => [b.id, b.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
  };

  // 1) 辺接触: 同じ階層でタイルが 4 近傍隣接
  const tileOwner = new Map<string, string>();
  for (const b of buildings) {
    for (const t of facilityTiles(b)) tileOwner.set(`${facilityLevel(b)}:${tileKey(t.x, t.y)}`, b.id);
  }
  for (const b of buildings) {
    const level = facilityLevel(b);
    for (const t of facilityTiles(b)) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const other = tileOwner.get(`${level}:${tileKey(t.x + dx, t.y + dy)}`);
        if (other && other !== b.id) union(b.id, other);
      }
    }
  }

  // 2) operational な高層連絡通路（エリアの所属ターミナル経由）
  const areaTerminal = new Map<string, string>();
  for (const a of sortedValues(layout.terminalAreas)) areaTerminal.set(a.id, a.terminalId);
  for (const link of sortedValues(layout.terminalLinks ?? {})) {
    if (link.kind !== 'elevatedWalkway' || link.buildState !== 'operational') continue;
    const from = areaTerminal.get(link.fromAreaId);
    const to = areaTerminal.get(link.toAreaId);
    if (from && to && from !== to && parent.has(from) && parent.has(to)) union(from, to);
  }

  const groups = new Map<string, string[]>();
  for (const b of buildings) {
    const root = find(b.id);
    const arr = groups.get(root) ?? [];
    arr.push(b.id);
    groups.set(root, arr);
  }
  return [...groups.entries()]
    .map(([id, buildingIds]) => ({ id, buildingIds: buildingIds.sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** 施設 ID → 複合体 ID の対応（ターミナル建物のみ） */
export function terminalComplexIdByBuilding(layout: AirportLayout): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of deriveTerminalComplexes(layout)) {
    for (const id of c.buildingIds) out.set(id, c.id);
  }
  return out;
}
