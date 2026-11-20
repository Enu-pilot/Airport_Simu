import type { AirportLayout } from '../model/types';
import { rectsShareEdge } from './model';

/**
 * ターミナル「サービス複合体」: 運用中ターミナルリンクで結ばれたターミナル建物の集合。
 *
 * サテライト棟のように入口・チェックイン・保安・手荷物受取・出口を自前で持たない建物でも、
 * リンクで結ばれた本体ターミナルがそれらを備えていれば、旅客はリンクを歩いて本体の設備を
 * 使える。この関数はその「候補集合」を返すだけで、実際に通れるかどうかはエリアグラフの
 * 経路探索（findPaxRoute: リンクの allowedZones・双方向・buildState を反映済み）が決める。
 *
 * 建物間の旅客移動は、明示リンク、または同レベルでエリア同士が辺を共有する隣接の
 * どちらかで結ばれていれば可能で、その建物同士は同じ複合体になる（隣り合う建物は
 * 1 つの建物とみなす）。リンクも隣接も無い建物同士は同じ複合体にならない。
 * 建設中リンクは既定では数えず（opts.includeUnderConstruction で
 * 検証側の「完成待ち」判定用に含められる）、計画中リンクは常に対象外。
 */
export interface ServiceComplexOptions {
  includeUnderConstruction?: boolean;
}

/** 全ターミナルについて、所属する複合体のターミナル ID 群（自分を含む・ソート済み）を返す */
export function terminalServiceComplexes(
  layout: AirportLayout,
  opts: ServiceComplexOptions = {},
): Map<string, string[]> {
  const terminalIds = Object.values(layout.facilities)
    .filter((f) => f.kind === 'terminal')
    .map((f) => f.id)
    .sort();

  // union-find
  const parent = new Map<string, string>(terminalIds.map((id) => [id, id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const link of Object.values(layout.terminalLinks ?? {})) {
    const active = link.buildState === 'operational' || (opts.includeUnderConstruction === true && link.buildState === 'underConstruction');
    if (!active) continue;
    const fromTerminal = layout.terminalAreas[link.fromAreaId]?.terminalId;
    const toTerminal = layout.terminalAreas[link.toAreaId]?.terminalId;
    if (!fromTerminal || !toTerminal || fromTerminal === toTerminal) continue;
    if (!parent.has(fromTerminal) || !parent.has(toTerminal)) continue;
    union(fromTerminal, toTerminal);
  }

  // 隣接: 異なるターミナルのエリア同士が同レベルで辺を共有していれば同じ複合体にする
  const areasByTerminal = new Map<string, { level: number; x: number; y: number; w: number; h: number }[]>();
  for (const a of Object.values(layout.terminalAreas)) {
    if (!parent.has(a.terminalId)) continue;
    const rect = { level: a.level, x: a.origin.x, y: a.origin.y, w: a.w, h: a.h };
    (areasByTerminal.get(a.terminalId) ?? areasByTerminal.set(a.terminalId, []).get(a.terminalId)!).push(rect);
  }
  const complexIds = [...areasByTerminal.keys()].sort();
  for (let i = 0; i < complexIds.length; i++) {
    for (let j = i + 1; j < complexIds.length; j++) {
      const as = areasByTerminal.get(complexIds[i]!)!;
      const bs = areasByTerminal.get(complexIds[j]!)!;
      if (as.some((a) => bs.some((b) => a.level === b.level && rectsShareEdge(a, b)))) {
        union(complexIds[i]!, complexIds[j]!);
      }
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const id of terminalIds) {
    const root = find(id);
    (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(id);
  }
  const result = new Map<string, string[]>();
  for (const members of byRoot.values()) {
    const sorted = [...members].sort();
    for (const id of sorted) result.set(id, sorted);
  }
  return result;
}

/** 1 ターミナルの複合体を返す（ターミナルでない/未知の ID は自分だけの集合） */
export function serviceComplexOf(
  layout: AirportLayout,
  terminalId: string,
  opts: ServiceComplexOptions = {},
): string[] {
  return terminalServiceComplexes(layout, opts).get(terminalId) ?? [terminalId];
}
